// Boundary values and mobile-network behaviour. Each case is either an exact threshold,
// where an off-by-one changes a colour, or an event recorded on a train: a handover, a
// captive portal, a tunnel, a saturated cell, a carrier blocking UDP.
import assert from 'node:assert';
import {stubBrowser, fakeStore, bodyOf, netError, sleep, suite} from './helpers.mjs';

stubBrowser();
const probe = await import('../js/probe.js');
const g = await import('../js/grade.js');
const {createRecorder} = await import('../js/session.js');
const {summarise, countsAsFailure} = await import('../js/export.js');

const P = Object.fromEntries(probe.PROBES.map(p => [p.id, p]));
const PROBE_IDS = probe.PROBES.map(p => p.id);

const session = () => ({id: 's1', name: 't', operator: 'KPN', connection: 'cellular',
                        intervalMs: 80, started: Date.now(),
                        download: {budgetMs: 40, maxBytes: 20000},
                        ipv4_available: true, ipv4_check: null});

function stubStun({srflx = true, block = false} = {}) {
  globalThis.RTCPeerConnection = class {
    addTransceiver() {} async createOffer() { return {}; }
    async setLocalDescription() {
      if (block) return;                       // a carrier that drops STUN: nothing ever comes back
      setTimeout(() => srflx && this.onicecandidate?.({candidate: {type: 'srflx', address: '2a09::9'}}), 1);
      setTimeout(() => this.onicecandidate?.({candidate: null}), 3);
    }
    close() {}
  };
}

const trace = (ip = '2a09:bac5::9', colo = 'AMS') =>
  `fl=1\nip=${ip}\nts=1\ncolo=${colo}\nvisit_scheme=https\n`;

const okResponse = (body = trace()) => ({ok: true, status: 200, type: 'opaque',
                                         headers: {get: () => null}, body: bodyOf(1000),
                                         text: async () => body});

/* ---------------- exact thresholds ---------------- */

const t = suite('thresholds');

t.test('a value on an edge belongs to the worse side, and only just', () => {
  // Every edge is checked from both sides.
  for (const [cap, edges] of Object.entries(g.THRESHOLDS).map(([k, v]) => [k, v.edges])) {
    const low = g.THRESHOLDS[cap].dir === 'low';
    edges.forEach((edge, i) => {
      const better = low ? edge - 0.001 : edge + 0.001;
      const worse = low ? edge : edge;    // the edge itself is already the worse side
      assert.equal(g.gradeValue(cap, better), g.GRADES[i],
                   `${cap}: ${better} sits just inside ${g.GRADES[i]}`);
      assert.equal(g.gradeValue(cap, worse), g.GRADES[i + 1],
                   `${cap}: ${worse} is exactly the edge and grades one worse`);
    });
  }
});

t.test('nothing and nonsense are not grades', () => {
  for (const cap of g.CAPABILITIES) {
    for (const v of [null, undefined, NaN, Infinity, -Infinity, -1, '30']) {
      assert.equal(g.gradeValue(cap, v), null,
                   `${cap} must grade ${String(v)} as nothing rather than a colour`);
    }
  }
  // Zero is a valid reading in both directions: instant, and stopped.
  assert.equal(g.gradeValue('realtime', 0), 'green');
  assert.equal(g.gradeValue('video', 0), 'red');
});

t.test('a percentile of a short series is not the maximum', () => {
  assert.equal(g.quantile([], 0.5), null, 'nothing has no median');
  assert.equal(g.quantile([5], 0.9), 5);
  assert.deepEqual([g.quantile([1, 2], 0.5), g.quantile([1, 2], 0.9)], [1, 2]);
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(g.quantile(ten, 0.9), 9, 'nearest rank: p90 of ten samples is the ninth');
  assert.equal(g.quantile(ten, 0.5), 5);
  assert.equal(g.quantile(ten, 0), 1, 'and the ends stay inside the array');
  assert.equal(g.quantile(ten, 1), 10);
});


t.test('the accuracy class turns over at exactly 100 m', async () => {
  const rows = await withFixes([fix(51.9, 4.4, 100), fix(51.9001, 4.4, 100)]);
  assert.ok(rows.some(r => r.accuracy_class === 'gps'), '100 m is still a usable fix');
  const coarse = await withFixes([fix(51.9, 4.4, 101), fix(51.9001, 4.4, 101)]);
  assert.ok(coarse.every(r => r.accuracy_class == null || r.accuracy_class === 'coarse'),
            '101 m is a tower estimate');
  assert.ok(coarse.every(r => r.speed_derived == null), 'and nothing is derived from it');
});

