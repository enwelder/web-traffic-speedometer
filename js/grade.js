// Purposes are graded, not probes: what a person is doing reads several measurements, and no
// single probe decides one.

export const GRADES = ['green', 'yellow', 'orange', 'red'];
const RANK = Object.fromEntries(GRADES.map((g, i) => [g, i]));

// The scales. Every edge is absolute; none consults the session.
//
//   scale       green       yellow      orange      red         from
//   ------------------------------------------------------------------------------
//   round_trip  <100 ms     <200 ms     <400 ms     ≥400 ms     G.114
//   ttfb        <800 ms     <1800 ms    <3000 ms    ≥3000 ms    web.dev TTFB
//   article     <2.5 s      <4 s        <8 s        ≥8 s        Core Web Vitals LCP
//   rate        >10 Mb/s    >5 Mb/s     >1.5 Mb/s   ≤1.5 Mb/s   Netflix tiers
//   call_rate   >300 kb/s   >100 kb/s   >30 kb/s    ≤30 kb/s    Opus, RFC 6716
//
//   G.114     https://www.itu.int/rec/T-REC-G.114     150 ms one-way preferred, 400 unusable
//   TTFB      https://web.dev/articles/ttfb           covers DNS, TCP, TLS, first byte
//   LCP       https://web.dev/articles/lcp            2.5 s good, 4 s poor
//   Netflix   https://help.netflix.com/en/node/306    3 Mb/s 720p, 5 1080p, 15 4K
//   Opus      https://www.rfc-editor.org/info/rfc6716 6-510 kb/s, 9-14 for wideband speech
//
// Where the edges depart from the source:
//   round_trip  G.114 budgets mouth-to-ear one-way; codec, packetisation and the jitter
//               buffer take 80-120 ms of it, leaving ~100 ms of round trip to the edge.
//   ttfb        defined over a site's 75th percentile, applied here to a single round.
//   rate        4K is not the bar; it asks 15 Mb/s and buys nothing on a phone screen.
//   call_rate   catches a link carrying nothing, not slow ones — a call is latency-bound.
export const SCALES = {
  round_trip: {unit: 'ms',  dir: 'low',  edges: [100, 200, 400]},
  ttfb:       {unit: 'ms',  dir: 'low',  edges: [800, 1800, 3000]},
  article:    {unit: 'ms',  dir: 'low',  edges: [2500, 4000, 8000]},
  rate:       {unit: 'bps', dir: 'high', edges: [10e6, 5e6, 1.5e6]},
  call_rate:  {unit: 'bps', dir: 'high', edges: [0.3e6, 0.1e6, 0.03e6]},
  dns_delta:  {unit: 'ms',  dir: 'low',  edges: [250, 500, 1000]}
};

// What each purpose is judged on. A purpose is the worst of its terms, so one requirement
// failing sinks it however well the others read: a call with a fast round trip and no UDP
// path is still a call that will not connect.
//
//   purpose    terms, in the order the tile prefers to report them
//   ------------------------------------------------------------------------------
//   voice      UDP path · route · round_trip · call_rate
//   news       lookup not on a retry timer · lookup · known host · throughput
//              · ttfb · article
//   streaming  throughput · rate
export const PURPOSES = {
  voice:     {label: 'voice & video calling', scales: ['round_trip', 'call_rate']},
  news:      {label: 'reading articles',     scales: ['ttfb', 'article']},
  streaming: {label: 'streaming video',      scales: ['rate']}
};

export const CAPABILITIES = Object.keys(PURPOSES);

// Bytes on the critical path to a readable article. HTML, CSS and fonts are 221 kB at the
// mobile median and the largest image is what LCP waits for; the rest of the median 2,164 kB
// page arrives after the article can be read.
// https://almanac.httparchive.org/en/2025/page-weight
const ARTICLE_BYTES = 500000;

export function gradeValue(scale, value) {
  const t = SCALES[scale];
  // Missing, non-finite and negative values yield no grade: they come from arithmetic that
  // went wrong upstream, and comparing them against the edges produces green for a negative
  // latency and red for a NaN.
  if (!t || value == null || !Number.isFinite(value) || value < 0) return null;
  if (t.dir === 'low') {
    for (let i = 0; i < t.edges.length; i++) if (value < t.edges[i]) return GRADES[i];
    return 'red';
  }
  for (let i = 0; i < t.edges.length; i++) if (value > t.edges[i]) return GRADES[i];
  return 'red';
}

export const worse = (a, b) => (a == null ? b : b == null ? a : (RANK[a] >= RANK[b] ? a : b));

// A resting probe has reported nothing about the network, so it must not grade the purpose it
// feeds as red for the whole cool-down.
const failed = r => !!r && r.ok === false && !r.expected && r.fail !== 'resting';

// A download the far end turned away is a fact about the endpoint, not about the link, and
// must not be reported as the person's connection being bad. Anything else that stops a
// transfer — a refused connection, a stall, a timeout — is the network.
const ourFault = r => r?.refused_by === 'server';

// Opening an article costs two new-origin setups on the critical path, two warm round trips
// for what they pull in, and then the bytes. Modelled from measurements rather than measured,
// and consuming a throughput bound, so the figure is an upper bound on the wait.
export function articleMs(probes) {
  const dns = probes.dns?.ok ? probes.dns.ms : null;
  const web = probes.web?.ok ? probes.web.ms : null;
  const rate = probes.down?.ok ? probes.down.bps_min : null;
  if (dns == null || web == null || !rate) return null;
  return Math.round(2 * dns + 2 * web + (ARTICLE_BYTES * 8000) / rate);
}

