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

// A 250 kB body completes inside TCP slow start, so its implied rate measures how fast the
// congestion window ramps: 4 Mb/s on 5G. The download pulls for a fixed span instead,
// discards the ramp and rates the remainder.
export const DOWNLOAD_REQUEST_BYTES = 50000000;   // requested; the transfer is aborted long before this arrives
export const DEFAULT_DOWN_BUDGET_MS = 2000;
export const DEFAULT_DOWN_MAX_BYTES = 5000000;
// The ramp ends at whichever of these two thresholds is reached later.
export const WARMUP_MS = 500;
export const WARMUP_BYTES = 131072;
// Lower bound on the rated span, set by clock resolution. It has to stay reachable when the
// byte ceiling ends the transfer within a few hundred milliseconds.
export const MIN_STEADY_MS = 100;
export const PEAK_WINDOW_MS = 500;
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

export const PROBES = [
  // Probes with `samples` run repeatedly within the round; `ms` is the median of the
  // samples that fit in the budget and every sample is kept.
  {id: 'ip6',     label: 'no DNS · v6', kind: 'trace',    url: 'https://[2606:4700:4700::1111]/cdn-cgi/trace', samples: 3},
  {id: 'ip4',     label: 'no DNS · v4', kind: 'trace',    url: 'https://1.1.1.1/cdn-cgi/trace'},
  {id: 'dns',     label: 'DNS fresh',   kind: 'opaque',   url: 'https://%RANDOM%.github.io/',      method: 'HEAD'},
  // Sampled like the other latency probes, so their medians cover the same thing.
  {id: 'dns_ctl', label: 'DNS cached',  kind: 'opaque',   url: 'https://wts-dns-control.github.io/', method: 'HEAD', samples: 3},
  {id: 'web',     label: 'other net',   kind: 'opaque',   url: 'https://www.gstatic.com/generate_204', samples: 3},
  {id: 'down',    label: 'throughput',  kind: 'download', url: 'https://speed.cloudflare.com/__down'},
  // The only probe over UDP, which is what streaming and calls use. A carrier can treat UDP
  // differently from TCP, and the address reported is the NAT mapping for that transport.
  {id: 'udp',     label: 'UDP',         kind: 'stun',     url: STUN_SERVER, samples: 3}
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
             : probe.id === 'down' ? `${probe.url}?bytes=${DOWNLOAD_REQUEST_BYTES}`
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
  const since = () => Math.round(performance.now() - t0);

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
      r.ok = true;
      r.ms = since();
      if (probe.id === 'dns' && looksLikeRetry(r.ms)) r.retry_suspected = true;
      return r;
    }

    r.status = res.status;
    if (!res.ok) { r.ms = since(); r.fail = 'http'; return r; }

    if (probe.kind === 'download') return await readDownload(res, r, url, since, timedOut, ctl, download);

    const trace = parseTrace(await res.text());
    r.ms = since();
    if (probe.id === 'dns' && looksLikeRetry(r.ms)) r.retry_suspected = true;
    const bad = validateTrace(trace, url);
    if (bad) { r.fail = 'parse'; r.parse_reason = bad; return r; }
    r.ok = true;
    r.egress_ip = trace.ip;
    r.colo = trace.colo;
    return r;
  } catch (e) {
    r.ms = since();
    r.fail = e && e.name === 'AbortError' ? (timedOut ? 'timeout' : 'abort') : 'network';
    return r;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relay);
  }
}