await t.run();

/* ---------------- the download ---------------- */

const d = suite('download edges');

// A stream given as a list of chunks. `stall` never resolves, as a read from a saturated
// cell does not.
const stream = chunks => ({getReader() {
  let i = 0;
  return {
    async read() {
      const c = chunks[i++];
      if (!c) return {done: true};
      if (c.stall) return new Promise(() => {});
      await sleep(c.after || 0);
      if (c.error) throw netError();
      return {done: false, value: new Uint8Array(c.bytes)};
    },
    cancel: async () => {}
  };
}});

const download = async (chunks, opts = {}) => {
  globalThis.fetch = async () => ({ok: true, status: 200, body: stream(chunks),
                                   headers: {get: () => null}});
  return probe.runProbe(P.down, {timeoutMs: 8000, download: {budgetMs: 400, maxBytes: 1e6, ...opts}});
};

d.test('a body that never arrives is a stalled cell, not a broken connection', async () => {
  const r = await download([{stall: true}]);
  assert.equal(r.ok, false);
  assert.equal(r.fail, 'stalled', 'the headers came back and then nothing did');
  assert.equal(r.bytes, 0);
  assert.ok(r.duration_ms >= 350, `the budget bounded it rather than the 8 s deadline: ${r.duration_ms} ms`);
  assert.equal(countsAsFailure(r), true, 'and it counts against the connection');
});

d.test('a 200 with no body is not the radio', async () => {
  const r = await download([]);
  assert.equal(r.fail, 'empty', 'something answered for the endpoint with nothing to send');
  assert.equal(r.bytes, 0);
});

d.test('a stream cut mid-flight keeps what arrived', async () => {
  const r = await download([{after: 2, bytes: 200000}, {after: 2, error: true}]);
  assert.equal(r.ok, false);
  assert.equal(r.fail, 'network');
  assert.equal(r.bytes, 200000, 'the bytes that did arrive are still the measurement');
  assert.equal(r.truncated, true);
});

d.test('a sample too short to rate reports no rate at all, not a slow one', async () => {
  for (const [name, chunks] of [['one tiny chunk', [{after: 2, bytes: 10}]],
                                ['one buffered chunk', [{after: 2, bytes: 5e6}]],
                                ['a stall after one chunk', [{after: 2, bytes: 1000}, {stall: true}]]]) {
    const r = await download(chunks);
    assert.equal(r.insufficient_sample, true, `${name}: not enough to rate`);
    assert.equal(r.bps_steady, null, `${name}: and no steady rate is invented`);
    assert.equal(r.bps_peak, null, `${name}: nor a peak — 7.5 Gb/s from one buffered chunk is not a link`);
    assert.equal(g.gradeRound({probes: {down: r}}).video, r.ok ? null : 'red',
                 `${name}: a measurement that could not be taken is not a bad one`);
  }
});

d.test('whichever limit comes first stops the read, and says which', async () => {
  const byBytes = await download(Array.from({length: 200}, () => ({after: 2, bytes: 100000})),
                                 {budgetMs: 60000, maxBytes: 1e6});
  assert.equal(byBytes.aborted_reason, 'bytes');
  assert.ok(byBytes.bytes >= 1e6 && byBytes.bytes < 1.2e6, `stopped near the ceiling: ${byBytes.bytes}`);

  const byTime = await download(Array.from({length: 400}, () => ({after: 5, bytes: 20000})),
                                {budgetMs: 300, maxBytes: 50e6});
  assert.equal(byTime.aborted_reason, 'time');
  assert.ok(byTime.duration_ms < 600, `stopped near the budget: ${byTime.duration_ms} ms`);
  assert.equal(byTime.ok, true, 'a read stopped by its own budget is a measurement, not a failure');
});

d.test('the rate is measured across four orders of magnitude of link', async () => {
  // 20 ms chunks at the given rate. The ramp rule has to hold at both ends: on a fast link
  // the byte ceiling arrives before a fixed warmup, on a slow one 128 kB never arrives.
  for (const mbps of [200, 133, 50, 10, 1, 0.4]) {
    const per = Math.max(1, Math.round((mbps * 1e6 / 8) * 0.02));
    const r = await download(Array.from({length: 400}, () => ({after: 20, bytes: per})),
                             {budgetMs: 1000, maxBytes: 5e6});
    assert.equal(r.insufficient_sample, false,
                 `${mbps} Mb/s must produce a rate: warmup ${r.warmup_ms} of ${r.duration_ms} ms`);
    const err = Math.abs(r.bps_steady - mbps * 1e6) / (mbps * 1e6);
    assert.ok(err < 0.35, `${mbps} Mb/s measured as ${(r.bps_steady / 1e6).toFixed(1)}`);
    assert.ok(r.bps_peak >= r.bps_steady * 0.9,
              `${mbps} Mb/s: a peak below the sustained rate is arithmetic, not a link ` +
              `(${r.bps_peak} vs ${r.bps_steady})`);
  }
});

