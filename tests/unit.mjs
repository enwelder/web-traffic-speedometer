// Functional tests for the measurement modules, with no browser and no network.
import assert from 'node:assert';
import {stubBrowser, fakeStore, TRACE, bodyOf, netError, sleep, suite} from './helpers.mjs';

stubBrowser();
const probe = await import('../js/probe.js');
const {createRecorder, projectedBytes, environment, PROFILES} = await import('../js/session.js');
const ui = await import('../js/ui.js');
const {sessionJson, filename, summarise} = await import('../js/export.js');

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

s.test('a literal is judged on the round it ran in, and nothing else', async () => {
  // Inferring that a family is absent from its silence needed a session-long verdict, and the
  // verdict was wrong on a network with no route to the IPv6 literal, wrong again across a
  // handover, and wrong when both literals were blocked at once. Every case below is decided
  // by what carried traffic in that one round.
  const trace = ip => ({ok: true, status: 200, type: 'opaque', body: bodyOf(2000),
                        headers: {get: h => (h === 'cf-meta-ip' ? ip : null)},
                        text: async () => TRACE});
  const round = async answer => {
    globalThis.fetch = async (url, o) => {
      const r = answer(String(url));
      if (r instanceof Error) throw r;
      return {...r, signal: o?.signal};
    };
    return (await probe.runRound({})).probes;
  };
  const v6 = u => u.includes('[');
  const v4 = u => u.includes('1.1.1.1');

  // A carrier with no IPv4 path: IPv6 carries, so the IPv4 literal costs nobody anything.
  let r = await round(u => (v4(u) ? netError() : trace('2a02::1')));
  assert.equal(r.ip4.unused, true, 'nobody waited on IPv4');
  assert.equal(r.ip4.blocked, undefined);

  // A network with no route to the IPv6 literal. The same rule, the other way round, and it
  // applies from the first round rather than after three.
  r = await round(u => (v6(u) ? netError() : trace('1.2.3.4')));
  assert.equal(r.ip6.unused, true, 'and none on IPv6');

  // 1.1.1.1 refused while IPv4 carries the download: the address, not the path.
  r = await round(u => (v4(u) ? netError() : trace('1.2.3.4')));
  assert.equal(r.ip4.blocked, true, 'IPv4 egress in this round proves the path');

  // Both literals refused while the download still egresses. Neither is the link failing, and
  // the old model had to declare one of them absent.
  r = await round(u => (v6(u) || v4(u) ? netError() : trace('1.2.3.4')));
  assert.equal(r.ip4.blocked, true);
  assert.equal(r.ip6.unused, true);

  // A literal that answers with a status this code rejects still completed a handshake to that
  // address, so its family carried traffic.
  r = await round(u => (v6(u) ? {ok: false, status: 429, text: async () => ''} : trace('1.2.3.4')));
  assert.equal(r.ip6.blocked, true, 'a 429 is an answer, not an absent path');

  // Nothing reached anything: no excuses, and the row is a real failure.
  r = await round(() => netError());
  for (const id of ['ip6', 'ip4']) {
    assert.equal(r[id].unused, undefined, `${id} is not excused by a dead network`);
    assert.equal(r[id].blocked, undefined);
  }
});


s.test('a literal refused while its family carries traffic is blocked, not broken', async () => {
  // Recorded on two operators: the download egressed over IPv4 in the same round the IPv4
  // literal failed. 1.1.1.1 is a public resolver and is a common thing to intercept, so the
  // failure is about that address and not about the link.
  globalThis.fetch = async (url, o) => {
    if (String(url).includes('1.1.1.1')) throw netError();
    return {ok: true, status: 200, type: 'opaque',
            headers: {get: h => (h === 'cf-meta-ip' ? '109.36.152.49' : null)},
            body: bodyOf(25000), text: async () => TRACE, signal: o?.signal};
  };
  const round = (await probe.runRound({available: {ip6: true, ip4: true}})).probes;
  assert.equal(round.ip4.blocked, true, 'the round saw IPv4 carry traffic');
  assert.equal(round.ip4.expected, undefined, 'so the path is not absent');

  // With nothing reaching the far end, the same failure is the network.
  globalThis.fetch = async () => { throw netError(); };
  const dead = (await probe.runRound({available: {ip6: true, ip4: true}})).probes;
  assert.equal(dead.ip4.blocked, undefined, 'no egress this round, so nothing excuses it');
  assert.equal(dead.ip6.blocked, undefined);
});

