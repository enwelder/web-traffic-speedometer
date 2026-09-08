// Grading is about capabilities, not probes. A probe's number means nothing on its own: the
// fresh-lookup probe costs about 200 ms on a perfect link because a real lookup and a cold
// hostname are part of what it measures, so holding it to the same scale as a warm round
// trip to an address marked healthy connections yellow all afternoon.
//
// Every threshold below is absolute. Nothing here consults the session's own statistics —
// a connection is not good merely because it is no worse than the rest of the journey.

export const GRADES = ['green', 'yellow', 'orange', 'red'];
const RANK = Object.fromEntries(GRADES.map((g, i) => [g, i]));

// Tunable in one place, so calibrating against a real journey is a data change.
export const THRESHOLDS = {
  realtime: {label: 'calls & real-time', unit: 'ms', dir: 'low',  edges: [100, 200, 400]},
  tap:      {label: 'tapping a link',    unit: 'ms', dir: 'low',  edges: [300, 1000, 3000]},
  newsite:  {label: 'opening a new site', unit: 'ms', dir: 'low', edges: [400, 1200, 3000]},
  video:    {label: 'video & downloads', unit: 'bps', dir: 'high', edges: [10e6, 5e6, 1.5e6]}
};

export const CAPABILITIES = Object.keys(THRESHOLDS);

export function gradeValue(capability, value) {
  const t = THRESHOLDS[capability];
  // Nothing is not a grade, and neither is nonsense. A negative latency graded green and a
  // NaN graded red: both are arithmetic that went wrong upstream, and inventing a colour for
  // them puts a number on screen that no measurement produced.
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  if (t.dir === 'low') {
    for (let i = 0; i < t.edges.length; i++) if (value < t.edges[i]) return GRADES[i];
    return 'red';
  }
  for (let i = 0; i < t.edges.length; i++) if (value > t.edges[i]) return GRADES[i];
  return 'red';
}

export const worse = (a, b) => (a == null ? b : b == null ? a : (RANK[a] >= RANK[b] ? a : b));

// A probe resting to clear its own wedged connection has not told us anything about the
// network. Grading the capability it feeds as red for the whole cool-down said the opposite
// of what the rest exists to establish.
const failed = r => !!r && r.ok === false && !r.expected && r.fail !== 'resting';

// What each capability reads, and what makes it red regardless of the number.
export function gradeRound(sample) {
  if (!sample || sample.skipped) return null;
  const p = sample.probes || {};
  const out = {};

  // Latency comes from the direct probe; UDP contributes whether the path exists at all.
  // The two are not on one scale — a STUN exchange carries ICE gathering on top of a round
  // trip, and holding it to the same milliseconds put a 33 ms link in orange. Real-time
  // traffic dies on loss before it dies on latency, so either path failing is red however
  // fast the other answers.
  out.realtime = failed(p.ip6) || failed(p.udp)
    ? 'red'
    : gradeValue('realtime', p.ip6?.ok ? p.ip6.ms : null);

  out.tap = failed(p.web) ? 'red' : gradeValue('tap', p.web?.ok ? p.web.ms : null);
  // A lookup that came back on a resolver's retry timer is loss, not slowness.
  out.newsite = failed(p.dns) || p.dns?.retry_suspected ? 'red'
              : gradeValue('newsite', p.dns?.ok ? p.dns.ms : null);

  const d = p.down;
  out.video = failed(d) ? 'red'
            : d?.ok && !d.insufficient_sample ? gradeValue('video', d.bps_steady)
            : null;   // never grade a sample that could not be measured

  return out;
}

// Nearest rank: the smallest value at or above the quantile. Rounding the index down put a
// ten-sample window on its own last element, so anything labelled p90 was the maximum.
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

// Which probe reading each capability is graded on, so the UI shows the number behind the
// colour rather than a second opinion.
export function capabilityValue(capability, sample) {
  const p = sample?.probes || {};
  switch (capability) {
    case 'realtime': return p.ip6?.ok ? p.ip6.ms : null;
    case 'tap':      return p.web?.ok ? p.web.ms : null;
    case 'newsite':  return p.dns?.ok ? p.dns.ms : null;
    case 'video':    return p.down?.ok && !p.down.insufficient_sample ? p.down.bps_steady : null;
    default:         return null;
  }
}
