// Three parallel probes per round. Comparing `ip` against `dns` isolates DNS resolution;
// all three failing together points at the radio link; `web` catches faults specific to
// one provider's edge.

export const PROBES = [
  {id: 'ip',  label: 'via IP address', url: 'https://1.1.1.1/cdn-cgi/trace',           kind: 'trace'},
  {id: 'dns', label: 'via hostname',   url: 'https://one.one.one.one/cdn-cgi/trace',   kind: 'trace'},
  {id: 'web', label: 'other network',  url: 'https://www.gstatic.com/generate_204',    kind: 'opaque'}
];

export const TIMEOUT_MS = 4000;

// Both Cloudflare endpoints send `access-control-allow-origin: *`, so the body a no-cors
// request already transferred can be read at no extra cost. gstatic sends none and stays
// opaque, which is why its success is "the promise resolved" and its status is unknowable.

function parseTrace(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function blank() {
  return {ok: false, ms: null, status: null, fail: null, egress_ip: null, colo: null};
}

// `fail` is the reason, never merely the fact: timeout | network | http | parse | abort.
// `ms` is filled in on failure too, since how long a probe took to fail separates a
// refused connection from a link that hung until the deadline.
export async function runProbe(probe, {timeoutMs = TIMEOUT_MS, signal} = {}) {
  const r = blank();
  const ctl = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const relay = () => ctl.abort();
  if (signal) signal.addEventListener('abort', relay, {once: true});

  const t0 = performance.now();
  const done = () => Math.round(performance.now() - t0);

  try {
    const res = await fetch(probe.url + (probe.url.includes('?') ? '&' : '?') + '_=' + Date.now(), {
      mode: probe.kind === 'trace' ? 'cors' : 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: ctl.signal
    });

    if (probe.kind === 'opaque') {
      r.ok = true;
      r.ms = done();
      return r;
    }

    r.status = res.status;
    if (!res.ok) {
      r.ms = done();
      r.fail = 'http';
      return r;
    }

    const trace = parseTrace(await res.text());
    r.ms = done();
    // A body that is not trace-shaped means something answered on Cloudflare's behalf.
    if (!trace.ip || !trace.colo) {
      r.fail = 'parse';
      return r;
    }
    r.ok = true;
    r.egress_ip = trace.ip;
    r.colo = trace.colo;
    return r;
  } catch (e) {
    r.ms = done();
    r.fail = e && e.name === 'AbortError' ? (timedOut ? 'timeout' : 'abort') : 'network';
    return r;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relay);
  }
}

export function runRound(signal) {
  return Promise.all(PROBES.map(p => runProbe(p, {signal})));
}