s.test('a repeated probe reports the median and keeps every sample', async () => {
  const times = [10, 50, 90];   // median 50, last 90, so the two are distinguishable
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
      // One candidate per address family, as a dual-stack network reports, then completion.
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

// A body delivered in timed chunks, which separates the ramp from the steady portion.
function pacedBody(chunks) {
  let i = 0;
  return {getReader: () => ({
    read: async () => {
      if (i >= chunks.length) return {done: true};
      const c = chunks[i++];
      await new Promise(r => setTimeout(r, c.after));
      return {done: false, value: new Uint8Array(c.bytes)};
    },
    cancel: async () => {}
  })};
}

s.test('the reading never claims more than the link delivered', async () => {
  // A ramp then a faster stretch: 100 kB over 500 ms, then 1 MB over 1000 ms.
  const chunks = [];
  for (let i = 0; i < 5; i++) chunks.push({after: 100, bytes: 20000});
  for (let i = 0; i < 10; i++) chunks.push({after: 100, bytes: 100000});
  globalThis.fetch = async () => ({ok: true, status: 200, body: pacedBody(chunks),
    headers: {get: () => null}});

  const r = await probe.runProbe(P.down, {timeoutMs: 8000,
    download: {windowMs: 5000, rampMs: 0, streams: 1, capBytes: 1e9}});
  assert.equal(r.ok, true);
  assert.equal(r.aborted_reason, 'eof', 'the body ends on its own');
  assert.ok(r.bps > 0, `a rate is reported: ${r.bps}`);
  // The window is the fast stretch, so it may sit above the average of the whole transfer,
  // but never above what the link actually delivered inside that window.
  const inWindow = (r.window_bytes * 8) / (r.window_ms / 1000);
  assert.ok(r.bps <= inWindow * 1.01,
            `${(r.bps / 1e6).toFixed(1)} must not exceed ${(inWindow / 1e6).toFixed(1)} Mb/s`);
});

s.test('a body that outlasts the window is stopped, and still measures the link', async () => {
  const forever = () => ({getReader: () => ({
    read: async () => { await new Promise(r => setTimeout(r, 50)); return {done: false, value: new Uint8Array(20000)}; },
    cancel: async () => {}
  })});
  globalThis.fetch = async () => ({ok: true, status: 200, body: forever(), headers: {get: () => null}});

  const r = await probe.runProbe(P.down, {timeoutMs: 8000,
    download: {windowMs: 600, rampMs: 0, streams: 1, capBytes: 1e9}});
  assert.equal(r.aborted_reason, 'done', 'the window is what stops a read that would not end');
  assert.ok(r.window_ms < 900, `stopped near the window: ${r.window_ms} ms`);
  assert.ok(r.bps > 0, 'and the window is the measurement');
});

s.test('every link in range is measured, and none of them flattered', async () => {
  const paced = mbps => {
    const per = Math.max(1, Math.round((mbps * 1e6 / 8) * 0.02));
    const chunks = Math.ceil(probe.DOWN_REQUEST_BYTES / per);
    return pacedBody(Array.from({length: chunks}, () => ({after: 20, bytes: per})));
  };
  for (const mbps of [0.4, 1.5, 5, 10, 50, 500]) {
    globalThis.fetch = async () => ({ok: true, status: 200, body: paced(mbps), headers: {get: () => null}});
    const r = await probe.runProbe(P.down, {timeoutMs: 8000,
      download: {windowMs: 1000, rampMs: 0, streams: 1}});
    assert.ok(r.bps > 0, `${mbps} Mb/s must produce a reading, got ${r.bps}`);
    // A reading above the true rate would grade a link better than it is, and nothing —
    // jitter, a ramp, a saturated round — may cause that.
    const claimed = r.saturated ? probe.DOWN_CEILING_BPS : r.bps;
    assert.ok(claimed <= Math.max(mbps * 1e6, probe.DOWN_CEILING_BPS) * 1.15,
              `${mbps} Mb/s: read ${(claimed / 1e6).toFixed(2)} Mb/s claims more than the link`);
  }
});


s.test('a resolver retry timer is flagged as loss rather than latency', () => {
  assert.equal(probe.looksLikeRetry(2207), true, 'the cluster seen in a journey');
  assert.equal(probe.looksLikeRetry(2000), true);
  assert.equal(probe.looksLikeRetry(5100), true, 'the other common timer');
  assert.equal(probe.looksLikeRetry(1177), false, 'merely slow is not a retry');
  assert.equal(probe.looksLikeRetry(196), false);
  assert.equal(probe.looksLikeRetry(null), false);
});

s.test('every latency probe is sampled the same way', () => {
  const sampled = probe.PROBES.filter(p => p.samples > 1).map(p => p.id).sort();
  assert.deepEqual(sampled, ['dns_ctl', 'ip6', 'udp', 'web'],
                   'one probe discarding a cold first sample while others kept theirs made ' +
                   'their medians incomparable');
  assert.equal(probe.PROBES.find(p => p.id === 'dns').samples, undefined,
               'except the fresh-lookup probe: each sample would be a different hostname');
});

s.test('a round runs every probe and keeps what the far end saw', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200, body: bodyOf(250000),
    headers: {get: k => k === 'server-timing'
      ? 'cfL4;desc="?rtt=6212&min_rtt=6209&rtt_var=2336&lost=0&retrans=3&delivery_rate=648180&cwnd=53"'
      : ({'cf-meta-colo': 'AMS'})[k] ?? null}
  });
  globalThis.RTCPeerConnection = class {
    addTransceiver() {} async createOffer() { return {}; }
    async setLocalDescription() { setTimeout(() => this.onicecandidate({candidate: null}), 1); }
    close() {}
  };
  const round = (await probe.runRound({})).probes;
  delete globalThis.RTCPeerConnection;
  const d = round.down;
  assert.equal(Object.keys(round).length, probe.PROBES.length, 'every probe runs every round');
  // Three streams share one 250 kB stub between them.
  assert.equal(d.bytes, 250000 * probe.DOWN_STREAMS);
  assert.equal(d.bps_transfer, undefined, 'no whole-transfer rate survives');
  assert.equal(d.bps_min, undefined, 'nor the old whole-transfer floor');
  assert.deepEqual([d.server.retrans, d.server.cwnd], [3, 53], "Cloudflare's own TCP view is kept");
});

