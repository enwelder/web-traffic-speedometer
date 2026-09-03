// Six probes run in parallel every round, each isolating a different layer.
//
// ip6/ip4 use address literals, so no name resolution happens at all — that is what makes
// them a clean read on the radio link. On an IPv6-only carrier (NAT64/DNS64, the normal
// Dutch mobile configuration) ip4 cannot work: iOS has no CLAT, so it relies on DNS64
// synthesising an address during lookup, and a literal skips lookup entirely. Availability
// is therefore established once per session rather than rediscovered every round.
//
// dns requests a random <label>.github.io. The wildcard record and the *.github.io
// certificate make any label valid, so the carrier's resolver must perform a lookup it
// cannot have cached. dns_ctl requests a fixed label at the same destination, whose name
// stays cached for an hour — so dns failing while dns_ctl succeeds is a resolution failure
// and nothing else, with the destination held constant.

export const DOWNLOAD_SIZES = [100000, 250000, 500000];
export const DEFAULT_DOWNLOAD_BYTES = 250000;
// 8 s for everything that uses TCP. Journey data showed small probes succeeding at 3885 ms
// against a 4000 ms ceiling, so the old limit was recording slow-but-working rounds as
// failures and destroying the distinction between slow and gone.
export const TIMEOUT_MS = 8000;
export const STUN_TIMEOUT_MS = 3000;      // UDP either answers quickly or not at all
export const MIN_TIMEOUT_MS = 1000;

// A probe whose connection has wedged fails every round while its peers succeed. Safari
// cannot be told to open a fresh connection, so recovery is to stop asking for a while and
// let the browser retire the connection on idle.
export const STUCK_AFTER = 3;
export const STUCK_COOLDOWN = 6;
export const STUN_SERVER = 'stun:stun.cloudflare.com:3478';
export const IPV4_PREFLIGHT_MS = 2000;

