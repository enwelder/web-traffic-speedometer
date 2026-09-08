// Seven probes run in parallel every round, each isolating a different layer.
//
// ip6/ip4 use address literals, so no name resolution happens. On an IPv6-only carrier
// (NAT64/DNS64) ip4 cannot work: iOS has no CLAT and depends on DNS64 synthesising an
// address during lookup, which a literal skips. Availability is established once per
// session by checkIpv4.
//
// dns requests a random <label>.github.io. The wildcard record and the *.github.io
// certificate make any label valid, so the resolver must perform an uncached lookup.
// dns_ctl requests a fixed label at the same destination, whose name stays cached for an
// hour, so dns failing while dns_ctl succeeds isolates resolution with the destination
// held constant.

// The download probe answers which band the link is in, not how fast it is, and reports a
// bound: what the bytes that arrived prove the link can carry. The request asks for what
// clears the top grading edge over a 500 ms window, and nothing beyond it is ever read, so a
// fast link pays for the whole body and a slow one stops at the budget having transferred
// whatever it managed — the same measurement from fewer bytes.
export const DOWNLOAD_REQUEST_BYTES = 625000;   // 10 Mb/s sustained for 500 ms
// iOS opens a fresh connection for the download every round, and a fresh connection delivers
// its first bytes at the congestion window's pace rather than the link's. This request is
// spent opening that window so that the measured one sees the link. Without it a 5G cell a
// reference test clocked at 350 Mb/s measured 7 Mb/s here, which is the ramp, not the link.
export const WARMUP_REQUEST_BYTES = 96000;
export const DEFAULT_DOWN_BUDGET_MS = 2000;
// Added to a duration taken from the wall clock, which brackets more than the body. Resource
// timing reports the body's own span, and is charged nothing.
export const DOWN_SLACK_MS = 50;
// Applies to every TCP probe. Small probes have been observed succeeding at 3885 ms, so a
// lower ceiling records slow-but-working rounds as failures.
export const TIMEOUT_MS = 8000;
export const STUN_TIMEOUT_MS = 3000;      // UDP answers within a round trip or not at all
export const MIN_TIMEOUT_MS = 1000;

// A probe whose connection has stopped carrying traffic fails every round while its peers
// succeed. Safari cannot be told to open a fresh connection, so the probe stops running for
// STUCK_COOLDOWN rounds and the browser retires the connection on idle.
export const STUCK_AFTER = 3;
export const STUCK_COOLDOWN = 6;
export const STUN_SERVER = 'stun:stun.cloudflare.com:3478';
export const IPV4_PREFLIGHT_MS = 2000;

// `label` names the test performed, not what it is used for: a probe measures one thing and
// the purposes in grade.js decide what that means. It travels in the recording so a reader
// does not have to infer the test from a URL.
export const PROBES = [
  // Probes with `samples` run repeatedly within the round; `ms` is the median of the
  // samples that fit in the budget and every sample is kept.
  {id: 'ip6',     label: 'GET to an IPv6 literal, no lookup',   kind: 'trace',  url: 'https://[2606:4700:4700::1111]/cdn-cgi/trace', samples: 3},
  {id: 'ip4',     label: 'GET to an IPv4 literal, no lookup',   kind: 'trace',  url: 'https://1.1.1.1/cdn-cgi/trace'},
  {id: 'dns',     label: 'HEAD to a name no resolver has seen', kind: 'opaque', url: 'https://%RANDOM%.github.io/',      method: 'HEAD'},
  // Sampled like the other latency probes, so their medians cover the same thing.
  {id: 'dns_ctl', label: 'HEAD to that host under a cached name', kind: 'opaque', url: 'https://wts-dns-control.github.io/', method: 'HEAD', samples: 3},
  {id: 'web',     label: 'HEAD to a host the phone knows',       kind: 'opaque', url: 'https://www.gstatic.com/generate_204', samples: 3},
  {id: 'down',    label: 'timed body read, reported as a bound', kind: 'download', url: 'https://speed.cloudflare.com/__down', bytes: DOWNLOAD_REQUEST_BYTES},
  // The only probe over UDP, which is what streaming and calls use. A carrier can treat UDP
  // differently from TCP, and the address reported is the NAT mapping for that transport.
  {id: 'udp',     label: 'STUN binding request over UDP',       kind: 'stun',   url: STUN_SERVER, samples: 3}
];