s.test('a truncated download still reports what it pulled', async () => {
  globalThis.fetch = async () => ({ok: true, status: 200, headers: {get: () => null},
    body: {getReader: () => ({read: async () => { throw new Error('cut'); }, cancel: async () => {}})}});
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
                        intervalMs: 100, started: Date.now(),
                        download: {windowMs: 60, rampMs: 0, streams: 1},
                        ipv4_available: null, ipv4_check: null});

l.test('a blocked literal does not make its path absent', async () => {
  // Recorded on two operators: the download egressed over IPv4 every round while the IPv4
  // literal failed every round, because 1.1.1.1 is a public resolver that relays and filters
  // intercept. Believing the literal alone marks a working path absent and then excuses every
  // failure on it for the rest of the session.
  globalThis.fetch = async (url, o) => {
    if (String(url).includes('1.1.1.1')) throw netError();
    return {ok: true, status: 200, type: 'opaque',
            headers: {get: h => (h === 'cf-meta-ip' ? '109.36.152.49' : null)},
            body: bodyOf(25000), text: async () => TRACE,
            signal: o?.signal};
  };
  const store = fakeStore();
  const {rec} = recorder(store);
  const sess = session();
  await rec.start(sess);
  assert.equal(sess.ipv4_available, false, 'the literal failed, so the preflight says absent');

  await sleep(400);
  await rec.stop();
  assert.equal(sess.ipv4_available, true,
               'but a round egressed over IPv4, which settles it whatever the literal did');
  assert.ok(store.written.samples.some(x => x.probes.ip4?.ok === false && !x.probes.ip4.expected),
            'and its failures stay real rather than being excused');
});

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
  while (Date.now() < until) { /* block the event loop, as a suspended tab does */ }
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
  const produced = [];
  const {rec, notices} = recorder(store, {onSample: s => produced.push(s)});
  await rec.start(session());
  await sleep(200);
  const held = store.written.samples.length;
  store.failNext(3);
  await sleep(500);
  await rec.stop();
  assert.ok(notices.some(n => n.includes('Storage write failed')), 'the failure reaches the screen');
  assert.ok(store.written.samples.length > held, 'and the held rows land on retry');

  // Checked by sequence number rather than by count: dropping the rejected batch and
  // carrying on also grows the total.
  const seqs = store.written.samples.map(x => x.seq).sort((a, b) => a - b);
  assert.equal(new Set(seqs).size, seqs.length, 'no round is written twice');
  assert.deepEqual(seqs, produced.map(x => x.seq).sort((a, b) => a - b),
                   `every round survived the outage: wrote ${seqs.length} of ${produced.length}`);
});