export const PROBES = [
  // Repeated within the round: a single round trip is noisy, so the reported figure is the
  // median of the samples that fit in the budget, with every sample kept.
  {id: 'ip6',     label: 'no DNS · v6', kind: 'trace',    url: 'https://[2606:4700:4700::1111]/cdn-cgi/trace', samples: 3},
  {id: 'ip4',     label: 'no DNS · v4', kind: 'trace',    url: 'https://1.1.1.1/cdn-cgi/trace'},
  {id: 'dns',     label: 'DNS fresh',   kind: 'opaque',   url: 'https://%RANDOM%.github.io/',      method: 'HEAD'},
  {id: 'dns_ctl', label: 'DNS cached',  kind: 'opaque',   url: 'https://wts-dns-control.github.io/', method: 'HEAD'},
  {id: 'web',     label: 'other net',   kind: 'opaque',   url: 'https://www.gstatic.com/generate_204'},
  {id: 'down',    label: 'throughput',  kind: 'download', url: 'https://speed.cloudflare.com/__down'},
  // The only probe that leaves over UDP. Streaming and calls use UDP, and a carrier can
  // treat it differently from TCP, so a UDP path that fails while TCP holds is its own
  // finding — and the address it reports is the NAT mapping for a different transport.
  {id: 'udp',     label: 'UDP',         kind: 'stun',     url: STUN_SERVER}
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

// The body has to be the one Cloudflare produces for the request that was actually made,
// not merely trace-shaped. A middlebox answering on its behalf, or rewriting the Host on
// the way through, shows up here rather than as a plausible-looking measurement.
function validateTrace(trace, url) {
  if (!trace.ip || !trace.colo) return 'missing fields';
  if (!IPV4.test(trace.ip) && !IPV6.test(trace.ip)) return 'egress is not an address';
  if (!/^[A-Z]{3}$/.test(trace.colo)) return 'colo is not a PoP code';
  if (trace.visit_scheme && trace.visit_scheme !== 'https') return `scheme downgraded to ${trace.visit_scheme}`;
  if (trace.h && trace.h !== new URL(url).host) return `host rewritten to ${trace.h}`;
  return null;
}

// Cloudflare's own view of the connection: RTT in microseconds, retransmits, losses,
// delivery rate and congestion window. Congestion looks different from a coverage gap
// here — retrans and cwnd move while reachability does not.
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
// all equal to fetchStart, so a non-zero secureConnectionStart does not imply a handshake —
// only a connect window with a TLS phase inside it does. These fields are zeroed
// cross-origin unless the server sends timing-allow-origin, which of the six endpoints only
// the download one does.
async function readTiming(url) {
  // The entry is queued at responseEnd and is occasionally not visible yet when the body
  // finishes resolving; without the retry, TTFB comes back undefined at random.
  let e = null;
  for (let i = 0; i < 3 && !e; i++) {
    e = performance.getEntriesByName(url, 'resource').pop() || null;
    if (!e) await new Promise(r => setTimeout(r, 0));
  }
  if (!e || !e.responseStart) return null;
  const reused = e.connectEnd === e.connectStart;
  return {
    ttfb_ms: Math.round(e.responseStart - e.requestStart),
    transfer_ms: Math.round(e.responseEnd - e.responseStart),
    handshake: !reused && e.secureConnectionStart > 0 && e.secureConnectionStart < e.connectEnd,
    reused,
    protocol: e.nextHopProtocol || null
  };
}

function probeUrl(probe, downloadBytes) {
  const base = probe.id === 'dns' ? probe.url.replace('%RANDOM%', rand())
             : probe.id === 'down' ? `${probe.url}?bytes=${downloadBytes}`
             : probe.url;
  return base + (base.includes('?') ? '&' : '?') + '_=' + Date.now() + rand().slice(0, 4);
}

// `fail` is the reason, never merely the fact: timeout | network | http | parse | abort.
// `ms` is filled in on failure too, since how long a probe took to fail separates a refused
// connection from a link that hung until the deadline.
// One attempt. `runProbe` wraps this with repetition for probes that ask for samples.
async function runOnce(probe, {timeoutMs = TIMEOUT_MS, signal, downloadBytes = DEFAULT_DOWNLOAD_BYTES} = {}) {
  if (probe.kind === 'stun') return runStun(probe, {timeoutMs, signal});
  const r = {ok: false, ms: null, status: null, fail: null};
  const ctl = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const relay = () => ctl.abort();
  if (signal) signal.addEventListener('abort', relay, {once: true});

  const url = probeUrl(probe, downloadBytes);
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
      // Opaque: the status is genuinely unknowable, so success means the request completed.
      r.ok = true;
      r.ms = since();
      return r;
    }

    r.status = res.status;
    if (!res.ok) { r.ms = since(); r.fail = 'http'; return r; }

    if (probe.kind === 'download') return await readDownload(res, r, url, since, timedOut);

    const trace = parseTrace(await res.text());
    r.ms = since();
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

// The body is streamed rather than awaited whole, so a download cut short by the deadline
// still yields a throughput figure — on a saturated cell that partial number is the
// measurement, and discarding it would throw away the case being investigated.
async function readDownload(res, r, url, since, timedOut) {
  const server = parseServerTiming(res.headers.get('server-timing'));
  const firstByteAt = performance.now();
  let bytes = 0;
  let truncated = false;

  try {
    const reader = res.body.getReader();
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
  } catch {
    truncated = true;
  }

  r.ms = since();
  r.bytes = bytes;
  r.truncated = truncated;
  r.server = server;
  Object.assign(r, await readTiming(url) || {});

  // Prefer the browser's own responseStart..responseEnd window; the stream loop only sees
  // the body once buffered, which on a fast link reads as near-zero time.
  const window = r.transfer_ms != null ? r.transfer_ms : Math.round(performance.now() - firstByteAt);
  r.transfer_ms = window;

  // Two rates, because they answer different questions. bps_transfer is the payload phase
  // alone, which is what a stalled article download actually experiences. bps_end_to_end
  // includes connection setup, which at small sizes is the handshake wearing a throughput
  // costume. Below a 2 ms window the clock cannot resolve the phase, so no rate is given
  // rather than an invented one; bytes and transfer_ms always stand.
  r.bps_transfer = window >= 2 && bytes > 0 ? Math.round((bytes * 8) / (window / 1000)) : null;
  r.bps_end_to_end = r.ms >= 2 && bytes > 0 ? Math.round((bytes * 8) / (r.ms / 1000)) : null;

  r.ok = bytes > 0 && !truncated;
  if (!r.ok) r.fail = truncated ? (timedOut ? 'timeout' : 'abort') : 'network';
  r.colo = res.headers.get('cf-meta-colo') || null;
  r.egress_ip = res.headers.get('cf-meta-ip') || null;
  return r;
}

const median = xs => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2);
};

