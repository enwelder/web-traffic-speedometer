// Grades capabilities rather than probes: each capability has its own scale, because the
// probes feeding them measure different work. The fresh-lookup probe costs about 200 ms on a
// perfect link, since a real lookup of a cold hostname is part of what it measures.
//
// Every threshold below is absolute; none consults the session's own statistics.

export const GRADES = ['green', 'yellow', 'orange', 'red'];
const RANK = Object.fromEntries(GRADES.map((g, i) => [g, i]));

// Edges run from best to worst; `dir` says which side of an edge is better.
//
// realtime: ITU-T G.114 (https://www.itu.int/rec/T-REC-G.114) puts one-way mouth-to-ear
// delay under 150 ms in the preferred range, 150-400 ms in the acceptable one and over
// 400 ms in the unacceptable one. Codec, packetisation and the jitter buffer account for
// 80-120 ms of that, which leaves about 100 ms of round trip to the edge inside the
// preferred range.
//
// tap: a warm origin, so it is held to a tighter bar than the cold-origin figures below.
//
// newsite: the TTFB thresholds from https://web.dev/articles/ttfb — good 800 ms, needs
// improvement to 1800 ms, poor beyond. They cover DNS, TCP, TLS and the first response byte,
// which is what this probe measures for a hostname no resolver has seen. web.dev defines
// them over a site's 75th percentile; applied here to a single round, so an individual round
// is judged more harshly than a site would be.
//
// video: Netflix asks 3 Mb/s for 720p, 5 Mb/s for 1080p and 15 Mb/s for 4K
// (https://help.netflix.com/en/node/306). Green is 1080p with headroom to spare, yellow
// meets the 1080p figure exactly, and orange is below the 720p one — so orange means
// standard definition at best. 4K is not the bar: it asks 15 Mb/s and buys nothing on a
// phone screen.
export const THRESHOLDS = {
  realtime: {label: 'calls & real-time', unit: 'ms', dir: 'low',  edges: [100, 200, 400]},
  tap:      {label: 'tapping a link',    unit: 'ms', dir: 'low',  edges: [300, 1000, 3000]},
  newsite:  {label: 'opening a new site', unit: 'ms', dir: 'low', edges: [800, 1800, 3000]},
  video:    {label: 'video & downloads', unit: 'bps', dir: 'high', edges: [10e6, 5e6, 1.5e6]}
};

export const CAPABILITIES = Object.keys(THRESHOLDS);

export function gradeValue(capability, value) {
  const t = THRESHOLDS[capability];
  // Missing, non-finite and negative values yield no grade: they come from arithmetic that
  // went wrong upstream, and comparing them against the edges produces green for a negative
  // latency and red for a NaN.
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  if (t.dir === 'low') {
    for (let i = 0; i < t.edges.length; i++) if (value < t.edges[i]) return GRADES[i];
    return 'red';
  }
  for (let i = 0; i < t.edges.length; i++) if (value > t.edges[i]) return GRADES[i];
  return 'red';
}

export const worse = (a, b) => (a == null ? b : b == null ? a : (RANK[a] >= RANK[b] ? a : b));

// A resting probe has reported nothing about the network, so it must not grade the
// capability it feeds as red for the whole cool-down.
const failed = r => !!r && r.ok === false && !r.expected && r.fail !== 'resting';

// What each capability reads, and what makes it red regardless of the number.
export function gradeRound(sample) {
  if (!sample || sample.skipped) return null;
  const p = sample.probes || {};
  const out = {};

  // Latency comes from the direct probe; UDP contributes only whether the path exists. A
  // STUN exchange carries ICE gathering on top of a round trip, so its milliseconds are on a
  // different scale and are not graded. Real-time traffic breaks on loss before latency, so
  // either path failing is red however fast the other answers.
  out.realtime = failed(p.ip6) || failed(p.udp)
    ? 'red'
    : gradeValue('realtime', p.ip6?.ok ? p.ip6.ms : null);

  out.tap = failed(p.web) ? 'red' : gradeValue('tap', p.web?.ok ? p.web.ms : null);
  // A lookup returning on a resolver's retry timer indicates loss.
  out.newsite = failed(p.dns) || p.dns?.retry_suspected ? 'red'
              : gradeValue('newsite', p.dns?.ok ? p.dns.ms : null);

  // The download reports a bound, so grading it is a threshold test: the question is which
  // band the bytes that arrived prove the link is in, never how fast it is.
  const d = p.down;
  out.video = failed(d) ? 'red' : gradeValue('video', d?.ok ? d.bps_min : null);

  return out;
}

// Nearest rank: the smallest value at or above the quantile. Rounding the index down puts a
// ten-sample window on its own last element, making p90 the maximum.
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

// The probe reading each capability is graded on, so the UI shows the number behind the
// colour.
export function capabilityValue(capability, sample) {
  const p = sample?.probes || {};
  switch (capability) {
    case 'realtime': return p.ip6?.ok ? p.ip6.ms : null;
    case 'tap':      return p.web?.ok ? p.web.ms : null;
    case 'newsite':  return p.dns?.ok ? p.dns.ms : null;
    case 'video':    return p.down?.ok ? p.down.bps_min : null;
    default:         return null;
  }
}