await d.run();

/* ---------------- mobile network events ---------------- */

const n = suite('network events');

async function record(fetchImpl, ms = 500, opts = {}) {
  if (!opts.stun?.keep) stubStun(opts.stun || {});
  globalThis.fetch = fetchImpl;
  const store = fakeStore();
  const notices = [];
  const rec = createRecorder({store, onNotice: x => x && notices.push(x)});
  await rec.start(session());
  if (opts.during) await opts.during(rec, store);
  else await sleep(ms);
  await rec.stop();
  return {rows: store.written.samples.filter(x => !x.skipped), events: store.written.events,
          notices, store};
}

n.test('a captive portal answering for Cloudflare is a failure, not a measurement', async () => {
  const {rows} = await record(async url => String(url).includes('speed.cloudflare')
    ? okResponse()
    : ({ok: true, status: 200, type: 'basic', headers: {get: () => null},
        text: async () => '<html><body>Sign in to WiFi in de trein</body></html>'}), 300);
  const traces = rows.map(x => x.probes.ip6).filter(Boolean);
  assert.ok(traces.length > 0);
  assert.ok(traces.every(x => x.ok === false && x.fail === 'parse'),
            'a plausible-looking body is not accepted for a trace');
  assert.ok(traces.every(x => x.parse_reason), 'and the row says what was wrong with it');
});

n.test('a rate limit is told apart from a radio failure', async () => {
  const {rows} = await record(async () => ({ok: false, status: 429, type: 'basic',
                                            headers: {get: () => null}, text: async () => ''}), 300);
  const ip6 = rows.map(x => x.probes.ip6).filter(Boolean);
  assert.ok(ip6.every(x => x.fail === 'http' && x.status === 429),
            'the status is kept so a busy endpoint is not read as an outage');
});

n.test('a carrier that drops UDP shows up on the real-time capability alone', async () => {
  const {rows} = await record(async () => okResponse(), 400, {stun: {block: true}});
  const settled = rows.filter(x => x.probes.udp);
  assert.ok(settled.length > 0);
  assert.ok(settled.every(x => x.probes.udp.ok === false), 'STUN never completes');
  assert.ok(settled.every(x => x.grades.realtime === 'red'), 'real-time is red');
  assert.ok(settled.some(x => x.grades.tap !== 'red'), 'while everything over TCP is fine');
});

n.test('a resolver answering on its retry timer is loss, not slowness', () => {
  for (const ms of [2000, 1750, 5000, 5250]) {
    assert.equal(probe.looksLikeRetry(ms), true, `${ms} ms sits on a retry timer`);
  }
  for (const ms of [200, 1500, 2400, 4000, 6000]) {
    assert.equal(probe.looksLikeRetry(ms), false, `${ms} ms does not`);
  }
  const row = {probes: {dns: {ok: true, ms: 2000, retry_suspected: true}}};
  assert.equal(g.gradeRound(row).newsite, 'red', 'and a lost first query is red however fast the retry');
});

n.test('a tunnel is a total outage and comes back whole', async () => {
  let down = false;
  // A tunnel takes the radio, so UDP goes with it: nothing answers.
  globalThis.RTCPeerConnection = class {
    addTransceiver() {} async createOffer() { return {}; }
    async setLocalDescription() {
      if (down) return;
      setTimeout(() => this.onicecandidate?.({candidate: {type: 'srflx', address: '2a09::9'}}), 1);
      setTimeout(() => this.onicecandidate?.({candidate: null}), 3);
    }
    close() {}
  };
  const {rows} = await record(async () => { if (down) throw netError(); return okResponse(); }, 0, {
    stun: {keep: true},
    // Long enough for several rounds: a STUN probe that never answers holds its own
    // deadline, so an outage produces fewer complete rounds than a healthy stretch.
    during: async () => { await sleep(200); down = true; await sleep(2500); down = false; await sleep(1500); }
  });
  const dead = rows.filter(x => PROBE_IDS.every(id => !x.probes[id]?.ok));
  assert.ok(dead.length >= 2, `the outage is in the data as rows, not as a gap: ${dead.length}`);
  assert.ok(dead.every(x => PROBE_IDS.every(id => x.probes[id]?.fail !== 'resting')),
            'and nothing is rested during it, so the failure stays visible');
  // Rows reach the store as their rounds finish, so a slow round can be written after a
  // later quick one. The sequence number carries the order.
  const inOrder = [...rows].sort((a, b) => a.seq - b.seq);
  assert.ok(inOrder.at(-1).probes.ip6?.ok, 'recovery needs no intervention');
  assert.equal(new Set(inOrder.map(x => x.seq)).size, inOrder.length, 'and no round is recorded twice');
});

