// Functional tests for the measurement modules, with no browser and no network.
import assert from 'node:assert';
import {stubBrowser, fakeStore, TRACE, bodyOf, netError, sleep, suite} from './helpers.mjs';

stubBrowser();
const probe = await import('../js/probe.js');
const {createRecorder, projectedBytes, environment, PROFILES} = await import('../js/session.js');
const ui = await import('../js/ui.js');
const {sessionJson, filename} = await import('../js/export.js');

const P = Object.fromEntries(probe.PROBES.map(p => [p.id, p]));
const s = suite('probes');

s.test('a trace probe reports egress and PoP', async () => {
  globalThis.fetch = async () => ({ok: true, status: 200, text: async () => TRACE});
  for (const id of ['ip6', 'ip4']) {
    const r = await probe.runProbe(P[id]);
    assert.deepEqual([r.ok, r.status, r.colo, r.egress_ip], [true, 200, 'AMS', '2a09:bac5::9'], id);
  }
});

s.test('failures carry a reason and a time-to-fail, never a bare false', async () => {
  globalThis.fetch = async () => { throw netError(); };
  const r = await probe.runProbe(P.ip6);
  assert.deepEqual([r.ok, r.fail], [false, 'network']);
  assert.ok(r.ms >= 0, 'how long it took to fail is kept');
});

s.test('a rate limit is not a radio failure', async () => {
  globalThis.fetch = async () => ({ok: false, status: 429, text: async () => ''});
  const r = await probe.runProbe(P.ip6);
  assert.deepEqual([r.ok, r.fail, r.status], [false, 'http', 429]);
});

s.test('an intercepted body is a failure, not an opaque success', async () => {
  globalThis.fetch = async () => ({ok: true, status: 200, text: async () => '<html>Sign in</html>'});
  const r = await probe.runProbe(P.ip6);
  assert.deepEqual([r.ok, r.fail], [false, 'parse']);
});

s.test('our deadline is distinguishable from a caller stopping the session', async () => {
  const hang = (url, o) => new Promise((_, rej) =>
    o.signal?.addEventListener('abort', () => rej(Object.assign(new Error('x'), {name: 'AbortError'})), {once: true}));
  globalThis.fetch = hang;
  assert.equal((await probe.runProbe(P.ip6, {timeoutMs: 80})).fail, 'timeout');
  const ctl = new AbortController();
  const pending = probe.runProbe(P.ip6, {timeoutMs: 5000, signal: ctl.signal});
  setTimeout(() => ctl.abort(), 40);
  assert.equal((await pending).fail, 'abort');
});

s.test('the DNS probe never reuses a hostname; its control never changes one', async () => {
  const seen = {dns: [], dns_ctl: []};
  let method;
  globalThis.fetch = async (url, o) => {
    const h = new URL(url).hostname;
    (h.startsWith('wts-') ? seen.dns_ctl : seen.dns).push(h);
    method = o.method;
    return {type: 'opaque', ok: false, status: 0};
  };
  for (let i = 0; i < 5; i++) { await probe.runProbe(P.dns); await probe.runProbe(P.dns_ctl); }
  assert.equal(new Set(seen.dns).size, 5, 'a name the resolver cannot have cached, every round');
  assert.equal(new Set(seen.dns_ctl).size, 1, 'the control holds its name so it stays cached');
  assert.ok(seen.dns.every(h => /^[0-9a-f]{16}\.github\.io$/.test(h)), seen.dns[0]);
  assert.ok(seen.dns_ctl[0].endsWith('.github.io'), 'both sit on the same destination');
  assert.equal(method, 'HEAD', 'HEAD keeps the 9 kB 404 body off the wire');
});