// Reads for `budgetMs` or until `maxBytes`, discards the ramp and rates the remainder. The
// request asks for far more than will be read, so the transfer is aborted when the read
// ends.
async function readDownload(res, r, url, since, timedOut, ctl, opts) {
  const budgetMs = opts.budgetMs ?? DEFAULT_DOWN_BUDGET_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_DOWN_MAX_BYTES;
  const server = parseServerTiming(res.headers.get('server-timing'));
  const t0 = performance.now();
  // One mark per chunk; every figure below is derived from this series.
  const marks = [{t: 0, bytes: 0}];
  let bytes = 0;
  let reason = 'eof';
  let truncated = false;

  let reader = null;
  try {
    reader = res.body.getReader();
    // The budget bounds each read, not just the loop: checking only between chunks leaves a
    // stalled stream running to the fetch timeout, recording a congested cell as a failure
    // instead of a slow measurement.
    const stopAt = t0 + budgetMs;
    for (;;) {
      const left = stopAt - performance.now();
      if (left <= 0) { reason = 'time'; break; }
      let timer;
      const expired = Symbol('expired');
      const budget = new Promise(r => { timer = setTimeout(() => r(expired), left); });
      const next = await Promise.race([reader.read(), budget]);
      clearTimeout(timer);
      if (next === expired) { reason = 'time'; break; }
      if (next.done) { reason = 'eof'; break; }
      bytes += next.value.byteLength;
      marks.push({t: performance.now() - t0, bytes});
      if (bytes >= maxBytes) { reason = 'bytes'; break; }
    }
  } catch (e) {
    truncated = true;
    // The reason comes from the error; the timeout flag was captured before the read began.
    reason = e && e.name === 'AbortError' ? 'aborted' : 'network';
    r.fail = e && e.name === 'AbortError' ? 'abort' : 'network';
  }
  // Stops the rest of the 50 MB body from arriving unread. Not awaited: a cancel that never
  // settles would hang the round.
  if (reader) { try { reader.cancel(); } catch { /* already closed */ } }
  if (reason !== 'eof') ctl.abort();

  // Wall clock rather than the last chunk's timestamp, so time spent stalled is charged to
  // the rate.
  const duration = Math.round(performance.now() - t0);
  r.ms = since();
  r.bytes = bytes;
  r.duration_ms = duration;
  r.aborted_reason = reason;
  r.truncated = truncated;
  r.server = server;
  Object.assign(r, await readTiming(url) || {});

  const warm = warmupMark(marks, duration, reason);
  r.warmup_ms = warm ? Math.round(warm.t) : null;
  r.warmup_bytes = warm ? warm.bytes : null;

  const steadyMs = warm ? duration - warm.t : 0;
  // Needs enough wall clock to divide by, and enough of the transfer outside the ramp.
  if (!warm || steadyMs < MIN_STEADY_MS || steadyMs < duration / 3) {
    // Nothing outside the ramp to rate.
    r.bps_steady = null;
    r.insufficient_sample = true;
  } else {
    r.bps_steady = Math.round(((bytes - warm.bytes) * 8) / (steadyMs / 1000));
    r.insufficient_sample = false;
  }
  // The peak window has to fit inside the steady portion, or it includes the ramp and
  // reports a peak below the sustained rate. Under three marks the window spans one or two
  // chunks, which yields anything from 14 kb/s on a 10-byte body to 7.5 Gb/s on a chunk the
  // browser had already buffered.
  r.bps_peak = r.insufficient_sample || marks.length < 3 ? null
             : bestWindow(marks, Math.min(PEAK_WINDOW_MS, Math.max(100, duration / 3)));

  r.ok = bytes > 0 && !truncated;
  if (!r.ok && !r.fail) {
    // 'stalled': headers came back and the budget ran out with no payload, which is a
    // congested cell. 'empty': the body ended with no bytes, so something answered for the
    // endpoint with nothing to send.
    r.fail = reason === 'time' ? 'stalled' : reason === 'eof' ? 'empty' : 'network';
  }
  r.colo = res.headers.get('cf-meta-colo') || null;
  r.egress_ip = res.headers.get('cf-meta-ip') || null;
  return r;
}

// Where the ramp ends. A fixed 500 ms gate fails at both extremes: on a fast link the byte
// ceiling arrives first (5 MB in 300 ms at 133 Mb/s), and on a very slow one 128 kB never
// arrives inside the budget.
function warmupMark(marks, duration, reason) {
  // The time requirement is capped at a third of the transfer, so a rated span always remains.
  const gate = Math.min(WARMUP_MS, duration / 3);
  const found = marks.find(m => m.t >= gate && m.bytes >= WARMUP_BYTES);
  if (found) return found;

  // Under 128 kB in the whole budget: the link rather than the congestion window is the
  // limit, so only the first quarter of the transfer is discarded.
  if (reason === 'time' && marks[marks.length - 1].bytes > 0) {
    return marks.find(m => m.t >= duration * 0.25) || null;
  }
  return null;
}

// The highest sustained rate over any window of the given width.
function bestWindow(marks, widthMs) {
  let best = null;
  for (let i = 0, j = 1; j < marks.length; j++) {
    // At least one interval always stays inside the window: closing it whenever two chunks
    // are further apart than the width reports no peak, or one below the sustained rate, for
    // the bursty delivery iOS produces on a fast link.
    while (j - i > 1 && marks[j].t - marks[i].t > widthMs) i++;
    const span = marks[j].t - marks[i].t;
    if (span <= 0) continue;
    const bps = ((marks[j].bytes - marks[i].bytes) * 8) / (span / 1000);
    if (best == null || bps > best) best = bps;
  }
  return best == null ? null : Math.round(best);
}

const median = xs => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2);
};

// A probe that asks for samples is run repeatedly inside one deadline; `ms` becomes the
// median and every sample is kept alongside. Repetition stops at the first failure, which
// leaves the remaining budget to the rest of the round.
export async function runProbe(probe, opts = {}) {
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
