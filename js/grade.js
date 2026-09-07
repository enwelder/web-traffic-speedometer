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
  if (value == null) return null;
  if (t.dir === 'low') {
    for (let i = 0; i < t.edges.length; i++) if (value < t.edges[i]) return GRADES[i];
    return 'red';
  }
  for (let i = 0; i < t.edges.length; i++) if (value > t.edges[i]) return GRADES[i];
  return 'red';
}

export const worse = (a, b) => (a == null ? b : b == null ? a : (RANK[a] >= RANK[b] ? a : b));

const failed = r => !!r && r.ok === false && !r.expected && r.fail !== 'data_cap';

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

// Worst of the last N rounds, so one slow round does not repaint the screen — and one good
// one does not clear a bad stretch either.
export function windowGrade(recent, capability) {
  let g = null;
  for (const grades of recent) g = worse(g, grades?.[capability] ?? null);
  return g;
}

// Displayed state changes only after the window has agreed with itself twice. Without this
// the colours flicker on a moving train and stop being readable at a glance.
export function createDisplay({windowRounds = 3, confirmations = 2} = {}) {
  const history = [];
  const shown = {};
  const pending = {};

  return {
    push(grades) {
      history.push(grades);
      if (history.length > windowRounds) history.shift();
      for (const cap of CAPABILITIES) {
        const candidate = windowGrade(history, cap);
        if (candidate == null || candidate === shown[cap]) { pending[cap] = null; continue; }
        pending[cap] = pending[cap]?.grade === candidate
          ? {grade: candidate, seen: pending[cap].seen + 1}
          : {grade: candidate, seen: 1};
        // The first reading a session ever gets has nothing to confirm against.
        if (shown[cap] == null || pending[cap].seen >= confirmations) {
          shown[cap] = candidate;
          pending[cap] = null;
        }
      }
      return {...shown};
    },
    current: () => ({...shown}),
    reset() {
      history.length = 0;
      for (const k of Object.keys(shown)) delete shown[k];
      for (const k of Object.keys(pending)) delete pending[k];
    }
  };
}

// Variance, reported beside the colour and never inside it. A connection that alternates
// between 40 ms and 900 ms is a different thing from one steady at 400, and averaging them
// into one grade would hide exactly the behaviour worth seeing.
// Nearest rank: the smallest value at or above the quantile. Rounding the index down put a
// ten-sample window on its own last element, so anything labelled p90 was the maximum.
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

export function stability(values) {
  const v = values.filter(x => x != null).sort((a, b) => a - b);
  if (v.length < 4) return null;
  const at = q => quantile(v, q);
  const p50 = at(0.5);
  if (!p50) return null;
  return {ratio: Math.round((at(0.9) / p50) * 10) / 10, iqr: at(0.75) - at(0.25), n: v.length};
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
