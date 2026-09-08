// Grades capabilities rather than probes: each capability has its own scale, because the
// probes feeding them measure different work. The fresh-lookup probe costs about 200 ms on a
// perfect link, since a real lookup of a cold hostname is part of what it measures.
//
// Every threshold below is absolute; none consults the session's own statistics.

export const GRADES = ['green', 'yellow', 'orange', 'red'];
const RANK = Object.fromEntries(GRADES.map((g, i) => [g, i]));

// Each scale is absolute — none consults the session — and cites where its edges come from.
//
// round_trip: ITU-T G.114 (https://www.itu.int/rec/T-REC-G.114) puts one-way mouth-to-ear
// delay under 150 ms in the preferred range, 150-400 ms in the acceptable one and over
// 400 ms in the unacceptable one. Codec, packetisation and the jitter buffer account for
// 80-120 ms of that, which leaves about 100 ms of round trip to the edge inside the
// preferred range.
//
// ttfb: https://web.dev/articles/ttfb — good 800 ms, needs improvement to 1800 ms, poor
// beyond. It covers DNS, TCP, TLS and the first response byte, which is what the fresh-lookup
// probe measures for a hostname no resolver has seen. web.dev defines it over a site's 75th
// percentile; applied here to a single round, so a round is judged more harshly than a site.
//
// article: the Core Web Vitals thresholds for Largest Contentful Paint — good 2.5 s, poor
// 4 s (https://web.dev/articles/lcp). Held against a modelled time, not a measured one.
//
// rate: Netflix asks 3 Mb/s for 720p, 5 Mb/s for 1080p and 15 Mb/s for 4K
// (https://help.netflix.com/en/node/306). Green is 1080p with headroom, yellow meets the
// 1080p figure, orange is below the 720p one. 4K is not the bar: it buys nothing on a phone.
//
// call_rate: a call is latency-bound, not bandwidth-bound, so this term exists to catch a
// link carrying almost nothing rather than to rank fast links. Opus runs wideband speech at
// 9-14 kb/s and scales from 6 kb/s to 510 kb/s (https://www.rfc-editor.org/info/rfc6716/), so
// 30 kb/s is already several times what speech needs once RTP and IP overhead are counted;
// green additionally carries a video call.
export const SCALES = {
  round_trip: {unit: 'ms',  dir: 'low',  edges: [100, 200, 400]},
  ttfb:       {unit: 'ms',  dir: 'low',  edges: [800, 1800, 3000]},
  article:    {unit: 'ms',  dir: 'low',  edges: [2500, 4000, 8000]},
  rate:       {unit: 'bps', dir: 'high', edges: [10e6, 5e6, 1.5e6]},
  call_rate:  {unit: 'bps', dir: 'high', edges: [0.3e6, 0.1e6, 0.03e6]}
};

// What a person is trying to do, and every measurement that has to hold for it. A purpose is
// the worst of its terms, so one requirement failing sinks it however well the others read:
// a call with a fast round trip and no UDP path is still a call that will not connect.
export const PURPOSES = {
  voice:     {label: 'calls & live audio', unit: 'ms',  scales: ['round_trip', 'call_rate']},
  news:      {label: 'opening an article', unit: 'ms',  scales: ['ttfb', 'article']},
  streaming: {label: 'video & downloads',  unit: 'bps', scales: ['rate']}
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

const worstOf = (...grades) => grades.reduce(worse, null);

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

// Every purpose reads several probes, so no single probe failing decides one on its own.
export function gradeRound(sample) {
  if (!sample || sample.skipped) return null;
  const p = sample.probes || {};
  const rate = p.down?.ok ? p.down.bps_min : null;
  // A throughput probe that failed for a reason of its own leaves the purposes that read it
  // with one fewer term, rather than with a red one.
  const downFailed = failed(p.down) && !ourFault(p.down) ? 'red' : null;

  return {
    // Real-time traffic breaks on loss before it breaks on latency, so either path failing is
    // red however fast the other answers. A STUN exchange carries ICE gathering on top of a
    // round trip, so its milliseconds are on a different scale and only its success counts.
    voice: worstOf(failed(p.ip6) || failed(p.udp) ? 'red' : null,
                   gradeValue('round_trip', p.ip6?.ok ? p.ip6.ms : null),
                   gradeValue('call_rate', rate)),
    // An article needs a cold origin resolved and a warm one reached, so either probe failing
    // sinks it. A lookup returning on a resolver's retry timer is loss, not slowness.
    news: worstOf(failed(p.dns) || failed(p.web) || p.dns?.retry_suspected ? 'red' : null,
                  downFailed,
                  gradeValue('ttfb', p.dns?.ok ? p.dns.ms : null),
                  gradeValue('article', articleMs(p))),
    streaming: worstOf(downFailed, gradeValue('rate', rate))
  };
}

// Nearest rank: the smallest value at or above the quantile. Rounding the index down puts a
// ten-sample window on its own last element, making p90 the maximum.
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

// The figure a purpose leads with, so the tile shows the number behind its colour rather
// than a second opinion. A purpose reads several probes; this is the one a person would
// recognise as the answer.
export function capabilityValue(capability, sample) {
  const p = sample?.probes || {};
  switch (capability) {
    case 'voice':     return p.ip6?.ok ? p.ip6.ms : null;
    case 'news':      return articleMs(p);
    case 'streaming': return p.down?.ok ? p.down.bps_min : null;
    default:          return null;
  }
}
