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

export const ACTIVITIES = {
  voice:     {label: 'voice & video calling', scales: ['round_trip', 'call_rate']},
  news:      {label: 'reading articles',     scales: ['ttfb', 'article']},
  streaming: {label: 'streaming video',      scales: ['rate']}
};

export const ACTIVITY_IDS = Object.keys(ACTIVITIES);

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

// A resting probe has reported nothing about the network, so it must not grade the activity it
// feeds as red for the whole cool-down.
const failed = r => !!r && r.ok === false && !r.expected && !r.blocked && r.fail !== 'resting';

// A download the far end turned away is a fact about the endpoint, not about the link, and
// must not be reported as the person's connection being bad. Anything else that stops a
// transfer — a refused connection, a stall, a timeout — is the network.
const ourFault = r => r?.refused_by === 'server';

export function articleMs(probes) {
  const dns = probes.dns?.ok ? probes.dns.ms : null;
  const web = probes.web?.ok ? probes.web.ms : null;
  const rate = throughput(probes.down);
  if (dns == null || web == null || !rate) return null;
  return Math.round(2 * dns + 2 * web + (ARTICLE_BYTES * 8000) / rate);
}

// The route is whichever address family this network carries: the one carrying traffic, or
// failing that the one that genuinely failed, since a merely absent family explains nothing.
// A browser prefers IPv6 where both work, so it leads.
export function activeRoute(probes = {}) {
  if (probes.ip6?.ok) return 'ip6';
  if (probes.ip4?.ok) return 'ip4';
  return failed(probes.ip4) && !failed(probes.ip6) ? 'ip4' : 'ip6';
}

const routeMs = p => (p.ip6?.ok ? p.ip6.ms : p.ip4?.ok ? p.ip4.ms : null);
// Anything that reached the network this round. An IP literal can be blocked or hijacked
// where ordinary traffic is not: on one operator both literals failed every round while DNS,
// the web probe and the download all answered.
const reached = p => !!(p.web?.ok || p.down?.ok || p.dns?.ok || p.dns_ctl?.ok);

// No route means no family is carrying traffic, at least one genuinely failed, and nothing
// else got out either. A family that is merely absent, or rested, has reported nothing and
// cannot condemn the link; neither can a blocked literal while the rest of the round succeeds.
const noRoute = p =>
  !p.ip6?.ok && !p.ip4?.ok && (failed(p.ip6) || failed(p.ip4)) && !reached(p);

// Only whether the UDP path exists is read, never its milliseconds: the row above grades those.
const TERMS = {
  voice: ({p, rate}) => [
    {note: 'no UDP', grade: failed(p.udp) ? 'red' : null},
    {note: 'no route', grade: noRoute(p) ? 'red' : null},
    {scale: 'round_trip', value: routeMs(p)},
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

// What the link carried. Three figures are recorded and every one of them is a floor: what
// this page timed after the ramp, what Cloudflare measured at its end of the same transfer,
// and the whole transfer including its ramp. The largest is the least wrong, and the two
// independent ones disagreeing is itself worth seeing in the file.
export function throughput(down) {
  if (!down?.ok) return null;
  const seen = [down.bps, down.bps_server, down.bps_min].filter(Number.isFinite);
  return seen.length ? Math.max(...seen) : null;
}

function terms(activity, p) {
  const rate = throughput(p.down);
  // A download the far end refused is a fact about the endpoint, so it leaves the activities
  // that read it with one fewer term rather than with a red one.
  const noThroughput = failed(p.down) && !ourFault(p.down) ? 'red' : null;
  return TERMS[activity]?.({p, rate, noThroughput}) ?? [];
}

// An activity's verdict and the measurement that decided it, so the number shown and the
// colour beside it always describe the same thing.
export function activityReading(activity, sample) {
  const graded = terms(activity, sample?.probes || {})
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
  if (r.blocked) return 'blocked';
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
    : {scale: PROBE_SCALES[id], value: id === 'down' ? throughput(r) : r.ms};
  return {
    state, grade: m.grade ?? gradeValue(m.scale, m.value), value: m.value ?? null,
    unit: m.scale ? SCALES[m.scale].unit : null, note: m.note ?? null, scale: m.scale ?? null
  };
}

export function gradeActivities(sample) {
  if (!sample || sample.skipped) return null;
  const out = {};
  for (const activity of ACTIVITY_IDS) out[activity] = activityReading(activity, sample).grade;
  return out;
}

// Every probe's own grade for one round, resolved once so the file and the screen agree.
export function gradeProbes(sample) {
  if (!sample || sample.skipped) return null;
  const out = {};
  for (const id of Object.keys(PROBE_SCALES)) out[id] = probeReading(id, sample).grade;
  return out;
}

// The figure an activity leads with, which is the one that decided its grade.
export function activityValue(activity, sample) {
  return activityReading(activity, sample).value;
}
