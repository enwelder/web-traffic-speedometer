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

s.test('runProbe MUST report egress_ip, colo and status WHEN the trace body parses', async () => {
  globalThis.fetch = async () => ({ok: true, status: 200, text: async () => TRACE});
  for (const id of ['ip6', 'ip4']) {
    const r = await probe.runProbe(P[id]);
    assert.deepEqual([r.ok, r.status, r.colo, r.egress_ip], [true, 200, 'AMS', '2a09:bac5::9'], id);
  }
});

s.test('runProbe MUST return fail network with a time-to-fail WHEN fetch throws', async () => {
  globalThis.fetch = async () => { throw netError(); };
  const r = await probe.runProbe(P.ip6);
  assert.deepEqual([r.ok, r.fail], [false, 'network']);
  assert.ok(r.ms >= 0, 'how long it took to fail is kept');
});

s.test('runProbe MUST return fail http with the status WHEN the server answers 429', async () => {
  globalThis.fetch = async () => ({ok: false, status: 429, text: async () => ''});
  const r = await probe.runProbe(P.ip6);
  assert.deepEqual([r.ok, r.fail, r.status], [false, 'http', 429]);
});

s.test('runProbe MUST return fail parse WHEN the response body is an interception page', async () => {
  globalThis.fetch = async () => ({ok: true, status: 200, text: async () => '<html>Sign in</html>'});
  const r = await probe.runProbe(P.ip6);
  assert.deepEqual([r.ok, r.fail], [false, 'parse']);
});

s.test('runProbe MUST return fail timeout for its own deadline and fail abort WHEN the caller aborts the signal', async () => {
  const hang = (url, o) => new Promise((_, rej) =>
    o.signal?.addEventListener('abort', () => rej(Object.assign(new Error('x'), {name: 'AbortError'})), {once: true}));
  globalThis.fetch = hang;
  assert.equal((await probe.runProbe(P.ip6, {timeoutMs: 80})).fail, 'timeout');
  const ctl = new AbortController();
  const pending = probe.runProbe(P.ip6, {timeoutMs: 5000, signal: ctl.signal});
  setTimeout(() => ctl.abort(), 40);
  assert.equal((await pending).fail, 'abort');
});

s.test('runProbe MUST request a fresh hostname per dns sample and one fixed hostname for dns_ctl WHEN sampled repeatedly', async () => {
  const seen = {dns: [], dns_ctl: []};
  let method;
  globalThis.fetch = async (url, o) => {
    const h = new URL(url).hostname;
    (h.startsWith('wts-') ? seen.dns_ctl : seen.dns).push(h);
    method = o.method;
    return {type: 'opaque', ok: false, status: 0};
  };
  for (let i = 0; i < 5; i++) { await probe.runProbe(P.dns); await probe.runProbe(P.dns_ctl); }
  // Every sample too, not merely every round: a repeat under the same name would be answered
  // from a cache and would stop being a first contact.
  assert.ok(seen.dns.length >= 5 * P.dns.samples, `every sample issued a request: ${seen.dns.length}`);
  assert.equal(new Set(seen.dns).size, seen.dns.length,
               'and no name is requested twice');
  assert.equal(new Set(seen.dns_ctl).size, 1, 'the control holds its name so it stays cached');
  assert.ok(seen.dns.every(h => /^[0-9a-f]{16}\.github\.io$/.test(h)), seen.dns[0]);
  assert.ok(seen.dns_ctl[0].endsWith('.github.io'), 'both sit on the same destination');
  assert.equal(method, 'HEAD', 'HEAD keeps the 9 kB 404 body off the wire');
});