s.test('no probe may outlive its own round', async () => {
  for (const interval of [2000, 5000, 15000, 30000]) {
    for (const p of probe.PROBES) {
      const t = probe.timeoutFor(p, interval);
      assert.ok(t < interval, `${p.id} at ${interval}ms must give up first, got ${t}ms`);
      assert.ok(t >= 1000, `${p.id} still gets a fair attempt, got ${t}ms`);
    }
  }
  assert.equal(probe.timeoutFor(P.down, 30000), 8000, 'a long interval is not a licence to hang');
  assert.equal(probe.timeoutFor(P.ip6, 2000), 1500, 'a short interval squeezes the small probes too');
});

s.test('an absent IPv4 path is settled once and flagged, not rediscovered', async () => {
  globalThis.fetch = async () => { throw netError(); };
  const v4 = await probe.checkIpv4();
  assert.deepEqual([v4.available, v4.fail], [false, 'network']);
  assert.equal((await probe.runRound({ipv4Available: false})).ip4.expected, true);
  assert.equal((await probe.runRound({ipv4Available: false})).ip6.expected, undefined, 'only ip4 is exempt');
  assert.equal((await probe.runRound({ipv4Available: true})).ip4.expected, undefined,
               'where IPv4 exists, a failure is a real failure');
});

s.test('a repeated probe reports the median and keeps every sample', async () => {
  const times = [10, 90, 20];
  let i = 0;
  globalThis.fetch = async () => {
    const wait = times[i++ % times.length];
    await new Promise(r => setTimeout(r, wait));
    return {ok: true, status: 200, text: async () => TRACE};
  };
  const r = await probe.runProbe(P.ip6, {timeoutMs: 3000});
  assert.equal(r.samples_ok, 3, 'all three samples fitted the budget');
  assert.equal(r.ms_samples.length, 3, 'and every one is kept');
  const sorted = [...r.ms_samples].sort((a, b) => a - b);
  assert.equal(r.ms, sorted[1], `ms is the median, not the last: ${r.ms} of ${r.ms_samples}`);
  assert.ok(r.ms < sorted[2], 'so one slow sample cannot drag the round');
});

s.test('repetition stops at the first failure rather than spending the round on it', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw netError(); };
  const r = await probe.runProbe(P.ip6, {timeoutMs: 3000});
  assert.equal(calls, 1, 'a failed probe is not retried within its own round');
  assert.equal(r.ok, false);
  assert.equal(r.samples_ok, 0);
});

s.test('sampling never overruns the probe deadline', async () => {
  globalThis.fetch = async (url, o) => {
    await new Promise((res, rej) => {
      const t = setTimeout(res, 5000);
      o.signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('x'), {name: 'AbortError'})); }, {once: true});
    });
    return {ok: true, status: 200, text: async () => TRACE};
  };
  const t0 = Date.now();
  const r = await probe.runProbe(P.ip6, {timeoutMs: 600});
  const spent = Date.now() - t0;
  assert.ok(spent < 1200, `the whole sampled probe stayed inside its budget: ${spent} ms`);
  assert.equal(r.fail, 'timeout');
});

s.test('a trace body must describe the request that was actually made', async () => {
  const body = extra => `fl=1\nip=2a09:bac5::9\nts=1\ncolo=AMS\nvisit_scheme=https\n${extra}`;
  const check = async (text, expected) => {
    globalThis.fetch = async () => ({ok: true, status: 200, text: async () => text});
    const r = await probe.runProbe(P.ip4, {timeoutMs: 500});
    if (expected === null) return assert.equal(r.ok, true, `should have passed: ${text}`);
    assert.equal(r.fail, 'parse', `should have been rejected: ${text}`);
    assert.match(r.parse_reason, expected);
  };
  await check(body('h=1.1.1.1\n'), null);
  await check('fl=1\ncolo=AMS\n', /missing fields/);
  await check('ip=not-an-address\ncolo=AMS\n', /not an address/);
  await check('ip=1.2.3.4\ncolo=amsterdam\n', /not a PoP code/);
  await check(body('') + 'visit_scheme=http\n', /downgraded/);
  await check(body('h=proxy.example.net\n'), /host rewritten/);
});