const rand = () => {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
};

function parseTrace(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

// Checks that the body is the one Cloudflare produced for this request. A middlebox
// answering on its behalf, or rewriting the Host in transit, is reported as a parse
// failure with a reason.
function validateTrace(trace, url) {
  if (!trace.ip || !trace.colo) return 'missing fields';
  if (!IPV4.test(trace.ip) && !IPV6.test(trace.ip)) return 'egress is not an address';
  if (!/^[A-Z]{3}$/.test(trace.colo)) return 'colo is not a PoP code';
  if (trace.visit_scheme && trace.visit_scheme !== 'https') return `scheme downgraded to ${trace.visit_scheme}`;
  if (trace.h && trace.h !== new URL(url).host) return `host rewritten to ${trace.h}`;
  return null;
}

// Cloudflare's view of the connection: RTT in microseconds, retransmits, losses, delivery
// rate and congestion window. Under congestion retrans and cwnd move while reachability
// holds.
function parseServerTiming(header) {
  if (!header) return null;
  const m = /cfL4;desc="([^"]*)"/.exec(header);
  if (!m) return null;
  const q = new URLSearchParams(m[1].replace(/^\?/, ''));
  const num = k => (q.has(k) ? Number(q.get(k)) : null);
  return {
    rtt_us: num('rtt'), min_rtt_us: num('min_rtt'), rtt_var_us: num('rtt_var'),
    lost: num('lost'), retrans: num('retrans'),
    delivery_rate: num('delivery_rate'), cwnd: num('cwnd')
  };
}

// On a reused connection the spec sets connectStart, connectEnd and secureConnectionStart
// all equal to fetchStart, so a handshake is indicated by a connect window with a TLS phase
// inside it rather than by a non-zero secureConnectionStart. These fields are zeroed
// cross-origin unless the server sends timing-allow-origin; of the seven endpoints only the
// download one does.
async function readTiming(url) {
  // The entry is queued at responseEnd and is sometimes not visible when the body resolves;
  // without the retry, TTFB is undefined at random.
  let e = null;
  for (let i = 0; i < 3 && !e; i++) {
    e = performance.getEntriesByName(url, 'resource').pop() || null;
    if (!e) await new Promise(r => setTimeout(r, 0));
  }
  if (!e || !e.responseStart) return null;
  const reused = e.connectEnd === e.connectStart;
  const ms = (a, b) => (a > 0 && b > 0 && b >= a ? Math.round(b - a) : null);
  return {
    // The phases before the payload starts. On the download endpoint they cover most of the
    // request, so a rate computed over the whole request includes the handshake.
    lookup_ms: ms(e.domainLookupStart, e.domainLookupEnd),
    connect_ms: reused ? 0 : ms(e.connectStart, e.connectEnd),
    tls_ms: reused ? 0 : ms(e.secureConnectionStart, e.connectEnd),
    ttfb_ms: Math.round(e.responseStart - e.requestStart),
    transfer_ms: Math.round(e.responseEnd - e.responseStart),
    handshake: !reused && e.secureConnectionStart > 0 && e.secureConnectionStart < e.connectEnd,
    reused,
    protocol: e.nextHopProtocol || null
  };
}

function probeUrl(probe) {
  const base = probe.id === 'dns' ? probe.url.replace('%RANDOM%', rand())
             : probe.bytes ? `${probe.url}?bytes=${probe.bytes}`
             : probe.url;
  return base + (base.includes('?') ? '&' : '?') + '_=' + Date.now() + rand().slice(0, 4);
}

// A resolver that gets no answer retries on a fixed timer, so a lookup time within
// tolerance of one of those timers indicates packet loss rather than a slow lookup.
const RETRY_TIMERS_MS = [2000, 5000];
const RETRY_TOLERANCE_MS = 300;
export function looksLikeRetry(ms) {
  return ms != null && RETRY_TIMERS_MS.some(t => Math.abs(ms - t) <= RETRY_TOLERANCE_MS);
}

