// Five probes per round, each isolating a different layer.
//
// ip6/ip4 use address literals, so no name resolution happens at all — that is what makes
// them a clean read on the radio link. On an IPv6-only carrier (NAT64/DNS64, which is the
// normal Dutch mobile configuration) ip4 cannot work: iOS has no CLAT, so it relies on
// DNS64 synthesising an address during lookup, and a literal address skips lookup entirely.
// Recording both is how the address family in use becomes visible instead of assumed.
//
// dns requests a random <label>.github.io. The wildcard record and the *.github.io
// certificate make any label valid, so every round forces the carrier's resolver to perform
// a lookup it cannot have cached. A fixed hostname cannot do this: one.one.one.one has a
// 24-hour TTL, so after the first lookup the probe stops testing DNS entirely.

export const DOWNLOAD_BYTES = 25000;
export const TIMEOUT_MS = 4000;

export const PROBES = [
  {id: 'ip6',  label: 'no DNS · v6', url: 'https://[2606:4700:4700::1111]/cdn-cgi/trace', kind: 'trace'},
  {id: 'ip4',  label: 'no DNS · v4', url: 'https://1.1.1.1/cdn-cgi/trace',                kind: 'trace'},
  {id: 'dns',  label: 'DNS',         url: 'https://%RANDOM%.github.io/',                  kind: 'opaque', method: 'HEAD'},
  {id: 'web',  label: 'other net',   url: 'https://www.gstatic.com/generate_204',         kind: 'opaque'},
  {id: 'down', label: 'throughput',  url: 'https://speed.cloudflare.com/__down',          kind: 'download'}
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

// Cloudflare reports its own view of the connection: RTT in microseconds, retransmits,
// losses, delivery rate and congestion window. Congestion looks different from a coverage
// gap here — retrans and cwnd move while reachability does not.
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
// all equal to fetchStart, so a non-zero secureConnectionStart does NOT imply a handshake —
// only a connect window with a TLS phase inside it does.
// These fields are zeroed cross-origin unless the server sends timing-allow-origin, which
// of the five endpoints only the download one does.
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
    protocol: e.nextHopProtocol || null,
    transferred: e.transferSize || null
  };
}

function blank() {
  return {ok: false, ms: null, status: null, fail: null};
}

function probeUrl(probe) {
  const base = probe.id === 'dns' ? probe.url.replace('%RANDOM%', rand())
             : probe.id === 'down' ? `${probe.url}?bytes=${DOWNLOAD_BYTES}`
             : probe.url;
  return base + (base.includes('?') ? '&' : '?') + '_=' + Date.now() + rand().slice(0, 4);
}

// `fail` is the reason, never merely the fact: timeout | network | http | parse | abort.
// `ms` is filled in on failure too, since how long a probe took to fail separates a refused
// connection from a link that hung until the deadline.
export async function runProbe(probe, {timeoutMs = TIMEOUT_MS, signal} = {}) {
  const r = blank();
  const ctl = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const relay = () => ctl.abort();
  if (signal) signal.addEventListener('abort', relay, {once: true});

  const url = probeUrl(probe);
  if (probe.id === 'dns') r.host = new URL(url).hostname;
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

    if (probe.kind === 'download') return await readDownload(res, r, url, t0, since, timedOut);

    const trace = parseTrace(await res.text());
    r.ms = since();
    if (!trace.ip || !trace.colo) { r.fail = 'parse'; return r; }  // something answered for Cloudflare
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
async function readDownload(res, r, url, t0, since, timedOut) {
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
  // the body after it has been buffered, which on a fast link reads as near-zero time.
  const window = r.transfer_ms != null ? r.transfer_ms : Math.round(performance.now() - firstByteAt);
  r.transfer_ms = window;
  // Below a couple of milliseconds the window is shorter than the clock can resolve, so a
  // rate computed from it is noise. bytes and transfer_ms stay, and the rate is left empty
  // rather than reported as an implausible number.
  r.bps = window >= 2 && bytes > 0 ? Math.round((bytes * 8) / (window / 1000)) : null;
  r.ok = bytes > 0 && !truncated;
  if (!r.ok) r.fail = truncated ? (timedOut ? 'timeout' : 'abort') : 'network';
  r.colo = res.headers.get('cf-meta-colo') || null;
  r.egress_ip = res.headers.get('cf-meta-ip') || null;
  return r;
}

export function runRound(signal) {
  return Promise.all(PROBES.map(p => runProbe(p, {signal})));
}

// The resource timing buffer defaults to 250 entries; at five probes a round it would fill
// within two minutes and silently stop recording, taking handshake detection with it.
export function clearTimings() {
  performance.clearResourceTimings();
}