// A single round trip is noise. Where a probe asks for samples, it is run repeatedly inside
// its own deadline and `ms` becomes the median; every sample is kept alongside. Repetition
// stops at the first failure, since repeating a failed probe within one round says nothing
// new and spends budget the round may still need.
export async function runProbe(probe, opts = {}) {
  if (!probe.samples || probe.samples < 2) return runOnce(probe, opts);

  const budget = opts.timeoutMs ?? TIMEOUT_MS;
  const deadline = performance.now() + budget;
  const runs = [];
  for (let i = 0; i < probe.samples; i++) {
    const left = deadline - performance.now();
    if (i > 0 && left < MIN_TIMEOUT_MS / 2) break;
    const r = await runOnce(probe, {...opts, timeoutMs: Math.max(MIN_TIMEOUT_MS / 2, left)});
    runs.push(r);
    if (!r.ok) break;
  }

  const last = runs[runs.length - 1];
  const good = runs.filter(r => r.ok).map(r => r.ms);
  last.ms_samples = runs.map(r => r.ms);
  last.samples_ok = good.length;
  if (good.length) last.ms = median(good);
  return last;
}

// Establishing this once means an IPv6-only network does not spend the rest of the session
// reporting the same failure as though it were news.
export async function checkIpv4(signal) {
  const probe = PROBES.find(p => p.id === 'ip4');
  const r = await runProbe(probe, {timeoutMs: IPV4_PREFLIGHT_MS, signal});
  return {available: r.ok, ms: r.ms, fail: r.fail};
}

// No probe may outlive its own round, or a slow stretch stacks rounds on top of each other
// and the cadence stops being a cadence. Every deadline is therefore capped by the interval,
// not only the download's. Cut short at the deadline, a download still reports what it
// managed to pull, which on a congested cell is the measurement rather than a loss.
export function timeoutFor(probe, intervalMs) {
  const base = probe.kind === 'stun' ? STUN_TIMEOUT_MS : TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(base, intervalMs - 500));
}

// ICE gathering against a STUN server, and nothing else: no data channel, no track, no
// remote description, so no peer connection is ever established and nothing can be sent
// anywhere. The server sees a binding request carrying no payload. Every server-reflexive
// candidate is kept, because a dual-stack network reports one per address family and the
// pair is the UDP NAT mapping.
function runStun(probe, {timeoutMs, signal}) {
  const r = {ok: false, ms: null, status: null, fail: null, public_ips: [], candidates: 0};
  if (typeof RTCPeerConnection === 'undefined') { r.fail = 'unsupported'; return Promise.resolve(r); }

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
    const timer = setTimeout(() => finish(r.candidates ? 'timeout' : 'timeout'), timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, {once: true});

    pc.onicecandidate = e => {
      if (!e.candidate) return finish(null);            // gathering complete
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

export async function runRound({signal, downloadBytes = DEFAULT_DOWNLOAD_BYTES,
                                intervalMs = 5000, ipv4Available = true, resting = null} = {}) {
  const results = await Promise.all(PROBES.map(p => {
    // A probe resting to clear a wedged connection still produces a row, so the round stays
    // complete and the reason is in the data rather than looking like twenty more timeouts.
    if (resting?.has(p.id)) {
      return Promise.resolve({ok: false, ms: null, status: null, fail: 'resting', stuck: true});
    }
    return runProbe(p, {signal, downloadBytes, timeoutMs: timeoutFor(p, intervalMs)});
  }));
  const out = {};
  PROBES.forEach((p, i) => {
    const r = results[i];
    // An IPv4 literal on an IPv6-only network is a known-absent path, not an outage.
    if (p.id === 'ip4' && !r.ok && !ipv4Available) r.expected = true;
    out[p.id] = r;
  });
  return out;
}

// The resource timing buffer defaults to 250 entries; at six probes a round it would fill
// within two minutes and silently stop recording, taking handshake detection with it.
export function clearTimings() {
  performance.clearResourceTimings();
}
