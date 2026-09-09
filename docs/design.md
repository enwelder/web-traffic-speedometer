# Design notes

Why each part works the way it does. Most of it comes from recorded journeys rather than
from review.

## IPv4 and IPv6

Dutch mobile networks are IPv6-only with NAT64/DNS64. iOS has no CLAT, so it relies on DNS64
synthesising an address during name resolution. An address literal skips resolution, so the
`ip4` probe has nothing to connect to and is refused within a few milliseconds.

A preflight at session start records the result in `ipv4_available`, with the evidence in
`ipv4_check`. After that, `ip4` failures carry `expected: true`, stay out of failure counts
and do not colour the display. An `ip4` failure without that flag means IPv4 worked at the
start of the session and stopped.

## Latency sampling

`ip6`, `dns_ctl`, `web` and `udp` each run three times per round, inside one shared deadline.
`ms` is the median of the samples that succeeded; all samples are kept in `ms_samples`.

One round trip is not a measurement. A cold connection, a single retransmission or a
scheduling delay moves it by an order of magnitude. RMBT takes 10–200 samples for this
reason; three is the compromise here, because this runs for a whole journey and every sample
costs data.

`dns` is sampled once. A second lookup of the same name is answered from cache.

Sampling stops at the first failure within a round. A repeat of a failed probe adds nothing
and spends budget the round may still need.

## The DNS probe

Each round requests `https://<random label>.github.io/` with `HEAD`, using a label never used
before. `*.github.io` has both a wildcard DNS record and a wildcard certificate, so any label
resolves and serves over TLS. `HEAD` keeps the 9 kB 404 body off the wire. The hostname is
recorded per round, so a reader can verify each one was fresh.

A fixed hostname would stop testing DNS after the first round. `one.one.one.one` has a
24-hour TTL, so the OS answers from cache and no query reaches the network, including during
the long outages that matter most.

`dns_ctl` requests a constant hostname at the same destination. The pair discriminates
failures: `dns` failing while `dns_ctl` succeeds isolates name resolution, because the only
difference between them is whether the name was already known.

The pair does **not** measure lookup time. Roughly a tenth of the latency difference between
them is resolution; the rest is GitHub handling a hostname it has not seen, which is why
requesting the same new name twice collapses the gap.

Alternatives considered:

| option | why not |
|---|---|
| wildcard on Cloudflare, matching the IP probe's destination | none exists. `pages.dev`, `workers.dev` and `cloudflare-dns.com` have no wildcard DNS |
| DNS-over-HTTPS | bypasses the OS resolver, so it measures Cloudflare's recursive resolver instead of the carrier's |

## Stuck probes

A probe that fails three rounds running, while most of the others succeed, is marked `stuck`
and rested for six rounds. Rested rounds are still written, with `fail: "resting"`.

The browser sometimes keeps a connection in a state it will not retire. After an outage,
every other probe recovers within a round while one keeps timing out on its own for the rest
of the session; one recording has twenty consecutive false failures like this. A page cannot
ask for a fresh connection, so the only available remedy is to leave the probe idle long
enough for the browser to drop the old one.

Three constraints on the rule, each from a recording:

- Only `timeout`, `network` and `stalled` trigger it. Those are the failures a new connection
  could fix.
- A `parse` failure does not. The connection worked and returned a body, which is what a
  captive portal answering for Cloudflare looks like. Resting would hide the portal for six
  rounds out of every nine.
- *Most* other probes must be succeeding, not one. One probe still answering is weak evidence
  that six separate connections have each wedged. An earlier version rested every probe at
  once during an outage and blanked the readout exactly when the network was worst.

## Checking a trace response

`ip6` and `ip4` accept a Cloudflare trace body only if the egress parses as an IP address,
`colo` is a three-letter PoP code, the scheme is still HTTPS, and the echoed host matches the
host requested. Anything else fails as `parse`, with the detail in `parse_reason`.

Without these checks, a middlebox answering on Cloudflare's behalf, or rewriting the Host
header in transit, passes as a successful measurement. RTR's test suite has the same check
under the name "unmodified content".

## The UDP probe

`udp` opens a peer connection, gathers ICE candidates against a STUN server, and reads the
server-reflexive ones. Candidate gathering is the only way a browser can send a UDP packet.
It is worth the complexity because real-time traffic uses UDP and carriers shape it
separately from TCP.

Gathering by itself cannot carry data. Sending requires a data channel, a media track, or a
remote description that completes negotiation. None is created, the transceiver is
receive-only, and the connection closes when gathering finishes. `tests/security.mjs`
enforces all four.

All server-reflexive candidates are kept. A dual-stack network reports one per address
family, and comparing them with the TCP egress from the same round shows whether both
transports leave by the same path.

## The download probe

Two requests per round, each read to the end:

| request | size | purpose |
|---|---|---|
| warm-up | 96 kB | opens the congestion window |
| measured | 128 kB – 4 MB | sized from the warm-up to take about 500 ms |

