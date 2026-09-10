// Grading: each activity on its own scales, absolute thresholds, the worst term sets the grade.
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
  udp: ok(50),
  down: {ok: true, ms: 300, bps: 40e6},
  ...over
}});

s.test('gradeActivities MUST grade each activity on its own scales WHEN one round supplies every probe', () => {
  const grades = g.gradeActivities(round());
  assert.equal(grades.voice, 'green', '30 ms round trip, UDP open, 40 Mb/s');
  assert.equal(grades.news, 'green', '190 ms to a cold origin is a good result');
  assert.equal(grades.streaming, 'green', '40 Mb/s');

  // The same value grades differently per scale: 190 ms is green on `ttfb` and yellow on
  // `round_trip`.
  assert.equal(g.gradeValue('ttfb', 190), 'green');
  assert.equal(g.gradeValue('round_trip', 190), 'yellow');
});

s.test('gradeActivities MUST return identical grades WHEN called repeatedly with identical round data', () => {
  const slow = round({ip6: ok(900), udp: ok(900), dns_ctl: ok(2500), dns: ok(2500)});
  const first = g.gradeActivities(slow);
  for (let i = 0; i < 50; i++) g.gradeActivities(slow);      // history cannot move the answer
  assert.deepEqual(g.gradeActivities(slow), first, 'grading is a pure function of the round');
  assert.equal(first.voice, 'red');
  assert.equal(first.news, 'red');
});

s.test('gradeActivities MUST leave the round unchanged WHEN it grades one', () => {
  const input = round({ip6: ok(900), down: {ok: false, fail: 'network', refused_by: 'server'}});
  const before = JSON.parse(JSON.stringify(input));
  g.gradeActivities(input);
  g.probeReading('ip6', input);
  g.activityReading('voice', input);
  assert.deepEqual(input, before, 'the round carries no field a reading wrote into it');
});

s.test('gradeActivities MUST grade voice on its worst term WHEN any one of its terms degrades', () => {
  // Any one of voice's terms can set red.
  assert.equal(g.gradeActivities(round()).voice, 'green', 'all three hold');
  assert.equal(g.gradeActivities(round({udp: bad()})).voice, 'red', 'no UDP path');
  assert.equal(g.gradeActivities(round({ip6: ok(500)})).voice, 'red', 'round trip too long');
  assert.equal(g.gradeActivities(round({down: {ok: true, bps: 20e3}})).voice, 'red',
               'a link carrying less than speech needs');
  // `call_rate` detects a link carrying no data: speech takes 9-14 kb/s.
  assert.equal(g.gradeActivities(round({down: {ok: true, bps: 500e3}})).voice, 'green',
               'half a megabit is ample for a call');
  assert.equal(g.gradeActivities(round({ip6: ok(10), udp: bad()})).voice, 'red',
               'loss beats a fast answer: calls break on loss before latency');

  assert.equal(g.gradeActivities(round({ip6: ok(33), udp: ok(340)})).voice, 'orange',
               'call audio travels over UDP, so its delay grades the call');
});

s.test('gradeActivities MUST grade voice on the UDP round trip WHEN STUN answers slower than the literal', () => {
  const r = g.activityReading('voice', round({ip6: ok(33), udp: ok(340)}));
  assert.deepEqual([r.grade, r.value, r.scale], ['orange', 340, 'round_trip']);
});

s.test('gradeActivities MUST add no UDP delay term WHEN udp is expected', () => {
  // A browser without WebRTC, such as Safari in Lockdown Mode, measures no UDP delay.
  const r = g.activityReading('voice', round({udp: bad({fail: 'unsupported', expected: true})}));
  assert.deepEqual([r.grade, r.missing], ['green', []]);
});

s.test('gradeActivities MUST grade voice red with note no upload WHEN the upload failed on the link', () => {
  const r = g.activityReading('voice', round({up: bad()}));
  assert.deepEqual([r.grade, r.note], ['red', 'no upload']);
});

s.test('gradeActivities MUST grade voice on the upload rate WHEN the upload answered', () => {
  // 50 kb/s upstream carries speech without video.
  const r = g.activityReading('voice', round({up: ok(900, {bps: 50e3})}));
  assert.deepEqual([r.grade, r.value, r.scale], ['orange', 50e3, 'call_rate']);
});

