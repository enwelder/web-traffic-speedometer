// Grading tests: per-capability scales, absolute thresholds, and the cases where a round
// gets no grade at all.
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
  down: {ok: true, ms: 2100, bps_min: 40e6},
  ...over
}});

s.test('a probe is graded on its own scale, not a shared one', () => {
  // The fresh-lookup probe costs ~200 ms on a perfect link: a real lookup of a hostname the
  // edge has never seen. Its scale is therefore not the warm round trip's.
  const grades = g.gradeRound(round());
  assert.equal(grades.realtime, 'green', '30 ms round trip');
  assert.equal(grades.tap, 'green', '65 ms to a known host');
  assert.equal(grades.newsite, 'green', '190 ms including a real lookup is a good result');
  assert.equal(grades.video, 'green', '40 Mb/s');

  // The same 190 ms on the round-trip scale.
  assert.equal(g.gradeValue('tap', 190), 'green');
  assert.equal(g.gradeValue('realtime', 190), 'yellow', 'the same number means different things');
});

s.test('nothing consults the session for its thresholds', () => {
  // Every edge is a constant, so a slow journey cannot normalise itself into green.
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
  // Loss outranks a fast answer: calls break on loss before latency.
  assert.equal(g.gradeRound(round({udp: bad(), ip6: ok(10)})).realtime, 'red');
  assert.equal(g.gradeRound(round()).realtime, 'green', 'an absent IPv4 path is not loss');

  // A STUN exchange carries ICE gathering on top of a round trip, so its milliseconds are on
  // a different scale from the direct probe's and only its success is graded.
  assert.equal(g.gradeRound(round({ip6: ok(33), udp: ok(340)})).realtime, 'green',
               'a slow STUN exchange over a fast link is still a fast link');
  assert.equal(g.gradeRound(round({ip6: ok(340), udp: ok(33)})).realtime, 'orange',
               'while a slow link is graded whatever STUN reports');
});

s.test('a lookup that came back on a retry timer grades as loss', () => {
  const retried = round({dns: ok(2207, {retry_suspected: true})});
  assert.equal(g.gradeRound(retried).newsite, 'red',
               'a fixed multi-second timer is packet loss, not a slow resolver');
  // Without the flag the same duration grades on latency alone.
  assert.equal(g.gradeRound(round({dns: ok(2207)})).newsite, 'orange');
});

s.test('an unmeasurable rate is never graded', () => {
  const short = round({down: {ok: true, ms: 300, bps_steady: null, insufficient_sample: true}});
  assert.equal(g.gradeRound(short).video, null, 'no grade rather than a grade of the ramp');
  const rested = round({down: {ok: false, fail: 'resting'}});
  assert.equal(g.gradeRound(rested).video, null, 'a rested probe grades nothing rather than red');
  assert.equal(g.gradeRound(round({down: bad()})).video, 'red', 'a real failure still is');
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
