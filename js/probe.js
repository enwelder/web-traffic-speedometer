// The probes run in parallel every round, each isolating one layer. The download follows
// RTR-NetTest's RMBT at reduced size: one TCP flow carries at most its receive window divided by
// its round trip, so the download opens several connections.
export const DOWN_STREAMS = 3;

// Discarded ramp: activates the radio, so the window is independent of prior connection state.
// RMBT uses 2 s.
export const DOWN_RAMP_MS = 300;
export const DOWN_RAMP_BYTES = 1000000;

// Measurement window. A fixed window keeps rounds comparable; the byte cap fixes the per-round
// data cost and sets the ceiling below.
export const DOWN_WINDOW_MS = 1500;
export const DOWN_CAP_BYTES = 4700000;

// Highest reportable rate. Reaching the cap before the window closes proves a lower bound, so the
// reading saturates here and is flagged. 25 Mb/s is 3.5 times the 1080p edge.
export const DOWN_CEILING_BPS = Math.round((DOWN_CAP_BYTES * 8) / (DOWN_WINDOW_MS / 1000));

// Requested bytes per stream, above what a capped window reads. Requesting the endpoint maximum
// (99,999,999) and cancelling every round draws refusals without CORS headers.
export const DOWN_REQUEST_BYTES = 8000000;
// A window shorter than this holds no round trip and yields no rate. A window that reaches the
// byte cap is exempt: the cap proves the ceiling.
export const DOWN_MIN_SPAN_MS = 100;
// Calls need about 100 kb/s upstream. 40 kB crosses the 0.3 Mb/s edge in 1.07 s and the 0.1 Mb/s
// edge in 3.2 s, both inside the upload's budget.
export const UP_BYTES = 40000;
// A round trip under load runs long on a busy link: the timeout is twice the window.
export const LOADED_RTT_MS = 2 * DOWN_WINDOW_MS;
// Held back from the interval so a round returns before the next one is due.
export const ROUND_SLACK_MS = 500;
// Added to a deadline taken from the wall clock, which brackets more than the body.
export const DOWN_SLACK_MS = 50;
export const TIMEOUT_MS = 8000;
export const STUN_TIMEOUT_MS = 3000;      // per sample: UDP answers within a round trip or not at all
export const MIN_TIMEOUT_MS = 1000;

export const STUCK_AFTER = 3;
export const STUCK_COOLDOWN = 6;
export const STUN_SERVER = 'stun:stun.cloudflare.com:3478';
export const PREFLIGHT_MS = 2000;
export const PREFLIGHT_RETRY_MS = 1500;

// `label` names the request performed and is exported with every recording; grade.js maps
// measurements to activities.
// A cold connection, a retransmission or a scheduling delay shifts one round trip by an order of
// magnitude. RMBT takes 10-200 samples and reports the median; a latency sample costs about 1.2 kB
// against megabytes for the download.
const LATENCY_SAMPLES = 10;

// Each sample opens a connection to an uncontacted host, a full first contact of up to a second
// on a mobile link, so fewer samples fit the budget.
const FIRST_CONTACT_SAMPLES = 5;

export const PROBES = [
  // Probes with `samples` run repeatedly within the round; `ms` is the median of the
  // samples that fit in the budget and every sample is kept.
  {id: 'ip6',     label: 'GET to an IPv6 literal, no lookup',   kind: 'trace',  url: 'https://[2606:4700:4700::1111]/cdn-cgi/trace', samples: LATENCY_SAMPLES},
  {id: 'ip4',     label: 'GET to an IPv4 literal, no lookup',   kind: 'trace',  url: 'https://1.1.1.1/cdn-cgi/trace', samples: LATENCY_SAMPLES},
  // A new hostname per sample, so no sample is answered from a cache.
  {id: 'dns',     label: 'HEAD to a name no resolver has seen', kind: 'opaque', url: 'https://%RANDOM%.github.io/',      method: 'HEAD', samples: FIRST_CONTACT_SAMPLES, fresh: true},
  // Sampled like the other latency probes, so the medians are comparable.
  {id: 'dns_ctl', label: 'HEAD to that host under a cached name', kind: 'opaque', url: 'https://wts-dns-control.github.io/', method: 'HEAD', samples: LATENCY_SAMPLES},
  {id: 'down',    label: 'parallel streams, read for a fixed window', kind: 'download', url: 'https://speed.cloudflare.com/__down', bytes: DOWN_REQUEST_BYTES},
  // The only request with a body: a fixed count of zero bytes, timed to the response the server
  // sends once the last byte arrived.
  {id: 'up', label: 'POST of zero bytes, timed to the response', kind: 'upload', url: 'https://speed.cloudflare.com/__up', method: 'POST', bodyBytes: UP_BYTES},
  // The only UDP probe. Calls and streaming use UDP, and carriers can handle it apart from TCP;
  // the reported address is the UDP NAT mapping.
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

// Validates the trace body against the request. A middlebox answering for Cloudflare or rewriting
// the Host yields a parse failure with a reason.
function validateTrace(trace, url) {
  if (!trace.ip || !trace.colo) return 'missing fields';
  if (!IPV4.test(trace.ip) && !IPV6.test(trace.ip)) return 'egress is not an address';
  if (!/^[A-Z]{3}$/.test(trace.colo)) return 'colo is not a PoP code';
  if (trace.visit_scheme && trace.visit_scheme !== 'https') return `scheme downgraded to ${trace.visit_scheme}`;
  if (trace.h && trace.h !== new URL(url).host) return `host rewritten to ${trace.h}`;
  return null;
}

// Cloudflare's view of the connection: transport, RTT in microseconds, retransmits, losses,
// delivery rate and congestion window. Under congestion retrans and cwnd move while reachability
// holds. `proto` is the transport the server terminated.
function parseServerTiming(header) {
  if (!header) return null;
  const m = /cfL4;desc="([^"]*)"/.exec(header);
  if (!m) return null;
  const q = new URLSearchParams(m[1].replace(/^\?/, ''));
  const num = k => (q.has(k) ? Number(q.get(k)) : null);
  return {
    rtt_us: num('rtt'), min_rtt_us: num('min_rtt'), rtt_var_us: num('rtt_var'),
    lost: num('lost'), retrans: num('retrans'),
    delivery_rate: num('delivery_rate'), cwnd: num('cwnd'), proto: q.get('proto')
  };
}