`bps_min` is a lower bound on throughput, not a rate: it is what the bytes that arrived prove
the link can carry. The display only needs to know which band the link is in. Charging every
uncertainty to the bound means slow start, WebKit delivering bodies in lumps, and clock
jitter all push it downwards, so none of them needs correcting for.

The warm-up exists because a fresh connection delivers its first bytes at the congestion
window's pace, and iOS opens a fresh one every round (`reused` is false on every recorded
download row). Measured on a Mac using a phone's 5G hotspot, against a reference test reading
350 Mbit/s:

| condition | measured |
|---|---|
| 625 kB, cold connection | 19.9 Mb/s |
| 625 kB, warm connection | 177 Mb/s |
| 4 MB, warm connection | 293 Mb/s |
| 8 MB, warm connection | 291 Mb/s |

Accuracy stops improving at 4 MB, which sets the ceiling. A fixed 4 MB would take 32 s on a
1 Mb/s cell and be truncated every round, hence sizing the measured request from the warm-up.

A download rejected before any response is retried once as an opaque request. An unreadable
response still counts as one, so opaque success means the server refused this origin, and
opaque failure means the connection never opened. A server refusal does not grade the link as
bad.

Spending more per round does not steady the result. 4 MB transfers vary 5.4× across passes,
and three samples per round cost 2.7× the data for no gain (3.9× spread against 3.8×). The
variance is between rounds, not within them, so a journey has to be aggregated to get a
stable figure.

## Deadlines and scheduling

Every probe deadline is 8 s, capped at the interval minus half a second, and the values in
force are written to `environment.timeouts_ms`. No probe can outlive its round.

Eight seconds rather than four: journey data showed probes succeeding at 3885 ms against a
4000 ms ceiling, so anything slower was being recorded as a failure. That collapses "slow"
into "gone", which is the distinction the tool exists to make.

Rounds are scheduled from the moment the previous round fired, not onto a fixed grid. On a
grid, lateness pulls the next slot closer, so after a freeze the next round fires immediately
and collides with the one still running. A round costs megabytes, so two rounds moments apart
measure the same instant twice at twice the price.

Both profiles run the download every round. It is the only probe that measures throughput,
and sampling it occasionally leaves most rounds without one. The interval therefore sets cost
and resolution together: Fine locates a dropout to within 15 s and costs twice as much as
Coarse.

## Grading

Two things are graded, on the same four colours and the same scales: each probe's own
measurement, and each activity composed from several of them.

### The scales

Every edge is absolute. Nothing consults the session's own statistics, so a connection is not
good merely because it is no worse than the rest of the journey.

| scale | green | yellow | orange | red | from |
|---|---|---|---|---|---|
| `round_trip` | <100 ms | <200 ms | <400 ms | ≥400 ms | ITU-T G.114 |
| `ttfb` | <800 ms | <1800 ms | <3000 ms | ≥3000 ms | web.dev TTFB |
| `article` | <2.5 s | <4 s | <8 s | ≥8 s | Core Web Vitals LCP |
| `rate` | >10 Mb/s | >5 Mb/s | >1.5 Mb/s | ≤1.5 Mb/s | Netflix tiers |
| `call_rate` | >300 kb/s | >100 kb/s | >30 kb/s | ≤30 kb/s | Opus, RFC 6716 |
| `dns_delta` | <250 ms | <500 ms | <1000 ms | ≥1000 ms | derived — below |

| source | | |
|---|---|---|
| G.114 | <https://www.itu.int/rec/T-REC-G.114> | 150 ms one-way preferred, 400 unusable |
| TTFB | <https://web.dev/articles/ttfb> | covers DNS, TCP, TLS, first byte |
| LCP | <https://web.dev/articles/lcp> | 2.5 s good, 4 s poor |
| Netflix | <https://help.netflix.com/en/node/306> | 3 Mb/s 720p, 5 1080p, 15 4K |
| Opus | <https://www.rfc-editor.org/info/rfc6716> | 6-510 kb/s, 9-14 for wideband speech |

Where the edges depart from their source:

- `round_trip` — G.114 budgets mouth-to-ear one-way. Codec, packetisation and the jitter
  buffer take 80-120 ms of it, leaving ~100 ms of round trip to the edge.
- `ttfb` — defined over a site's 75th percentile, applied here to a single round.
- `rate` — 4K is not the bar; it asks 15 Mb/s and buys nothing on a phone screen.
- `call_rate` — catches a link carrying nothing, not slow ones. A call is latency-bound.

A value exactly on an edge takes the worse side. Anything that is not a finite, non-negative
number is not graded at all.

### Per probe

| probe | scale | graded on |
|---|---|---|
| `ip6` `ip4` `dns_ctl` `web` `udp` | `round_trip` | `ms`, the median of its samples |
| `down` | `rate` | `bps_min` |
| `dns` | `dns_delta` | the gap to `dns_ctl` |

A probe reports before it grades. Four states carry no colour, because in none of them did
the probe measure the link:

| state | when |
|---|---|
| `absent` | the path is known missing — IPv4 after the preflight, UDP without WebRTC |
| `resting` | the recorder stood the probe down to clear a wedged connection |
| `refused` | the far end turned the request away; a fact about the endpoint |
| `none` | the round ran no such probe |

