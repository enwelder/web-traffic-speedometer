import {countsAsFailure} from './export.js';

export const GRADES = ['green', 'yellow', 'orange', 'red'];
const RANK = Object.fromEntries(GRADES.map((g, i) => [g, i]));

// YouTube's recommended sustained speeds for 1080p, 720p and 480p, divided by 0.7: ExoPlayer and
// hls.js select a rendition at no more than 70% of measured throughput, and one round's rate is a
// single sample of that throughput.
const PLAYER_BANDWIDTH_FRACTION = 0.7;
const VIDEO_EDGES = [5e6, 2.5e6, 1.1e6].map(bps => Math.round(bps / PLAYER_BANDWIDTH_FRACTION));

export const SCALES = {
  round_trip: {unit: 'ms',  dir: 'low',  edges: [100, 200, 400]},
  ttfb:       {unit: 'ms',  dir: 'low',  edges: [800, 1800, 3000]},
  article:    {unit: 'ms',  dir: 'low',  edges: [2500, 4000, 8000]},
  rate:       {unit: 'bps', dir: 'high', edges: VIDEO_EDGES},
  call_rate:  {unit: 'bps', dir: 'high', edges: [0.3e6, 0.1e6, 0.03e6]}
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

// A resting probe sends no request, so it adds no red to the activity it feeds during the
// cool-down.
const failed = countsAsFailure;

// A server refusal describes the endpoint and is excluded from link grades. Every other transfer
// failure (refused connection, stall, timeout) counts against the network.
const ourFault = r => r?.refused_by === 'server';

// Window rate across the round's streams. A saturated round reached the byte cap before the
// window closed; its reading is the ceiling, a lower bound above every edge.
export const throughput = down => (down?.ok && Number.isFinite(down.bps) ? down.bps : null);


export function articleMs(probes) {
  const dns = probes.dns?.ok ? probes.dns.ms : null;
  const warm = probes.dns_ctl?.ok ? probes.dns_ctl.ms : null;
  const rate = throughput(probes.down);
  if (dns == null || warm == null || !rate) return null;
  return Math.round(2 * dns + 2 * warm + (ARTICLE_BYTES * 8000) / rate);
}

// Route family by precedence: literal answered, family carried traffic with its literal refused,
// literal failed, family absent. IPv6 leads when both qualify, matching browser preference.
export function activeRoute(probes = {}) {
  // An absent family ranks last, so a network without IPv6 reports the IPv4 family.
  const rank = [f => probes[f]?.ok, f => probes[f]?.blocked, f => failed(probes[f]),
                f => probes[f] && !probes[f].expected];
  for (const better of rank) {
    const found = ['ip6', 'ip4'].find(better);
    if (found) return found;
  }
  return 'ip6';
}

const routeMs = p => (p.ip6?.ok ? p.ip6.ms : p.ip4?.ok ? p.ip4.ms : null);
// Any hostname probe that reached the network this round. Literals can be blocked or hijacked on
// a working path: on one operator both literals failed every round while DNS and the download
// answered.
const reached = p => !!(p.down?.ok || p.up?.ok || p.dns?.ok || p.dns_ctl?.ok);

// The round trip failed: neither literal answered and one of them counts against the link. A
// timed-out literal counts; absent, rested, blocked and unused literals do not.
export const roundTripFailed = p => !p.ip6?.ok && !p.ip4?.ok && (failed(p.ip6) || failed(p.ip4));
// No route: the round trip failed and no hostname probe reached the network.
const noRoute = p => roundTripFailed(p) && !reached(p);

// The stall check runs while a download stream waits for headers. Losing the other host and UDP
// together there means the link carried nothing. An abort and a browser without WebRTC lose
// nothing.
const lost = c => c?.ok === false && c.fail !== 'abort' && c.fail !== 'unsupported';
const linkDown = p => lost(p.down?.stall_check?.other_host) && lost(p.down?.stall_check?.udp);
const linkTerm = p => ({note: 'link down', grade: linkDown(p) ? 'red' : null});

const TERMS = {
  voice: ({p, rate, noThroughput, skipRate}) => [
    linkTerm(p),
    {note: 'no UDP', grade: failed(p.udp) ? 'red' : null},
    {note: 'no route', grade: noRoute(p) ? 'red' : null},
    {note: 'round trip lost', grade: roundTripFailed(p) ? 'red' : null},
    {scale: 'round_trip', value: routeMs(p)},
    // Call audio travels over UDP. A browser without WebRTC measures no UDP delay and adds no term.
    ...(p.udp?.ok ? [{scale: 'round_trip', value: p.udp.ms}] : []),
    // A call sends as much as it receives. An upload the round could not time adds no term.
    {note: 'no upload', grade: failed(p.up) ? 'red' : null},
    ...(p.up?.ok ? [{scale: 'call_rate', value: p.up.bps}] : []),
    // A call carries about 100 kb/s over the path the round trip and the UDP probe measured, so a
    // failed bulk download drops the rate term and adds no red.
    ...(skipRate || noThroughput ? [] : [{scale: 'call_rate', value: rate}])
  ],
  news: ({p, noThroughput, skipRate}) => [
    linkTerm(p),
    {note: 'lookup lost', grade: p.dns?.retry_suspected ? 'red' : null},
    {note: 'no lookup', grade: failed(p.dns) ? 'red' : null},
    {note: 'host gone', grade: failed(p.dns_ctl) ? 'red' : null},
    {note: 'no data', grade: noThroughput},
    {scale: 'ttfb', value: p.dns?.ok ? p.dns.ms : null},
    ...(skipRate ? [] : [{scale: 'article', value: articleMs(p)}])
  ],
  streaming: ({p, rate, noThroughput, skipRate}) => [
    linkTerm(p),
    {note: 'no data', grade: noThroughput},
    ...(skipRate ? [] : [{scale: 'rate', value: rate}])
  ]
};


// A server refusal, a short span or a rest measures no throughput, so the rate terms are dropped:
// an empty term marks the activity unrated. A network failure drops `call_rate` from voice and adds
// red to news and streaming.
function terms(activity, p) {
  const skipRate = ourFault(p.down) || !countsAsFailure(p.down) && p.down?.ok === false;
  const noThroughput = failed(p.down) && !skipRate ? 'red' : null;
  return TERMS[activity]?.({p, rate: throughput(p.down), noThroughput, skipRate}) ?? [];
}

// The Google reference answered while every Cloudflare instrument failed: the far end failed, and
// the round holds no measurement of the link.
const FAR_END = {grade: null, value: null, unit: null, note: 'far end', scale: null, saturated: false};

// An activity's grade and the term that set it, so the displayed value matches the colour.
export function activityReading(activity, sample) {
  if (sample?.reference?.ok) return {...FAR_END, missing: []};
  const graded = terms(activity, sample?.probes || {})
    .map(t => ({...t, grade: t.grade ?? gradeValue(t.scale, t.value)}));
  const grade = graded.reduce((a, t) => worse(a, t.grade), null);

  // A scaled term without a measurement makes the activity unrated: a call graded on UDP and
  // throughput alone ignores a missing round trip. A red term still sets red.
  const missing = graded.filter(t => t.scale && t.grade == null).map(t => t.scale);
  if (missing.length && grade !== 'red') {
    return {grade: null, value: null, unit: null, note: 'unrated', scale: null,
            saturated: false, missing};
  }

  const decided = grade == null ? null : graded.find(t => t.grade === grade);
  return {
    grade,
    value: decided?.value ?? null,
    unit: decided?.scale ? SCALES[decided.scale].unit : null,
    note: decided?.note ?? null,
    scale: decided?.scale ?? null,
    // Only the download rate saturates and prints ≥.
    saturated: decided?.scale === 'rate' && sample?.probes?.down?.saturated === true,
    missing: []
  };
}

// Every probe in PROBES needs a scale; a probe without one shows an uncoloured value.
export const PROBE_SCALES = {
  ip6: 'round_trip', ip4: 'round_trip', dns_ctl: 'round_trip',
  udp: 'round_trip', down: 'rate', up: 'call_rate', dns: 'ttfb'
};

// Probes whose reading is a rate; every other probe reads milliseconds.
const RATED = new Set(['down', 'up']);

function probeState(r) {
  if (!r) return 'none';
  if (r.fail === 'resting') return 'resting';
  if (r.expected) return 'absent';
  if (r.blocked) return 'blocked';
  if (r.unused) return 'unused';
  if (ourFault(r)) return 'refused';
  if (failed(r)) return 'failed';
  return r.ok ? 'ok' : 'none';
}

// First-contact time to an uncontacted host: resolution, connect and TLS handshake as one value,
// since resource-timing phases are zeroed cross-origin without Timing-Allow-Origin. Graded on
// `ttfb`, the wait for a new host.
function dnsMeasure(p) {
  if (p.dns?.retry_suspected) return {grade: 'red', note: 'lost'};
  return {scale: 'ttfb', value: p.dns.ms};
}

// A probe's measurement this round and its grade.
export function probeReading(id, sample) {
  const p = sample && !sample.skipped ? (sample.probes || {}) : {};
  const r = p[id];
  const state = probeState(r);
  if (state !== 'ok') {
    return {state, grade: state === 'failed' ? 'red' : null, value: null, unit: null,
            note: state === 'failed' ? r.fail : state === 'none' ? null : state, scale: null};
  }
  const m = id === 'dns' ? dnsMeasure(p)
    : {scale: PROBE_SCALES[id], value: RATED.has(id) ? throughput(r) : r.ms};
  return {
    state, grade: m.grade ?? gradeValue(m.scale, m.value), value: m.value ?? null,
    unit: m.scale ? SCALES[m.scale].unit : null, note: m.note ?? null, scale: m.scale ?? null,
    saturated: r.saturated === true
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

// The value of the term that set an activity's grade.
export function activityValue(activity, sample) {
  return activityReading(activity, sample).value;
}