s.test('gradeActivities MUST add no upload term WHEN the round has no up result or the upload was short', () => {
  for (const up of [undefined, bad({fail: 'short'}), bad({fail: 'no_budget'})]) {
    const r = g.activityReading('voice', round({up}));
    assert.deepEqual([r.grade, r.missing], ['green', []], JSON.stringify(up));
  }
});

s.test('probeReading MUST return the upload rate graded on call_rate WHEN the upload answered', () => {
  const r = g.probeReading('up', round({up: ok(60, {bps: 2e6})}));
  assert.deepEqual([r.state, r.value, r.unit, r.grade], ['ok', 2e6, 'bps', 'green']);
});

s.test('gradeActivities MUST grade news on the cold lookup and the throughput together WHEN either term degrades', () => {
  assert.equal(g.gradeActivities(round()).news, 'green');
  // A fast lookup with near-zero throughput grades news red.
  const crawling = g.gradeActivities(round({dns: ok(120), down: {ok: true, bps: 300e3}}));
  assert.equal(crawling.news, 'red', 'a fast cold origin over a link that carries nothing');
  // A slow lookup on a fast link: 2.5 s exceeds web.dev's poor threshold, 3.5 s grades red.
  assert.equal(g.gradeActivities(round({dns: ok(2500)})).news, 'orange');
  assert.equal(g.gradeActivities(round({dns: ok(3500)})).news, 'red');
});

s.test('gradeActivities MUST grade news red WHEN either the cold lookup or the cached-name host fails', () => {
  assert.equal(g.gradeActivities(round({dns_ctl: bad()})).news, 'red',
               'a warm origin refusing to answer stops an article');
  assert.equal(g.gradeActivities(round({dns: bad()})).news, 'red', 'and so does a lookup failing');
  assert.equal(g.gradeActivities(round({dns_ctl: bad()})).voice, 'green',
               'while a call over the same round is unaffected');
});

s.test('articleMs MUST return 2·dns + 2·dns_ctl + the transfer time WHEN every term measured', () => {
  // 500 kB at 40 Mb/s transfers in 100 ms.
  assert.equal(g.articleMs(round().probes), 2 * 190 + 2 * 60 + 100);
});

// Every Cloudflare instrument failed, over TCP and over UDP.
const cloudflareDown = {ip6: bad(), ip4: bad({expected: true}), udp: bad({fail: 'no_srflx'}),
                        down: {ok: false, fail: 'network', refused_by: 'connection', bps: null}};

s.test('activityReading MUST return a null grade with note far end for every activity WHEN the reference answered', () => {
  const row = {...round(cloudflareDown), reference: {ok: true, ms: 40, fail: null}};
  for (const activity of g.ACTIVITY_IDS) {
    const r = g.activityReading(activity, row);
    assert.deepEqual([r.grade, r.note], [null, 'far end'], activity);
  }
});

s.test('activityReading MUST grade the round as measured WHEN the reference failed', () => {
  const row = {...round(cloudflareDown), reference: {ok: false, ms: 1000, fail: 'timeout'}};
  assert.equal(g.gradeActivities(row).voice, 'red', 'the link carried nothing Google could answer either');
});

s.test('gradeActivities MUST grade news red WHEN the DNS answer carries retry_suspected', () => {
  const retried = round({dns: ok(2207, {retry_suspected: true})});
  assert.equal(g.gradeActivities(retried).news, 'red',
               'a fixed multi-second timer is packet loss, not a slow resolver');
});

s.test('gradeActivities MUST charge streaming red for a connection failure and withhold red for a server refusal WHEN the download fails', () => {
  // A server refusal describes the endpoint; the connection carries the other probes.
  const refused = round({down: {ok: false, fail: 'network', refused_by: 'server'}});
  assert.notEqual(g.gradeActivities(refused).streaming, 'red',
                  'the endpoint turning us away is a fact about the endpoint');

  const dead = round({down: {ok: false, fail: 'network', refused_by: 'connection'}});
  assert.equal(g.gradeActivities(dead).streaming, 'red', 'a connection that never opened is the link');

  const rested = round({down: {ok: false, fail: 'resting'}});
  assert.notEqual(g.gradeActivities(rested).streaming, 'red', 'a rested probe reported nothing');
});

