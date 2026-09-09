// Grading tests: each activity is judged on its own scales, every threshold is absolute, and a
// activity is only as good as its weakest requirement.
import assert from 'node:assert';
import {stubBrowser, suite} from './helpers.mjs';

stubBrowser();
const g = await import('../js/grade.js');
const {PROBES} = await import('../js/probe.js');

const s = suite('grading');

const ok = (ms, extra = {}) => ({ok: true, ms, fail: null, ...extra});
const bad = (extra = {}) => ({ok: false, ms: null, fail: 'timeout', ...extra});
const pick = r => ({state: r.state, grade: r.grade});
const round = (over = {}) => ({probes: {
  ip6: ok(30), ip4: bad({expected: true}), dns: ok(190), dns_ctl: ok(60),
  web: ok(65), udp: ok(50),
  down: {ok: true, ms: 300, bps_min: 40e6},
  ...over
}});

s.test('each activity is graded on its own scales', () => {
  const grades = g.gradeActivities(round());
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
  const first = g.gradeActivities(slow);
  for (let i = 0; i < 50; i++) g.gradeActivities(slow);      // history cannot move the answer
  assert.deepEqual(g.gradeActivities(slow), first, 'grading is a pure function of the round');
  assert.equal(first.voice, 'red');
  assert.equal(first.news, 'red');
});

s.test('a activity is only as good as its weakest requirement', () => {
  // Voice reads three things, and each alone can sink it however well the others read.
  assert.equal(g.gradeActivities(round()).voice, 'green', 'all three hold');
  assert.equal(g.gradeActivities(round({udp: bad()})).voice, 'red', 'no UDP path');
  assert.equal(g.gradeActivities(round({ip6: ok(500)})).voice, 'red', 'round trip too long');
  assert.equal(g.gradeActivities(round({down: {ok: true, bps_min: 20e3}})).voice, 'red',
               'a link carrying less than speech needs');
  // The term is there to catch a dead link, not to rank live ones: speech is 9-14 kb/s, so
  // anything a train cell actually delivers carries a call.
  assert.equal(g.gradeActivities(round({down: {ok: true, bps_min: 500e3}})).voice, 'green',
               'half a megabit is ample for a call');
  assert.equal(g.gradeActivities(round({ip6: ok(10), udp: bad()})).voice, 'red',
               'loss beats a fast answer: calls break on loss before latency');

  // A STUN exchange carries ICE gathering on top of a round trip, so its milliseconds are on
  // a different scale and only whether the path exists is read.
  assert.equal(g.gradeActivities(round({ip6: ok(33), udp: ok(340)})).voice, 'green',
               'a slow STUN exchange over a fast link is still a fast link');
});

s.test('opening an article reads the lookup and the bytes together', () => {
  assert.equal(g.gradeActivities(round()).news, 'green');
  // A fast lookup does not save an article that cannot be pulled down.
  const crawling = g.gradeActivities(round({dns: ok(120), down: {ok: true, bps_min: 300e3}}));
  assert.equal(crawling.news, 'red', 'a fast cold origin over a link that carries nothing');
  // And a quick link does not save a slow lookup: 2.5 s of cold origin is past the point
  // web.dev calls poor, and 3.5 s is past the point an article is worth waiting for.
  assert.equal(g.gradeActivities(round({dns: ok(2500)})).news, 'orange');
  assert.equal(g.gradeActivities(round({dns: ok(3500)})).news, 'red');
});

s.test('an article needs both origins, the cold one and the warm one', () => {
  assert.equal(g.gradeActivities(round({web: bad()})).news, 'red',
               'a host the phone already knows refusing to answer stops an article');
  assert.equal(g.gradeActivities(round({dns: bad()})).news, 'red', 'and so does a lookup failing');
  assert.equal(g.gradeActivities(round({web: bad()})).voice, 'green',
               'while a call over the same round is unaffected');
});

s.test('a lookup that came back on a retry timer grades as loss', () => {
  const retried = round({dns: ok(2207, {retry_suspected: true})});
  assert.equal(g.gradeActivities(retried).news, 'red',
               'a fixed multi-second timer is packet loss, not a slow resolver');
});