// `fail` carries the reason: timeout | network | http | parse | abort. `ms` is set on
// failure too, since how long a probe took to fail separates a refused connection from a
// link that hung until the deadline. One attempt; runProbe adds repetition for probes that
// ask for samples.
async function runOnce(probe, {timeoutMs = TIMEOUT_MS, signal, download = {}} = {}) {
  if (probe.kind === 'stun') return runStun(probe, {timeoutMs, signal});
  const r = {ok: false, ms: null, status: null, fail: null};
  const ctl = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const relay = () => ctl.abort();
  if (signal) signal.addEventListener('abort', relay, {once: true});

  const url = probeUrl(probe);
  if (probe.id === 'dns' || probe.id === 'dns_ctl') r.host = new URL(url).hostname;
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);

  try {
    const res = await fetch(url, {
      method: probe.method || 'GET',
      mode: probe.kind === 'opaque' ? 'no-cors' : 'cors',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: ctl.signal
    });

    if (probe.kind === 'opaque') {
      // An opaque response has no readable status, so success means the request completed.
      markElapsed(r, probe, elapsed());
      r.ok = true;
      return r;
    }

    r.status = res.status;
    if (!res.ok) { r.ms = elapsed(); r.fail = 'http'; return r; }

    if (probe.kind === 'download') {
      return {...r, ...await readDownload(res, {url, elapsed, controller: ctl, ...download})};
    }

    const trace = parseTrace(await res.text());
    markElapsed(r, probe, elapsed());
    return finishTrace(r, trace, url);
  } catch (e) {
    r.ms = elapsed();
    r.fail = e && e.name === 'AbortError' ? (timedOut ? 'timeout' : 'abort') : 'network';
    return r;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relay);
  }
}

// The dns probe is the only one whose duration can be a resolver's retry timer, so the flag
// is set wherever its duration is taken.
function markElapsed(r, probe, ms) {
  r.ms = ms;
  if (probe.id === 'dns' && looksLikeRetry(ms)) r.retry_suspected = true;
  return r;
}

function finishTrace(r, trace, url) {
  const bad = validateTrace(trace, url);
  if (bad) { r.fail = 'parse'; r.parse_reason = bad; return r; }
  r.ok = true;
  r.egress_ip = trace.ip;
  r.colo = trace.colo;
  return r;
}

// Returned instead of a chunk when the budget ran out first.
const EXPIRED = Symbol('expired');

// One chunk, or EXPIRED. The budget bounds each read and not just the loop: checking only
// between chunks leaves a stalled stream running to the fetch timeout, which records a
// congested cell as a failure instead of as a slow measurement.
async function readWithin(reader, ms) {
  let timer;
  const budget = new Promise(resolve => { timer = setTimeout(() => resolve(EXPIRED), ms); });
  try {
    return await Promise.race([reader.read(), budget]);
  } finally {
    clearTimeout(timer);
  }
}

// Stops the rest of an unfinished body from arriving unread. Not awaited: a cancel that never
// settles would hang the round.
function cancelQuietly(reader) {
  if (!reader) return;
  try { reader.cancel(); } catch { /* already closed */ }
}

// Reads the body to its end, or until the budget runs out, and reports how much arrived and
// why it stopped: eof | time | aborted | network. The response carries exactly the bytes that
// were asked for, so a healthy link reaches eof and nothing is aborted.
async function readStream(res, {budgetMs, controller}) {
  const t0 = performance.now();
  let bytes = 0;
  let reason = 'eof';
  let truncated = false;
  let fail = null;

  let reader = null;
  try {
    reader = res.body.getReader();
    const stopAt = t0 + budgetMs;
    for (;;) {
      const left = stopAt - performance.now();
      if (left <= 0) { reason = 'time'; break; }
      const next = await readWithin(reader, left);
      if (next === EXPIRED) { reason = 'time'; break; }
      if (next.done) break;
      bytes += next.value.byteLength;
    }
  } catch (e) {
    truncated = true;
    // The reason comes from the error rather than from the caller's timeout flag, which was
    // captured before the read began.
    const aborted = e?.name === 'AbortError';
    reason = aborted ? 'aborted' : 'network';
    fail = aborted ? 'abort' : 'network';
  }
  cancelQuietly(reader);
  if (reason !== 'eof') controller.abort();

  // Wall clock: a stream that stalled spent that time, and charging it makes the bound
  // smaller, which is the safe direction.
  return {bytes, reason, truncated, fail, duration: Math.round(performance.now() - t0)};
}