l.test('the interval decides what a session costs', async () => {
  const {DOWNLOAD_DEFAULTS} = await import('../js/session.js');
  assert.equal(PROFILES.fine.intervalMs, 15000);
  assert.equal(PROFILES.coarse.intervalMs, 30000);

  const fine = projectedBytes(PROFILES.fine.intervalMs, DOWNLOAD_DEFAULTS);
  const coarse = projectedBytes(PROFILES.coarse.intervalMs, DOWNLOAD_DEFAULTS);

  // The cost is rounds times the byte ceiling, so halving the interval doubles it.
  assert.ok(Math.abs(fine - coarse * 2) < coarse * 0.02,
            `twice the rounds costs twice as much: ${(fine / 1e6) | 0} vs ${(coarse / 1e6) | 0} MB`);
  assert.ok(fine > 40 * DOWNLOAD_DEFAULTS.capBytes,
            'and a 40-minute run is priced in hundreds of megabytes, not tens');

  const ten = projectedBytes(PROFILES.fine.intervalMs, DOWNLOAD_DEFAULTS, 10);
  assert.ok(Math.abs(ten * 4 - fine) < fine * 0.02, 'the estimate is linear in duration too');
});


l.test('stopping waits for the write already running, so the last rounds are on disk', async () => {
  globalThis.fetch = async () => ({ok: true, status: 200, type: 'opaque', headers: {get: () => null},
                                   body: bodyOf(25000), text: async () => TRACE});
  const store = fakeStore();
  // Every write takes longer than a round, so stop always arrives during one.
  store.holdWrites(150);
  const produced = [];
  const {rec} = recorder(store, {onSample: s => produced.push(s)});
  await rec.start(session());
  await sleep(400);
  await rec.stop();

  assert.equal(rec.status().pending, 0, 'stop left nothing in memory');
  assert.equal(store.written.samples.length, produced.length,
               `every round is on disk when stop resolves: ${store.written.samples.length} of ${produced.length}`);
});

l.test('a resumed session keeps counting from what it has already spent', async () => {
  const {spentSoFar} = await import('../js/session.js');
  const row = seq => ({seq, probes: {ip6: {ok: true, ms: 20, ms_samples: [20, 21, 22]},
                                     down: {ok: true, bytes: 5000000}}});
  const one = spentSoFar([row(0)]);
  const three = spentSoFar([row(0), row(1), row(2)]);
  assert.equal(one.downloadBytes, 5000000, 'the download is counted exactly, not estimated');
  assert.equal(three.downloadBytes, 15000000);
  assert.ok(three.bytes > one.bytes, 'and the small probes accumulate too');
  // Only the first request to a host is charged a handshake, so three rounds cost less than
  // three times one round.
  assert.ok(three.bytes < one.bytes * 3, `handshakes are charged once: ${one.bytes} then ${three.bytes}`);

  const store = fakeStore();
  const {rec} = recorder(store);
  await rec.start(session(), {resumeSeq: 12, monoBase: 1000, spent: {bytes: 900, downloadBytes: 7e6}});
  const st = rec.status();
  await rec.stop();
  assert.ok(st.bytes >= 900, `the estimate resumes rather than restarting: ${st.bytes}`);
  assert.ok(st.downloadMB >= 7, `and so does the figure on screen: ${st.downloadMB} MB`);
});