s.test('the UDP probe gathers candidates and can send nothing', async () => {
  const opened = [];
  globalThis.RTCPeerConnection = class {
    constructor(cfg) { this.cfg = cfg; opened.push(this); this.closed = false; }
    addTransceiver(kind, opts) { this.transceiver = {kind, ...opts}; }
    async createOffer() { return {type: 'offer', sdp: 'v=0'}; }
    async setLocalDescription() {
      // Two families, as a dual-stack network reports, then completion.
      setTimeout(() => this.onicecandidate({candidate: {type: 'host', address: '10.0.0.1'}}), 1);
      setTimeout(() => this.onicecandidate({candidate: {type: 'srflx', address: '80.60.65.96'}}), 5);
      setTimeout(() => this.onicecandidate({candidate: {type: 'srflx', address: '2a09:bac5::9'}}), 8);
      setTimeout(() => this.onicecandidate({candidate: null}), 12);
    }
    close() { this.closed = true; }
  };
  const r = await probe.runProbe(P.udp, {timeoutMs: 1000});
  assert.equal(r.ok, true);
  assert.deepEqual(r.public_ips, ['80.60.65.96', '2a09:bac5::9'], 'one mapping per address family');
  assert.equal(r.candidates, 3, 'every candidate is counted, host ones included');
  assert.ok(r.ms >= 0, 'timed to the first server-reflexive candidate');
  assert.equal(opened[0].transceiver.direction, 'recvonly', 'the transceiver can only receive');
  assert.ok(opened.every(pc => pc.closed), 'the connection is always closed again');
  delete globalThis.RTCPeerConnection;
});

s.test('a blocked UDP path fails rather than hanging the round', async () => {
  globalThis.RTCPeerConnection = class {
    addTransceiver() {}
    async createOffer() { return {}; }
    async setLocalDescription() { /* no candidate ever arrives */ }
    close() { this.closed = true; }
  };
  const t0 = Date.now();
  const r = await probe.runProbe(P.udp, {timeoutMs: 300});
  assert.equal(r.ok, false);
  assert.equal(r.fail, 'timeout');
  assert.ok(Date.now() - t0 < 900, 'and gives up on time');
  delete globalThis.RTCPeerConnection;
});

s.test('a browser without WebRTC reports unsupported, not a network failure', async () => {
  const r = await probe.runProbe(P.udp, {timeoutMs: 300});
  assert.deepEqual([r.ok, r.fail], [false, 'unsupported']);
});

s.test('the download is streamed, counted, and reported as two labelled rates', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200, body: bodyOf(probe.DEFAULT_DOWNLOAD_BYTES),
    headers: {get: k => k === 'server-timing'
      ? 'cfL4;desc="?rtt=6212&min_rtt=6209&rtt_var=2336&lost=0&retrans=3&delivery_rate=648180&cwnd=53"'
      : ({'cf-meta-colo': 'AMS'})[k] ?? null}
  });
  globalThis.RTCPeerConnection = class {
    addTransceiver() {} async createOffer() { return {}; }
    async setLocalDescription() { setTimeout(() => this.onicecandidate({candidate: null}), 1); }
    close() {}
  };
  const round = await probe.runRound({});
  delete globalThis.RTCPeerConnection;
  const d = round.down;
  assert.equal(Object.keys(round).length, probe.PROBES.length, 'every probe runs every round');
  assert.equal(d.bytes, probe.DEFAULT_DOWNLOAD_BYTES);
  assert.equal(d.bps, undefined, 'no unlabelled rate survives');
  assert.ok('bps_transfer' in d && 'bps_end_to_end' in d);
  for (const k of ['bps_transfer', 'bps_end_to_end']) {
    assert.ok(d[k] === null || d[k] > 0, `${k} is a number or explicitly absent, never noise`);
  }
  assert.deepEqual([d.server.retrans, d.server.cwnd], [3, 53], "Cloudflare's own TCP view is kept");
});

