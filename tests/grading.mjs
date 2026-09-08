// Grading tests: each purpose is judged on its own scales, every threshold is absolute, and a
// purpose is only as good as its weakest requirement.
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
  down: {ok: true, ms: 300, bps_min: 40e6},
  ...over
}});

s.test('each purpose is graded on its own scales', () => {
  const grades = g.gradeRound(round());
  assert.equal(grades.voice, 'green', '30 ms round trip, UDP open, 40 Mb/s');
  assert.equal(grades.news, 'green', '190 ms to a cold origin is a good result');
  assert.equal(grades.streaming, 'green', '40 Mb/s');

  // The same number means different things on different scales: 190 ms of cold lookup is
  // comfortable, 190 ms of round trip is not.
  assert.equal(g.gradeValue('ttfb', 190), 'green');
  assert.equal(g.gradeValue('round_trip', 190), 'yellow');
});

s.test('nothing consults the session for its thresholds', () => {
  const slow = round({ip6: ok(900), udp: ok(900), web: ok(2500), dns: ok(2500)});
  const first = g.gradeRound(slow);
  for (let i = 0; i < 50; i++) g.gradeRound(slow);      // history cannot move the answer
  assert.deepEqual(g.gradeRound(slow), first, 'grading is a pure function of the round');
  assert.equal(first.voice, 'red');
  assert.equal(first.news, 'red');
});

s.test('a purpose is only as good as its weakest requirement', () => {
  // Voice reads three things, and each alone can sink it however well the others read.
  assert.equal(g.gradeRound(round()).voice, 'green', 'all three hold');
  assert.equal(g.gradeRound(round({udp: bad()})).voice, 'red', 'no UDP path');
  assert.equal(g.gradeRound(round({ip6: ok(500)})).voice, 'red', 'round trip too long');
  assert.equal(g.gradeRound(round({down: {ok: true, bps_min: 20e3}})).voice, 'red',
               'a link carrying less than speech needs');
  // The term is there to catch a dead link, not to rank live ones: speech is 9-14 kb/s, so
  // anything a train cell actually delivers carries a call.
  assert.equal(g.gradeRound(round({down: {ok: true, bps_min: 500e3}})).voice, 'green',
               'half a megabit is ample for a call');
  assert.equal(g.gradeRound(round({ip6: ok(10), udp: bad()})).voice, 'red',
               'loss beats a fast answer: calls break on loss before latency');

  // A STUN exchange carries ICE gathering on top of a round trip, so its milliseconds are on
  // a different scale and only whether the path exists is read.
  assert.equal(g.gradeRound(round({ip6: ok(33), udp: ok(340)})).voice, 'green',
               'a slow STUN exchange over a fast link is still a fast link');
});

s.test('opening an article reads the lookup and the bytes together', () => {
  assert.equal(g.gradeRound(round()).news, 'green');
  // A fast lookup does not save an article that cannot be pulled down.
  const crawling = g.gradeRound(round({dns: ok(120), down: {ok: true, bps_min: 300e3}}));
  assert.equal(crawling.news, 'red', 'a fast cold origin over a link that carries nothing');
  // And a quick link does not save a slow lookup: 2.5 s of cold origin is past the point
  // web.dev calls poor, and 3.5 s is past the point an article is worth waiting for.
  assert.equal(g.gradeRound(round({dns: ok(2500)})).news, 'orange');
  assert.equal(g.gradeRound(round({dns: ok(3500)})).news, 'red');
});

s.test('an article needs both origins, the cold one and the warm one', () => {
  assert.equal(g.gradeRound(round({web: bad()})).news, 'red',
               'a host the phone already knows refusing to answer stops an article');
  assert.equal(g.gradeRound(round({dns: bad()})).news, 'red', 'and so does a lookup failing');
  assert.equal(g.gradeRound(round({web: bad()})).voice, 'green',
               'while a call over the same round is unaffected');
});

s.test('a lookup that came back on a retry timer grades as loss', () => {
  const retried = round({dns: ok(2207, {retry_suspected: true})});
  assert.equal(g.gradeRound(retried).news, 'red',
               'a fixed multi-second timer is packet loss, not a slow resolver');
});

s.test('a download the far end refused is not the link being bad', () => {
  // The failure that broke two recorded journeys. Reporting it as red said the person's
  // connection could not carry video, when the connection was carrying everything else.
  const refused = round({down: {ok: false, fail: 'network', refused_by: 'server'}});
  assert.notEqual(g.gradeRound(refused).streaming, 'red',
                  'the endpoint turning us away is a fact about the endpoint');

  const dead = round({down: {ok: false, fail: 'network', refused_by: 'connection'}});
  assert.equal(g.gradeRound(dead).streaming, 'red', 'a connection that never opened is the link');

  const rested = round({down: {ok: false, fail: 'resting'}});
  assert.notEqual(g.gradeRound(rested).streaming, 'red', 'a rested probe reported nothing');
});

s.test('every scale is reachable and ordered', () => {
  for (const [name, t] of Object.entries(g.SCALES)) {
    const sorted = [...t.edges].sort((a, b) => t.dir === 'low' ? a - b : b - a);
    assert.deepEqual(t.edges, sorted, `${name} edges run from best to worst`);
    const seen = new Set();
    const probes = t.dir === 'low'
      ? [t.edges[0] - 1, t.edges[0], t.edges[1], t.edges[2]]
      : [t.edges[0] + 1, t.edges[0], t.edges[1], t.edges[2] - 1];
    for (const v of probes) seen.add(g.gradeValue(name, v));
    assert.deepEqual([...seen].sort(), [...g.GRADES].sort(), `${name} can produce all four grades`);
    assert.equal(g.gradeValue(name, null), null, `${name} grades nothing from nothing`);
  }
});

s.test('every purpose names the scales it is judged on', () => {
  for (const [name, purpose] of Object.entries(g.PURPOSES)) {
    assert.ok(purpose.label, `${name} has a label`);
    assert.ok(purpose.scales.length > 0, `${name} names its scales`);
    for (const scale of purpose.scales) {
      assert.ok(g.SCALES[scale], `${name} reads ${scale}, which must exist`);
    }
  }
});

await s.run();