async function timingEntry(url) {
  // The entry is queued at responseEnd and can be missing when the body resolves; the retry covers
  // that gap.
  let e = null;
  for (let i = 0; i < 3 && !e; i++) {
    e = performance.getEntriesByName(url, 'resource').pop() || null;
    if (!e) await new Promise(r => setTimeout(r, 0));
  }
  return e;
}

// On a reused connection the spec sets connectStart, connectEnd and secureConnectionStart to
// fetchStart, so a handshake requires a nonzero connect window containing a TLS phase. The fields
// are zeroed cross-origin without timing-allow-origin, which only the download endpoint sends.
async function readTiming(url) {
  const e = await timingEntry(url);
  if (!e || !e.responseStart) return null;
  const reused = e.connectEnd === e.connectStart;
  const ms = (a, b) => (a > 0 && b > 0 && b >= a ? Math.round(b - a) : null);
  return {
    // Phases before the payload; on the download endpoint they cover most of the request.
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

// A listener added to an already aborted signal never fires, so the caller's abort is applied
// directly as well as subscribed to. Returns the unsubscribe.
export function relayAbort(signal, ctl) {
  if (!signal) return () => {};
  const relay = () => ctl.abort();
  if (signal.aborted) ctl.abort();
  else signal.addEventListener('abort', relay, {once: true});
  return () => signal.removeEventListener('abort', relay);
}

// A body is sent as text/plain, a CORS-safelisted type, so the upload needs no preflight.
async function request(url, {signal, verb = 'GET', mode = 'cors', body = null}) {
  const res = await fetch(url, {
    method: verb, mode, cache: 'no-store', credentials: 'omit',
    referrerPolicy: 'no-referrer', signal, body,
    headers: body ? {'Content-Type': 'text/plain'} : undefined
  });
  return res;
}

// One attempt. `fail`: timeout | network | http | parse | abort. `ms` is set on failure too: the
// time to fail separates a refused connection from a link that hung until the deadline.
async function runOnce(probe, {timeoutMs = TIMEOUT_MS, signal} = {}) {
  if (probe.kind === 'stun') return runStun(probe, {timeoutMs, signal});
  const r = {ok: false, ms: null, status: null, fail: null};
  const ctl = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const unrelay = relayAbort(signal, ctl);
  if (ctl.signal.aborted) { clearTimeout(timer); unrelay(); return {...r, fail: 'abort', ms: 0}; }

  const url = probeUrl(probe);
  if (probe.id === 'dns' || probe.id === 'dns_ctl') r.host = new URL(url).hostname;
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);

  try {
    const res = await request(url, {signal: ctl.signal, verb: probe.method || 'GET',
                                    mode: probe.kind === 'opaque' ? 'no-cors' : 'cors'});

    if (probe.kind === 'opaque') {
      // An opaque response has no readable status, so success means the request completed.
      markElapsed(r, probe, elapsed());
      r.ok = true;
      return r;
    }

    r.status = res.status;
    if (!res.ok) { r.ms = elapsed(); r.fail = 'http'; return r; }

    const trace = parseTrace(await res.text());
    markElapsed(r, probe, elapsed());
    return finishTrace(r, trace, url);
  } catch (e) {
    r.ms = elapsed();
    r.fail = e && e.name === 'AbortError' ? (timedOut ? 'timeout' : 'abort') : 'network';
    return r;
  } finally {
    clearTimeout(timer);
    unrelay();
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
  // The HTTP version the server received the request over.
  r.protocol = trace.http || null;
  return r;
}

// Marks a read whose budget ran out before a chunk arrived.
const EXPIRED = Symbol('expired');

// One chunk, or EXPIRED. The budget bounds each read; a check between chunks alone leaves a
// stalled read running to the fetch timeout.
async function readWithin(reader, ms) {
  let timer;
  const budget = new Promise(resolve => { timer = setTimeout(() => resolve(EXPIRED), ms); });
  try {
    return await Promise.race([reader.read(), budget]);
  } finally {
    clearTimeout(timer);
  }
}

// Cancels the rest of an unfinished body. Not awaited: an unsettled cancel hangs the round.
function cancelQuietly(reader) {
  if (!reader) return;
  try { reader.cancel(); } catch { /* already closed */ }
}

// Counts all streams' bytes against one clock, so the streams form one measurement. The ramp is
// discarded; the window after it is the measurement and ends on the clock or the cap, whichever
// comes first.
function downloadMeter({rampMs, rampBytes, windowMs, capBytes}) {
  const t0 = performance.now();
  let total = 0, markT = null, markBytes = 0, stopped = null, stopT = null, onOpen = () => {};
  // Resolves when the window opens, so the loaded round trip runs during the transfer.
  // measureDownload also resolves it on exit, for a window that never opens.
  const opened = new Promise(resolve => { onOpen = () => resolve(markT != null); });
  return {
    opened,
    open() { onOpen(); },
    // Returns a stop reason once the measurement ends; readers stop on it.
    take(n) {
      const now = performance.now();
      if (markT == null) {
        total += n;
        // The chunk that ends the ramp belongs to the ramp: its bytes crossed before the window opened,
        // and counting them in the window overstates the rate by 4-6%.
        if (now - t0 < rampMs && total < rampBytes) return null;
        markT = now;
        markBytes = total;
        onOpen();
        return null;
      }
      total += n;
      if (total - markBytes >= capBytes) { stopped = 'cap'; stopT = now; }
      else if (now - markT >= windowMs) { stopped = 'window'; stopT = now; }
      return stopped;
    },
    // Clock close time of the window. A stream stalled mid-window stops here, so `window_ms` keeps the
    // configured value and rounds stay comparable.
    until() { return markT == null ? Infinity : markT + windowMs; },
    // RMBT ends the measurement at t* = min over threads of the last time each recorded, so
    // the rate covers only the span every stream was running. A stream that reaches its end
    // early ends the window for all of them.
    threadEnded() {
      if (markT == null || stopped) return;
      stopped = 'thread';
      stopT = performance.now();
    },
    read() {
      // The span the counted bytes crossed in; time after the window closed is excluded.
      const now = performance.now();
      const end = stopT ?? (markT == null ? now : Math.min(now, markT + windowMs));
      // An unopened window counts zero bytes; ramp bytes are excluded.
      const bytes = markT == null ? 0 : total - markBytes;
      const ms = markT == null ? 0 : Math.round(end - markT);
      return {bytes: total, window_bytes: bytes, window_ms: ms,
              ramp_ms: Math.round((markT ?? end) - t0), saturated: stopped === 'cap'};
    }
  };
}

// Reads one stream until the measurement ends, the deadline passes or the body ends, and stores
// the end reason in `stat`, the stream's `per_stream` entry. The round takes the worst reason.
async function pumpStream(res, meter, {deadline, stat, elapsed}) {
  stat.end = await pull(res, meter, {deadline, stat, elapsed});
  return stat.end;
}

async function pull(res, meter, {deadline, stat, elapsed}) {
  let reader = null;
  // `done`: the window closed. `time`: the deadline passed. The bound that set the budget determines
  // the reason, which avoids re-reading a clock at the boundary.
  const over = () => (meter.until() < deadline ? 'done' : 'time');
  try {
    reader = res.body.getReader();
    for (;;) {
      const left = Math.min(deadline, meter.until()) - performance.now();
      if (left <= 0) return over();
      const next = await readWithin(reader, left);
      if (next === EXPIRED) return over();
      if (next.done) { meter.threadEnded(); return 'eof'; }
      stat.first_byte_ms ??= elapsed();
      stat.bytes += next.value.byteLength;
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

// A download rejected before any response leaves the refusing side unknown. An opaque repeat
// separates the cases: opaque success means the server answered without CORS headers, opaque
// failure means no connection opened. The repeat omits `bytes`, so the body is empty.
async function whoRefused(probe, opts) {
  const r = await runOnce({...probe, id: 'down_probe_check', kind: 'opaque', bytes: 0},
                          {...opts, timeoutMs: MIN_TIMEOUT_MS});
  return r.ok ? 'server' : 'connection';
}

// Every instrument but the lookups runs on Cloudflare. When all of them fail, over TCP and over
// UDP, one request to Google separates a failure at the far end from a link that carried nothing.
// A tunnel stall leaves STUN answering, and a browser without WebRTC has no UDP verdict, so neither
// reaches the request. The reference is no probe row and grades nothing itself.
export const REFERENCE = {id: 'reference', kind: 'opaque', url: 'https://www.gstatic.com/generate_204'};

const cloudflareFailed = out =>
  !out.ip6?.ok && !out.ip4?.ok && !out.down?.ok && !out.up?.ok &&
  out.udp?.ok === false && !out.udp.expected;

async function checkReference(out, {signal, pending}) {
  if (signal?.aborted || !cloudflareFailed(out)) return null;
  const r = await tracked(pending, REFERENCE.id,
                          runOnce(REFERENCE, {signal, timeoutMs: MIN_TIMEOUT_MS}));
  return {ok: r.ok, ms: r.ms, fail: r.fail};
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

// Distinct per stream, which prevents coalescing onto one connection and cache hits.
const downUrl = (probe, i, cfg) =>
  `${probe.url}?bytes=${cfg.bytes}&s=${i}-${Math.random().toString(36).slice(2, 10)}`;

// The rate is the window's rate. Reaching the cap first proves a lower bound, flagged `saturated`.
function downloadResult(meter, cfg) {
  const m = meter.read();
  // Computed from this round's cap and window, so the exported ceiling matches them.
  // DOWN_CEILING_BPS is the same arithmetic on the defaults.
  const ceiling = Math.round((cfg.capBytes * 8) / (cfg.windowMs / 1000));
  // A window under DOWN_MIN_SPAN_MS yields no rate: 9 kB in 3 ms computes to 24 Mb/s and measures
  // the clock. Those bytes are charged against DOWN_MIN_SPAN_MS as a proven floor: 4 MB within a
  // millisecond still clears the ceiling at 100 ms, 9 kB does not.
  const floor = m.window_bytes > 0
    ? Math.round((m.window_bytes * 8) / (Math.max(m.window_ms, DOWN_MIN_SPAN_MS) / 1000))
    : null;
  const rate = m.window_ms >= DOWN_MIN_SPAN_MS ? floor : null;
  // Reaching the cap proves the ceiling regardless of window length.
  const saturated = m.saturated || (floor != null && floor >= ceiling);
  return {...m, saturated, ceiling_bps: ceiling, bps: saturated ? ceiling : rate};
}

// The worst end reason across streams.
function downReason(reasons) {
  for (const r of ['network', 'aborted', 'time', 'eof']) if (reasons.includes(r)) return r;
  return 'done';
}

// Server timing, PoP and egress come from the first stream with headers. `ms` includes the
// handshake.
async function downloadOutcome(live, meter, {elapsed, deadline, cfg, perStream}) {
  const first = live[0];
  const server = parseServerTiming(first.res.headers.get('server-timing'));
  const m = downloadResult(meter, cfg);
  // Present for completed loads only: WebKit files no entry for an aborted fetch.
  const timing = await readTiming(first.url) || {};
  const reasons = live.map(s => s.stat.end);
  const reason = downReason(reasons);
  const out = {
    ms: elapsed(),
    streams: live.length,
    per_stream: perStream,
    duration_ms: m.ramp_ms + m.window_ms,
    aborted_reason: reason,
    truncated: reason === 'network',
    ...m,
    // Window closed by the deadline before `windowMs` elapsed; `bps` covers a shorter span.
    window_cut: meter.until() > deadline && Number.isFinite(meter.until()) && !m.saturated &&
                !reasons.includes('eof'),
    server,
    ...timing,
    ok: m.bps != null && reason !== 'network',
    fail: reason === 'network' ? 'network' : null,
    colo: first.res.headers.get('cf-meta-colo') || null,
    egress_ip: first.res.headers.get('cf-meta-ip') || null
  };
  if (!out.ok && !out.fail) {
    // 'short': bytes arrived over a span under DOWN_MIN_SPAN_MS, or the window never opened.
    // 'stalled': headers arrived and no payload followed, as on a congested cell. 'empty': the body
    // ended with zero bytes.
    const short = m.window_bytes > 0 || (m.window_ms === 0 && m.bytes > 0);
    out.fail = short ? 'short' : reason === 'eof' ? 'empty' : 'stalled';
  }
  return out;
}

// Triggered when a stream has no headers STALL_CHECK_MS into the download: one request to the
// download host, one to gstatic, one STUN binding. Download host slow with gstatic fast: browser
// or host. Both slow: link. STUN fast with both slow: TCP path.
const STALL_CHECK_MS = 2000;

function stallCheck(probe, {signal, deadline}) {
  const one = p => runOnce(p, {signal, timeoutMs: Math.max(0, deadline - performance.now())})
    .then(r => ({ok: r.ok, ms: r.ms, fail: r.fail}));
  return Promise.all([
    one({...probe, id: 'down_stall_check', kind: 'opaque', bytes: 0}),
    one(PROBES.find(x => x.id === 'dns_ctl')),
    one(PROBES.find(x => x.id === 'udp'))
  ]).then(([sameHost, otherHost, udp]) => ({same_host: sameHost, other_host: otherHost, udp}));
}

// Resource-timing sizes per stream, read before clearTimings(). WebKit files entries for completed
// loads only, so a size on a cancelled stream counts bytes received unread.
async function readStreamSizes(urls, perStream) {
  for (const [i, url] of urls.entries()) {
    const e = await timingEntry(url);
    perStream[i].transfer_size = e ? e.transferSize : null;
    perStream[i].encoded_body_size = e ? e.encodedBodySize : null;
  }
}

function dropBody(res) {
  try { Promise.resolve(res.body?.cancel()).catch(() => {}); } catch { /* already closed */ }
}

// Opens one stream and calls `onOpen` on header arrival. An HTTP error records `headers_ms` and
// `status`.
async function openStream(url, ctl, {stat, elapsed, onOpen}) {
  let res;
  try {
    res = await request(url, {signal: ctl.signal});
  } catch (e) {
    stat.end ??= e?.name === 'AbortError' ? 'aborted' : 'network';
    return;
  }
  if (stat.end === 'connect') { dropBody(res); return; }
  stat.headers_ms = elapsed();
  if (!res.ok) {
    stat.end = 'http';
    stat.status = res.status;
    dropBody(res);
    return;
  }
  await onOpen(res);
}

// Several connections, one clock. One flow carries at most its receive window divided by its
// round trip, a fraction of mobile link capacity; RMBT opens three connections, as does this.
async function measureDownload(probe, opts) {
  const cfg = downloadConfig(opts.download);
  const ctl = new AbortController();
  const unrelay = relayAbort(opts.signal, ctl);
  const meter = downloadMeter(cfg);
  opts.onWindow?.(meter.opened);
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const deadline = t0 + (opts.timeoutMs ?? TIMEOUT_MS);
  const urls = Array.from({length: cfg.streams}, (_, i) => downUrl(probe, i, cfg));

  // Per-stream record: header time, first-byte time, bytes read, end reason.
  const perStream = urls.map(() => ({headers_ms: null, first_byte_ms: null, bytes: 0, end: null}));
  const waiting = () => perStream.filter(s => s.headers_ms == null && s.end == null);
  // Streams without headers at the deadline are aborted with end `connect`, which bounds the
  // download by its budget.
  const streamCtls = urls.map(() => new AbortController());
  const unlink = streamCtls.map(c => relayAbort(ctl.signal, c));
  const cutoff = setTimeout(() => {
    for (const s of waiting()) { s.end = 'connect'; streamCtls[perStream.indexOf(s)].abort(); }
  }, Math.max(0, deadline - performance.now()));
  let check = null;
  const checkTimer = setTimeout(() => {
    if (waiting().length) check = stallCheck(probe, {signal: ctl.signal, deadline});
  }, STALL_CHECK_MS);
  const live = [];

  try {
    await Promise.all(urls.map((url, i) => openStream(url, streamCtls[i], {
      stat: perStream[i], elapsed,
      onOpen: res => {
        live.push({res, url, stat: perStream[i]});
        return pumpStream(res, meter, {deadline, stat: perStream[i], elapsed});
      }
    })));
    clearTimeout(checkTimer);
    const stall = await check;
    await readStreamSizes(urls, perStream);
    const out = live.length
      ? await downloadOutcome(live, meter, {elapsed, deadline, cfg, perStream})
      : downFailed(perStream, elapsed());
    if (stall) out.stall_check = stall;
    return out;
  } finally {
    clearTimeout(cutoff);
    clearTimeout(checkTimer);
    ctl.abort();
    meter.open();
    unrelay();
    unlink.forEach(u => u());
  }
}

// An abort controller that fires at `timeoutMs` or when `signal` aborts; `fail` names which one
// ended a request.
function deadline(signal, timeoutMs) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const unrelay = relayAbort(signal, ctl);
  return {
    ctl,
    fail: e => (e?.name === 'AbortError' ? (timedOut ? 'timeout' : 'abort') : 'network'),
    done() { clearTimeout(timer); unrelay(); }
  };
}

// One POST of `bodyBytes` zero bytes. The server answers once the last byte arrived, so the span
// from the request start to the response start holds the upload and one round trip. Resource
// timing separates that span from connection setup; without an entry the span includes it.
async function measureUpload(probe, {timeoutMs = TIMEOUT_MS, signal} = {}) {
  const r = {ok: false, ms: null, status: null, fail: null, bytes: 0};
  const d = deadline(signal, timeoutMs);
  if (d.ctl.signal.aborted) { d.done(); return {...r, fail: 'abort', ms: 0}; }
  const url = probeUrl(probe);
  const t0 = performance.now();
  try {
    const res = await request(url, {signal: d.ctl.signal, verb: probe.method || 'GET',
                                    body: new Uint8Array(probe.bodyBytes)});
    r.ms = Math.round(performance.now() - t0);
    r.status = res.status;
    // Reading the body completes the load, which files the timing entry.
    await res.text();
    return await finishUpload(r, res, url, probe);
  } catch (e) {
    r.ms = Math.round(performance.now() - t0);
    r.fail = d.fail(e);
    return r;
  } finally {
    d.done();
  }
}

async function finishUpload(r, res, url, probe) {
  if (!res.ok) { r.fail = 'http'; return r; }
  r.server = parseServerTiming(res.headers.get('server-timing'));
  r.colo = res.headers.get('cf-meta-colo') || null;
  r.upload_bytes = Number(res.headers.get('cf-meta-upload-bytes')) || 0;
  r.bytes = r.upload_bytes;
  Object.assign(r, await readTiming(url));
  // A count the browser could not read, or a body cut short, gives no rate.
  if (r.upload_bytes !== probe.bodyBytes) { r.fail = 'short'; return r; }
  const timed = r.ttfb_ms > 0;
  r.rate_source = timed ? 'timing' : 'fetch';
  r.bps = Math.round((probe.bodyBytes * 8000) / (timed ? r.ttfb_ms : Math.max(r.ms, 1)));
  r.ok = true;
  return r;
}

// No stream opened. Failure precedence: `http`, `network`, `connect`, `abort`.
function downFailed(perStream, ms) {
  const ends = perStream.map(s => s.end);
  const status = perStream.find(s => s.status)?.status ?? null;
  const first = ['http', 'network', 'connect', 'aborted'].find(e => ends.includes(e));
  return {ok: false, ms, status, streams: 0, per_stream: perStream,
          fail: first === 'aborted' ? 'abort' : first ?? 'network',
          bps: null, ceiling_bps: DOWN_CEILING_BPS};
}

async function takeSamples(probe, opts, started) {
  const deadline = started + (opts.timeoutMs ?? TIMEOUT_MS);
  const runs = [];
  const starts = [];
  let slowest = 0;
  for (let i = 0; i < probe.samples; i++) {
    const left = deadline - performance.now();
    // Admission requires twice the slowest sample so far. A sample admitted with less times out
    // on the budget and records the overrun as a link failure.
    if (i > 0 && left < Math.max(MIN_TIMEOUT_MS, 2 * slowest)) return {runs, starts, end: 'budget'};
    const answered = runs.some(r => r.ok);
    starts.push(Math.round(performance.now() - started));
    // Each sample gets the whole remaining budget, so a slow answer keeps its full time. A STUN
    // sample is capped, since its lost binding response never arrives late.
    const r = await runOnce(probe, {...opts, timeoutMs: probe.kind === 'stun' ? Math.min(left, STUN_TIMEOUT_MS) : left});
    runs.push(r);
    slowest = Math.max(slowest, r.ms ?? 0);
    // After a success a failed sample is a lost packet, and sampling continues.
    if (!r.ok && (!answered || r.fail === 'abort')) return {runs, starts, end: 'failure'};
  }
  return {runs, starts, end: 'count'};
}

// Sampled probes run repeatedly inside one deadline; `ms` is the median and every sample is kept.
// Before the first success, sampling stops at the first failure. After a success a failed sample
// is a lost packet: sampling continues, `samples_lost` counts it and `sample_fail` keeps the first
// reason. A probe with no successful sample fails.
export async function runProbe(probe, opts = {}) {
  if (probe.kind === 'download') {
    const r = await measureDownload(probe, opts);
    if (r.fail === 'network') r.refused_by = await whoRefused(probe, opts);
    return r;
  }
  if (probe.kind === 'upload') return measureUpload(probe, opts);
  if (!probe.samples || probe.samples < 2) return runOnce(probe, opts);

  const started = performance.now();
  const {runs, starts, end} = await takeSamples(probe, opts, started);
  const good = runs.filter(r => r.ok);
  const bad = runs.find(r => !r.ok);
  const out = {...(good[good.length - 1] ?? runs[runs.length - 1])};
  out.ms_samples = runs.map(r => r.ms);
  out.sample_starts_ms = starts;
  // The trace endpoint reports the HTTP version per request, so each answered sample carries the
  // transport it used.
  if (probe.kind === 'trace') {
    out.protocol_samples = runs.map(r => (r.ok ? r.protocol : null));
    delete out.protocol;
  }
  if (probe.kind === 'stun') {
    out.host_ms_samples = runs.map(r => r.host_ms);
    delete out.host_ms;
  }
  out.samples_ok = good.length;
  // A STUN sample's `ms` is its first srflx candidate and gathering continues after it, so
  // `wall_ms` accounts for the budget.
  out.samples_end = end;
  out.wall_ms = Math.round(performance.now() - started);
  if (good.length) {
    const ms = good.map(r => r.ms);
    out.ok = true;
    out.fail = null;
    out.ms = median(ms);
    // Spread within one round reaches 52–4275 ms; the median omits it.
    out.ms_min = Math.min(...ms);
    out.ms_max = Math.max(...ms);
    if (bad) out.sample_fail = bad.fail;
    out.samples_lost = runs.filter(r => !r.ok && r.fail !== 'abort').length;
  }
  return out;
}

// Preflight of both address families, once per session. Single-family networks are common
// (IPv6-only mobile carriers with NAT64, IPv4-only Wi-Fi), so an absent family is no outage.
export async function checkPaths(signal) {
  const attempt = () => Promise.all(['ip6', 'ip4'].map(id =>
    runProbe(PROBES.find(p => p.id === id), {timeoutMs: PREFLIGHT_MS, signal})));
  let [v6, v4] = await attempt();
  // Both failing at once usually means the radio is still waking; the result is kept for the
  // session, so the check runs again.
  if (!v6.ok && !v4.ok) {
    await new Promise(r => setTimeout(r, PREFLIGHT_RETRY_MS));
    [v6, v4] = await attempt();
  }
  // A second double failure leaves both paths unknown: marking a path absent would exclude its
  // failures for the whole session.
  const settled = v6.ok || v4.ok;
  const one = r => ({available: settled ? r.ok : null, ms: r.ms, fail: r.fail});
  return {ip6: one(v6), ip4: one(v4)};
}

// Every deadline is capped by the interval, so a probe cannot outlive its round and shift the
// cadence. A download cut at the deadline reports the bytes it read. STUN samples share the window
// of the TCP probes, so one slow answer leaves room for the rest of the series.
export function timeoutFor(_probe, intervalMs) {
  return Math.max(MIN_TIMEOUT_MS, Math.min(TIMEOUT_MS, intervalMs - ROUND_SLACK_MS));
}

// ICE gathering against a STUN server only: without a data channel, track or remote description
// no peer connection is established and no payload is sent; the server receives a binding
// request. Every server-reflexive candidate is kept: a dual-stack network reports one per family,
// and the pair is the UDP NAT mapping.
function runStun(probe, {timeoutMs, signal}) {
  const r = {ok: false, ms: null, status: null, fail: null, public_ips: [], candidates: 0, host_ms: null};
  // Flagged `expected`, like an absent IPv4 path, so a browser without WebRTC grades no round
  // degraded.
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
    if (signal?.aborted) return finish('abort');
    if (signal) signal.addEventListener('abort', onAbort, {once: true});

    pc.onicecandidate = e => {
      // A null candidate ends gathering; without a server-reflexive candidate the UDP path failed.
      if (!e.candidate) return finish(r.public_ips.length ? null : 'no_srflx');
      r.candidates++;
      if (e.candidate.type === 'host') r.host_ms ??= Math.round(performance.now() - t0);
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

// Address families that carried traffic in this round, from this round's results only. Evidence:
// an egress address reported by the far end (also recorded by a transfer that then stalled), a
// literal that answered, and a literal that returned a rejected status or body; a 429 or a
// middlebox page is a completed TLS handshake to that address.
function carriedFamilies(out) {
  const carried = new Set();
  for (const [id, r] of Object.entries(out)) {
    if (!r) continue;
    if (id === 'ip6' || id === 'ip4') {
      // A literal's family is the address family in its URL.
      if (r.ok || r.fail === 'http' || r.fail === 'parse') carried.add(id);
    } else if (r.egress_ip) {
      // Hostname probes: the family is that of the egress address the far end reports. Both
      // reporting endpoints are dual-stack, so the reported family is the family used.
      carried.add(r.egress_ip.includes(':') ? 'ip6' : 'ip4');
    }
  }
  return carried;
}

// A refused address fails fast. A literal that hung until its deadline or the round's abort
// stalled on a path that carried traffic earlier or later in the round, as in a railway tunnel.
const STALLED = new Set(['timeout', 'abort']);

// Classifies a failing literal as `blocked`, `unused` or a failure, from this round only. A
// literal counts as a failure when no family carried traffic, or when it stalled on its own
// family. A session-long absence verdict misclassifies a network without a route to the IPv6
// literal, a handover, and two blocked literals.
function markLiterals(out) {
  const carried = carriedFamilies(out);
  for (const id of ['ip6', 'ip4']) {
    const r = out[id];
    if (!r || r.ok || r.fail === 'resting') continue;
    // The family carried traffic and the literal address was refused; public resolver addresses are
    // commonly intercepted.
    if (carried.has(id)) {
      if (!STALLED.has(r.fail)) r.blocked = true;
    } else if (carried.size) {
      // The other family carried the traffic; the failure is recorded and excluded from tallies.
      r.unused = true;
    }
  }
}

// A resting probe yields a `resting` result, so every row holds all probes.
const runOrRest = (p, opts, resting) => (resting?.has(p.id)
  ? Promise.resolve({ok: false, ms: null, status: null, fail: 'resting', stuck: true})
  : runProbe(p, opts));

// `pending` holds the probes a round has started and not settled, for the skip event.
function tracked(pending, id, promise) {
  pending?.add(id);
  return promise.finally(() => pending?.delete(id));
}

// Latency probes run first on an idle link, then the download, as in RMBT. Concurrent phases
// measure the round trip under the tool's own download load.
export async function runRound({signal, download = {}, intervalMs = 5000,
                                resting = null, pending = null} = {}) {
  const opts = p => ({signal, download, timeoutMs: timeoutFor(p, intervalMs)});
  const t0 = performance.now();
  const idle = PROBES.filter(p => p.kind !== 'download' && p.kind !== 'upload');
  const results = await Promise.all(idle.map(p =>
    tracked(pending, p.id, runOrRest(p, opts(p), resting))));
  const idleMs = Math.round(performance.now() - t0);

  const out = {};
  idle.forEach((p, i) => { out[p.id] = results[i]; });

  // The download runs alone, with one latency sample during its window; the difference from the
  // idle round trip is the queueing delay under load.
  const down = PROBES.find(p => p.kind === 'download');
  const loaded = [];
  // Sequential phases: the download gets the interval remainder after the idle phase. Two full 8 s
  // budgets (a dead IPv6 literal, then the download) exceed a 15 s slot.
  const left = intervalMs - ROUND_SLACK_MS - (performance.now() - t0);
  const downOpts = {...opts(down),
                    timeoutMs: Math.max(MIN_TIMEOUT_MS, Math.min(timeoutFor(down, intervalMs), left))};
  const up = PROBES.find(p => p.kind === 'upload');
  if (signal?.aborted) {
    out[down.id] = {ok: false, ms: null, status: null, fail: 'abort'};
    out[up.id] = {ok: false, ms: null, status: null, fail: 'abort'};
    markLiterals(out);
    return {probes: out, loaded_rtt_ms: null, loaded_rtt_from: null,
            phase_idle_ms: idleMs, phase_down_ms: null, phase_up_ms: null, reference: null};
  }

  const downT0 = performance.now();
  let openWindow, downDone = false;
  const windowOpened = new Promise(resolve => { openWindow = resolve; });
  const downRun = tracked(pending, down.id, runOrRest(down, {...downOpts, onWindow: openWindow}, resting))
    // A rested or refused download opens no window; the window promise resolves false.
    .finally(() => { downDone = true; openWindow(Promise.resolve(false)); });
  const [downResult] = await Promise.all([
    downRun,
    sampleUnderLoad(loaded, out, downOpts,
                    {windowOpened, live: () => !downDone, pending, until: downT0 + downOpts.timeoutMs})
  ]);
  out[down.id] = downResult;
  const phaseDownMs = Math.round(performance.now() - downT0);

  // The upload follows the download, which keeps its budget.
  const upT0 = performance.now();
  out[up.id] = await tracked(pending, up.id, runUpload(up, {signal, intervalMs, t0, resting}));
  const phaseUpMs = Math.round(performance.now() - upT0);

  markLiterals(out);
  const reference = await checkReference(out, {signal, pending});
  return {probes: out, loaded_rtt_ms: loaded[0] ?? null, loaded_rtt_from: loaded[1] ?? null,
          phase_idle_ms: idleMs, phase_down_ms: phaseDownMs, phase_up_ms: phaseUpMs, reference};
}

// The upload takes what the interval leaves after the idle and download phases. Below
// MIN_TIMEOUT_MS it is not sent: a request without a fair budget records its overrun as a link
// failure, and pushes the round past its slot.
function runUpload(up, {signal, intervalMs, t0, resting}) {
  const left = intervalMs - ROUND_SLACK_MS - (performance.now() - t0);
  if (left < MIN_TIMEOUT_MS) return Promise.resolve({ok: false, ms: null, status: null, fail: 'no_budget'});
  return runOrRest(up, {signal, timeoutMs: Math.min(timeoutFor(up, intervalMs), left)}, resting);
}

// One ungraded round trip during the download window, repeating the probe that answered idle, so
// the idle and loaded values are one measurement under two loads. It waits for the window: started
// with the download, it completes during the TLS handshakes and repeats the idle measurement.
async function sampleUnderLoad(into, idle, opts, {windowOpened, live, pending, until}) {
  const id = ['ip6', 'ip4', 'dns_ctl'].find(x => idle[x]?.ok);
  if (!id) return;
  const open = await windowOpened;
  // Requires an open window and a running transfer; after the body ends, a sample measures the
  // idle link.
  if (!open || !live()) return;
  // Timeout capped at the download deadline.
  const left = until - performance.now();
  if (left <= 0) return;
  const r = await tracked(pending, 'loaded_rtt', runOnce(PROBES.find(x => x.id === id),
                          {...opts, timeoutMs: Math.min(left, LOADED_RTT_MS)}));
  into.push(r.ok ? r.ms : null);
  into.push(id);
}

// The resource-timing buffer holds 250 entries by default and fills within two minutes at this
// request rate; a full buffer records no entries and handshake detection fails.
export function clearTimings() {
  performance.clearResourceTimings();
}
