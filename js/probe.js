// Seven probes run in parallel every round, each isolating a different layer.
// The download follows RMBT, the method RTR-NetTest uses, at a fraction of its size: one TCP
// flow carries its receive window divided by its round trip and no more, and several
// connections carry several windows.
export const DOWN_STREAMS = 3;

// Discarded. RMBT spends two seconds here to get the radio into an active state, so a result
// does not depend on what the connection was doing beforehand.
export const DOWN_RAMP_MS = 300;
export const DOWN_RAMP_BYTES = 1000000;

// The measurement. A fixed window makes rounds comparable with each other, and a byte cap
// makes what a round costs knowable in advance. The cap sets the ceiling below.
export const DOWN_WINDOW_MS = 1500;
export const DOWN_CAP_BYTES = 4700000;

// The fastest this can report. Reaching the cap before the window closes proves the link
// carries at least this much and says nothing about how much more, so the reading saturates
// here and is flagged. 25 Mb/s is two and a half times the edge video is graded on, so a
// healthy link is always provably green.
export const DOWN_CEILING_BPS = Math.round((DOWN_CAP_BYTES * 8) / (DOWN_WINDOW_MS / 1000));

// Per stream, and only ever partly read: three of these outlast a window that stops at the
// cap. Asking for the endpoint's maximum, 99,999,999, and abandoning it every round gets the
// requests refused without CORS headers.
export const DOWN_REQUEST_BYTES = 8000000;
// Added to a deadline taken from the wall clock, which brackets more than the body.
export const DOWN_SLACK_MS = 50;
export const TIMEOUT_MS = 8000;
export const STUN_TIMEOUT_MS = 3000;      // UDP answers within a round trip or not at all
export const MIN_TIMEOUT_MS = 1000;

export const STUCK_AFTER = 3;
export const STUCK_COOLDOWN = 6;
export const STUN_SERVER = 'stun:stun.cloudflare.com:3478';
export const PREFLIGHT_MS = 2000;
export const PREFLIGHT_RETRY_MS = 1500;

// `label` names the test performed. A probe measures one thing; the activities in grade.js
// decide what it means. It travels in the recording, so the test is readable without the URL.
// A cold connection, a retransmission or a scheduling delay moves one round trip by an order
// of magnitude. RMBT takes between 10 and 200 samples and reports the median; ten puts this in
// the same range, and a latency sample is about 1.2 kB against the megabytes the download
// already spends.
const LATENCY_SAMPLES = 10;

// Each of these opens a connection to a host never used before, so a sample costs a full
// first contact — around a second on a mobile link, against tens of milliseconds for the
// others. Fewer of them, for the same round.
const FIRST_CONTACT_SAMPLES = 5;

export const PROBES = [
  // Probes with `samples` run repeatedly within the round; `ms` is the median of the
  // samples that fit in the budget and every sample is kept.
  {id: 'ip6',     label: 'GET to an IPv6 literal, no lookup',   kind: 'trace',  url: 'https://[2606:4700:4700::1111]/cdn-cgi/trace', samples: LATENCY_SAMPLES},
  {id: 'ip4',     label: 'GET to an IPv4 literal, no lookup',   kind: 'trace',  url: 'https://1.1.1.1/cdn-cgi/trace', samples: LATENCY_SAMPLES},
  // A different name every sample, so no repeat is answered from a cache and every sample
  // reaches a host never contacted before.
  {id: 'dns',     label: 'HEAD to a name no resolver has seen', kind: 'opaque', url: 'https://%RANDOM%.github.io/',      method: 'HEAD', samples: FIRST_CONTACT_SAMPLES, fresh: true},
  // Sampled like the other latency probes, so their medians cover the same thing.
  {id: 'dns_ctl', label: 'HEAD to that host under a cached name', kind: 'opaque', url: 'https://wts-dns-control.github.io/', method: 'HEAD', samples: LATENCY_SAMPLES},
  {id: 'web',     label: 'HEAD to a host the phone knows',       kind: 'opaque', url: 'https://www.gstatic.com/generate_204', samples: LATENCY_SAMPLES},
  {id: 'down',    label: 'parallel streams, read for a fixed window', kind: 'download', url: 'https://speed.cloudflare.com/__down', bytes: DOWN_REQUEST_BYTES},
  // The only probe over UDP, which is what streaming and calls use. A carrier can treat UDP
  // differently from TCP, and the address reported is the NAT mapping for that transport.
  {id: 'udp',     label: 'STUN binding request over UDP',       kind: 'stun',   url: STUN_SERVER, samples: LATENCY_SAMPLES}
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
// inside it. These fields are zeroed
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
  const base = probe.fresh ? probe.url.replace('%RANDOM%', rand())
             : probe.bytes ? `${probe.url}?bytes=${probe.bytes}`
             : probe.url;
  return base + (base.includes('?') ? '&' : '?') + '_=' + Date.now() + rand().slice(0, 4);
}