n.test('an egress change under an unchanged label is said once', async () => {
  let ip = '2a09:bac5::9';
  const {events} = await record(async () => okResponse(trace(ip)), 0, {
    during: async () => { await sleep(250); ip = '77:77::77'; await sleep(400); }
  });
  const said = events.filter(e => /egress address changed/.test(e.text || ''));
  assert.equal(said.length, 1, `once, not every round afterwards: ${said.length}`);
});

n.test('a PoP change is in the data without being interpreted', async () => {
  let colo = 'AMS';
  const {rows} = await record(async () => okResponse(trace('2a09:bac5::9', colo)), 0, {
    during: async () => { await sleep(250); colo = 'FRA'; await sleep(300); }
  });
  const seen = new Set(rows.map(x => x.probes.ip6?.colo).filter(Boolean));
  assert.deepEqual([...seen].sort(), ['AMS', 'FRA'], 'both PoPs are on the rows');
  assert.ok(rows.every(x => x.grades), 'and a routing change is not graded as a fault');
});

n.test('a round that outlives its slot is written down, not skipped silently', async () => {
  const {rows, store} = await record(async () => { await sleep(200); return okResponse(); }, 600);
  const skipped = store.written.samples.filter(x => x.skipped === 'overlap');
  assert.ok(skipped.length > 0, 'a round that came due mid-flight leaves a row');
  assert.ok(skipped.every(x => x.late_ms != null), 'carrying how late it was');
  assert.ok(skipped.some(x => x.prev_round_ms > 0),
            'and how long the round it collided with took, once one has finished — without ' +
            'that, a stalling app cannot be told from a slow network');
  assert.ok(rows.every(x => x.grades), 'the rounds that did run are unaffected');
});

n.test('every failure reason a probe can produce is classified once, everywhere', () => {
  const network = ['timeout', 'network', 'http', 'parse', 'abort', 'stalled', 'empty', 'no_srflx'];
  const notNetwork = ['resting'];
  for (const fail of network) {
    assert.equal(countsAsFailure({ok: false, fail}), true, `${fail} is a failure`);
  }
  for (const fail of notNetwork) {
    assert.equal(countsAsFailure({ok: false, fail}), false, `${fail} is not`);
  }
  assert.equal(countsAsFailure({ok: false, fail: 'network', expected: true}), false,
               'a known-absent path is not an outage');
  assert.equal(countsAsFailure({ok: true}), false);
  assert.equal(countsAsFailure(undefined), false, 'a probe that produced no row at all');
  assert.equal(countsAsFailure({ok: false, fail: 'unsupported', expected: true}), false,
               'a browser without the API is a missing capability, not an outage');
});

