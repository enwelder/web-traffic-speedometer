// Grading tests. A journey on good 5G came back mostly yellow and orange; these pin the two
// reasons that happened and the rules that replaced them.
import assert from 'node:assert';
import {stubBrowser, suite} from './helpers.mjs';

stubBrowser();
const g = await import('../js/grade.js');

const s = suite('grading');

const ok = (ms, extra = {}) => ({ok: true, ms, fail: null, ...extra});
const bad = (extra = {}) => ({ok: false, ms: null, fail: 'timeout', ...extra});
const round = (over = {}) => ({probes: {
  ip6: ok(30), ip4: bad({expected: true}), dns: ok(190), dns_ctl: ok(60),
  web: ok(65), udp: ok(50),
  down: {ok: true, ms: 2100, bps_steady: 40e6, bps_peak: 55e6, insufficient_sample: false},
  ...over
}});

s.test('a probe is graded on its own scale, not a shared one', () => {
  // The fresh-lookup probe costs ~200 ms on a perfect link: a real lookup plus a hostname
  // the edge has never seen. Judging it against the same 300 ms as a warm round trip is
  // what painted a healthy afternoon yellow.
  const grades = g.gradeRound(round());
  assert.equal(grades.realtime, 'green', '30 ms round trip');
  assert.equal(grades.tap, 'green', '65 ms to a known host');
  assert.equal(grades.newsite, 'green', '190 ms including a real lookup is a good result');
  assert.equal(grades.video, 'green', '40 Mb/s');

  // The same 190 ms judged as a plain latency would not have been green.
  assert.equal(g.gradeValue('tap', 190), 'green');
  assert.equal(g.gradeValue('realtime', 190), 'yellow', 'the same number means different things');
});

s.test('nothing consults the session for its thresholds', () => {
  // Every edge is a constant. A connection is not good because it is no worse than the rest
  // of the journey, and a slow journey must not normalise itself into green.
  const slow = {probes: {...round().probes, ip6: ok(900), udp: ok(900), web: ok(2500), dns: ok(2500)}};
  const first = g.gradeRound(slow);
  for (let i = 0; i < 50; i++) g.gradeRound(slow);      // history cannot move the answer
  assert.deepEqual(g.gradeRound(slow), first, 'grading is a pure function of the round');
  assert.equal(first.realtime, 'red');
  assert.equal(first.tap, 'orange');
});

s.test('real-time takes latency from one probe and loss from both', () => {
  assert.equal(g.gradeRound(round({udp: bad()})).realtime, 'red', 'UDP gone');
  assert.equal(g.gradeRound(round({ip6: bad()})).realtime, 'red', 'the direct path gone');
  // Loss beats a fast answer: calls die on loss before they die on latency.
  assert.equal(g.gradeRound(round({udp: bad(), ip6: ok(10)})).realtime, 'red');
  assert.equal(g.gradeRound(round()).realtime, 'green', 'an absent IPv4 path is not loss');

  // A STUN exchange carries ICE gathering on top of a round trip, so its milliseconds are
  // not the link's. Judging them on one scale put a 33 ms connection in orange.
  assert.equal(g.gradeRound(round({ip6: ok(33), udp: ok(340)})).realtime, 'green',
               'a slow STUN exchange over a fast link is still a fast link');
  assert.equal(g.gradeRound(round({ip6: ok(340), udp: ok(33)})).realtime, 'orange',
               'while a slow link is graded whatever STUN reports');
});

s.test('a lookup that came back on a retry timer grades as loss', () => {
  const retried = round({dns: ok(2207, {retry_suspected: true})});
  assert.equal(g.gradeRound(retried).newsite, 'red',
               'a fixed multi-second timer is packet loss, not a slow resolver');
  // Without the flag the same duration is merely bad.
  assert.equal(g.gradeRound(round({dns: ok(2207)})).newsite, 'orange');
});

