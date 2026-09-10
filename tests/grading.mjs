// Grading tests: each activity is judged on its own scales, every threshold is absolute, and a
// activity is only as good as its weakest requirement.
import assert from 'node:assert';
import {stubBrowser, suite} from './helpers.mjs';

stubBrowser();
const g = await import('../js/grade.js');
const probe = await import('../js/probe.js');
const {PROBES} = probe;

const s = suite('grading');

const ok = (ms, extra = {}) => ({ok: true, ms, fail: null, ...extra});
const bad = (extra = {}) => ({ok: false, ms: null, fail: 'timeout', ...extra});
const pick = r => ({state: r.state, grade: r.grade});
const round = (over = {}) => ({probes: {
  ip6: ok(30), ip4: bad({expected: true}), dns: ok(190), dns_ctl: ok(60),
  web: ok(65), udp: ok(50),
  down: {ok: true, ms: 300, bps: 40e6},
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
  assert.equal(g.gradeActivities(round({down: {ok: true, bps: 20e3}})).voice, 'red',
               'a link carrying less than speech needs');
  // The term is there to catch a dead link, not to rank live ones: speech is 9-14 kb/s, so
  // anything a train cell delivers carries a call.
  assert.equal(g.gradeActivities(round({down: {ok: true, bps: 500e3}})).voice, 'green',
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
  const crawling = g.gradeActivities(round({dns: ok(120), down: {ok: true, bps: 300e3}}));
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

s.test('a lookup on a retry timer is red however small the delta', () => {
  // The first query was lost. Loss, not slowness, and the delta cannot see it.
  const lost = round({dns: ok(80, {retry_suspected: true}), dns_ctl: ok(60)});
  const r = g.probeReading('dns', lost);
  assert.equal(r.grade, 'red');
  assert.equal(r.value, null, 'there is no number that would explain the colour');
  assert.equal(r.note, 'lost');
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

s.test('every family gone is the only route failure', () => {
  // Every other probe fails too, so the round has no traffic to credit a literal with.
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

s.test('throughput is what the round streamed over its window', () => {
  const down = over => ({ok: true, ms: 300, ...over});
  assert.equal(g.throughput(down({bps: 22e6})), 22e6);
  assert.equal(g.throughput({ok: false, bps: 30e6}), null, 'a failed download measured nothing');
  assert.equal(g.throughput(down({})), null, 'and a window that never opened measured nothing');

  // A saturated round proves the link carries at least the ceiling, which is above every edge.
  const sat = {ok: true, bps: probe.DOWN_CEILING_BPS, saturated: true};
  assert.equal(g.activityReading('streaming', {probes: {down: sat}}).grade, 'green');
  assert.equal(g.activityReading('streaming', {probes: {down: sat}}).saturated, true,
               'and the reading says so, so the screen can print a ≥');
});

s.test('the route row shows the family doing the work', () => {
  // A fibre connection with IPv6 addressing but no route to the IPv6 literal reported a red
  // row every round while IPv4 carried every byte. Neither literal answered, and the tie went
  // to IPv6 — the family that was doing nothing.
  const ok = ms => ({ok: true, ms});
  const bad = over => ({ok: false, ms: null, fail: 'network', ...over});

  assert.equal(g.activeRoute({ip6: ok(30), ip4: ok(25)}), 'ip6', 'a browser prefers IPv6');
  assert.equal(g.activeRoute({ip6: bad(), ip4: ok(25)}), 'ip4');

  // Its literal is refused but the family carries traffic, which beats a family that fails.
  const blocked = {ip6: bad(), ip4: bad({blocked: true})};
  assert.equal(g.activeRoute(blocked), 'ip4');
  assert.equal(g.probeReading('ip4', {probes: blocked}).grade, null,
               'and a blocked literal takes no colour, because the path is fine');

  // An absent family has said nothing at all, so it is the last thing worth showing.
  assert.equal(g.activeRoute({ip6: bad({expected: true}), ip4: bad({blocked: true})}), 'ip4');

  // Nothing carrying anything is still red.
  const dead = {ip6: bad(), ip4: bad()};
  assert.equal(g.activeRoute(dead), 'ip6');
  assert.equal(g.probeReading('ip6', {probes: dead}).grade, 'red');
});

s.test('a literal never decides an activity while anything reached the network', () => {
  // The whole point of the flags is what the screen and the file say about the literal. They
  // must not be able to change a verdict about calling, reading or watching — that belongs to
  // the probes a person waits on.
  const ok = ms => ({ok: true, ms});
  const bad = o => ({ok: false, ms: null, fail: 'network', ...o});
  const base = {dns: ok(180), dns_ctl: ok(30), web: ok(25), udp: ok(20), down: {ok: true, bps: 25e6}};

  for (const over of [{ip6: bad(), ip4: bad()},
                      {ip6: bad({unused: true}), ip4: bad({blocked: true})},
                      {ip6: bad({blocked: true}), ip4: bad({unused: true})},
                      {ip6: bad({expected: true}), ip4: bad()}]) {
    const probes = {...base, ...over};
    const stripped = {...probes, ip6: {...probes.ip6}, ip4: {...probes.ip4}};
    for (const id of ['ip6', 'ip4']) {
      delete stripped[id].unused; delete stripped[id].blocked; delete stripped[id].expected;
    }
    assert.deepEqual(g.gradeActivities({probes}), g.gradeActivities({probes: stripped}),
                     `the flags moved a verdict: ${JSON.stringify(over)}`);
  }
});

s.test('the states a failing literal can take are exclusive, and only one is red', () => {
  const bad = o => ({ok: false, ms: null, fail: 'network', ...o});
  const state = o => g.probeReading('ip4', {probes: {ip4: bad(o)}}).state;
  assert.equal(state({}), 'failed');
  assert.equal(state({unused: true}), 'unused');
  assert.equal(state({blocked: true}), 'blocked');
  assert.equal(state({expected: true}), 'absent');
  assert.equal(state({fail: 'resting'}), 'resting');

  // Only a plain failure is charged to the link, and only it takes a colour.
  for (const o of [{unused: true}, {blocked: true}, {expected: true}, {fail: 'resting'}]) {
    const r = g.probeReading('ip4', {probes: {ip4: bad(o)}});
    assert.equal(r.grade, null, `${JSON.stringify(o)} takes no colour`);
  }
  assert.equal(g.probeReading('ip4', {probes: {ip4: bad()}}).grade, 'red');
});

// What a download that produced no rate does to each activity. A term that cannot be measured
// is dropped; one left in place with no value reads as unrated, which blanks an activity whose
// round trip and UDP path were both measured.
s.test('a download with no rate degrades what it measures and nothing else', () => {
  const grades = down => {
    const r = g.gradeActivities(round({down}));
    return [r.voice, r.news, r.streaming];
  };

  // The link stopped carrying: every activity that needs data is red, calls included.
  assert.deepEqual(grades({ok: false, fail: 'network', refused_by: 'connection', bps: null}),
                   ['red', 'red', 'red'], 'a connection that would not open is the link');
  assert.deepEqual(grades({ok: false, fail: 'stalled', bps: null}),
                   ['red', 'red', 'red'], 'a cell that stopped answering mid-window is the link');
  assert.deepEqual(grades({ok: false, fail: 'timeout', bps: null}),
                   ['red', 'red', 'red']);

  // The endpoint turned us away, or the measurement was too short to divide by. Neither says
  // anything about the link, so the round trip and the lookup still grade.
  for (const down of [{ok: false, fail: 'network', refused_by: 'server', bps: null},
                      {ok: false, fail: 'short', bps: null},
                      {ok: false, fail: 'resting', bps: null}]) {
    const [voice, news, streaming] = grades(down);
    assert.equal(voice, 'green', `calls grade on the round trip: ${down.fail}`);
    assert.equal(news, 'green', `an article grades on the lookup alone: ${down.fail}`);
    assert.equal(streaming, null, `streaming has nothing left to read: ${down.fail}`);
  }
});

s.test('an unmeasured term never leaves an activity greener than its worst probe', () => {
  // The carve-out must not become a way to lose a red: a refused download beside a dead UDP
  // path is still a call that will not connect.
  const r = g.gradeActivities(round({down: {ok: false, fail: 'short', bps: null},
                                     udp: {ok: false, ms: null, fail: 'timeout'}}));
  assert.equal(r.voice, 'red', 'no UDP is still no call');
});

await s.run();