s.test('a truncated download still reports what it pulled', async () => {
  globalThis.fetch = async () => ({ok: true, status: 200, headers: {get: () => null},
    body: {getReader: () => ({read: async () => { throw new Error('cut'); }})}});
  const r = await probe.runProbe(P.down, {timeoutMs: 50});
  assert.equal(r.truncated, true, 'truncation is recorded rather than discarded');
});

await s.run();

/* ---------------- the round loop ---------------- */

const l = suite('round loop');

function recorder(store, opts = {}) {
  const notices = [];
  const rec = createRecorder({store, onNotice: t => t && notices.push(t), ...opts});
  return {rec, notices};
}

const session = () => ({id: 's1', name: 't', operator: 'KPN', connection: 'cellular',
                        intervalMs: 100, downloadBytes: 25000, started: Date.now(),
                        ipv4_available: null, ipv4_check: null});

l.test('every scheduled round produces a row, healthy or not', async () => {
  let mode = 'ok';
  globalThis.fetch = (url, o) => new Promise((res, rej) => {
    const t = setTimeout(() => mode === 'fail' ? rej(netError())
      : res({ok: true, status: 200, type: 'opaque', headers: {get: () => null},
             body: bodyOf(25000), text: async () => TRACE}), 5);
    o.signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('a'), {name: 'AbortError'})); }, {once: true});
  });
  const store = fakeStore();
  const {rec} = recorder(store);
  const sess = session();
  await rec.start(sess);
  assert.equal(sess.ipv4_available, true, 'the preflight settled it and wrote the evidence');
  assert.ok(sess.ipv4_check.ms >= 0);

  await sleep(500);
  assert.ok(store.written.samples.length >= 4, 'rounds are landing');
  assert.ok(store.written.samples.every(x => x.probes.down), 'every round carries a download');
  assert.ok(store.written.samples.every(x => x.visible === true), 'tab visibility is per row');

  mode = 'fail';
  await sleep(150);
  const from = store.written.samples.length;
  await sleep(400);
  const failed = store.written.samples.slice(from);
  assert.ok(failed.length >= 2, 'failing rounds are still written');
  for (const x of failed) {
    assert.equal(x.probes.ip6.ok, false);
    assert.equal(x.probes.ip6.fail, 'network', 'the reason, not just the fact');
    assert.ok(x.probes.ip6.ms >= 0, 'the time it took to fail');
  }
  await rec.stop();
  const seqs = store.written.samples.map(x => x.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, seqs.map((_, i) => i), 'seq is contiguous; a gap would be a lost attempt');
});

l.test('a round that cannot start is written down, not passed over', async () => {
  globalThis.fetch = (url, o) => new Promise((res, rej) => {
    const t = setTimeout(() => res({ok: true, status: 200, type: 'opaque', headers: {get: () => null},
                                    body: bodyOf(25000), text: async () => TRACE}), 260);
    o.signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('a'), {name: 'AbortError'})); }, {once: true});
  });
  const store = fakeStore();
  const {rec} = recorder(store);
  await rec.start(session());
  await sleep(800);
  await rec.stop();
  const skipped = store.written.samples.filter(x => x.skipped === 'overlap');
  assert.ok(skipped.length > 0, 'overlapped rounds appear as rows');
  assert.ok(skipped.every(x => x.late_ms != null), 'with their lateness recorded');
});

l.test('a frozen tab is recorded as a pause, not read as an outage', async () => {
  globalThis.fetch = async () => ({ok: true, status: 200, type: 'opaque', headers: {get: () => null},
                                   body: bodyOf(25000), text: async () => TRACE});
  const store = fakeStore();
  const {rec} = recorder(store);
  await rec.start(session());
  await sleep(200);
  const until = Date.now() + 600;
  while (Date.now() < until) { /* block the event loop, exactly as a suspended tab does */ }
  await sleep(200);
  await rec.stop();
  const pauses = store.written.events.filter(e => e.type === 'pause');
  assert.ok(pauses.length > 0, 'the freeze is an event');
  assert.ok(parseFloat(pauses[0].text) >= 0.4, `with the bridged duration: ${pauses[0].text}`);
});