s.test('an unmeasurable rate is never graded', () => {
  const short = round({down: {ok: true, ms: 300, bps_steady: null, insufficient_sample: true}});
  assert.equal(g.gradeRound(short).video, null, 'no grade rather than a grade of the ramp');
  const capped = round({down: {ok: false, fail: 'data_cap'}});
  assert.equal(g.gradeRound(capped).video, null, 'stopping at the cap is not a failure');
  assert.equal(g.gradeRound(round({down: bad()})).video, 'red', 'a real failure still is');
});

s.test('the window takes the worst of the recent rounds', () => {
  const good = {realtime: 'green'}, mid = {realtime: 'yellow'}, poor = {realtime: 'orange'};
  assert.equal(g.windowGrade([good, good, good], 'realtime'), 'green');
  assert.equal(g.windowGrade([good, poor, good], 'realtime'), 'orange', 'one bad round shows');
  assert.equal(g.windowGrade([good, mid, poor], 'realtime'), 'orange');
  assert.equal(g.windowGrade([], 'realtime'), null);
});

s.test('the display waits for the window to agree with itself', () => {
  const d = g.createDisplay({windowRounds: 3, confirmations: 2});
  // The first reading has nothing to confirm against, so it shows immediately.
  assert.equal(d.push({realtime: 'green'}).realtime, 'green');
  assert.equal(d.push({realtime: 'green'}).realtime, 'green');

  // One bad round is not enough to repaint the screen.
  assert.equal(d.push({realtime: 'red'}).realtime, 'green', 'first window disagreeing: hold');
  assert.equal(d.push({realtime: 'red'}).realtime, 'red', 'second agreeing window: change');

  // And it holds on the way back, symmetrically: the window has to lose the bad rounds
  // first, then agree with itself twice. Recovering faster than it degraded would make the
  // colour optimistic exactly where it matters.
  assert.equal(d.push({realtime: 'green'}).realtime, 'red', 'window still holds two red rounds');
  assert.equal(d.push({realtime: 'green'}).realtime, 'red');
  assert.equal(d.push({realtime: 'green'}).realtime, 'red', 'window clean, first confirmation');
  assert.equal(d.push({realtime: 'green'}).realtime, 'green', 'second confirmation clears it');

  d.reset();
  assert.deepEqual(d.current(), {}, 'a new session starts with no state');
});

s.test('variance is reported, never folded into the colour', () => {
  const steady = g.stability([100, 102, 98, 101, 99, 100, 103, 97]);
  const swinging = g.stability([40, 900, 45, 850, 38, 920, 42, 880]);
  assert.ok(steady.ratio < 1.2, `steady: ×${steady.ratio}`);
  assert.ok(swinging.ratio > 5, `swinging: ×${swinging.ratio}`);

  // Both can sit in the same band, which is the point of keeping them apart: the colour
  // says what works, the ratio says whether it will keep working.
  assert.equal(g.gradeValue('tap', 100), 'green');
  assert.equal(g.gradeValue('tap', 103), 'green');
  assert.equal(g.stability([1, 2]), null, 'too few readings claim nothing');
});

s.test('every threshold is reachable and ordered', () => {
  for (const [cap, t] of Object.entries(g.THRESHOLDS)) {
    const sorted = [...t.edges].sort((a, b) => t.dir === 'low' ? a - b : b - a);
    assert.deepEqual(t.edges, sorted, `${cap} edges run from best to worst`);
    const seen = new Set();
    const probes = t.dir === 'low'
      ? [t.edges[0] - 1, t.edges[0], t.edges[1], t.edges[2]]
      : [t.edges[0] + 1, t.edges[0], t.edges[1], t.edges[2] - 1];
    for (const v of probes) seen.add(g.gradeValue(cap, v));
    assert.deepEqual([...seen].sort(), [...g.GRADES].sort(), `${cap} can produce all four grades`);
    assert.equal(g.gradeValue(cap, null), null, `${cap} grades nothing from nothing`);
  }
});

await s.run();