Anything else that failed is red, and the row shows the failure reason in place of a number.

`absent` has not been seen on a live run. A Mac tethered to an iPhone gets a real IPv4 address
because the phone runs CLAT for it, so the IPv6-only case only appears in Safari on the phone
itself. Recorded journeys cover it; the current build does not.

`udp`'s milliseconds are graded on its own row but deliberately ignored by the calling
activity, which reads only whether the path exists. A slow STUN exchange can therefore show
orange on a row above a green call. Both are correct: ICE gathering rides on top of the round
trip, so the number overstates the link.

### The DNS delta

The fresh-lookup probe is graded on `dns.ms − dns_ctl.ms`, never on its own latency. Both
requests go to the same host over the same path, so the difference removes everything they
share.

No standard covers this quantity, so the edges are fitted to the three committed journeys —
259 rounds where both probes answered:

| p50 | p80 | p90 | p95 | max | negative |
|---|---|---|---|---|---|
| 150 ms | 259 ms | 460 ms | 832 ms | 4164 ms | 3 rounds |

Edges of 250 / 500 / 1000 ms split that corpus 206 / 31 / 12 / 10. `tests/replay.mjs` asserts
that split, so moving an edge without re-deriving it fails.

Two live runs since — a dual-stack Wi-Fi and a 5G hotspot, on different egress paths — put the
minimum at 113 ms and 124 ms and the median at 126 ms and 143 ms. The floor holds across three
independent networks, which is what places it at the destination rather than at any carrier.

Three consequences worth stating:

- A green here means "no worse than the floor", not "DNS is fast". Most of the gap is the far
  end handling an unseen hostname, as the probe's own section above sets out.
- The delta goes negative on noise, because `dns` is one sample and `dns_ctl` the median of
  three. It is clamped at zero.
- `retry_suspected` forces red whatever the delta says, since a lost first query is loss
  rather than slowness. No committed recording exercises this path.

### Per activity

An activity reads several measurements and takes the worst, so one failed requirement sinks
it however well the others read.

| activity | terms |
|---|---|
| voice & video calling | UDP path · route · round trip · throughput for a call |
| reading articles | lookup not on a retry timer · lookup · known host · throughput · TTFB · modelled article time |
| streaming video | throughput · rate |

A term for a path that is gone shows text instead of a number: `no UDP`, `host gone`,
`no data`.

Article time is modelled, not measured: `2 × lookup + 2 × known host + 500 kB / bound`. The
500 kB is the critical path to a readable article, where HTML, CSS and fonts come to 221 kB at
the mobile median and the largest image is what LCP waits for
(<https://almanac.httparchive.org/en/2025/page-weight>); the rest of the median 2,164 kB page
arrives after the article can be read. It divides by the throughput bound, so the result is an
upper bound on the wait.

Grades are resolved once per round and stored in the file, per probe and per activity.

## Operator and connection type

Connection type is asked before a run, and the operator only when the connection is not
Wi-Fi. No browser API exposes either: `navigator.connection` is unimplemented in Safari on
every platform. Everything else about a session, including its name, is generated.

The recorded egress IP makes the label checkable afterwards, since a carrier range and a home
Wi-Fi address resolve to different ASNs. An egress change under an unchanged label is
reported on screen when it happens.

One SIM is active at a time, so comparing operators means comparing journeys.

## iOS limits

**Position quality varies within a journey.** `coords.speed` is filled on 0, 2 and 51 of the
158, 75 and 243 rounds of three recorded journeys, and accuracy swings between a few metres
and a tower estimate; one journey spent 30 of 74 rounds at exactly 1414 m. `enableHighAccuracy` is the only control a browser has. So fixes are never
served from cache, a speed is derived from consecutive fixes only when both are under 100 m,
and `accuracy_class` lets a consumer filter without reimplementing the threshold. Deriving
from coarse fixes produced 682 km/h on a train, because two tower estimates hundreds of
metres apart look like motion; three such rows are still in the committed recordings. A
derived speed above 400 km/h is discarded even when both fixes claim accuracy. The
coordinates stay on the row either way.

**The screen lock is not reliable.** The session holds a wake lock, but the system can take
it back without the page becoming hidden, usually when Low Power Mode engages. The lock is
therefore reacquired on release, on every round, and whenever the tab becomes visible. Losses
and recoveries are logged, and every sample carries `wake_lock`. An outright refusal is
reported on screen once.

**Locking the screen or backgrounding the tab freezes JavaScript.** The gap appears as a
`pause` event, as `late_ms` on the next row, and as `visible: false`.

**Safari evicts storage** for sites left unvisited for about a week. Sessions that have never
been exported are flagged in the list.

## Content Security Policy

Scripts, styles, images, the manifest and the worker are pinned to the page's own origin,
under `default-src 'none'`.

`connect-src` is `'self' https:` instead of an allowlist. The CSP host-source grammar cannot
express a bracketed IPv6 literal, and naming the IPv6 probe endpoint makes the browser ignore
the source and block that probe entirely. The enforced allowlist is the URL check in
`tests/security.mjs`.