// The UDP probe is the only one that is not a fetch, so each outcome is produced explicitly
// here. A carrier blocking STUN, a symmetric NAT and a browser without WebRTC are
// indistinguishable from the outside and are recorded differently.
n.test('every way the UDP path can fail is told apart', async () => {
  const stun = impl => { globalThis.RTCPeerConnection = impl; return probe.runProbe(P.udp, {timeoutMs: 300}); };
  const gathering = candidates => class {
    addTransceiver() {} async createOffer() { return {}; }
    async setLocalDescription() {
      candidates.forEach((c, i) => setTimeout(() => this.onicecandidate?.({candidate: c}), i + 1));
      setTimeout(() => this.onicecandidate?.({candidate: null}), candidates.length + 2);
    }
    close() { globalThis.__closed = (globalThis.__closed || 0) + 1; }
  };

  globalThis.__closed = 0;
  const absent = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = undefined;
  const none = await probe.runProbe(P.udp, {timeoutMs: 300});
  assert.deepEqual([none.fail, none.expected], ['unsupported', true],
                   'no WebRTC at all is flagged the way an absent IPv4 path is');
  globalThis.RTCPeerConnection = absent;

  const refused = await stun(class {
    addTransceiver() {} async createOffer() { throw new Error('no media'); }
    async setLocalDescription() {} close() {}
  });
  assert.equal(refused.fail, 'network');
  assert.equal(refused.parse_reason, 'no media', 'and why it refused is kept');

  const symmetric = await stun(gathering([{type: 'host', address: '192.168.1.5'}]));
  assert.deepEqual([symmetric.fail, symmetric.candidates], ['no_srflx', 1],
                   'candidates gathered but none reflexive: the packet never reached the server');
  assert.notEqual(symmetric.expected, true, 'which is a real failure of the UDP path');

  const blocked = await stun(class {
    addTransceiver() {} async createOffer() { return {}; }
    async setLocalDescription() {} close() { globalThis.__closed++; }
  });
  assert.equal(blocked.fail, 'timeout', 'a carrier dropping STUN never answers at all');

  const dual = await stun(gathering([{type: 'srflx', address: '2a09::9'},
                                     {type: 'srflx', address: '77.1.2.3'}]));
  assert.deepEqual(dual.public_ips, ['2a09::9', '77.1.2.3'],
                   'a dual-stack network maps one address per family and both are kept');
  assert.ok(globalThis.__closed > 0, 'and every peer connection is closed again');
});

await n.run();

/* ---------------- one recorder across several sessions ---------------- */

const l = suite('session lifecycle');

l.test('a second journey on the same recorder starts from nothing', async () => {
  stubStun();
  let wedged = true;
  globalThis.fetch = async url => {
    if (String(url).includes('gstatic') && wedged) throw netError();
    return okResponse();
  };
  const store = fakeStore();
  const rec = createRecorder({store});

  // First journey: long enough for the web probe to be marked stuck and rested.
  await rec.start(session());
  await sleep(700);
  await rec.stop();
  const first = store.written.samples.filter(x => !x.skipped);
  assert.ok(first.some(x => x.probes.web?.fail === 'resting'), 'the first journey rested it');

  // Second journey on a healthy network. One recorder lives for the page, so a rest
  // scheduled by round number in the first journey would silence the probe through the
  // second.
  wedged = false;
  store.written.samples.length = 0;
  await rec.start({...session(), id: 's2'});
  await sleep(400);
  await rec.stop();
  const second = store.written.samples.filter(x => !x.skipped);

  assert.ok(second.length > 0, 'the second journey recorded');
  assert.equal(second[0].seq, 0, 'and numbers its rounds from zero');
  assert.ok(second.every(x => x.probes.web?.fail !== 'resting'),
            'with nothing carried over from the last one');
  assert.ok(second.every(x => x.sessionId === 's2'), 'and every row belongs to it');
  assert.ok(second.every(x => x.in_pause === false), 'a pause from the last journey is not still on');
  assert.ok(second.every(x => x.speed_derived == null),
            'nor a position from a journey that ended somewhere else');
});

l.test('the first round is not reported as late', async () => {
  stubStun();
  globalThis.fetch = async () => { await sleep(30); return okResponse(); };
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session());
  await sleep(300);
  await rec.stop();
  const rows = [...store.written.samples].sort((a, b) => a.seq - b.seq);
  assert.equal(rows[0].late_ms, 0,
               `start-up cost is not scheduling lateness: ${rows[0].late_ms} ms`);
  assert.ok(rows.every(x => x.late_ms >= 0), 'and lateness is never negative');
  assert.equal(store.written.events.filter(e => e.type === 'pause').length, 0,
               'a slow radio at start does not log a pause that never happened');
});

l.test('a resumed journey continues its numbering and its bill', async () => {
  stubStun();
  globalThis.fetch = async () => okResponse();
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session(), {resumeSeq: 41, monoBase: 60000,
                              spent: {bytes: 1234, downloadBytes: 5e6}, resumedGapMs: 30000});
  await sleep(250);
  const st = rec.status();
  await rec.stop();
  const rows = [...store.written.samples].sort((a, b) => a.seq - b.seq);

  assert.equal(rows[0].seq, 41, 'the sequence carries on rather than restarting');
  assert.ok(rows[0].mono >= 60000, 'and so does the monotonic clock, bridged across the gap');
  assert.ok(st.bytes > 1234, 'the estimate continues from what was already spent');
  assert.ok(st.downloadMB >= 5, `and so does the figure on screen: ${st.downloadMB} MB`);
  assert.ok(store.written.events.some(e => e.type === 'pause' && /bridged across reload/.test(e.text)),
            'the gap the reload cost is written down, not left to be inferred');
});