l.test('a failing store holds rows in memory and retries rather than dropping them', async () => {
  globalThis.fetch = async () => ({ok: true, status: 200, type: 'opaque', headers: {get: () => null},
                                   body: bodyOf(25000), text: async () => TRACE});
  const store = fakeStore();
  const {rec, notices} = recorder(store);
  await rec.start(session());
  await sleep(200);
  const held = store.written.samples.length;
  store.failNext(3);
  await sleep(500);
  await rec.stop();
  assert.ok(notices.some(n => n.includes('Storage write failed')), 'the failure reaches the screen');
  assert.ok(store.written.samples.length > held, 'and the held rows land on retry');
});

l.test('both profiles run the download every round, differing only in interval', () => {
  assert.equal(PROFILES.fine.intervalMs, 15000);
  assert.equal(PROFILES.coarse.intervalMs, 30000);
  assert.equal(PROFILES.fine.downloadBytes, PROFILES.coarse.downloadBytes,
               'the payload is the same; only how often it is fetched differs');
  assert.ok(projectedBytes(PROFILES.fine.intervalMs, PROFILES.fine.downloadBytes) >
            projectedBytes(PROFILES.coarse.intervalMs, PROFILES.coarse.downloadBytes) * 1.9,
            'and the finer profile costs about twice as much');
});

l.test('the projection tracks interval and payload, and counts one download per round', () => {
  const rounds = (40 * 60000) / 5000;
  const p = projectedBytes(5000, 250000);
  assert.ok(p > rounds * 250000 && p < rounds * 250000 * 1.1, `${(p / 1048576) | 0} MB at 5s/250kB`);
  assert.ok(projectedBytes(5000, 500000) > projectedBytes(5000, 100000));
  assert.ok(projectedBytes(2000, 250000) > projectedBytes(30000, 250000));
});

l.test('the environment block makes a session self-describing', () => {
  const env = environment(10000, 250000);
  assert.equal(env.download_bytes, 250000);
  assert.equal(env.probes.length, probe.PROBES.length);
  assert.ok(Object.values(env.timeouts_ms).every(t => t < 10000), 'every deadline fits inside a round');
  assert.ok(env.timeouts_ms.ip6 >= 8000, 'and slow-but-working rounds are not cut off');
  assert.ok(env.app_version && env.timezone);
});

await l.run();

/* ---------------- classification and export ---------------- */

const c = suite('classification');
const OK = (extra = {}) => ({ok: true, ms: 20, fail: null, ...extra});
const BAD = (extra = {}) => ({ok: false, ms: 20, fail: 'network', ...extra});
const healthy = () => ({ip6: OK(), ip4: BAD({expected: true}), dns: OK(), dns_ctl: OK(),
                        web: OK(), down: OK(), udp: OK()});

c.test('an expected failure colours nothing and counts as nothing', () => {
  assert.equal(ui.counts(BAD({expected: true})), false);
  assert.equal(ui.counts(undefined), false, 'a probe with no record is not a failure');
  assert.equal(ui.counts({}), false);
  assert.equal(ui.counts(BAD()), true);
  assert.equal(ui.classify({probes: healthy()}), 'up', 'a missing IPv4 path is not a degraded round');
});

c.test('each failure shape maps to its own reading', () => {
  assert.equal(ui.classify({probes: {...healthy(), dns: BAD()}}), 'dns', 'resolution while the link holds');
  assert.equal(ui.classify({probes: {...healthy(), ip6: BAD(), web: BAD()}}), 'down', 'the radio link');
  assert.equal(ui.classify({probes: {...healthy(), web: BAD()}}), 'part');
  assert.equal(ui.classify({probes: {...healthy(), down: BAD()}}), 'part');
  assert.equal(ui.classify({probes: healthy(), skipped: 'overlap'}), 'skip');
});