// What the transfer proves the link carries, and never more. Every uncertainty is charged
// against the figure, so slow start, the browser handing the body over in lumps and clock
// jitter can only make it smaller — which is why none of them has to be corrected for.
//
// `bodyMs` is the body's own span from resource timing and is used as measured. Without it
// the wall clock stands in, bracketing connection setup as well, with the slack added on top.
function boundFrom(bytes, bodyMs, wallMs) {
  const ms = bodyMs != null && bodyMs > 0 ? bodyMs : wallMs + DOWN_SLACK_MS;
  return ms > 0 ? Math.round((bytes * 8) / (ms / 1000)) : null;
}

// The download probe's fields. `elapsed` is the caller's clock, so `ms` covers the whole
// request rather than the read alone.
async function readDownload(res, {url, elapsed, controller, budgetMs}) {
  const server = parseServerTiming(res.headers.get('server-timing'));
  const stream = await readStream(res, {controller, budgetMs: budgetMs ?? DEFAULT_DOWN_BUDGET_MS});
  // Present only for a body read to its end: WebKit files no entry for an aborted fetch.
  const timing = await readTiming(url) || {};
  const out = {
    ms: elapsed(),
    bytes: stream.bytes,
    duration_ms: stream.duration,
    aborted_reason: stream.reason,
    truncated: stream.truncated,
    // Whether the body arrived whole. A bound from a partial body is still true, but it is a
    // floor rather than close to the rate.
    complete: stream.reason === 'eof',
    bps_min: boundFrom(stream.bytes, timing.transfer_ms, stream.duration),
    server,
    ...timing,
    ok: stream.bytes > 0 && !stream.truncated,
    fail: stream.fail,
    colo: res.headers.get('cf-meta-colo') || null,
    egress_ip: res.headers.get('cf-meta-ip') || null
  };
  if (!out.ok && !out.fail) {
    // 'stalled': headers came back and the budget ran out with no payload, which is a
    // congested cell. 'empty': the body ended with no bytes, so something answered for the
    // endpoint with nothing to send.
    out.fail = stream.reason === 'time' ? 'stalled'
             : stream.reason === 'eof' ? 'empty' : 'network';
  }
  return out;
}

const median = xs => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2);
};

// A download rejecting before any response says nothing about which side refused. Repeating
// it as an opaque request separates them, because a response this origin is not allowed to
// read still counts as a success: opaque success means the server answered without the
// headers that let us read it, opaque failure means the connection never opened. The repeat
// carries no `bytes`, so the endpoint sends an empty body.
async function whoRefused(probe, opts) {
  const r = await runOnce({...probe, id: 'down_probe_check', kind: 'opaque', bytes: 0},
                          {...opts, timeoutMs: MIN_TIMEOUT_MS});
  return r.ok ? 'server' : 'connection';
}

// Two requests: the first opens the congestion window, the second is measured over it. A link
// too slow to finish the first one quickly has no window to escape, because the link itself is
// the limit from the first packet — so there the first request is the measurement and the
// second is skipped, which is also what keeps a slow round cheap.
async function measureDownload(probe, opts) {
  const budgetMs = opts.download?.budgetMs ?? DEFAULT_DOWN_BUDGET_MS;
  const started = performance.now();
  const warm = await runOnce({...probe, id: 'down_warmup', bytes: WARMUP_REQUEST_BYTES},
                             {...opts, download: {...opts.download, budgetMs}});
  const spent = performance.now() - started;
  if (!warm.ok || spent > budgetMs * 0.4) {
    warm.warmup_only = true;
    return warm;
  }
  return runOnce(probe, {...opts, download: {...opts.download, budgetMs: budgetMs - spent}});
}

// A probe that asks for samples is run repeatedly inside one deadline; `ms` becomes the
// median and every sample is kept alongside. Repetition stops at the first failure, which
// leaves the remaining budget to the rest of the round.
export async function runProbe(probe, opts = {}) {
  if (probe.kind === 'download') {
    const r = await measureDownload(probe, opts);
    if (r.fail === 'network') r.refused_by = await whoRefused(probe, opts);
    return r;
  }
  if (!probe.samples || probe.samples < 2) return runOnce(probe, opts);

  const budget = opts.timeoutMs ?? TIMEOUT_MS;
  const deadline = performance.now() + budget;
  const runs = [];
  let slowest = 0;
  for (let i = 0; i < probe.samples; i++) {
    const left = deadline - performance.now();
    // A sample the remaining budget cannot hold is skipped: one timing out only because it
    // was given less time than its predecessors marks the whole probe failed.
    if (i > 0 && left < Math.max(MIN_TIMEOUT_MS, slowest)) break;
    const r = await runOnce(probe, {...opts, timeoutMs: left});
    runs.push(r);
    slowest = Math.max(slowest, r.ms ?? 0);
    if (!r.ok) break;
  }

  const last = runs[runs.length - 1];
  const good = runs.filter(r => r.ok).map(r => r.ms);
  last.ms_samples = runs.map(r => r.ms);
  last.samples_ok = good.length;
  if (good.length) {
    last.ms = median(good);
    // The median alone hides a spread like 52-4275 ms within one round.
    last.ms_min = Math.min(...good);
    last.ms_max = Math.max(...good);
  }
  return last;
}