l.test('stopping twice, or before starting, changes nothing', async () => {
  stubStun();
  globalThis.fetch = async () => okResponse();
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.stop();
  assert.equal(rec.status().running, false, 'stopping before starting is not an error');
  await rec.start(session());
  await sleep(200);
  await rec.stop();
  const after = store.written.samples.length;
  await rec.stop();
  assert.equal(store.written.samples.length, after, 'and stopping twice writes nothing twice');
  assert.equal(rec.status().running, false);
  rec.mark();
  assert.equal(store.written.events.filter(e => e.type === 'mark').length, 0,
               'a mark after the journey ended belongs to no journey');
});

l.test('a wall clock that jumps does not take the round order with it', async () => {
  stubStun();
  globalThis.fetch = async () => okResponse();
  const store = fakeStore();
  const rec = createRecorder({store});
  const realNow = Date.now;
  await rec.start(session());
  await sleep(200);
  // The radio reattaches and the OS corrects the wall clock back by a minute. Both clocks
  // are on every row, so the correction is visible in the data.
  Date.now = () => realNow() - 60000;
  await sleep(300);
  Date.now = realNow;
  await rec.stop();

  const rows = [...store.written.samples].sort((a, b) => a.seq - b.seq);
  assert.ok(rows.length > 3, `enough rounds either side of the jump: ${rows.length}`);
  const monos = rows.map(x => x.mono);
  assert.deepEqual(monos, [...monos].sort((a, b) => a - b),
                   'the monotonic clock never goes backwards, whatever the wall clock does');
  assert.ok(rows.some(x => x.t < rows[0].t), 'the jump itself is on the rows, not smoothed away');
  assert.ok(rows.every(x => x.late_ms < 1000),
            'and lateness is measured on the monotonic clock, so a jump is not a freeze');
  assert.equal(store.written.events.filter(e => e.type === 'pause').length, 0,
               'nor is it logged as one');
});

await l.run();

/* ---------------- the rollup on degenerate sessions ---------------- */

const e = suite('rollup edges');

e.test('a session with nothing in it summarises without inventing anything', () => {
  const s = summarise([]);
  assert.equal(s.ran, 0);
  assert.ok(Object.values(s.probes).every(p => p.ms_p50 == null),
            'no rounds means no percentiles, not zeros');
});

e.test('a session in which everything failed still describes itself', () => {
  const rows = Array.from({length: 5}, (_, seq) => ({
    seq, skipped: null, round_error: null,
    probes: Object.fromEntries(PROBE_IDS.map(id => [id, {ok: false, fail: 'timeout', ms: 8000}]))
  }));
  const s = summarise(rows);
  assert.equal(s.ran, 5);
  assert.equal(s.degraded, 5);
  assert.equal(s.probes.ip6.fails.timeout, 5);
  assert.equal(s.probes.ip6.ms_p50, null, 'a median of failures is not a latency');
  assert.equal(s.probes.down.bps_steady_p50, null);
});

e.test('a session of nothing but skipped rounds is not counted as measurement', () => {
  const rows = Array.from({length: 4}, (_, seq) => ({seq, skipped: 'overlap', probes: {}}));
  const s = summarise(rows);
  assert.equal(s.ran, 0);
  assert.equal(s.skipped, 4);
  assert.equal(s.degraded, 0, 'a round that never ran cannot have degraded');
});

await e.run();

/* ---------------- storage closing mid-session ---------------- */

const st = suite('storage edges');

// A minimal IndexedDB: enough for store.js to open a database, run a transaction and be told
// the connection has closed, which is what iOS does when a tab is backgrounded under storage
// pressure.
function fakeIndexedDB() {
  const state = {opens: 0, closed: false, puts: [], connections: []};
  const later = fn => setTimeout(fn, 0);
  const makeDb = () => {
    const db = {
      objectStoreNames: {contains: () => true},
      createObjectStore: () => ({createIndex() {}}),
      onclose: null, onversionchange: null,
      close() { this.closed = true; },
      closed: false,
      transaction() {
        if (db.closed) throw Object.assign(new Error('closed'), {name: 'InvalidStateError'});
        const t = {oncomplete: null, onerror: null, onabort: null,
                   objectStore: () => ({
                     put: row => state.puts.push(row),
                     get: () => { const req = {}; later(() => req.onsuccess?.()); return req; },
                     index: () => ({getAll: () => { const req = {result: []}; later(() => req.onsuccess?.()); return req; }})
                   })};
        later(() => t.oncomplete?.());
        return t;
      }
    };
    state.connections.push(db);
    return db;
  };
  return {
    state,
    open() {
      state.opens++;
      const req = {};
      later(() => { req.result = makeDb(); req.onsuccess?.(); });
      return req;
    }
  };
}