c.test('the worst recent value is the slow end for a rate and the high end for a latency', () => {
  ui.resetHistory();
  const t = Date.now();
  // Latencies climbing, throughput falling: the tile should surface the bad end of each.
  const lat = [10, 12, 14, 16, 18, 20, 22, 900];
  const bps = [50e6, 40e6, 30e6, 20e6, 10e6, 5e6, 2e6, 1e6];
  lat.forEach((ms, i) => ui.trackLatency({
    t: t + i * 1000, skipped: null,
    probes: {ip6: {ok: true, ms}, dns: {ok: true, ms}, web: {ok: true, ms},
             down: {ok: true, ms, bps_transfer: bps[i]}}
  }));
  const l = ui.worst('ip6');
  assert.equal(l.label, 'p90');
  assert.ok(l.value >= 22, `a latency spike shows: ${l.value} ms`);

  const d = ui.worst('down');
  assert.equal(d.label, 'p10', 'a rate is judged from its low end');
  assert.ok(d.value <= 2e6, `the slowest throughput shows: ${d.value} bps`);
  assert.ok(d.value > 1000, 'and it is a rate, not a millisecond figure rendered as one');

  ui.resetHistory();
  assert.equal(ui.worst('ip6'), null, 'and a new session starts empty');
});

c.test('too few samples are labelled for what they are', () => {
  ui.resetHistory();
  const t = Date.now();
  assert.equal(ui.worst('ip6'), null, 'nothing is claimed from no samples');
  for (let i = 0; i < 3; i++) {
    ui.trackLatency({t: t + i * 1000, skipped: null, probes: {ip6: {ok: true, ms: 10 + i}}});
  }
  assert.equal(ui.worst('ip6').label, 'max', 'three samples are a maximum, not a percentile');
  for (let i = 3; i < 9; i++) {
    ui.trackLatency({t: t + i * 1000, skipped: null, probes: {ip6: {ok: true, ms: 10 + i}}});
  }
  assert.equal(ui.worst('ip6').label, 'p90', 'and enough of them earn the word');
  ui.resetHistory();
});

await c.run();

const e = suite('export');

e.test('the file is lossless and self-describing', () => {
  const sess = {id: 'a', name: 'KPN · 3 Sep 08:14', operator: 'KPN', connection: 'cellular',
                note: 'quote " comma , newline\n', started: Date.parse('2026-09-03T06:14:00Z'),
                stopped: null, intervalMs: 10000, downloadBytes: 250000, ipv4_available: false,
                ipv4_check: {available: false, ms: 5, fail: 'network'}, exportedAt: null,
                environment: {app_version: '1.0.0'}};
  const samples = [{sessionId: 'a', seq: 0, t: sess.started, mono: 0, late_ms: 0, skipped: null,
                    round_error: null, visible: true, lat: 51.9, lon: 4.4, accuracy: 12, speed: 38,
                    heading: 71, pos_t: sess.started - 1200, pos_error: null, intervalMs: 10000,
                    probes: healthy()}];
  const events = [{sessionId: 'a', t: sess.started + 60, mono: 60, type: 'mark', lat: 51.9, lon: 4.4, text: 'stalled'}];
  const out = JSON.parse(sessionJson(sess, samples, events));
  assert.equal(out.format, 'wts/session');
  assert.deepEqual(out.session, sess, 'the session round-trips whole');
  assert.deepEqual(out.samples, samples, 'every nested probe field survives');
  assert.deepEqual(out.events, events);
  assert.equal(out.probes.length, probe.PROBES.length, 'the probe set travels with the data');
});

e.test('a hostile session name cannot corrupt the file or the filename', () => {
  const sess = {id: 'a', name: 'x", y\n\\', operator: 'K,P"N', started: Date.parse('2026-09-03T06:14:00Z')};
  const f = filename(sess);
  assert.ok(!/["',\n\\]/.test(f), `filename is sanitised: ${f}`);
  assert.match(f, /^wts-20260903-\d{4}-k-p-n\.json$/, f);
  assert.deepEqual(JSON.parse(sessionJson(sess, [], [])).session.name, 'x", y\n\\');
});

await e.run();
