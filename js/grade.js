export const GRADES = ['green', 'yellow', 'orange', 'red'];
const RANK = Object.fromEntries(GRADES.map((g, i) => [g, i]));

export const SCALES = {
  round_trip: {unit: 'ms',  dir: 'low',  edges: [100, 200, 400]},
  ttfb:       {unit: 'ms',  dir: 'low',  edges: [800, 1800, 3000]},
  article:    {unit: 'ms',  dir: 'low',  edges: [2500, 4000, 8000]},
  rate:       {unit: 'bps', dir: 'high', edges: [10e6, 5e6, 1.5e6]},
  call_rate:  {unit: 'bps', dir: 'high', edges: [0.3e6, 0.1e6, 0.03e6]},
  dns_delta:  {unit: 'ms',  dir: 'low',  edges: [250, 500, 1000]}
};

export const PURPOSES = {
  voice:     {label: 'voice & video calling', scales: ['round_trip', 'call_rate']},
  news:      {label: 'reading articles',     scales: ['ttfb', 'article']},
  streaming: {label: 'streaming video',      scales: ['rate']}
};

export const CAPABILITIES = Object.keys(PURPOSES);

const ARTICLE_BYTES = 500000;

export function gradeValue(scale, value) {
  const t = SCALES[scale];
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

export function articleMs(probes) {
  const dns = probes.dns?.ok ? probes.dns.ms : null;
  const web = probes.web?.ok ? probes.web.ms : null;
  const rate = probes.down?.ok ? probes.down.bps_min : null;
  if (dns == null || web == null || !rate) return null;
  return Math.round(2 * dns + 2 * web + (ARTICLE_BYTES * 8000) / rate);
}

// Only whether the UDP path exists is read, never its milliseconds: the row above grades those.
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

// A purpose's verdict and the measurement that decided it, so the tile's number and its colour
// always describe the same thing.
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

// Every probe in PROBES needs an entry: one without a scale shows a number no colour ever
// contradicts.
export const PROBE_SCALES = {
  ip6: 'round_trip', ip4: 'round_trip', dns_ctl: 'round_trip', web: 'round_trip',
  udp: 'round_trip', down: 'rate', dns: 'dns_delta'
};

function probeState(r) {
  if (!r) return 'none';
  if (r.fail === 'resting') return 'resting';
  if (r.expected) return 'absent';
  if (ourFault(r)) return 'refused';
  if (failed(r)) return 'failed';
  return r.ok ? 'ok' : 'none';
}

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