l.test('the environment block makes a session self-describing', () => {
  const env = environment(10000);
  assert.ok(env.download.streams > 0 && env.download.windowMs > 0 && env.download.capBytes > 0,
            'the download settings travel with the session');
  assert.equal(env.download.ceilingBps, probe.DOWN_CEILING_BPS,
               'including the fastest it can ever report, so a file states its own limit');
  assert.equal(env.probes.length, probe.PROBES.length);
  assert.ok(Object.values(env.timeouts_ms).every(t => t < 10000), 'every deadline fits inside a round');
  assert.ok(env.timeouts_ms.ip6 >= 8000, 'and slow-but-working rounds are not cut off');
  assert.ok(env.app_version && env.timezone);
});

await l.run();

/* ---------------- classification and export ---------------- */

const c = suite('classification');
const OK = (ms = 20, extra = {}) => ({ok: true, ms, fail: null, ...extra});
const BAD = (extra = {}) => ({ok: false, ms: 20, fail: 'network', ...extra});
const healthy = () => ({ip6: OK(30), ip4: BAD({expected: true}), dns: OK(190), dns_ctl: OK(60),
                        web: OK(65), udp: OK(50),
                        down: {ok: true, bps: 40e6}});

c.test('an expected failure colours nothing and counts as nothing', () => {
  assert.equal(ui.counts(BAD({expected: true})), false);
  assert.equal(ui.counts(undefined), false, 'a probe with no record is not a failure');
  assert.equal(ui.counts({}), false);
  assert.equal(ui.counts(BAD({fail: 'resting'})), false, 'nor a probe the recorder is resting');
  assert.equal(ui.counts(BAD({fail: 'resting'})), false, 'nor a probe resting to recover');
  assert.equal(ui.counts(BAD()), true);
  assert.equal(ui.classify({probes: healthy()}), 'green', 'a missing IPv4 path is not degraded');
});

c.test('a round taken as a whole is its worst activity', () => {
  assert.equal(ui.classify({probes: {...healthy(), dns: OK(2500)}}), 'orange');
  assert.equal(ui.classify({probes: {...healthy(), udp: BAD()}}), 'red', 'no UDP path sinks voice');
  assert.equal(ui.classify({probes: healthy(), skipped: 'overlap'}), 'skip');
});

c.test('each activity keeps its own colour, which is what the strips show', () => {
  // The failure that started this: one probe down painted a whole tile red while the rest of
  // the connection was fine. A per-activity grade is what makes that legible.
  const oneBadLookup = {probes: {...healthy(), dns: OK(2500)}};
  assert.equal(ui.gradeFor('news', oneBadLookup), 'orange');
  assert.equal(ui.gradeFor('voice', oneBadLookup), 'green', 'calls are unaffected by a lookup');
  assert.equal(ui.gradeFor('streaming', oneBadLookup), 'green');
  assert.equal(ui.gradeFor('voice', {probes: healthy(), skipped: 'overlap'}), 'skip');
});

c.test('the readout shows the grade the file recorded, not a second opinion', () => {
  // A row's stored grades are used in preference to regrading it.
  const sample = {probes: healthy(), grades: {voice: 'red', news: 'green', streaming: 'green'}};
  assert.equal(ui.classify(sample), 'red', 'the stored grade wins');
});

