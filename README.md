# Web Traffic Speedometer

[![release](https://github.com/enwelder/web-traffic-speedometer/actions/workflows/release.yml/badge.svg)](https://github.com/enwelder/web-traffic-speedometer/actions/workflows/release.yml)
[![codeql](https://github.com/enwelder/web-traffic-speedometer/actions/workflows/codeql.yml/badge.svg)](https://github.com/enwelder/web-traffic-speedometer/actions/workflows/codeql.yml)
[![release version](https://img.shields.io/github/v/release/enwelder/web-traffic-speedometer?label=release&color=4C9BE8)](https://github.com/enwelder/web-traffic-speedometer/releases/latest)
[![licence 0BSD](https://img.shields.io/github/license/enwelder/web-traffic-speedometer?color=35B37E)](LICENSE)

**[Open the logger](https://enwelder.github.io/web-traffic-speedometer/)**

Answers one question about any network, anywhere: **can I make a call, read an article, or
watch a video on this connection right now — and if not, which layer is at fault?**

It runs in a browser, on any device, over Wi-Fi or mobile data. Point it at a connection that
drops video calls, or at a commute where data dies between stations, and it records what was
actually happening the whole time.

A browser is given no radio metrics — no RSRP, RSRQ, SINR or cell ID, on any platform.
Timing requests is the only measurement available. So: seven requests every round, each
isolating a different layer, which is what makes a failure attributable rather than merely
noted.

## What it does

```
every 15 s (Fine) or 30 s (Coarse)
        │
        ▼
  seven probes in parallel, each on its own deadline
        │
        ▼
  one row ─── 7 measurements · GPS fix · timing · grades
        │
        ├──▶ IndexedDB ──▶ one JSON file per session
        └──▶ the screen
```

Every round is written whole, including the rounds that failed. Nothing is aggregated away,
and every grade on screen can be recomputed from the exported rows. Where the line falls
between noise and an outage is an analysis decision, made downstream against timetables and
cell databases — not here.

## The seven probes

| Probe | Request | Isolates |
|---|---|---|
| `ip6` | `https://[2606:4700:4700::1111]/cdn-cgi/trace` | the radio link over IPv6, no name resolution involved |
| `ip4` | `https://1.1.1.1/cdn-cgi/trace` | the same over IPv4 |
| `dns` | `https://<random>.github.io/` `HEAD` | a name the carrier's resolver cannot have cached |
| `dns_ctl` | `https://wts-dns-control.github.io/` `HEAD` | the same destination, name already cached |
| `web` | `https://www.gstatic.com/generate_204` | a provider that is not Cloudflare |
| `down` | `https://speed.cloudflare.com/__down` | throughput the link sustains |
| `udp` | `stun:stun.cloudflare.com:3478` | whether UDP gets out, and what it maps to |

`ip6`, `dns_ctl`, `web` and `udp` run three times per round and report the median. `down`
reports a lower bound on throughput, not a rate.

Reading them against each other is the point:

| observation | conclusion |
|---|---|
| `dns` fails, `dns_ctl` succeeds | name resolution, not the destination |
| `dns` and `ip6` both fail | the radio link, not DNS |
| `web` alone fails | one provider's edge, not the network |
| all answer but `down` collapses | congestion — a saturated cell still replies quickly to small requests |
| `udp` alone fails | the carrier shapes UDP apart from TCP; calls and streaming ride on UDP |

## How probes become activity grades

```
  ip6 or ip4 ──┐   whichever family carries traffic
  udp        ──┼──▶  voice & video calling
  down       ──┘

  dns        ──┐
  web        ──┼──▶  reading articles
  down       ──┘

  down       ─────▶  streaming video

  dns_ctl    ─────▶  the baseline the dns grade is measured against
```

Which measurement each activity reads:

| probe | voice & video calling | reading articles | streaming video |
|---|---|---|---|
| `ip6` `ip4` | round trip over whichever works; **both** gone → red | | |
| `udp` | failure → red | | |
| `dns` | | TTFB; failure or lost first query → red | |
| `web` | | in the article model; failure → red | |
| `down` | call rate | in the article model; failure → red | rate; failure → red |
| `dns_ctl` | *not read directly* — it is what `dns` is graded against | | |

**The route is whichever address family the network has.** A network carrying only IPv6 is
ordinary — most mobile carriers, using NAT64/DNS64 — and so is one carrying only IPv4, which
is common on Wi-Fi and on older mobile networks. Either alone is a working connection.
Calling only goes red when *both* families are gone, and the round trip is read from the one
that answered; a browser prefers IPv6 where both work, so it leads.

**An activity is the worst of its terms.** One failed requirement sinks it however well the
others read: a call with a 30 ms round trip and no UDP path is a call that will not connect.
Its verdict is a colour rather than a number, since the terms behind it are measured in
different units; the numbers are on the probe rows above it, and the grade is stored per round
so it can be traced back to them.

Article time is modelled, not measured:

```
2 × dns + 2 × web + 500 kB / down
```

500 kB is the critical path to a readable article — HTML, CSS and fonts are
[221 kB at the mobile median](https://almanac.httparchive.org/en/2025/page-weight), and the
largest image is what LCP waits for. Dividing by a throughput *bound* makes the result an
upper bound on the wait.

## The scales

Every edge is absolute. Nothing consults the session's own statistics, so a connection is not
good merely because it is no worse than the rest of the journey. A value exactly on an edge
takes the worse side.

| scale | what is measured on it | green | yellow | orange | red | source |
|---|---|---|---|---|---|---|
| `round_trip` | the latency of `ip6` `ip4` `dns_ctl` `web` `udp` | <100 ms | <200 ms | <400 ms | ≥400 ms | [ITU-T G.114](https://www.itu.int/rec/T-REC-G.114) |
| `ttfb` | `dns` latency, for reading articles | <800 ms | <1800 ms | <3000 ms | ≥3000 ms | [web.dev](https://web.dev/articles/ttfb) |
| `article` | the modelled article time below | <2.5 s | <4 s | <8 s | ≥8 s | [Core Web Vitals LCP](https://web.dev/articles/lcp) |
| `rate` | `down`'s throughput bound | >10 Mb/s | >5 Mb/s | >1.5 Mb/s | ≤1.5 Mb/s | [Netflix tiers](https://help.netflix.com/en/node/306) |
| `call_rate` | the same bound, asked what a call needs | >300 kb/s | >100 kb/s | >30 kb/s | ≤30 kb/s | [Opus, RFC 6716](https://www.rfc-editor.org/info/rfc6716) |
| `dns_delta` | `dns` latency minus `dns_ctl` latency | <250 ms | <500 ms | <1000 ms | ≥1000 ms | derived — see below |

The same measurement can be read on two scales: `down`'s bound decides streaming on `rate`
and calling on `call_rate`, because a call needs a thousandth of what video does.

Where an edge departs from its source:

| scale | why |
|---|---|
| `round_trip` | G.114 budgets mouth-to-ear one-way; codec, packetisation and jitter buffer take 80-120 ms, leaving ~100 ms of round trip to the edge |
| `ttfb` | defined over a site's 75th percentile, applied here to a single round |
| `rate` | 4K is not the bar: it asks 15 Mb/s and buys nothing on a phone screen |
| `call_rate` | catches a link carrying nothing, not a slow one — a call is latency-bound |

Every probe is graded on its own row too, on the scale named above. Four states carry no
colour, because in none of them did the probe measure the link:

| state | when |
|---|---|
| `absent` | the path is known missing — IPv4 after the preflight, UDP without WebRTC |
| `resting` | the recorder stood the probe down to clear a wedged connection |
| `refused` | the far end turned the request away: a fact about the endpoint |
| `none` | the round ran no such probe |

## On screen

Six rows on top, one per reading, then one history strip per activity. The two address
families share a row — the one carrying traffic is the one worth reading, and its label says
which it is. Tapping a row says what it measures; **?** does all six at once.

The strips carry the activity verdicts: one bar per round, newest on the right.

**Degraded** is the share of rounds with any probe failure, and is the figure worth watching:
full outages are rare — the longest recorded ran four rounds — while partially failing rounds
reached 47% over the worst stretch at a perfectly healthy median latency of 96 ms.

## Data usage

The two download requests are almost the whole cost; the six small probes total ~12 kB per
round. The projection assumes the 4 MB ceiling every round: **~630 MB for 40 minutes on
Fine**, ~310 MB on Coarse. A slow link costs far less, because the measured request is sized
from what the warm-up saw. Both figures are shown before a run and tracked during it. Nothing
stops a run partway.

## Design notes

Why each probe is built the way it is. Most of this came from recorded journeys rather than
from review.

**Single-stack networks are normal.** Many mobile carriers are IPv6-only with NAT64/DNS64,
where iOS has no CLAT and relies on DNS64 synthesising an address during resolution — which an
address literal skips, so `ip4` cannot connect at all. Plenty of other networks carry no IPv6.
A preflight settles both families once per session into `ipv6_available` and `ipv4_available`;
afterwards a failure of the absent family carries `expected: true` and stays out of every
tally. A failure *without* that flag means the family worked at the start and stopped. Both
gone is never "expected" — that is the network being down.

**Latency is a median of three.** One round trip moves by an order of magnitude on a cold
connection, a retransmission or a scheduling delay. RMBT takes 10-200 samples for the same
reason; three is the compromise for something that runs a whole journey and pays per sample.
Sampling stops at the first failure. `dns` is sampled once — a second lookup is answered from
cache.

**A name that cannot be cached.** A fixed hostname stops testing DNS after one round:
`one.one.one.one` has a 24-hour TTL, so the OS answers from cache and no query reaches the
network, including during the outages that matter most. `*.github.io` has a wildcard record
*and* a wildcard certificate, so a never-used label resolves and serves over TLS. `HEAD` keeps
the 9 kB 404 body off the wire.

| alternative | why not |
|---|---|
| a wildcard on Cloudflare, matching the IP probes' destination | none exists: `pages.dev`, `workers.dev` and `cloudflare-dns.com` have no wildcard DNS |
| DNS-over-HTTPS | bypasses the OS resolver, so it measures Cloudflare's recursive resolver instead of the carrier's |

**The DNS delta.** `dns` is graded on `dns.ms − dns_ctl.ms`, never on its own latency: both
requests go to the same host over the same path, so the difference removes what they share.
No standard covers this, so the edges are fitted to the 259 rounds in the committed journeys
where both answered. Two later live runs agree:

| corpus | n | min | p50 | p90 | max |
|---|---|---|---|---|---|
| three recorded journeys | 259 | −112 ms | 150 ms | 460 ms | 4164 ms |
| dual-stack Wi-Fi | 7 | 113 ms | 126 ms | — | 138 ms |
| 5G hotspot, different egress | 11 | 124 ms | 143 ms | — | 268 ms |

The ~120 ms floor appears on all three, which places it at the destination rather than at any
carrier. A green here therefore means "no worse than the floor", not "DNS is fast" — most of
the gap is GitHub handling a hostname it has not seen. The delta goes negative on noise
(`dns` is one sample, `dns_ctl` a median of three) and is clamped at zero. `retry_suspected`
forces red whatever the delta says, since a lost first query is loss rather than slowness; no
recording exercises that path. `tests/replay.mjs` pins the corpus split, so moving an edge
without re-deriving it fails.

**A wedged probe is not the network.** A connection can reach a state the browser will not
retire: after an outage every other probe recovers within a round while one keeps timing out
alone — one recording has twenty consecutive false failures. A page cannot ask for a fresh
connection, so a probe failing three rounds running while *most* others answer is rested for
six rounds. Only `timeout`, `network` and `stalled` trigger it: a `parse` failure means the
connection worked and returned a body, which is what a captive portal looks like. *Most*
others, not one — an earlier version rested every probe at once during an outage and blanked
the readout exactly when the network was worst.

**Trace bodies are validated.** A response is accepted only if the egress parses as an
address, `colo` is a three-letter PoP code, the scheme is still HTTPS, and the echoed host
matches the one requested. Otherwise a middlebox answering on Cloudflare's behalf passes as a
measurement. RTR's suite has the same check, under "unmodified content".

**UDP needs a peer connection.** ICE candidate gathering is the only way a browser puts a UDP
packet on the wire. Gathering alone cannot carry data — sending needs a data channel, a track
or a completed negotiation, and none is ever created. Its milliseconds are graded on its own
row but ignored by the calling activity, which reads only whether the path exists: gathering
rides on top of the round trip, so the number overstates the link.

**The download reports a bound.** `bps_min` is what the bytes that arrived prove the link
carries. Charging every uncertainty to the bound — slow start, WebKit's lumpy delivery, clock
jitter — means it can only understate, so none of them needs correcting for. Two requests per
round: a 96 kB warm-up to open the congestion window, then a measured one sized from it for
~500 ms of body. iOS opens a fresh connection every round, and a fresh one delivers at the
congestion window's pace rather than the link's:

| condition | measured against a 350 Mb/s reference |
|---|---|
| 625 kB, cold connection | 19.9 Mb/s |
| 625 kB, warm connection | 177 Mb/s |
| 4 MB, warm connection | 293 Mb/s |
| 8 MB, warm connection | 291 Mb/s |

Accuracy stops improving at 4 MB, which sets the ceiling. Spending more does not steady the
result either: 4 MB transfers vary 5.4× across passes, and three samples a round cost 2.7× the
data for no gain. The variance is between rounds, so a journey has to be aggregated.

**Deadlines and scheduling.** Every TCP probe gets 8 s, capped at the interval minus half a
second; `udp` gets 3 s, since a STUN binding answers within a round trip or not at all. Eight
rather than four because journey data showed probes succeeding at 3885 ms against a 4000 ms
ceiling — anything slower was filed as a failure, which collapses "slow" into "gone". Rounds are scheduled from when the previous one fired, not onto a grid: on a
grid, lateness pulls the next slot closer, so after a freeze two rounds fire moments apart and
measure the same instant twice at twice the price.

**iOS limits.**

| limit | consequence |
|---|---|
| `coords.speed` is filled sporadically — on 0, 2 and 51 of 158, 75 and 243 rounds across three journeys | speed is derived from consecutive fixes, only when both are under 100 m |
| accuracy swings to tower estimates — one journey spent 30 of 74 rounds at exactly 1414 m | `accuracy_class` splits `gps` from `coarse`; deriving from coarse fixes produced 682 km/h on a train, so anything above 400 km/h is discarded |
| the system reclaims the wake lock without the page becoming hidden, usually on Low Power Mode | reacquired on release, every round, and on visibility; every row carries `wake_lock` |
| locking the screen or backgrounding the tab freezes JavaScript | recorded as a `pause` event, as `late_ms`, and as `visible: false` |
| Safari evicts storage after about a week unvisited | never-exported sessions are flagged in the list |

**Operator and connection type** are asked for, because no browser API exposes either —
`navigator.connection` is unimplemented in Safari everywhere. The recorded egress IP makes the
answer checkable afterwards, since a carrier range and home Wi-Fi resolve to different ASNs.

## Running it

Static files, no build step, no runtime dependencies. Serve over HTTPS; GitHub Pages is
enough. Locally `npm run serve` gives `http://localhost:8731`, which counts as a secure
context, so geolocation, wake lock and service workers work without certificates.

A service worker caches the shell, so the page loads and a crashed session recovers on a
network too degraded to fetch anything.

## Development

```
npm ci          # playwright and eslint, development only
npm run lint
npm test        # every suite
npm run test:unit / test:security / test:browser
```

Unit, grading and edge-case suites run with no browser and no network. `tests/replay.mjs`
runs three anonymised real journeys through the grading and rollup; `tests/browser.mjs`
drives a real browser for IndexedDB, crash recovery, the service worker and the CSP.

Recordings become fixtures with `node tools/anonymise.mjs <recording> <fixture>`: coordinates
removed, addresses and user agents redacted, timestamps shifted to a fixed epoch with
intervals preserved, measurements untouched.

Machine-local files go in `.dev/`, ignored as a directory — a recording carries a home
address, a workplace and a daily timetable, and this repository is public. Security tests
enforce it: nothing under `.dev/` may be tracked, and no committed file may have the shape of
a journey export.

`package.json` is the source of the version; `js/session.js` and `sw.js` restate it, since
there is no build step to read it from. A security test fails the build if the three disagree.
A push to `main` publishes to Pages; a new version number also tags and releases.

## Security properties

`tests/security.mjs` fails the build if any of these stops being true:

- It contacts nothing but its seven probes.
- It has no way to upload what it records: one `fetch`, no request bodies, no `sendBeacon`,
  `WebSocket` or `XMLHttpRequest`, no URL reaching the network via an image or a `src`.
- It sends no credentials or referrer.
- It executes no dynamic code and writes no markup. Everything reaches the DOM as text.
- It ships no third-party code, at build time or runtime.
- The peer connection gathers ICE candidates and nothing else.
- The service worker never touches a probe and never takes over a tab mid-session.

Data leaves only when you export it.

The page pins scripts, styles, images, the manifest and the worker to its own origin under
`default-src 'none'`. `connect-src` is `'self' https:` rather than an allowlist: the CSP
host-source grammar cannot express a bracketed IPv6 literal, and naming the IPv6 probe
endpoint makes the browser block that probe outright. The enforced allowlist is the URL check
in `tests/security.mjs`.

## The exported file

One session, one JSON file: metadata, environment, a recomputable rollup, every sample and
every event. Every field is listed in **[docs/data-format.md](docs/data-format.md)**.

## Licence

[0BSD](LICENSE). Public-domain-equivalent: use it for anything, no attribution required.