s.test('SCALES MUST order every set of edges from best to worst and reach all four grades WHEN gradeValue runs over each edge', () => {
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

s.test('ACTIVITIES MUST carry a label and scales present in SCALES WHEN every entry is read', () => {
  for (const [name, activity] of Object.entries(g.ACTIVITIES)) {
    assert.ok(activity.label, `${name} has a label`);
    assert.ok(activity.scales.length > 0, `${name} names its scales`);
    for (const scale of activity.scales) {
      assert.ok(g.SCALES[scale], `${name} reads ${scale}, which must exist`);
    }
  }
});


s.test('PROBE_SCALES MUST name a scale present in SCALES WHEN every probe in PROBES is read', () => {
  for (const p of PROBES) {
    const scale = g.PROBE_SCALES[p.id];
    assert.ok(scale, `${p.id} names a scale, or its row shows a number no colour contradicts`);
    assert.ok(g.SCALES[scale], `${p.id} reads ${scale}, which must exist`);
  }
});

s.test('probeReading MUST return the probe value, unit and grade WHEN the probe measured', () => {
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

s.test('probeReading MUST return a null grade WHEN the probe is absent, resting or missing from the round', () => {
  // An absent IPv4 path, a rested probe and a missing probe produce no measurement and no link
  // failure.
  assert.deepEqual(pick(g.probeReading('ip4', round())), {state: 'absent', grade: null});
  assert.deepEqual(pick(g.probeReading('dns_ctl', round({dns_ctl: bad({fail: 'resting'})}))),
                   {state: 'resting', grade: null});
  assert.deepEqual(pick(g.probeReading('udp', round({udp: undefined}))),
                   {state: 'none', grade: null});

  const failing = g.probeReading('dns_ctl', round({dns_ctl: bad()}));
  assert.deepEqual(pick(failing), {state: 'failed', grade: 'red'});
  assert.equal(failing.note, 'timeout', 'the row carries the failure reason');
});

s.test('probeReading MUST return state refused with a null grade WHEN the server refused the download', () => {
  // The probe row and the streaming grade treat a server refusal alike.
  const refused = round({down: {ok: false, fail: 'network', refused_by: 'server'}});
  assert.deepEqual(pick(g.probeReading('down', refused)), {state: 'refused', grade: null});
  assert.notEqual(g.gradeActivities(refused).streaming, 'red');
});

s.test('probeReading MUST return grade red with a null value WHEN the DNS answer carries retry_suspected', () => {
  // The first query was lost: packet loss, red regardless of the time.
  const lost = round({dns: ok(80, {retry_suspected: true}), dns_ctl: ok(60)});
  const r = g.probeReading('dns', lost);
  assert.equal(r.grade, 'red');
  assert.equal(r.value, null, 'there is no number that would explain the colour');
  assert.equal(r.note, 'lost');
});

s.test('activityReading MUST read the round trip from the family that answered WHEN one address family is absent', () => {
  // A single-family network is a working network; a route graded on IPv6 alone reports "no route"
  // on an IPv4-only network.
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

s.test('activityReading MUST return the no-route note only WHEN every family failed and no probe reached the network', () => {
  // Every other probe fails too, so the round has no traffic to credit a literal with.
  const dead = {dns: bad(), dns_ctl: bad(), down: bad()};
  const route = over => g.activityReading('voice', round({...dead, ...over}));

  assert.equal(route({ip6: bad(), ip4: bad()}).note, 'no route');
  // An absent family produces no result, so the other family's failure sets the grade.
  assert.equal(route({ip6: bad(), ip4: bad({expected: true})}).note, 'no route');
  assert.equal(route({ip6: bad({expected: true}), ip4: bad()}).note, 'no route');

  // One family carrying traffic is a route, however the other fared.
  assert.notEqual(route({ip6: bad(), ip4: ok(25)}).note, 'no route');

  // And neither literal answering is not "no route" while the rest of the round gets out:
  // one operator failed both every round while DNS and the download answered.
  const blocked = g.activityReading('voice', round({ip6: bad(), ip4: bad()}));
  assert.notEqual(blocked.note, 'no route',
                  'a blocked literal is not the same as a dead link');
  // Two rested probes produce no results, so the route has no failure.
  assert.notEqual(route({ip6: bad({fail: 'resting'}), ip4: bad({fail: 'resting'})}).note,
                  'no route');
});

s.test('throughput MUST return the round bps or null WHEN the download succeeded or opened no window', () => {
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

s.test('activeRoute MUST return the family carrying traffic WHEN the two literals report different failures', () => {
  // A fibre link with IPv6 addressing and no route to the IPv6 literal carries all traffic over
  // IPv4; the route row shows the family carrying traffic.
  const ok = ms => ({ok: true, ms});
  const bad = over => ({ok: false, ms: null, fail: 'network', ...over});

  assert.equal(g.activeRoute({ip6: ok(30), ip4: ok(25)}), 'ip6', 'a browser prefers IPv6');
  assert.equal(g.activeRoute({ip6: bad(), ip4: ok(25)}), 'ip4');

  // Its literal is refused but the family carries traffic, which beats a family that fails.
  const blocked = {ip6: bad(), ip4: bad({blocked: true})};
  assert.equal(g.activeRoute(blocked), 'ip4');
  assert.equal(g.probeReading('ip4', {probes: blocked}).grade, null,
               'and a blocked literal takes no colour, because the path is fine');

  // An absent family ranks last.
  assert.equal(g.activeRoute({ip6: bad({expected: true}), ip4: bad({blocked: true})}), 'ip4');

  // Without traffic on either family the route is red.
  const dead = {ip6: bad(), ip4: bad()};
  assert.equal(g.activeRoute(dead), 'ip6');
  assert.equal(g.probeReading('ip6', {probes: dead}).grade, 'red');
});

s.test('gradeActivities MUST move only the voice grade, to red, WHEN the literal flags are stripped from a round that reached the network', () => {
  // The flags describe the literal on the screen and in the file. Reading and watching wait on
  // other probes, so the flags move neither. A stripped flag turns a refused literal into a failed
  // round trip, which is red for a call.
  const ok = ms => ({ok: true, ms});
  const bad = o => ({ok: false, ms: null, fail: 'network', ...o});
  const base = {dns: ok(180), dns_ctl: ok(30), udp: ok(20), down: {ok: true, bps: 25e6}};

  for (const over of [{ip6: bad(), ip4: bad()},
                      {ip6: bad({unused: true}), ip4: bad({blocked: true})},
                      {ip6: bad({blocked: true}), ip4: bad({unused: true})},
                      {ip6: bad({expected: true}), ip4: bad()}]) {
    const probes = {...base, ...over};
    const stripped = {...probes, ip6: {...probes.ip6}, ip4: {...probes.ip4}};
    for (const id of ['ip6', 'ip4']) {
      delete stripped[id].unused; delete stripped[id].blocked; delete stripped[id].expected;
    }
    const flagged = g.gradeActivities({probes});
    const plain = g.gradeActivities({probes: stripped});
    assert.deepEqual([flagged.news, flagged.streaming], [plain.news, plain.streaming],
                     `the flags moved reading or watching: ${JSON.stringify(over)}`);
    assert.equal(plain.voice, 'red', `a failed round trip is red for a call: ${JSON.stringify(over)}`);
  }
  const refused = {...base, ip6: bad({unused: true}), ip4: bad({blocked: true})};
  assert.equal(g.gradeActivities({probes: refused}).voice, null,
               'a refused literal leaves the call without a round-trip instrument');
});

s.test('activityReading MUST return red with note round trip lost WHEN neither literal answered and one counts as a failure', () => {
  // Rijswijk tunnel: the IPv6 literal hung for 8 s while the lookups, STUN and a later download
  // answered.
  const tunnel = round({ip6: bad(), ip4: bad({fail: 'network', unused: true})});
  const r = g.activityReading('voice', tunnel);
  assert.deepEqual([r.grade, r.note], ['red', 'round trip lost']);
  assert.equal(g.gradeActivities(tunnel).streaming, 'green', 'the download measured after the stall');
});

s.test('activityReading MUST return red with note link down for voice, news and streaming WHEN the stall check lost the other host and UDP', () => {
  const lostCheck = {same_host: {ok: false, ms: 6000, fail: 'timeout'},
                     other_host: {ok: false, ms: 6000, fail: 'timeout'},
                     udp: {ok: false, ms: null, fail: 'timeout'}};
  // Round 116 of the 10 Sep session: every idle probe answered, then the link carried nothing.
  const outage = round({down: {ok: false, fail: 'connect', bps: null, stall_check: lostCheck}});
  for (const activity of g.ACTIVITY_IDS) {
    const r = g.activityReading(activity, outage);
    assert.deepEqual([r.grade, r.note], ['red', 'link down'], activity);
  }
});

s.test('gradeActivities MUST omit link down WHEN the stall check reached UDP or its UDP result is unsupported or abort', () => {
  const check = udp => ({same_host: {ok: false, ms: 6000, fail: 'timeout'},
                         other_host: {ok: false, ms: 6000, fail: 'timeout'}, udp});
  const withCheck = udp => round({down: {ok: false, fail: 'connect', bps: null, stall_check: check(udp)}});
  for (const udp of [{ok: true, ms: 48, fail: null},
                     {ok: false, ms: 0, fail: 'unsupported'},
                     {ok: false, ms: 0, fail: 'abort'}]) {
    const r = g.activityReading('voice', withCheck(udp));
    assert.equal(r.grade, 'green', `UDP ${udp.fail || 'answered'}: the call path held`);
    assert.notEqual(g.activityReading('streaming', withCheck(udp)).note, 'link down');
  }
});

s.test('probeReading MUST return one exclusive state per literal failure and grade only a plain failure red WHEN ip4 fails', () => {
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
s.test('gradeActivities MUST redden articles and streaming and grade calls on the round trip WHEN the download produced no rate', () => {
  const grades = down => {
    const r = g.gradeActivities(round({down}));
    return [r.voice, r.news, r.streaming];
  };

  // Download failure: news and streaming red; voice grades on the round trip and UDP, both ok.
  assert.deepEqual(grades({ok: false, fail: 'network', refused_by: 'connection', bps: null}),
                   ['green', 'red', 'red'], 'a connection that would not open is the link');
  assert.deepEqual(grades({ok: false, fail: 'stalled', bps: null}),
                   ['green', 'red', 'red'], 'a cell that stopped answering mid-window is the link');
  assert.deepEqual(grades({ok: false, fail: 'connect', bps: null}),
                   ['green', 'red', 'red'], 'a download that never opened is the link');
  assert.deepEqual(grades({ok: false, fail: 'timeout', bps: null}),
                   ['green', 'red', 'red']);

  // Server refusal, short span or rest: no link failure, so voice and news grade on their other
  // terms.
  for (const down of [{ok: false, fail: 'network', refused_by: 'server', bps: null},
                      {ok: false, fail: 'short', bps: null},
                      {ok: false, fail: 'resting', bps: null}]) {
    const [voice, news, streaming] = grades(down);
    assert.equal(voice, 'green', `calls grade on the round trip: ${down.fail}`);
    assert.equal(news, 'green', `an article grades on the lookup alone: ${down.fail}`);
    assert.equal(streaming, null, `streaming has nothing left to read: ${down.fail}`);
  }
});

s.test('gradeActivities MUST grade voice red WHEN the UDP path failed beside an unmeasured download', () => {
  // A dropped rate term leaves other red terms in place: a failed UDP path still grades voice red.
  const r = g.gradeActivities(round({down: {ok: false, fail: 'short', bps: null},
                                     udp: {ok: false, ms: null, fail: 'timeout'}}));
  assert.equal(r.voice, 'red', 'no UDP is still no call');
});

s.test('gradeActivities MUST grade voice red WHEN the download failed along with the round trip', () => {
  const r = g.gradeActivities(round({ip6: bad(), ip4: bad(), down: {ok: false, fail: 'stalled', bps: null}}));
  assert.equal(r.voice, 'red');
});

s.test('gradeValue MUST grade a rate against the 1080p, 720p and 480p sustained speeds divided by 0.7 WHEN reading the rate scale', () => {
  assert.equal(g.gradeValue('rate', 7.2e6), 'green', 'above 5 Mb/s ÷ 0.7');
  assert.equal(g.gradeValue('rate', 5.2e6), 'yellow', '1080p without headroom');
  assert.equal(g.gradeValue('rate', 3.6e6), 'yellow', 'above 2.5 Mb/s ÷ 0.7');
  assert.equal(g.gradeValue('rate', 3e6), 'orange');
  assert.equal(g.gradeValue('rate', 1.6e6), 'orange', 'above 1.1 Mb/s ÷ 0.7');
  assert.equal(g.gradeValue('rate', 1.5e6), 'red');
});

await s.run();