// Nothing else checks the wiring between the two modules: a function removed from ui.js
// surfaces only when a session refuses to start.
c.test('every ui function main.js calls exists', async () => {
  const {readFileSync} = await import('node:fs');
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const called = [...new Set([...main.matchAll(/\bui\.([a-zA-Z_$][\w$]*)\s*\(/g)].map(m => m[1]))];
  assert.ok(called.length > 10, `found the call sites: ${called.length}`);
  const missing = called.filter(name => typeof ui[name] !== 'function');
  assert.deepEqual(missing, [], `main.js calls ui functions that do not exist: ${missing.join(', ')}`);
});

c.test('every grade function the modules call exists', async () => {
  const {readFileSync} = await import('node:fs');
  const g = await import('../js/grade.js');
  for (const file of ['../js/main.js', '../js/ui.js', '../js/session.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const imported = /import\s*\{([^}]+)\}\s*from\s*'\.\/grade\.js'/.exec(src);
    if (!imported) continue;
    for (const name of imported[1].split(',').map(x => x.trim()).filter(Boolean)) {
      assert.ok(name in g, `${file} imports ${name} from grade.js, which does not export it`);
    }
  }
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

e.test('the rollup describes the session without judging it', () => {
  const probe = (ok, ms, extra = {}) => ({ok, ms, fail: ok ? null : 'timeout', ...extra});
  const row = (i, over = {}) => ({
    seq: i, t: 1000 + i * 1000, skipped: null, round_error: null, in_pause: false,
    wake_lock: true, accuracy_class: 'gps',
    probes: {ip6: probe(true, 10 * (i + 1)), ip4: probe(false, 5, {expected: true}),
             dns: probe(true, 100), dns_ctl: probe(true, 20), web: probe(true, 30),
             udp: probe(true, 15),
             down: probe(true, 400, {bps_min: 1e6 * (i + 1), bytes: 250000})},
    ...over
  });
  const samples = [...Array(10)].map((_, i) => row(i));
  samples.push(row(10, {skipped: 'overlap', probes: {}}));
  samples.push(row(11, {probes: {...row(11).probes, web: probe(false, 8000)}}));

  const sum = summarise(samples);
  assert.ok(sum.scales.round_trip && sum.activities.voice,
            'the scales and the activities they compose travel with the numbers');
  assert.ok(sum.grades, 'and the grades they produced');
  assert.equal(sum.rounds, 12);
  assert.equal(sum.ran, 11, 'a skipped round did not run');
  assert.equal(sum.skipped, 1);
  assert.equal(sum.degraded, 1, 'one round had a real failure');
  assert.equal(sum.probes.ip4.expected, 11, 'a known-absent path is counted apart from failures');
  assert.deepEqual(sum.probes.ip4.fails, {}, 'and never as a failure');
  assert.equal(sum.probes.web.fails.timeout, 1);

  // A rested probe is excluded from the failure counts; a rest lasts six rounds.
  const rested = samples.map((x, i) => i < 3 && x.probes.down
    ? {...x, probes: {...x.probes, down: {ok: false, fail: 'resting'}}} : x);
  const s2 = summarise(rested);
  assert.deepEqual(s2.probes.down.fails, {}, 'resting is not failing');
  assert.equal(s2.probes.down.stopped.resting, 3, 'it is counted, apart');
  assert.equal(s2.degraded, sum.degraded, 'and it does not move the degraded count');
  // Eleven rounds ran: ten at 10..100 ms plus the twelfth row at 120, with the skipped one
  // excluded.
  assert.equal(sum.probes.ip6.ms_p50, 60);
  assert.equal(sum.probes.ip6.ms_max, 120);
  assert.ok(sum.probes.down.bps_min_p10 < sum.probes.down.bps_min_p50,
            'the rate has a low end reported separately');
  assert.equal(sum.probes.down.bps_min_p50 != null, true,
               'summarising the rate the grades were taken on, not one that no longer exists');
  assert.equal(sum.probes.down.bytes_total, 250000 * 11);
  assert.equal(sum.fixes_gps, 11);

  // Every figure in the rollup is recomputable from the samples.
  const events = [
    {t: 5, mono: 5, type: 'label', text: 'slow', lat: 1, lon: 2},
    {t: 9, mono: 9, type: 'mark', text: 'mark 1', lat: 1, lon: 2}
  ];
  const out = JSON.parse(sessionJson({id: 'a', name: 'n', started: 1000}, samples, events));
  assert.deepEqual(out.summary, sum, 'the file carries the same rollup');
  assert.equal(out.samples.length, samples.length, 'alongside every raw row');

  // Marks are lifted out so a threshold can be checked against them by a join.
  assert.equal(out.events.length, 2, 'and still present among the events');
});

e.test('the screen and the file agree on what a failure is', async () => {
  const ui = await import('../js/ui.js');
  const {countsAsFailure} = await import('../js/export.js');
  const cases = [
    undefined, {}, {ok: true}, {ok: false, fail: 'timeout'}, {ok: false, fail: 'network'},
    {ok: false, fail: 'resting'}, {ok: false, expected: true, fail: 'network'},
    {ok: false, fail: 'budget'}
  ];
  for (const c of cases) {
    assert.equal(ui.counts(c), countsAsFailure(c),
                 `the percentage on screen and the count in the file must agree on ${JSON.stringify(c)}`);
  }
  assert.equal(countsAsFailure({ok: false, fail: 'resting'}), false);
  assert.equal(countsAsFailure({ok: false, fail: 'timeout'}), true);
});

await e.run();