s.test('timeoutFor MUST return a deadline under the interval and at least 1000 ms WHEN given any probe and interval', async () => {
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

s.test('runRound MUST derive unused and blocked from the traffic of that round alone WHEN a literal fails', async () => {
  // A family's silence carries no verdict of its own: it reads the same on a network with no
  // route to the IPv6 literal, across a handover, and with both literals blocked at once.
  // Every case below is settled by what carried traffic in that one round.
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
  // applies from the first round.
  r = await round(u => (v6(u) ? netError() : trace('1.2.3.4')));
  assert.equal(r.ip6.unused, true, 'and none on IPv6');

  // 1.1.1.1 refused while IPv4 carries the download: the address, not the path.
  r = await round(u => (v4(u) ? netError() : trace('1.2.3.4')));
  assert.equal(r.ip4.blocked, true, 'IPv4 egress in this round proves the path');

  // Both literals refused while the download still egresses. Neither is the link failing, and
  // neither family is absent.
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


s.test('runRound MUST set ip4.blocked WHEN the ip4 literal fails while the round egresses over IPv4', async () => {
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
  assert.equal(dead.ip4.blocked, undefined, 'no egress this round, so the failure is charged to the link');
  assert.equal(dead.ip6.blocked, undefined);
});

s.test('runProbe MUST return the median as ms and keep every sample with its spread WHEN the probe is sampled', async () => {
  // A slow sample in the middle, so the median and the last differ.
  const times = [10, 90, 50];
  let i = 0;
  globalThis.fetch = async () => {
    const wait = times[i++ % times.length];
    await new Promise(r => setTimeout(r, wait));
    return {ok: true, status: 200, text: async () => TRACE};
  };
  const r = await probe.runProbe(P.ip6, {timeoutMs: 8000});
  assert.equal(r.samples_ok, P.ip6.samples, 'every sample fitted the budget');
  assert.equal(r.ms_samples.length, P.ip6.samples, 'and every one is kept');
  const sorted = [...r.ms_samples].sort((a, b) => a - b);
  const mid = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
    : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
  assert.equal(r.ms, mid, `ms is the median, not the last: ${r.ms} of ${r.ms_samples}`);
  assert.ok(r.ms < sorted.at(-1), 'so one slow sample cannot drag the round');
  assert.deepEqual([r.ms_min, r.ms_max], [sorted[0], sorted.at(-1)],
                   'and the spread is kept, since a median alone hides it');
});

s.test('runProbe MUST issue one request WHEN the first sample fails', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw netError(); };
  const r = await probe.runProbe(P.ip6, {timeoutMs: 3000});
  assert.equal(calls, 1, 'a failed probe is not retried within its own round');
  assert.equal(r.ok, false);
  assert.equal(r.samples_ok, 0);
});

s.test('runProbe MUST return inside its timeout budget WHEN every sample hangs', async () => {
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

s.test('runProbe MUST return ok with sample_fail set WHEN one sample of ten times out', async () => {
  // KPN 5G, recorded: the first sample pays for waking the radio, the rest are the link.
  // A tenth that never comes back is one lost packet, and the nine that answered measured
  // the link; failing the probe on it reddens calls on a connection that carries them.
  const ms = [216, 21, 19, 22, 20, 24, 19, 21, 20];
  let i = 0;
  globalThis.fetch = async (url, o) => {
    const wait = ms[i++];
    if (wait == null) {
      // The tenth request hangs until its own deadline, as a lost SYN does.
      return new Promise((res, rej) => o.signal?.addEventListener('abort',
        () => rej(Object.assign(new Error('x'), {name: 'AbortError'})), {once: true}));
    }
    await sleep(wait);
    return {ok: true, status: 200, text: async () => TRACE};
  };
  const r = await probe.runProbe(P.ip6, {timeoutMs: 2000});
  assert.equal(r.ok, true, 'nine answers are a measurement');
  assert.equal(r.samples_ok, 9);
  assert.equal(r.sample_fail, 'timeout', 'and the one that did not is on the row');
  assert.ok(r.ms >= 19 && r.ms <= 30, `the median of the nine, not of the ten: ${r.ms}`);
  assert.equal(r.fail, null);
  assert.equal(r.ms_samples.length, 10, 'every attempt is kept, including the one that failed');
  assert.ok(r.ms_samples.at(-1) > 1000,
            `the failed sample keeps its time-to-fail: ${r.ms_samples.at(-1)} ms`);
});

s.test('runProbe MUST return ok false with fail network WHEN every sample throws', async () => {
  globalThis.fetch = async () => { throw netError(); };
  const r = await probe.runProbe(P.ip6, {timeoutMs: 2000});
  assert.equal(r.ok, false);
  assert.equal(r.fail, 'network');
  assert.equal(r.samples_ok, 0);
});

s.test('runProbe MUST stop sampling early and report the samples it took WHEN the remaining budget cannot hold another', async () => {
  // Five fresh hostnames at 1.5 s each: the fifth would be admitted with 2 s and time out on
  // the budget rather than on the network, which is exactly the 2 s resolver retry timer the
  // dns probe exists to recognise.
  let calls = 0;
  globalThis.fetch = async () => { calls++; await sleep(300); return {ok: true, status: 200, type: 'opaque'}; };
  const r = await probe.runProbe(P.dns, {timeoutMs: 1000});
  assert.ok(calls < P.dns.samples, `the budget stopped it early: ${calls} of ${P.dns.samples}`);
  assert.equal(r.ok, true, 'and what it did take is the measurement');
  assert.equal(r.samples_ok, calls);
});

s.test('runProbe MUST return fail parse with a parse_reason WHEN the trace body is short, downgraded or rewritten', async () => {
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

s.test('runProbe MUST report one public IP per family from a recvonly transceiver and close the connection WHEN candidates arrive', async () => {
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

s.test('runProbe MUST return fail timeout inside its deadline WHEN no ICE candidate arrives', async () => {
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

s.test('runProbe MUST return fail unsupported WHEN RTCPeerConnection is absent', async () => {
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

s.test('runProbe MUST report a bps at or under what the window carried WHEN the body ramps and then accelerates', async () => {
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
  // but never above what the link delivered inside that window.
  const inWindow = (r.window_bytes * 8) / (r.window_ms / 1000);
  assert.ok(r.bps <= inWindow * 1.01,
            `${(r.bps / 1e6).toFixed(1)} must not exceed ${(inWindow / 1e6).toFixed(1)} Mb/s`);
});

s.test('runProbe MUST stop at the window with aborted_reason done and report a rate WHEN the body never ends', async () => {
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

s.test('runProbe MUST report a rate at or under the link rate WHEN the link runs from 0.4 to 500 Mb/s', async () => {
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


s.test('looksLikeRetry MUST return true only for resolver retry timers WHEN given a latency', () => {
  assert.equal(probe.looksLikeRetry(2207), true, 'the cluster seen in a journey');
  assert.equal(probe.looksLikeRetry(2000), true);
  assert.equal(probe.looksLikeRetry(5100), true, 'the other common timer');
  assert.equal(probe.looksLikeRetry(1177), false, 'merely slow is not a retry');
  assert.equal(probe.looksLikeRetry(196), false);
  assert.equal(probe.looksLikeRetry(null), false);
});

s.test('PROBES MUST give every latency probe more than one sample and the comparable ones one count WHEN the set is read', () => {
  // One round trip is not a measurement, and one unsampled probe beside sampled ones is worse
  // than either: whichever row it is, it carries a single noisy sample where its neighbours
  // carry medians, and the route can be exactly that row.
  for (const p of probe.PROBES) {
    if (p.kind === 'download') continue;
    assert.ok(p.samples > 1, `${p.id} takes more than one sample`);
  }
  const counts = new Set(probe.PROBES.filter(p => p.kind !== 'download' && p.id !== 'dns')
    .map(p => p.samples));
  assert.equal(counts.size, 1, 'and the comparable ones take the same number');
  assert.ok(probe.PROBES.find(p => p.id === 'dns').samples < [...counts][0],
            'the first-contact probe takes fewer: every sample of it is a new connection');
});

s.test('runRound MUST run every probe in PROBES and keep the server-timing fields WHEN the round completes', async () => {
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
  assert.equal(d.bps_min, undefined, 'nor a whole-transfer floor');
  assert.deepEqual([d.server.retrans, d.server.cwnd], [3, 53], "Cloudflare's own TCP view is kept");
});

s.test('runProbe MUST set truncated WHEN the body read throws mid-stream', async () => {
  globalThis.fetch = async () => ({ok: true, status: 200, headers: {get: () => null},
    body: {getReader: () => ({read: async () => { throw new Error('cut'); }, cancel: async () => {}})}});
  const r = await probe.runProbe(P.down, {timeoutMs: 50});
  assert.equal(r.truncated, true, 'truncation is recorded');
});

s.test('runProbe MUST record why sampling ended and the wall time it took WHEN sampling stops on count, failure or budget', async () => {
  globalThis.fetch = async () => ({ok: true, status: 200, text: async () => TRACE});
  const all = await probe.runProbe(P.ip6, {timeoutMs: 8000});
  assert.equal(all.samples_end, 'count');

  globalThis.fetch = async () => { throw netError(); };
  assert.equal((await probe.runProbe(P.ip6, {timeoutMs: 3000})).samples_end, 'failure');

  globalThis.fetch = async () => { await sleep(300); return {ok: true, status: 200, type: 'opaque'}; };
  const slow = await probe.runProbe(P.dns, {timeoutMs: 1000});
  assert.equal(slow.samples_end, 'budget');
  assert.ok(slow.wall_ms >= slow.ms_samples.reduce((a, b) => a + b, 0),
            `the wall time holds every sample: ${slow.wall_ms} ms for ${slow.ms_samples}`);
});

s.test('runRound MUST hold every started probe in pending until it settles WHEN given a pending set', async () => {
  globalThis.fetch = async () => {
    await sleep(15);
    return {ok: true, status: 200, type: 'opaque', headers: {get: () => null}, body: bodyOf(2000),
            text: async () => TRACE};
  };
  const pending = new Set();
  const seen = new Set();
  const watch = setInterval(() => pending.forEach(id => seen.add(id)), 2);
  const round = await probe.runRound({pending, intervalMs: 3000,
                                      download: {windowMs: 50, rampMs: 0, streams: 1}});
  clearInterval(watch);
  assert.ok(['ip6', 'dns', 'web', 'down'].every(id => seen.has(id)), `held: ${[...seen]}`);
  assert.equal(pending.size, 0, 'and none once the round returns');
  assert.ok(round.phase_idle_ms > 0 && round.phase_down_ms >= 0,
            `phases ${round.phase_idle_ms} and ${round.phase_down_ms} ms`);
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

// A round is two phases. A listener added to a signal that has already aborted never fires,
// so a stop landing between them has to reach the phase that has yet to start.
l.test('createRecorder.stop MUST open no download connection and record fail abort WHEN stop lands between the two phases of a round', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    await sleep(60);
    return {ok: true, status: 200, type: 'opaque', headers: {get: () => null},
            body: bodyOf(25000), text: async () => TRACE};
  };
  const store = fakeStore();
  const {rec} = recorder(store);
  await rec.start(session());
  await sleep(20);                       // inside the idle phase, before the download opens
  await rec.stop();
  const after = urls.filter(u => u.includes('speed.cloudflare')).length;
  const row = store.written.samples.find(x => !x.skipped);
  assert.equal(after, 0, 'no download connection is opened after the stop');
  assert.equal(row.probes.down.fail, 'abort', 'and the round records why it has no throughput');
});

l.test('createRecorder MUST fit both round phases inside the interval WHEN a dead literal holds its connection to its own deadline', async () => {
  // The phases run one after the other, so a probe deadline sized against the interval alone
  // lets a round run two of them: 8 s of dead IPv6 and then 8 s of download, against 15 s.
  const seen = [];
  globalThis.fetch = async (url, o) => {
    if (String(url).includes('speed.cloudflare')) seen.push(Date.now());
    if (String(url).includes('[2606')) {
      // A dead literal that holds the connection open to its own deadline.
      return new Promise((res, rej) => o.signal?.addEventListener('abort',
        () => rej(Object.assign(new Error('x'), {name: 'AbortError'})), {once: true}));
    }
    return {ok: true, status: 200, type: 'opaque', headers: {get: () => null},
            body: bodyOf(25000), text: async () => TRACE};
  };
  const store = fakeStore();
  const {rec} = recorder(store);
  const t0 = Date.now();
  await rec.start({...session(), intervalMs: 2000, download: {windowMs: 60, rampMs: 0, streams: 1}});
  await sleep(2600);
  await rec.stop();
  const row = store.written.samples.find(x => x.probes.down);
  assert.ok(row, 'the round produced a row');
  assert.ok(row.round_ms < 2600, `the round fits its slot: ${row.round_ms} ms`);
  assert.ok(Date.now() - t0 < 5000, 'and the two phases together stay inside the interval');
});

l.test('createRecorder MUST record round_error with null grades and fail error on the probes WHEN the round loop throws', async () => {
  const store = fakeStore();
  const {rec} = recorder(store);
  globalThis.fetch = async () => ({ok: true, status: 200, type: 'opaque',
                                   headers: {get: () => null}, body: bodyOf(25000),
                                   text: async () => TRACE});
  const orig = globalThis.RTCPeerConnection;
  // The round loop itself failing, rather than a request coming back badly.
  globalThis.RTCPeerConnection = class {
    addTransceiver() { throw new Error('round broke'); }
    close() {}
  };
  await rec.start(session());
  await sleep(300);
  await rec.stop();
  globalThis.RTCPeerConnection = orig;

  const broken = store.written.samples.filter(x => x.round_error);
  assert.ok(broken.length > 0, 'the exception is recorded on the row');
  assert.equal(broken[0].grades, null, 'and the grades are null, since no probe measured');
  const fails = Object.values(broken[0].probes).filter(v => v.fail === 'network');
  assert.equal(fails.length, 0, 'no probe is blamed for a request it never made');
  assert.ok(Object.values(broken[0].probes).some(v => v.fail === 'error'),
            'the probes that never ran say so');
});

l.test('createRecorder MUST exclude a probe with zero successful samples from first_packet_ms WHEN its only sample failed', async () => {
  // first_packet_ms approximates the cost of waking the radio, so a probe that failed on its
  // first attempt contributes its time-to-fail: 8 s of dead IPv6 read as an 8 s first packet.
  globalThis.fetch = async (url, o) => {
    if (String(url).includes('[2606')) {
      return new Promise((res, rej) => o.signal?.addEventListener('abort',
        () => rej(Object.assign(new Error('x'), {name: 'AbortError'})), {once: true}));
    }
    await sleep(16);
    return {ok: true, status: 200, type: 'opaque', headers: {get: () => null},
            body: bodyOf(25000), text: async () => TRACE};
  };
  const store = fakeStore();
  const {rec} = recorder(store);
  await rec.start(session());
  await sleep(1500);
  await rec.stop();
  const row = store.written.samples.find(x => !x.skipped && x.first_packet_ms != null);
  assert.ok(row, 'a round reported a first packet');
  assert.equal(row.probes.ip6.samples_ok, 0, 'the literal produced no successful sample');
  assert.ok(row.first_packet_ms < 200,
            `and its time-to-fail is not the first packet: ${row.first_packet_ms} ms`);
});

l.test('createRecorder MUST set ipv4_available true WHEN a round egresses over IPv4 after the preflight literal failed', async () => {
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
  assert.equal(sess.ipv4_available, false, 'the literal failed, so the preflight records absent');

  await sleep(400);
  await rec.stop();
  assert.equal(sess.ipv4_available, true,
               'but a round egressed over IPv4, which settles it whatever the literal did');
  assert.ok(store.written.samples.some(x => x.probes.ip4?.ok === false && !x.probes.ip4.expected),
            'and its failures stay counted');
});

l.test('createRecorder MUST write a row with a contiguous seq for every scheduled round WHEN rounds succeed and then fail', async () => {
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

l.test('createRecorder MUST record a skip event and write no row WHEN a slot comes due while a round is running', async () => {
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
  const skips = store.written.events.filter(e => e.type === 'skip');
  assert.ok(skips.length > 0, 'a slot came due mid-round');
  const seqs = store.written.samples.map(x => x.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, seqs.map((_, i) => i), 'rows are numbered by the rounds that ran');
  assert.ok(skips.every(e => seqs.includes(e.round)), 'and each skip names a round that has a row');
});

l.test('createRecorder MUST record a pause event carrying the bridged duration WHEN the event loop is blocked', async () => {
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

l.test('createRecorder MUST retry held rows and write each seq once WHEN the store rejects three writes', async () => {
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

  // Checked by sequence number: dropping the rejected batch and carrying on also grows the
  // total.
  const seqs = store.written.samples.map(x => x.seq).sort((a, b) => a - b);
  assert.equal(new Set(seqs).size, seqs.length, 'no round is written twice');
  assert.deepEqual(seqs, produced.map(x => x.seq).sort((a, b) => a - b),
                   `every round survived the outage: wrote ${seqs.length} of ${produced.length}`);
});

l.test('projectedBytes MUST scale linearly with the number of rounds and the duration WHEN the interval halves', async () => {
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


l.test('createRecorder.stop MUST resolve with zero pending rows and every round on disk WHEN a write is in flight', async () => {
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

l.test('spentSoFar MUST count downloaded bytes exactly and charge each handshake once WHEN a session resumes from stored rows', async () => {
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
  assert.ok(st.bytes >= 900, `the estimate resumes from the stored rows: ${st.bytes}`);
  assert.ok(st.downloadMB >= 7, `and so does the figure on screen: ${st.downloadMB} MB`);
});

l.test('environment MUST carry the download settings, the probe set and deadlines under the interval WHEN built for a 10 s interval', () => {
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

l.test('createRecorder MUST record loaded_rtt_ms and loaded_rtt_from WHEN a round trip runs inside the download window', async () => {
  // Started with the download it races three TLS handshakes and answers before a payload byte
  // arrives, which measures the idle link a second time. Recorded on Wi-Fi, v3.11.0: loaded
  // minus idle was +2 ms at the median across 30 rounds.
  const events = [];
  globalThis.fetch = async (url) => {
    const down = String(url).includes('speed.cloudflare');
    events.push((down ? 'down:' : 'probe:') + Date.now());
    if (!down) {
      await sleep(10);
      return {ok: true, status: 200, type: 'opaque', headers: {get: () => null},
              text: async () => TRACE};
    }
    await sleep(20);
    let i = 0;
    return {ok: true, status: 200, type: 'opaque', headers: {get: () => null},
            text: async () => TRACE,
            body: {getReader: () => ({
              async read() {
                if (i++ >= 12) return {done: true};
                await sleep(20);
                return {done: false, value: new Uint8Array(60000)};
              },
              cancel: async () => {}
            })}};
  };
  const store = fakeStore();
  const {rec} = recorder(store);
  await rec.start({...session(), intervalMs: 3000,
                   download: {windowMs: 200, rampMs: 40, streams: 1, capBytes: 4700000}});
  await sleep(1200);
  await rec.stop();
  const row = store.written.samples.find(x => !x.skipped && x.probes.down?.ok);
  assert.ok(row, 'the download measured a window');
  assert.ok(row.loaded_rtt_ms != null, 'and a round trip was taken across it');
  assert.ok(['ip6', 'ip4', 'web'].includes(row.loaded_rtt_from),
            'named for the probe that answered idle');
});

l.test('createRecorder MUST record null loaded_rtt_ms WHEN the body ends inside the ramp', async () => {
  // A body that ends inside the ramp never opens a window, so there is no load to measure
  // under and nothing is invented.
  globalThis.fetch = async () => ({ok: true, status: 200, type: 'opaque',
                                   headers: {get: () => null}, body: bodyOf(1000),
                                   text: async () => TRACE});
  const store = fakeStore();
  const {rec} = recorder(store);
  await rec.start({...session(), intervalMs: 400,
                   download: {windowMs: 200, rampMs: 300, streams: 1}});
  await sleep(600);
  await rec.stop();
  const row = store.written.samples.find(x => !x.skipped);
  assert.equal(row.probes.down.window_ms, 0, 'the ramp swallowed the body');
  assert.equal(row.loaded_rtt_ms, null, 'so no round trip claims to be under load');
});

l.test('createRecorder MUST record round_ms covering both phases and visible_end WHEN a round completes', async () => {
  globalThis.fetch = async () => {
    await sleep(20);
    return {ok: true, status: 200, type: 'opaque', headers: {get: () => null}, body: bodyOf(25000),
            text: async () => TRACE};
  };
  const store = fakeStore();
  const {rec} = recorder(store);
  await rec.start({...session(), intervalMs: 1500});
  await sleep(1200);
  await rec.stop();
  const row = store.written.samples.find(x => x.phase_down_ms != null);
  assert.ok(row, 'a round completed');
  assert.ok(row.round_ms >= row.phase_idle_ms + row.phase_down_ms && row.phase_idle_ms > 0,
            `${row.round_ms} ms spans ${row.phase_idle_ms} + ${row.phase_down_ms} ms`);
  assert.equal(row.visible_end, true);
});

l.test('createRecorder.stop MUST set end_reason to stop WHEN it ends a session', async () => {
  globalThis.fetch = async () => ({ok: true, status: 200, type: 'opaque', headers: {get: () => null},
                                   body: bodyOf(25000), text: async () => TRACE});
  const {rec} = recorder(fakeStore());
  const sess = session();
  await rec.start(sess);
  await rec.stop();
  assert.equal(sess.end_reason, 'stop');
});

l.test('createRecorder MUST record page and network events WHEN the tab hides and the interface goes offline', async () => {
  const doc = Object.assign(new EventTarget(), {visibilityState: 'visible'});
  const win = new EventTarget();
  const saved = {document: globalThis.document, listen: globalThis.addEventListener};
  globalThis.document = doc;
  globalThis.addEventListener = win.addEventListener.bind(win);
  try {
    globalThis.fetch = async () => ({ok: true, status: 200, type: 'opaque', headers: {get: () => null},
                                     body: bodyOf(25000), text: async () => TRACE});
    const store = fakeStore();
    const {rec} = recorder(store);
    await rec.start(session());
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('offline'));
    win.dispatchEvent(new Event('online'));
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    await rec.stop();
    const seen = store.written.events.filter(e => e.type === 'page' || e.type === 'network')
                                     .map(e => `${e.type} ${e.text}`);
    assert.deepEqual(seen, ['page hidden', 'network offline', 'network online', 'page visible']);
  } finally {
    globalThis.document = saved.document;
    if (saved.listen) globalThis.addEventListener = saved.listen;
    else delete globalThis.addEventListener;
  }
});

l.test('createRecorder MUST record a connection change once per change of type or class WHEN navigator.connection reports it', async () => {
  const connection = Object.assign(new EventTarget(),
                                   {type: 'cellular', effectiveType: '4g', downlink: 10, rtt: 50});
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: {userAgent: 'node-test', language: 'en', geolocation: null, connection}, configurable: true
  });
  try {
    globalThis.fetch = async () => ({ok: true, status: 200, type: 'opaque', headers: {get: () => null},
                                     body: bodyOf(25000), text: async () => TRACE});
    const store = fakeStore();
    const {rec} = recorder(store);
    await rec.start(session());
    connection.downlink = 7.5;
    connection.dispatchEvent(new Event('change'));
    Object.assign(connection, {effectiveType: '3g', downlink: 1.2, rtt: 300});
    connection.dispatchEvent(new Event('change'));
    await rec.stop();
    assert.deepEqual(store.written.events.filter(e => e.type === 'network').map(e => e.text),
                     ['connection cellular 3g, 1.2 Mb/s, 300 ms']);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
});

await l.run();

/* ---------------- classification and export ---------------- */

const grade = await import('../js/grade.js');
const r = suite('readout');

// The readout: what the screen prints for a round, asserted character by character.
const shown = ms => ({ok: true, ms, fail: null});
const gone = over => ({ok: false, ms: 12, fail: 'network', ...over});
const round = over => ({t: Date.parse('2026-09-09T12:00:00Z'), probes: {
  ip6: shown(30), ip4: gone({unused: true}), dns: shown(180), dns_ctl: shown(20),
  web: shown(25), udp: shown(20),
  down: {ok: true, bps: 25066667, saturated: true, ceiling_bps: 25066667, streams: 3},
  ...over
}});

r.test('probeReading MUST return a value or a note for every probe and flag a saturated download WHEN the round is healthy', () => {
  const s = round();
  for (const id of ['ip6', 'dns', 'dns_ctl', 'web', 'udp']) {
    const rd = grade.probeReading(id, s);
    assert.ok(rd.value != null || rd.note, `${id} shows something`);
  }
  const down = grade.probeReading('down', s);
  assert.equal(down.saturated, true, 'a saturated download is flagged for the ≥');
  assert.equal(down.unit, 'bps');
});

r.test('probeReading MUST return the dns time graded on the ttfb scale WHEN the lookup answered', () => {
  // It was printed as "+190 ms extra" against a warm control that answers in 15 ms, on a scale
  // tuned to a corpus. The absolute time is what a person waits for, and ttfb grades it.
  const rd = grade.probeReading('dns', round({dns: shown(190)}));
  assert.equal(rd.scale, 'ttfb');
  assert.equal(rd.value, 190);
  assert.equal(rd.grade, 'green', '190 ms to a host never contacted is a good result');
  assert.equal(grade.probeReading('dns', round({dns: shown(2500)})).grade, 'orange');
});

r.test('probeReading MUST return a null grade and a null value WHEN the literal state is unused, blocked, absent or resting', () => {
  for (const [over, state] of [[{unused: true}, 'unused'], [{blocked: true}, 'blocked'],
                               [{expected: true}, 'absent'], [{fail: 'resting'}, 'resting']]) {
    const rd = grade.probeReading('ip4', round({ip4: gone(over)}));
    assert.equal(rd.state, state);
    assert.equal(rd.grade, null, `${state} takes no colour`);
    assert.equal(rd.value, null, `${state} prints no number`);
  }
});

r.test('changes MUST return one line per changed probe WHEN compared with the previous round', () => {
  const a = round();
  const b = round();
  const c = round({udp: gone()});

  const first = ui.changes(a, null);
  assert.ok(first.every(l => !l.includes('→')), 'the first round states, it does not compare');
  assert.ok(first.some(l => l.includes('ip4 unused')), 'and names what is not already fine');

  assert.deepEqual(ui.changes(b, a), [], 'an unchanged round produces no line');

  const moved = ui.changes(c, b);
  assert.equal(moved.length, 1, `one line for one change: ${JSON.stringify(moved)}`);
  assert.match(moved[0], /udp ok → failed/);
  assert.match(moved[0], /^\d\d:\d\d:\d\d/, 'stamped with the time it happened');

  // An activity changing colour is a bar on the strip and is not repeated here.
  assert.ok(!moved.some(l => /calling|articles|streaming/.test(l)));
});

r.test('createRecorder.status MUST report the same elapsed span WHEN the session has stopped', async () => {
  const store = fakeStore();
  const {rec} = recorder(store);
  const sess = session();
  await rec.start(sess);
  await sleep(300);
  const running = rec.status().elapsed;
  await rec.stop();
  assert.ok(running >= 0, 'a running session reports its elapsed time');
  assert.equal(rec.status().elapsed, running,
               'and a finished one still reports its span');
});

r.test('bytes and rate MUST format in base 10 WHEN given byte counts and bit rates', () => {
  // Dividing by 1024 while switching units at 1e6 puts a step backwards in the middle of the
  // scale: 1,000,000 bytes reads as 977 kB and 1,000,001 as 1.0 MB.
  assert.equal(ui.bytes(999999), '1000 kB');
  assert.equal(ui.bytes(1000000), '1.0 MB');
  assert.equal(ui.bytes(4700000), '4.7 MB', 'the download cap reads as the number it is');
  assert.equal(ui.bytes(5000), '5 kB');
  // The rate beside it is base 10 too, so the two scales agree.
  assert.equal(ui.rate(25066667), '25.1 Mb/s');
  assert.equal(ui.rate(999000), '999 kb/s');
});

await r.run();


const c = suite('classification');
const OK = (ms = 20, extra = {}) => ({ok: true, ms, fail: null, ...extra});
const BAD = (extra = {}) => ({ok: false, ms: 20, fail: 'network', ...extra});
const healthy = () => ({ip6: OK(30), ip4: BAD({expected: true}), dns: OK(190), dns_ctl: OK(60),
                        web: OK(65), udp: OK(50),
                        down: {ok: true, bps: 40e6}});

c.test('counts MUST return false WHEN the probe result is expected, resting, empty or missing', () => {
  assert.equal(ui.counts(BAD({expected: true})), false);
  assert.equal(ui.counts(undefined), false, 'a probe with no record is not a failure');
  assert.equal(ui.counts({}), false);
  assert.equal(ui.counts(BAD({fail: 'resting'})), false, 'nor a probe the recorder is resting');
  assert.equal(ui.counts(BAD({fail: 'resting'})), false, 'nor a probe resting to recover');
  assert.equal(ui.counts(BAD()), true);
  assert.equal(ui.classify({probes: healthy()}), 'green', 'a missing IPv4 path is not degraded');
});

c.test('classify MUST return the worst activity grade WHEN one probe degrades', () => {
  assert.equal(ui.classify({probes: {...healthy(), dns: OK(2500)}}), 'orange');
  assert.equal(ui.classify({probes: {...healthy(), udp: BAD()}}), 'red', 'no UDP path sinks voice');
});

c.test('gradeFor MUST grade each activity independently WHEN one probe degrades', () => {
  // One probe down paints a whole tile red while the rest of the connection is fine. A
  // per-activity grade is what keeps that legible.
  const oneBadLookup = {probes: {...healthy(), dns: OK(2500)}};
  assert.equal(ui.gradeFor('news', oneBadLookup), 'orange');
  assert.equal(ui.gradeFor('voice', oneBadLookup), 'green', 'calls are unaffected by a lookup');
  assert.equal(ui.gradeFor('streaming', oneBadLookup), 'green');
});

c.test('classify MUST return the stored grade WHEN the row carries grades', () => {
  // A row's stored grades are used in preference to regrading it.
  const sample = {probes: healthy(), grades: {voice: 'red', news: 'green', streaming: 'green'}};
  assert.equal(ui.classify(sample), 'red', 'the stored grade wins');
});

// Nothing else checks the wiring between the two modules: a function removed from ui.js
// surfaces only when a session refuses to start.
c.test('ui.js MUST export every function main.js calls WHEN the call sites are read', async () => {
  const {readFileSync} = await import('node:fs');
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const called = [...new Set([...main.matchAll(/\bui\.([a-zA-Z_$][\w$]*)\s*\(/g)].map(m => m[1]))];
  assert.ok(called.length > 10, `found the call sites: ${called.length}`);
  const missing = called.filter(name => typeof ui[name] !== 'function');
  assert.deepEqual(missing, [], `main.js calls ui functions that do not exist: ${missing.join(', ')}`);
});

c.test('grade.js MUST export every name the modules import from it WHEN the imports are read', async () => {
  const {readFileSync} = await import('node:fs');
  const g = grade;
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

e.test('sessionJson MUST round-trip the session, samples, events and probe set WHEN exporting', () => {
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

e.test('filename MUST strip quotes, commas, newlines and backslashes WHEN the session name carries them', () => {
  const sess = {id: 'a', name: 'x", y\n\\', operator: 'K,P"N', started: Date.parse('2026-09-03T06:14:00Z')};
  const f = filename(sess);
  assert.ok(!/["',\n\\]/.test(f), `filename is sanitised: ${f}`);
  assert.match(f, /^wts-20260903-\d{4}-k-p-n\.json$/, f);
  assert.deepEqual(JSON.parse(sessionJson(sess, [], [])).session.name, 'x", y\n\\');
});

e.test('summarise MUST count rounds, failures, rests and percentiles WHEN given a session of rows', () => {
  const probe = (ok, ms, extra = {}) => ({ok, ms, fail: ok ? null : 'timeout', ...extra});
  const row = (i, over = {}) => ({
    seq: i, t: 1000 + i * 1000, skipped: null, round_error: null, in_pause: false,
    wake_lock: true, accuracy_class: 'gps',
    probes: {ip6: probe(true, 10 * (i + 1)), ip4: probe(false, 5, {expected: true}),
             dns: probe(true, 100), dns_ctl: probe(true, 20), web: probe(true, 30),
             udp: probe(true, 15),
             down: probe(true, 400, {bps: 1e6 * (i + 1), bytes: 250000,
                                     saturated: i > 8})},
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
  assert.ok(sum.probes.down.bps_p10 < sum.probes.down.bps_p50,
            'the rate has a low end reported separately');
  assert.equal(sum.probes.down.bps_p50 != null, true,
               'summarising the rate the grades were taken on');
  assert.equal(sum.probes.down.rated, 11, 'every round that measured a rate is counted');
  assert.equal(sum.probes.down.saturated, 2, 'and the rounds that only proved the ceiling');
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

e.test('counts and countsAsFailure MUST return the same verdict WHEN given the same probe result', async () => {
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

e.test('summarise MUST count each skip event as a skipped slot WHEN the session records them', () => {
  const rows = [0, 1].map(seq => ({seq, probes: {ip6: {ok: true, ms: 20}}}));
  const events = [{type: 'skip', round: 1, running_ms: 16000, waiting_on: ['down']},
                  {type: 'mark', text: 'mark 1'}];
  const sum = summarise(rows, events);
  assert.equal(sum.skipped, 1);
  assert.equal(sum.ran, 2, 'a skip writes no row, so every row ran');
});

await e.run();