st.test('a connection the system closed is reopened rather than lost for the session', async () => {
  const idb = fakeIndexedDB();
  Object.defineProperty(globalThis, 'indexedDB', {value: idb, configurable: true});
  const store = await import(`../js/store.js?closed=${Date.now()}`);

  await store.putSamples([{sessionId: 'a', seq: 0}]);
  assert.equal(idb.state.opens, 1, 'one connection serves the session');
  assert.equal(idb.state.puts.length, 1);

  // Closed while the tab is in the background; the next write finds out by throwing.
  idb.state.connections.at(-1).closed = true;
  await store.putSamples([{sessionId: 'a', seq: 1}]);
  assert.equal(idb.state.opens, 2, 'the closed connection is replaced');
  assert.equal(idb.state.puts.length, 2, 'and the round that found it closed is still written');

  // The close event announces it before any write fails.
  idb.state.connections.at(-1).onclose?.();
  await store.putSamples([{sessionId: 'a', seq: 2}]);
  assert.equal(idb.state.opens, 3);
  assert.equal(idb.state.puts.length, 3, 'nothing is dropped either way');
});

st.test('a database that will not open reports it rather than hanging every later call', async () => {
  let failing = true;
  const idb = {
    open() {
      const req = {};
      setTimeout(() => {
        if (failing) { req.error = new Error('quota'); req.onerror?.(); }
        else {
          req.result = {objectStoreNames: {contains: () => true}, close() {},
                        transaction: () => { const t = {objectStore: () => ({put() {}})};
                                             setTimeout(() => t.oncomplete?.(), 0); return t; }};
          req.onsuccess?.();
        }
      }, 0);
      return req;
    }
  };
  Object.defineProperty(globalThis, 'indexedDB', {value: idb, configurable: true});
  const store = await import(`../js/store.js?refused=${Date.now()}`);

  await assert.rejects(() => store.putSamples([{sessionId: 'a', seq: 0}]), /quota/,
                       'the caller is told, so the rows stay in memory and are retried');
  // A rejected open is not cached, so the next attempt can succeed.
  failing = false;
  await assert.doesNotReject(() => store.putSamples([{sessionId: 'a', seq: 0}]),
                             'a later attempt opens a fresh connection');
});

await st.run();

/* ---------------- the exported file, with hostile input ---------------- */

const x = suite('export edges');

const {filename, sessionJson} = await import('../js/export.js');
const meta = over => ({id: 'a', name: 'x', operator: 'KPN', connection: 'cellular',
                       started: Date.parse('2026-09-03T06:14:00Z'), stopped: null,
                       intervalMs: 10000, ...over});