// Run once per session: on an IPv6-only network the ip4 probe would otherwise report the
// same failure every round.
export async function checkIpv4(signal) {
  const probe = PROBES.find(p => p.id === 'ip4');
  const r = await runProbe(probe, {timeoutMs: IPV4_PREFLIGHT_MS, signal});
  return {available: r.ok, ms: r.ms, fail: r.fail};
}

// Every deadline is capped by the interval: a probe outliving its round stacks rounds on
// top of each other and the cadence drifts. A download cut short at the deadline still
// reports what it pulled.
export function timeoutFor(probe, intervalMs) {
  const base = probe.kind === 'stun' ? STUN_TIMEOUT_MS : TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(base, intervalMs - 500));
}

// ICE gathering against a STUN server only: no data channel, no track and no remote
// description, so no peer connection is established and nothing can be sent. The server sees
// a binding request carrying no payload. Every server-reflexive candidate is kept: a
// dual-stack network reports one per address family, and the pair is the UDP NAT mapping.
function runStun(probe, {timeoutMs, signal}) {
  const r = {ok: false, ms: null, status: null, fail: null, public_ips: [], candidates: 0};
  // Flagged `expected`, like an absent IPv4 path: a browser without WebRTC would otherwise
  // mark every round degraded and hold the real-time grade on red.
  if (typeof RTCPeerConnection === 'undefined') {
    r.fail = 'unsupported';
    r.expected = true;
    return Promise.resolve(r);
  }

  const t0 = performance.now();
  let pc;
  try {
    pc = new RTCPeerConnection({iceServers: [{urls: probe.url}]});
  } catch (e) {
    r.fail = 'network';
    r.parse_reason = String(e && e.message || e);
    return Promise.resolve(r);
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = fail => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { pc.close(); } catch { /* already closed */ }
      if (!r.ok) r.fail = fail;
      resolve(r);
    };
    const onAbort = () => finish('abort');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, {once: true});

    pc.onicecandidate = e => {
      // No candidate means gathering has finished. Without a server-reflexive candidate
      // there is no UDP path out.
      if (!e.candidate) return finish(r.public_ips.length ? null : 'no_srflx');
      r.candidates++;
      if (e.candidate.type !== 'srflx') return;
      const address = e.candidate.address;
      if (address && !r.public_ips.includes(address)) r.public_ips.push(address);
      if (!r.ok) { r.ok = true; r.ms = Math.round(performance.now() - t0); }
    };

    pc.addTransceiver('audio', {direction: 'recvonly'});
    pc.createOffer()
      .then(o => pc.setLocalDescription(o))
      .catch(e => { r.parse_reason = String(e && e.message || e); finish('network'); });
  });
}

export async function runRound({signal, download = {}, intervalMs = 5000,
                                ipv4Available = true, resting = null} = {}) {
  const results = await Promise.all(PROBES.map(p => {
    // A resting probe still produces a row, so the round is complete and carries the reason
    // instead of another timeout.
    if (resting?.has(p.id)) {
      return Promise.resolve({ok: false, ms: null, status: null, fail: 'resting', stuck: true});
    }
    return runProbe(p, {signal, download, timeoutMs: timeoutFor(p, intervalMs)});
  }));
  const out = {};
  PROBES.forEach((p, i) => {
    const r = results[i];
    // An IPv4 literal on an IPv6-only network is a known-absent path.
    if (p.id === 'ip4' && !r.ok && !ipv4Available) r.expected = true;
    out[p.id] = r;
  });
  return out;
}

// The resource timing buffer defaults to 250 entries; at seven probes a round it fills
// within two minutes, after which it stops recording and handshake detection stops with it.
export function clearTimings() {
  performance.clearResourceTimings();
}
