// Six probes, each isolating a different layer. Only ip6/ip4/dns/dns_ctl/web run every
// round; the download runs on a fixed cadence because of its size.
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
export const DOWNLOAD_PERIOD_MS = 60000;
export const TIMEOUT_MS = 4000;
export const IPV4_PREFLIGHT_MS = 2000;

const DNS_CONTROL_HOST = 'webspeed-dns-control.github.io';

export const PROBES = [
  {id: 'ip6',     label: 'no DNS · v6', kind: 'trace',    url: 'https://[2606:4700:4700::1111]/cdn-cgi/trace'},
  {id: 'ip4',     label: 'no DNS · v4', kind: 'trace',    url: 'https://1.1.1.1/cdn-cgi/trace'},
  {id: 'dns',     label: 'DNS fresh',   kind: 'opaque',   url: 'https://%RANDOM%.github.io/',      method: 'HEAD'},
  {id: 'dns_ctl', label: 'DNS cached',  kind: 'opaque',   url: `https://${DNS_CONTROL_HOST}/`,     method: 'HEAD'},
  {id: 'web',     label: 'other net',   kind: 'opaque',   url: 'https://www.gstatic.com/generate_204'},
  {id: 'down',    label: 'throughput',  kind: 'download', url: 'https://speed.cloudflare.com/__down', periodic: true}
];

export const ROUND_PROBES = PROBES.filter(p => !p.periodic);

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
export async function runProbe(probe, {timeoutMs = TIMEOUT_MS, signal, downloadBytes = DEFAULT_DOWNLOAD_BYTES} = {}) {
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

// Establishing this once means an IPv6-only network does not spend the rest of the session
// reporting the same failure as though it were news.
export async function checkIpv4(signal) {
  const probe = PROBES.find(p => p.id === 'ip4');
  const r = await runProbe(probe, {timeoutMs: IPV4_PREFLIGHT_MS, signal});
  return {available: r.ok, ms: r.ms, fail: r.fail};
}

export async function runRound({signal, downloadBytes = null, ipv4Available = true} = {}) {
  const probes = downloadBytes ? PROBES : ROUND_PROBES;
  const results = await Promise.all(probes.map(p => runProbe(p, {signal, downloadBytes})));
  const out = {};
  probes.forEach((p, i) => {
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