// A resolver that gets no answer retries on a fixed timer, so a lookup time within
// tolerance of one of those timers indicates packet loss.
const RETRY_TIMERS_MS = [2000, 5000];
const RETRY_TOLERANCE_MS = 300;
export function looksLikeRetry(ms) {
  return ms != null && RETRY_TIMERS_MS.some(t => Math.abs(ms - t) <= RETRY_TOLERANCE_MS);
}

// The only call site. Every probe reaches the network through here, carrying no credentials,
// no referrer and nothing to send, so every request is a read and only a read.
async function request(url, signal, verb, mode) {
  const res = await fetch(url, {
    method: verb, mode, cache: 'no-store', credentials: 'omit',
    referrerPolicy: 'no-referrer', signal
  });
  return res;
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
    const res = await request(url, ctl.signal, probe.method || 'GET',
                              probe.kind === 'opaque' ? 'no-cors' : 'cors');

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

// Marks a read whose budget ran out before a chunk arrived.
const EXPIRED = Symbol('expired');

// One chunk, or EXPIRED. The budget bounds every individual read: checking only between
// chunks leaves a stalled stream running to the fetch timeout, which files a congested cell as
// a failure.
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
// Counts every stream's bytes against one clock, so the three streams are one measurement.
// The ramp is discarded; the window that follows is the measurement, and it ends on whichever
// comes first, the clock or the cap.
function downloadMeter({rampMs, rampBytes, windowMs, capBytes}) {
  const t0 = performance.now();
  let total = 0, markT = null, markBytes = 0, stopped = null;
  return {
    // Returns a reason once the measurement is over, so a reader knows to stop pulling.
    take(n) {
      const now = performance.now();
      // Judged on what arrived before this chunk, so the chunk that ends the ramp is the
      // window's first.
      if (markT == null) {
        if (now - t0 < rampMs && total < rampBytes) { total += n; return null; }
        markT = now;
        markBytes = total;
      }
      total += n;
      if (total - markBytes >= capBytes) stopped = 'cap';
      else if (now - markT >= windowMs) stopped = 'window';
      return stopped;
    },
    read() {
      const end = performance.now();
      const bytes = total - markBytes;
      const ms = markT == null ? 0 : Math.round(end - markT);
      return {bytes: total, window_bytes: bytes, window_ms: ms,
              ramp_ms: Math.round((markT ?? end) - t0), saturated: stopped === 'cap'};
    }
  };
}

// One stream, pulling until the measurement is over, the deadline passes or the far end runs
// out. Every stream reports why it stopped; the round takes the worst of those.
async function pumpStream(res, meter, deadline) {
  let reader = null;
  try {
    reader = res.body.getReader();
    for (;;) {
      const left = deadline - performance.now();
      if (left <= 0) return 'time';
      const next = await readWithin(reader, left);
      if (next === EXPIRED) return 'time';
      if (next.done) return 'eof';
      if (meter.take(next.value.byteLength)) return 'done';
    }
  } catch (e) {
    return e?.name === 'AbortError' ? 'aborted' : 'network';
  } finally {
    cancelQuietly(reader);
  }
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

function downloadConfig(d = {}) {
  return {
    streams: d.streams ?? DOWN_STREAMS,
    rampMs: d.rampMs ?? DOWN_RAMP_MS,
    rampBytes: d.rampBytes ?? DOWN_RAMP_BYTES,
    windowMs: d.windowMs ?? DOWN_WINDOW_MS,
    capBytes: d.capBytes ?? DOWN_CAP_BYTES,
    bytes: d.maxBytes ?? DOWN_REQUEST_BYTES
  };
}

// Distinct per stream so nothing coalesces them onto one connection or answers from a cache.
const downUrl = (probe, i, cfg) =>
  `${probe.url}?bytes=${cfg.bytes}&s=${i}-${Math.random().toString(36).slice(2, 10)}`;

// The measurement is the window, so the rate it reports is the window's. Reaching the cap
// first proves only that the link carries at least the ceiling, and says so.
function downloadResult(meter) {
  const m = meter.read();
  // A body handed over in one piece leaves no window to measure across — WebKit does this
  // whenever the whole response is already buffered. The transfer is then measured over its
  // own span, and anything past the ceiling saturates as usual.
  const span = m.window_ms > 0 ? m.window_ms : m.ramp_ms + m.window_ms;
  const bytes = m.window_ms > 0 ? m.window_bytes : m.bytes;
  const rate = span > 0 && bytes > 0 ? Math.round((bytes * 8) / (span / 1000)) : null;
  const saturated = m.saturated || (rate != null && rate >= DOWN_CEILING_BPS);
  return {...m, saturated, ceiling_bps: DOWN_CEILING_BPS,
          bps: saturated ? DOWN_CEILING_BPS : rate};
}

// The worst thing that happened to any stream. One stream stalling decides the round.
function downReason(reasons) {
  for (const r of ['network', 'aborted', 'time', 'eof']) if (reasons.includes(r)) return r;
  return 'done';
}

// `elapsed` is the caller's clock, so `ms` covers the whole request, handshake included.
async function readDownload(streams, meter, {url, elapsed, deadline}) {
  const first = streams[0];
  const server = parseServerTiming(first.headers.get('server-timing'));
  const reasons = await Promise.all(streams.map(res => pumpStream(res, meter, deadline)));
  const m = downloadResult(meter);
  // Present only for a body read to its end: WebKit files no entry for an aborted fetch.
  const timing = await readTiming(url) || {};
  const reason = downReason(reasons);
  const out = {
    ms: elapsed(),
    streams: streams.length,
    duration_ms: m.ramp_ms + m.window_ms,
    aborted_reason: reason,
    truncated: reason === 'network',
    ...m,
    server,
    ...timing,
    ok: m.window_bytes > 0 && reason !== 'network',
    fail: reason === 'network' ? 'network' : null,
    colo: first.headers.get('cf-meta-colo') || null,
    egress_ip: first.headers.get('cf-meta-ip') || null
  };
  if (!out.ok && !out.fail) {
    // 'stalled': headers came back and the window closed with no payload, which is a congested
    // cell. 'empty': the far end ran out with nothing to send.
    out.fail = reason === 'eof' ? 'empty' : 'stalled';
  }
  return out;
}

// Several connections, one clock. A single flow carries its receive window divided by its
// round trip, which on a mobile link is a fraction of what the link can do; RMBT opens three
// for that reason, and so does this.
async function measureDownload(probe, opts) {
  const cfg = downloadConfig(opts.download);
  const ctl = new AbortController();
  const relay = () => ctl.abort();
  if (opts.signal) opts.signal.addEventListener('abort', relay, {once: true});
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const deadline = t0 + (opts.timeoutMs ?? TIMEOUT_MS);
  const urls = Array.from({length: cfg.streams}, (_, i) => downUrl(probe, i, cfg));

  try {
    const opened = await Promise.allSettled(urls.map(u => openDown(u, ctl)));
    const live = opened.filter(o => o.status === 'fulfilled').map(o => o.value);
    if (!live.length) return downFailed(opened, elapsed());
    return await readDownload(live, downloadMeter(cfg), {url: urls[0], elapsed, deadline});
  } finally {
    ctl.abort();
    if (opts.signal) opts.signal.removeEventListener('abort', relay);
  }
}

async function openDown(url, ctl) {
  const res = await request(url, ctl.signal, 'GET', 'cors');
  if (!res.ok) throw Object.assign(new Error(`http ${res.status}`), {status: res.status});
  return res;
}

// Nothing opened. An HTTP status is the server's answer and is reported as one; anything else
// never reached it.
function downFailed(opened, ms) {
  const status = opened.map(o => o.reason?.status).find(Boolean) ?? null;
  return {ok: false, ms, status, streams: 0,
          fail: status ? 'http' : 'network', bps: null, ceiling_bps: DOWN_CEILING_BPS};
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

// Both address families are established once per session. A network carrying only one of them
// is ordinary — mobile carriers are commonly IPv6-only with NAT64, and plenty of networks
// elsewhere have no IPv6 at all — so the absent family must not read as an outage.
export async function checkPaths(signal) {
  const attempt = () => Promise.all(['ip6', 'ip4'].map(id =>
    runProbe(PROBES.find(p => p.id === id), {timeoutMs: PREFLIGHT_MS, signal})));
  let [v6, v4] = await attempt();
  // Both failing at once usually means the radio is still waking. The answer is kept for the
  // whole session, so ask again.
  if (!v6.ok && !v4.ok) {
    await new Promise(r => setTimeout(r, PREFLIGHT_RETRY_MS));
    [v6, v4] = await attempt();
  }
  // Still nothing leaves both paths unknown. Marking a path absent excuses its failures all
  // session, and a network that answers neither literal has said nothing about either.
  const settled = v6.ok || v4.ok;
  const one = r => ({available: settled ? r.ok : null, ms: r.ms, fail: r.fail});
  return {ip6: one(v6), ip4: one(v4)};
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

// Which families carried traffic in this round. Evidence from this round only: what a family
// did earlier cannot excuse it now, and what it does now needs no memory to read.
//
// Three things count, and all of them mean packets crossed the network over that family: an
// egress address the far end reported back — recorded even by a transfer that then stalled —
// a literal that answered, and a literal that answered with a status or a body this code
// rejected. A 429 or a middlebox's page is a completed TLS handshake to that address.
function carriedFamilies(out) {
  const carried = new Set();
  for (const [id, r] of Object.entries(out)) {
    if (!r) continue;
    if (id === 'ip6' || id === 'ip4') {
      // A literal names its own family: the address is in the URL. Reading it from the egress
      // would credit whichever family the far end reported.
      if (r.ok || r.fail === 'http' || r.fail === 'parse') carried.add(id);
    } else if (r.egress_ip) {
      // Everything else reaches a hostname, so the family is only knowable from the address
      // the far end saw. Both endpoints that report one are dual-stack, so what they saw is
      // what was used; behind NAT64 to an IPv4-only host it would not be.
      carried.add(r.egress_ip.includes(':') ? 'ip6' : 'ip4');
    }
  }
  return carried;
}

// A failing literal is one of three things, and only one of them is the connection failing.
// The test is what the person using this would notice: while any address family is carrying
// their traffic, a literal failing costs them nothing, whatever the reason for it.
//
// Decided from this round alone. A session-long verdict inferring absence from silence is
// wrong on a network with no route to the IPv6 literal, wrong across a handover between
// networks, and wrong when both literals are blocked at once. Nothing here remembers
// anything.
function markLiterals(out) {
  const carried = carriedFamilies(out);
  for (const id of ['ip6', 'ip4']) {
    const r = out[id];
    if (!r || r.ok || r.fail === 'resting') continue;
    // This family reached the far end, so the address alone is refused — a public resolver is
    // a common thing to intercept.
    if (carried.has(id)) r.blocked = true;
    // The other family carried the traffic. Recorded with its reason and charged to nothing,
    // because nobody waited on it.
    else if (carried.size) r.unused = true;
  }
}

// A resting probe still produces a row, so the round is complete and carries the reason.
const runOrRest = (p, opts, resting) => (resting?.has(p.id)
  ? Promise.resolve({ok: false, ms: null, status: null, fail: 'resting', stuck: true})
  : runProbe(p, opts));

// Latency first with the link otherwise idle, then the download. RMBT orders its phases this
// way and keeps the other connections quiet while it measures latency; running everything at
// once measures the round trip under this tool's own load, which reads high and moves with
// whatever the download happens to be doing.
export async function runRound({signal, download = {}, intervalMs = 5000,
                                resting = null} = {}) {
  const opts = p => ({signal, download, timeoutMs: timeoutFor(p, intervalMs)});
  const idle = PROBES.filter(p => p.kind !== 'download');
  const results = await Promise.all(idle.map(p => runOrRest(p, opts(p), resting)));

  const out = {};
  idle.forEach((p, i) => { out[p.id] = results[i]; });

  // The download runs alone, with one latency sample taken across it. The two round trips
  // together are the queueing this link does under load, which is felt as much as throughput.
  const down = PROBES.find(p => p.kind === 'download');
  const loaded = [];
  const [downResult] = await Promise.all([
    runOrRest(down, opts(down), resting),
    sampleUnderLoad(loaded, out, opts(down), downloadConfig(download))
  ]);
  out[down.id] = downResult;

  markLiterals(out);
  return {probes: out, loaded_rtt_ms: loaded[0] ?? null, loaded_rtt_from: loaded[1] ?? null};
}

// One round trip taken while the download is running. It grades nothing; the gap between it
// and the idle figure is what this link queues under load.
// Repeats whichever probe just answered on its own, so the pair is the same measurement taken
// twice: once with the link idle and once with the download on it. Started alongside the
// download, since a link fast enough to reach the cap is done inside 150 ms and a sample
// waiting for the ramp would find nothing running.
async function sampleUnderLoad(into, idle, opts, cfg) {
  const id = ['ip6', 'ip4', 'web'].find(x => idle[x]?.ok);
  if (!id) return;
  const r = await runOnce(PROBES.find(x => x.id === id),
                          {...opts, timeoutMs: Math.min(opts.timeoutMs, cfg.windowMs)});
  if (r.ok) { into.push(r.ms); into.push(id); }
}

// The resource timing buffer defaults to 250 entries; at seven probes a round it fills
// within two minutes, after which it stops recording and handshake detection stops with it.
export function clearTimings() {
  performance.clearResourceTimings();
}