// A term either measures something on a scale or reports a path being gone, which has a grade
// but no number. Loss beats latency for a call, so either path gone is red however fast the
// other answers; a STUN exchange carries ICE gathering on top of a round trip, so only whether
// its path exists is read, never its milliseconds.
const TERMS = {
  voice: ({p, rate}) => [
    {note: 'no UDP', grade: failed(p.udp) ? 'red' : null},
    {note: 'no route', grade: failed(p.ip6) ? 'red' : null},
    {scale: 'round_trip', value: p.ip6?.ok ? p.ip6.ms : null},
    {scale: 'call_rate', value: rate}
  ],
  news: ({p, noThroughput}) => [
    {note: 'lookup lost', grade: p.dns?.retry_suspected ? 'red' : null},
    {note: 'no lookup', grade: failed(p.dns) ? 'red' : null},
    {note: 'host gone', grade: failed(p.web) ? 'red' : null},
    {note: 'no data', grade: noThroughput},
    {scale: 'ttfb', value: p.dns?.ok ? p.dns.ms : null},
    {scale: 'article', value: articleMs(p)}
  ],
  streaming: ({rate, noThroughput}) => [
    {note: 'no data', grade: noThroughput},
    {scale: 'rate', value: rate}
  ]
};

function terms(capability, p) {
  const rate = p.down?.ok ? p.down.bps_min : null;
  // A download the far end refused is a fact about the endpoint, so it leaves the purposes
  // that read it with one fewer term rather than with a red one.
  const noThroughput = failed(p.down) && !ourFault(p.down) ? 'red' : null;
  return TERMS[capability]?.({p, rate, noThroughput}) ?? [];
}

// A purpose's verdict and the measurement it came from. The tile shows this reading, so the
// number and the colour always describe the same thing: a composed grade whose tile printed
// one of its terms would show a 30 ms round trip under a red border when the UDP path was the
// thing that had gone.
export function capabilityReading(capability, sample) {
  const graded = terms(capability, sample?.probes || {})
    .map(t => ({...t, grade: t.grade ?? gradeValue(t.scale, t.value)}));
  const grade = graded.reduce((a, t) => worse(a, t.grade), null);
  const decided = grade == null ? null : graded.find(t => t.grade === grade);
  return {
    grade,
    value: decided?.value ?? null,
    unit: decided?.scale ? SCALES[decided.scale].unit : null,
    note: decided?.note ?? null,
    scale: decided?.scale ?? null
  };
}

// Which scale reads each probe's own number. Every probe in PROBES needs an entry: a probe
// with no scale would show a measurement no colour ever contradicts.
export const PROBE_SCALES = {
  ip6: 'round_trip', ip4: 'round_trip', dns_ctl: 'round_trip', web: 'round_trip',
  udp: 'round_trip', down: 'rate', dns: 'dns_delta'
};

// A probe reports before it grades. Only `failed` carries a colour; the other three say why
// there is no measurement, so a rested probe and a dead one never look alike.
function probeState(r) {
  if (!r) return 'none';
  if (r.fail === 'resting') return 'resting';
  if (r.expected) return 'absent';
  if (ourFault(r)) return 'refused';
  if (failed(r)) return 'failed';
  return r.ok ? 'ok' : 'none';
}

// The fresh lookup is graded against the cached-name control at the same destination, never on
// its own latency. A single sample against a median of three goes negative on noise, and a
// negative delta is not a faster-than-instant lookup.
function dnsMeasure(p) {
  if (p.dns?.retry_suspected) return {grade: 'red', note: 'lost'};
  const ctl = p.dns_ctl?.ok ? p.dns_ctl.ms : null;
  if (ctl == null) return {grade: 'green', note: 'resolved'};
  return {scale: 'dns_delta', value: Math.max(0, p.dns.ms - ctl)};
}

// What a probe measured this round, and the colour that measurement grades to.
export function probeReading(id, sample) {
  const p = sample && !sample.skipped ? (sample.probes || {}) : {};
  const r = p[id];
  const state = probeState(r);
  if (state !== 'ok') {
    return {state, grade: state === 'failed' ? 'red' : null, value: null, unit: null,
            note: state === 'failed' ? r.fail : state === 'none' ? null : state, scale: null};
  }
  const m = id === 'dns' ? dnsMeasure(p)
    : {scale: PROBE_SCALES[id], value: id === 'down' ? r.bps_min : r.ms};
  return {
    state, grade: m.grade ?? gradeValue(m.scale, m.value), value: m.value ?? null,
    unit: m.scale ? SCALES[m.scale].unit : null, note: m.note ?? null, scale: m.scale ?? null
  };
}

// A purpose is the worst of its terms, so one requirement failing sinks it however well the
// others read.
export function gradeRound(sample) {
  if (!sample || sample.skipped) return null;
  const out = {};
  for (const cap of CAPABILITIES) out[cap] = capabilityReading(cap, sample).grade;
  return out;
}

// Every probe's own grade for one round, resolved once so the file and the screen agree.
export function gradeProbes(sample) {
  if (!sample || sample.skipped) return null;
  const out = {};
  for (const id of Object.keys(PROBE_SCALES)) out[id] = probeReading(id, sample).grade;
  return out;
}

// Nearest rank: the smallest value at or above the quantile. Rounding the index down puts a
// ten-sample window on its own last element, making p90 the maximum.
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

// The figure a purpose leads with, which is the one that decided its grade.
export function capabilityValue(capability, sample) {
  return capabilityReading(capability, sample).value;
}