s.test('a download the far end refused is not the link being bad', () => {
  // The failure that broke two recorded journeys. Reporting it as red said the person's
  // connection could not carry video, when the connection was carrying everything else.
  const refused = round({down: {ok: false, fail: 'network', refused_by: 'server'}});
  assert.notEqual(g.gradeActivities(refused).streaming, 'red',
                  'the endpoint turning us away is a fact about the endpoint');

  const dead = round({down: {ok: false, fail: 'network', refused_by: 'connection'}});
  assert.equal(g.gradeActivities(dead).streaming, 'red', 'a connection that never opened is the link');

  const rested = round({down: {ok: false, fail: 'resting'}});
  assert.notEqual(g.gradeActivities(rested).streaming, 'red', 'a rested probe reported nothing');
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

s.test('every activity names the scales it is judged on', () => {
  for (const [name, activity] of Object.entries(g.ACTIVITIES)) {
    assert.ok(activity.label, `${name} has a label`);
    assert.ok(activity.scales.length > 0, `${name} names its scales`);
    for (const scale of activity.scales) {
      assert.ok(g.SCALES[scale], `${name} reads ${scale}, which must exist`);
    }
  }
});


s.test('every probe names a scale that exists', () => {
  for (const p of PROBES) {
    const scale = g.PROBE_SCALES[p.id];
    assert.ok(scale, `${p.id} names a scale, or its row shows a number no colour contradicts`);
    assert.ok(g.SCALES[scale], `${p.id} reads ${scale}, which must exist`);
  }
});

s.test('a probe reports its own measurement', () => {
  const r = g.probeReading('ip6', round({ip6: ok(30)}));
  assert.equal(r.state, 'ok');
  assert.equal(r.grade, 'green');
  assert.equal(r.value, 30);
  assert.equal(r.unit, 'ms');

  assert.equal(g.probeReading('ip6', round({ip6: ok(250)})).grade, 'orange');
  assert.equal(g.probeReading('ip6', round({ip6: ok(500)})).grade, 'red');
  // The download grades on the bound it publishes, not on how long the read took.
  assert.equal(g.probeReading('down', round()).value, 40e6);
  assert.equal(g.probeReading('down', round()).grade, 'green');
});

s.test('a probe that measured nothing carries no colour', () => {
  // An absent IPv4 path, a rested probe and a probe the round never ran are all reasons for
  // there to be no measurement, and none of them is the link being bad.
  assert.deepEqual(pick(g.probeReading('ip4', round())), {state: 'absent', grade: null});
  assert.deepEqual(pick(g.probeReading('web', round({web: bad({fail: 'resting'})}))),
                   {state: 'resting', grade: null});
  assert.deepEqual(pick(g.probeReading('udp', round({udp: undefined}))),
                   {state: 'none', grade: null});

  const failing = g.probeReading('web', round({web: bad()}));
  assert.deepEqual(pick(failing), {state: 'failed', grade: 'red'});
  assert.equal(failing.note, 'timeout', 'the row says why, not just that');
});

s.test('a download the server refused does not grade the link', () => {
  // The same fact the streaming activity already ignores: the row and the tile below it must
  // not disagree about whose fault it was.
  const refused = round({down: {ok: false, fail: 'network', refused_by: 'server'}});
  assert.deepEqual(pick(g.probeReading('down', refused)), {state: 'refused', grade: null});
  assert.notEqual(g.gradeActivities(refused).streaming, 'red');
});

s.test('the fresh lookup is graded against the cached-name control', () => {
  // Same host, same path: the difference is what the delta is for. The absolute number is
  // mostly the far end handling a name it has not seen, so it is never graded on its own.
  const delta = (dns, ctl) => g.probeReading('dns', round({dns: ok(dns), dns_ctl: ok(ctl)}));
  assert.equal(delta(200, 60).grade, 'green', '140 ms sits at the floor every journey shows');
  assert.equal(delta(700, 60).grade, 'orange');
  assert.equal(delta(1200, 60).grade, 'red');
  assert.equal(delta(200, 60).value, 140, 'the row prints the difference it graded');

  // One sample against a median of three goes negative on noise. Three of 259 recorded rounds
  // do; a negative delta is not a faster-than-instant lookup.
  assert.equal(delta(40, 160).value, 0);
  assert.equal(delta(40, 160).grade, 'green');
});

s.test('a lookup on a retry timer is red however small the delta', () => {
  // The first query was lost. Loss, not slowness, and the delta cannot see it.
  const lost = round({dns: ok(80, {retry_suspected: true}), dns_ctl: ok(60)});
  const r = g.probeReading('dns', lost);
  assert.equal(r.grade, 'red');
  assert.equal(r.value, null, 'there is no number that would explain the colour');
  assert.equal(r.note, 'lost');
});

s.test('a fresh lookup with no control still reports', () => {
  // Nothing to subtract, but the name did resolve, and that is worth saying.
  const r = g.probeReading('dns', round({dns: ok(190), dns_ctl: bad()}));
  assert.equal(r.grade, 'green');
  assert.equal(r.value, null);
  assert.equal(r.note, 'resolved');
});

s.test('calling reads whichever address family the network carries', () => {
  // A network with only one family is ordinary, not broken. Grading the route on IPv6 alone
  // reported "no route" on every round of a perfectly healthy IPv4-only network.
  const route = over => g.activityReading('voice', round(over));

  const only4 = route({ip6: bad({expected: true}), ip4: ok(25)});
  assert.equal(only4.grade, 'green', 'an IPv4-only network is a working network');
  assert.equal(only4.value, 25, 'and the round trip is read from the family that answered');

  const only6 = route({ip6: ok(30), ip4: bad({expected: true})});
  assert.deepEqual([only6.grade, only6.value], ['green', 30]);

  // A browser prefers IPv6 where both work, so the screen reports the one it would use.
  assert.equal(route({ip6: ok(30), ip4: ok(25)}).value, 30);
  assert.equal(g.activeRoute({ip6: ok(30), ip4: ok(25)}), 'ip6');
  assert.equal(g.activeRoute({ip6: bad(), ip4: ok(25)}), 'ip4');
});

s.test('no route means every family is gone, not merely one', () => {
  // Nothing else reached the network either, or the literals are not the story.
  const dead = {dns: bad(), dns_ctl: bad(), web: bad(), down: bad()};
  const route = over => g.activityReading('voice', round({...dead, ...over}));

  assert.equal(route({ip6: bad(), ip4: bad()}).note, 'no route');
  // The absent family reported nothing, so the failure of the working one still decides.
  assert.equal(route({ip6: bad(), ip4: bad({expected: true})}).note, 'no route');
  assert.equal(route({ip6: bad({expected: true}), ip4: bad()}).note, 'no route');

  // One family carrying traffic is a route, however the other fared.
  assert.notEqual(route({ip6: bad(), ip4: ok(25)}).note, 'no route');

  // And neither literal answering is not "no route" while the rest of the round gets out:
  // one operator failed both every round while DNS, the web probe and the download answered.
  const blocked = g.activityReading('voice', round({ip6: bad(), ip4: bad()}));
  assert.notEqual(blocked.note, 'no route',
                  'a blocked literal is not the same as a dead link');
  // Two rested probes have reported nothing at all and cannot condemn the link.
  assert.notEqual(route({ip6: bad({fail: 'resting'}), ip4: bad({fail: 'resting'})}).note,
                  'no route');
});

s.test('throughput is what the transfer carried, and nothing else is voted in', () => {
  // Cloudflare's own rate for the connection looks like a second opinion and is not one:
  // headers precede the payload, so the figure stapled to a transfer describes the socket as
  // the previous one ended. A window-limited flow is never flagged app-limited either, so it
  // reports the same W/RTT number for the same reason and agreeing proves nothing.
  const down = over => ({ok: true, ms: 300, ...over});
  assert.equal(g.throughput(down({bps: 30e6, bps_server: 78e6, bps_min: 22e6})), 22e6);
  assert.equal(g.throughput(down({bps_min: 29e6})), 29e6);
  assert.equal(g.throughput({ok: false, bps_min: 30e6}), null, 'a failed download measured nothing');
  assert.equal(g.throughput(down({})), null);
});

await s.run();