x.test('a name the operator typed cannot produce a name the file system will not take', () => {
  const cases = {
    ['x'.repeat(200)]: 'x'.repeat(40),
    'KPN': 'kpn',
    'KPN / Odido': 'kpn-odido',
    'Ödido — 5G': 'dido-5g',
    '../../etc/passwd': 'etc-passwd',
    'a\\b:c*d?e"f<g>h|i': 'a-b-c-d-e-f-g-h-i',
    '   ': 'session',
    '📶': 'session'
  };
  for (const [operator, expected] of Object.entries(cases)) {
    const name = filename(meta({operator}));
    assert.equal(name, `wts-20260903-0814-${expected}.json`, `operator ${JSON.stringify(operator)}`);
    assert.ok(!/[/\\:*?"<>|]/.test(name.slice(4)), `${name} has no path or wildcard characters`);
  }
  assert.match(filename(meta({operator: '', connection: 'wifi'})), /-wifi\.json$/,
               'on Wi-Fi there is no operator, so the connection names the file');
  assert.doesNotMatch(filename(meta({started: NaN})), /NaN/,
                      'an unreadable start time still produces a usable name');
});

x.test('the file survives every character a person can type into it', () => {
  const session = meta({name: 'quote " comma , newline \n tab \t backslash \\ unicode ⏱',
                        note: '</script><script>alert(1)</script>'});
  const events = [{sessionId: 'a', t: 1, mono: 1, type: 'note', lat: null, lon: null,
                   text: 'emoji 🚆 and a "quote"'},
                  {sessionId: 'a', t: 2, mono: 2, type: 'label', lat: null, lon: null, text: 'slow'}];
  const text = sessionJson(session, [], events);
  const back = JSON.parse(text);
  assert.equal(back.session.name, session.name, 'the name round-trips exactly');
  assert.equal(back.session.note, session.note, 'and so does anything that looks like markup');
  assert.equal(back.events[0].text, events[0].text);
  assert.equal(back.events.length, 2, 'and every event is in the file as recorded');
});

x.test('a session with no rounds exports a file rather than failing', () => {
  const back = JSON.parse(sessionJson(meta(), [], []));
  assert.equal(back.format, 'wts/session');
  assert.equal(back.summary.ran, 0);
  assert.deepEqual(back.samples, []);
  assert.ok(back.probes.length > 0, 'the probe configuration is there even with nothing measured');
  assert.ok(back.app_version, 'and the version that would have measured it');
});

await x.run();

/* ---------------- the readout ---------------- */

const h = suite('tile edges');

h.test('a tile shows the grade of the round whose number it shows', () => {
  // Colour and number both come from the same round. Smoothing the colour over three rounds
  // while printing the current number paints a round measured at 35.5 Mb/s red because a
  // round three back was slow.
  const rows = [3.4e6, 3.2e6, 33.6e6, 1.1e6, 35.5e6, 12.0e6, 9.2e6, 48.5e6].map((bps, seq) => ({
    seq, skipped: null, probes: {down: {ok: true, bps_steady: bps}}
  }));
  for (const row of rows) {
    const grades = g.gradeRound(row);
    assert.equal(grades.video, g.gradeValue('video', g.capabilityValue('video', row)),
                 `${(row.probes.down.bps_steady / 1e6).toFixed(1)} Mb/s: the colour is this ` +
                 `round's, taken from the number the tile shows`);
  }
  assert.equal(g.gradeRound(rows[4]).video, 'green', '35.5 Mb/s is green, whatever came before it');
  assert.equal(g.gradeRound(rows[3]).video, 'red', 'and 1.1 Mb/s is red, whatever came after');
});

h.test('the strip and the tiles cannot disagree', async () => {
  const ui = await import('../js/ui.js');
  // The strip takes the worst grade in the round and every tile takes its own, so the worst
  // tile and the strip bar carry the same colour.
  const rows = [
    {probes: {ip6: {ok: true, ms: 30}, web: {ok: true, ms: 30}, dns: {ok: true, ms: 30},
              down: {ok: true, bps_steady: 50e6}}},
    {probes: {ip6: {ok: true, ms: 30}, web: {ok: true, ms: 30}, dns: {ok: true, ms: 2500},
              down: {ok: true, bps_steady: 50e6}}},
    {probes: {ip6: {ok: false, fail: 'timeout'}, web: {ok: true, ms: 30}, dns: {ok: true, ms: 30},
              down: {ok: true, bps_steady: 50e6}}}
  ];
  for (const row of rows) {
    const grades = g.gradeRound(row);
    let worst = null;
    for (const cap of g.CAPABILITIES) worst = g.worse(worst, grades[cap]);
    assert.equal(ui.classify(row), worst,
                 `the bar is the worst tile: ${JSON.stringify(grades)}`);
  }
});

h.test('a round that never ran colours nothing', () => {
  assert.equal(g.gradeRound({skipped: 'overlap', probes: {}}), null);
  const empty = g.gradeRound({probes: {}});
  assert.ok(g.CAPABILITIES.every(c => empty[c] === null),
            'and a round with no probe results grades nothing rather than green');
});

await h.run();

/* ---------------- helpers that need geolocation ---------------- */

function fix(lat, lon, accuracy, t = Date.now(), speed = null) {
  return {coords: {latitude: lat, longitude: lon, accuracy, speed, heading: null}, timestamp: t};
}

async function withFixes(fixes) {
  let watcher;
  const nav = {userAgent: 'node-test', language: 'en',
               geolocation: {watchPosition: cb => { watcher = cb; return 1; }, clearWatch() {}}};
  Object.defineProperty(globalThis, 'navigator', {value: nav, configurable: true});
  stubStun();
  globalThis.fetch = async () => okResponse();
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session());
  for (const f of fixes) { watcher(f); await sleep(150); }
  await rec.stop();
  stubBrowser();
  return store.written.samples.filter(x => !x.skipped);
}
