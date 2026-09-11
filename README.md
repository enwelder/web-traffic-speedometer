# Web Traffic Speedometer

[![release](https://github.com/enwelder/web-traffic-speedometer/actions/workflows/release.yml/badge.svg)](https://github.com/enwelder/web-traffic-speedometer/actions/workflows/release.yml)
[![codeql](https://github.com/enwelder/web-traffic-speedometer/actions/workflows/codeql.yml/badge.svg)](https://github.com/enwelder/web-traffic-speedometer/actions/workflows/codeql.yml)
[![release version](https://img.shields.io/github/v/release/enwelder/web-traffic-speedometer?label=release&color=4C9BE8)](https://github.com/enwelder/web-traffic-speedometer/releases/latest)
[![licence 0BSD](https://img.shields.io/github/license/enwelder/web-traffic-speedometer?color=35B37E)](LICENSE)

**[Open the logger](https://enwelder.github.io/web-traffic-speedometer/)**

Records, for any network, whether a call, an article load and a video stream work on the
connection at each moment, and which layer fails when one does not.

It runs in a browser on any device, over Wi-Fi or mobile data, and logs the connection state
for the length of a session: a line that drops video calls, a commute with dead zones between
stations.

Browsers expose no radio metrics (RSRP, RSRQ, SINR, cell ID) on any platform; request timing
is the only measurement available. Each of the seven requests per round isolates one layer, so
a failure is attributable to a layer.

## What it does

```
every 15 s (Fine) or 30 s (Coarse)
        │
        ▼
  seven probes, each on its own deadline:
  the idle probes in parallel, then the download, then the upload
        │
        ▼
  one row ─── 7 measurements · GPS fix · timing · grades
        │
        ├──▶ IndexedDB ──▶ one JSON file per session
        └──▶ the screen
```

Every completed round is written in full, failed rounds included. Rows are stored
unaggregated, and every on-screen grade is recomputable from the exported rows. The threshold
between noise and outage is an analysis decision, applied downstream against timetables and
cell databases.

## The seven probes

| Probe | Request | Isolates |
|---|---|---|
| `ip6` | `https://[2606:4700:4700::1111]/cdn-cgi/trace` | the radio link over IPv6, without name resolution |
| `ip4` | `https://1.1.1.1/cdn-cgi/trace` | the same over IPv4 |
| `dns` | `https://<random>.github.io/` `HEAD` | resolution of a name absent from every resolver cache |
| `dns_ctl` | `https://wts-dns-control.github.io/` `HEAD` | the same destination under a cached name |
| `down` | `https://speed.cloudflare.com/__down` | sustained throughput |
| `up` | `https://speed.cloudflare.com/__up` `POST`, 40 kB | the upstream rate a call needs |
| `udp` | `stun:stun.cloudflare.com:3478` | UDP egress and its NAT mapping |

`ip6`, `ip4`, `dns_ctl` and `udp` take ten samples per round and report the median; `dns` takes
five, each against an unused hostname. `down` and `up` report a lower bound on their rate.

Each probe's transport is fixed, and where the server reports it, recorded:

| probe | transport | fixed by | recorded |
|---|---|---|---|
| `ip6` `ip4` | TCP | an address literal has no DNS record, and the host sends no `Alt-Svc` | `protocol_samples`: the HTTP version the trace endpoint reports per sample |
| `dns` `dns_ctl` | TCP | GitHub Pages advertises no HTTP/3 | |
| `down` `up` | TCP | `speed.cloudflare.com` serves HTTP/1.1 only | `server.proto` from the `cfL4` block |
| `udp` | UDP | a `stun:` URL | |

A browser moves a request to HTTP/3 once its host advertises it. `tools/check-hosts.mjs` checks
every advertisement daily.

Cross-reading the probes:

| observation | conclusion |
|---|---|
| `dns` fails, `dns_ctl` succeeds | name resolution fails; the destination is reachable |
| `dns` and `ip6` both fail | radio link down |
| TCP probes stall, `udp` answers | the TCP path stalls while UDP passes, as in the Rijswijk and Delft tunnels on KPN |
| small probes answer, `down` collapses | congestion: a saturated cell answers small requests quickly |
| `udp` alone fails | the carrier handles UDP apart from TCP; calls and streaming use UDP |

## How probes become activity grades

```
  ip6 or ip4 ──┐   whichever family carries traffic
  udp        ──┤
  up         ──┼──▶  voice & video calling
  down       ──┘

  dns        ──┐
  dns_ctl    ──┼──▶  reading articles
  down       ──┘

  down       ─────▶  streaming video
```

Terms per activity:

| probe | voice & video calling | reading articles | streaming video |
|---|---|---|---|
| `ip6` `ip4` | round trip over the family that answered; no literal answered and one failed → red | | |
| `udp` | round trip; failure → red | | |
| `up` | call rate; failure → red | | |
| `dns` | | TTFB; failure or lost first query → red | |
| `dns_ctl` | | article model; failure → red | |
| `down` | call rate | article model; failure → red | rate; failure → red |
| `down` stall check | other host and UDP both lost → red | the same | the same |

**Route: the address family the network carries.** IPv6-only is standard on mobile carriers
(NAT64/DNS64) and IPv4-only is common on Wi-Fi and older mobile networks; either alone is a
working connection. Calling turns red when no literal answers and one of them failed on the
link, note `round trip lost`. The round trip comes from the family that answered, IPv6 first when
both answer, matching browser preference.

**Link down.** The download's stall check runs while a stream still waits for headers 2 s in.
When it loses the `dns_ctl` host and STUN together, the link carried nothing: every activity is
red, note `link down`.

**Far end.** Every probe except the lookups runs on Cloudflare. When both literals, the download,
the upload and STUN all fail in one round, a request to `https://www.gstatic.com/generate_204`
follows. An answer means the Cloudflare endpoints failed on a working link: every activity is
unrated, note `far end`, and the answer is stored as `reference`. A TCP stall leaves STUN
answering and never reaches the request. The reference has no probe row.

**An activity takes the worst of its terms.** One failed term sets the grade: a 30 ms round
trip without a UDP path is a call that does not connect. The terms have different units; the
grade is a colour, the numbers are on the probe rows, and the grade is stored per round.

Article time model:

```
2 × dns + 2 × dns_ctl + 500 kB / down
```

500 kB approximates the critical path to a readable article: HTML, CSS and fonts total
[221 kB at the mobile median](https://almanac.httparchive.org/en/2025/page-weight), and LCP
waits on the largest image. Dividing by a throughput lower bound yields an upper bound on the
load time.

## The scales

Every edge is absolute; grading reads no session statistics. A value on an edge takes the
worse grade.

| scale | measured on it | green | yellow | orange | red | source |
|---|---|---|---|---|---|---|
| `round_trip` | latency of `ip6` `ip4` `dns_ctl` `udp` | <100 ms | <200 ms | <400 ms | ≥400 ms | [ITU-T G.114](https://www.itu.int/rec/T-REC-G.114) |
| `ttfb` | time to reach an uncontacted host, on the `new host` row and for reading articles | <800 ms | <1800 ms | <3000 ms | ≥3000 ms | [web.dev](https://web.dev/articles/ttfb) |
| `article` | the modelled article time | <2.5 s | <4 s | <8 s | ≥8 s | [Core Web Vitals LCP](https://web.dev/articles/lcp) |
| `rate` | `down`'s throughput bound | >7.1 Mb/s | >3.6 Mb/s | >1.6 Mb/s | ≤1.6 Mb/s | [YouTube's recommended sustained speeds](https://support.google.com/youtube/answer/78358) for 1080p, 720p and 480p, ÷ 0.7 |
| `call_rate` | `down`'s bound and `up`'s rate against a call's requirement | >300 kb/s | >100 kb/s | >30 kb/s | ≤30 kb/s | [Opus, RFC 6716](https://www.rfc-editor.org/info/rfc6716) |

`down`'s bound is read on two scales, `rate` for streaming and `call_rate` for calling; `up` is
read on `call_rate`. A call needs about a thousandth of a video stream's rate in each direction.

Deviations from the sources:

| scale | reason |
|---|---|
| `round_trip` | G.114 budgets one-way mouth-to-ear delay; codec, packetisation and jitter buffer take 80-120 ms, leaving ~100 ms of round trip |
| `ttfb` | defined over a site's 75th percentile; applied to a single round |
| `rate` | the sources give sustained rates, and one round's 1.5 s window samples an instantaneous rate. Each edge is divided by 0.7, the bandwidth fraction [ExoPlayer](https://github.com/androidx/media) and [hls.js](https://github.com/video-dev/hls.js) apply before selecting a rendition. 4K (20 Mb/s) exceeds a phone screen's resolution |
| `call_rate` | a call is latency-bound; this edge detects a link carrying no data |

Each probe row is graded on its scale. Four states carry no colour, because the probe produced
no measurement:

| state | condition |
|---|---|
| `absent` | path known missing: IPv4 after the preflight, UDP without WebRTC |
| `resting` | probe stood down to clear a wedged connection |
| `refused` | the server refused the request |
| `none` | the round ran no such probe, or left the upload no budget |

## On screen

Six probe rows, then one history strip per activity. Both address families share one row,
which shows and names the family carrying traffic. Tapping a row shows what it measures; **?**
shows all six.

Each strip bar is the activity grade of one completed round, newest on the right. A hatched bar
marks an absence: JavaScript was frozen by a locked screen or a background tab. A round the page
left mid-way draws the hatch and carries no grades; the `pause` event that follows names that
round and draws none. The header shows the build version.

The readout shows per-round values; journey aggregates are in the exported `summary`.
`degraded` counts rounds with at least one probe failure. In recorded journeys the longest full
outage lasted four rounds, and partially failing rounds reached 47% over the worst stretch at a
96 ms median latency.

## Data usage

The download is nearly the whole cost. The six other probes total ~130 kB per round: the
upload's 40 kB, and TLS handshakes, since each sample is a request and Safari opens a connection
per request. A round streams a ramp and a byte-capped window, so the worst case is fixed before
the run: **up to 933 MB for 40 minutes on Fine** (default), 466 MB on Coarse. A link below the 25 Mb/s ceiling costs
proportionally less. The projection shows before a run and the running total during it.

## Design notes

Per-probe design decisions and the recorded measurements behind them.

**Address-family failures.** Networks carry IPv6 only, IPv4 only, or both; a literal can be
blocked on a working path, and one family can fail while the other carries all traffic. A
failing literal counts as a link failure when no family carried traffic in that round, or when it
timed out on a family that did.

Classification per round:

| the round shows | the literal is | colour | counted |
|---|---|---|---|
| this family carried traffic, the literal was refused | `blocked`: address refused, path working | none | no |
| this family carried traffic, the literal timed out | a stalled path | red | yes |
| another family carried traffic | `unused`: traffic used the other family | none | no |
| no family carried traffic | a failure | red | yes |

A refusal arrives within milliseconds. In the Rijswijk and Delft tunnels on KPN the IPv6 literal
hung for its 8 s deadline, and the download that ran after the stall egressed over IPv6.

A family carried traffic when its literal answered, when its literal returned a status or body
this code rejects (a completed handshake), or when a probe reported an egress address of that
family.

Classification uses the current round only. A session-wide absence verdict misclassifies a
fibre link with no route to the IPv6 literal, a handover between networks, and two literals
blocked at once. The session-start preflight is stored in `ipv6_check` and `ipv4_check` for
reference; no round is graded on it.

The route row shows one family, by precedence: a family whose literal answered, a family that
carried traffic with its literal refused, a family that failed. On a network without IPv6 the
row shows IPv4.

All three operators tested failed the IPv4 literal in every round while the download's egress
address was IPv4: `1.1.1.1` is a public resolver, and relays and filters intercept it. `blocked`
covers this case.

**Latency: median of ten.** A single round trip varies by an order of magnitude with a cold
connection, a retransmission or a scheduling delay; RMBT takes 10-200 samples and reports the
median for the same reason. `dns` takes five samples, each against a different random hostname,
so each pays a full first contact. Before the first success, sampling stops at the first
failure and the remaining budget goes to the rest of the round. `ms_samples`, `ms_min` and
`ms_max` keep the spread, up to 52-4275 ms within one round, which the median omits.

A probe fails when no sample succeeds. A failed sample after a success is a lost packet:
sampling continues while the budget allows, `samples_lost` counts it and `sample_fail` stores
its reason. Each sample gets the whole remaining budget, so a slow answer keeps its full time. Nine answers at 20 ms with one lost sample grade as a
working connection with one lost packet.

**Uncacheable names.** A fixed hostname is cached after one round: `one.one.one.one` has a
24-hour TTL, so the OS answers locally and no query reaches the network, outages included.
`*.github.io` has a wildcard DNS record and a wildcard certificate, so an unused label resolves
and serves TLS. `HEAD` keeps the 9 kB 404 body off the wire.

| alternative | rejected because |
|---|---|
| a wildcard on Cloudflare, matching the literal probes' destination | `pages.dev`, `workers.dev` and `cloudflare-dns.com` have no wildcard DNS |
| DNS-over-HTTPS | bypasses the OS resolver, leaving the carrier's resolver unmeasured |

**First contact with a host.** The `new host` probe requests an unused hostname, so no cache
holds any part of the path. The measured time covers resolution, TCP connect and TLS handshake;
`github.io` sends no `Timing-Allow-Origin`, so resource-timing phases are zeroed cross-origin
and the three are inseparable.

Measured on one machine: warm control 14 ms, new hostname 139 ms, **the same hostname again
13 ms**. The cost is first contact only.

The probe is graded on `ttfb`, the scale defined for that wait. Mobile values run four to eight
times desktop values: first contact spans several round trips, and mobile round trips are
longer.

`retry_suspected` forces red regardless of the time: a lost first query is packet loss.

**Wedged connections.** A connection can enter a state the browser keeps reusing: after an
outage every other probe recovers within a round while one keeps timing out, for twenty
consecutive rounds in one recording. A page cannot request a fresh connection, so a probe that
fails three consecutive rounds while most other probes answer is rested for six rounds. Only
`timeout` and `network` trigger a rest, and never on `udp`, `down` or `up`, which hold no
persistent connection. A `parse` failure returned a body over a working connection, as a captive portal
does. The majority condition keeps an outage from resting every probe at once.

**Trace body validation.** A response is accepted only if the egress parses as an address,
`colo` is a three-letter PoP code, the scheme is HTTPS and the echoed host matches the request.
A middlebox answering for Cloudflare fails all four checks. RTR's suite runs the same check as
"unmodified content".

**UDP through a peer connection.** ICE candidate gathering is the only browser mechanism that
sends a UDP packet. Gathering carries no data: sending requires a data channel, a track or a
completed negotiation, and the probe creates none. Call audio travels over UDP, so the STUN
median grades calling as well as its own row. Gathering adds the time to the first host
candidate, kept per sample in `host_ms_samples`, so the value is an upper bound on the UDP round
trip.

**Download: RMBT at a fraction of its size.** One TCP flow carries at most its receive window
divided by its round trip. Cloudflare reported a window of 106-126 segments (about 180 kB)
against a ~39 ms round trip on a KPN 5G cell, where one request read 41 Mb/s and RTR's
three-stream test read 320:

```
180 kB / 39 ms   =  37 Mb/s     one flow's capacity there
320 Mb/s x 39 ms = 1.56 MB      in-flight data one flow would need
1.56 MB / 180 kB =  8.7x        the gap; slow start does not account for it
```

The same code read 230-560 Mb/s on a desktop at a ~5 ms round trip: a single flow measures
latency as much as capacity. Open-RMBT opens three connections for that reason, and so does
this probe:

| phase | behaviour | reason |
|---|---|---|
| ramp | three connections stream for 300 ms or 1 MB, discarded | activates the radio before measuring; RMBT spends 2 s |
| window | 1.5 s, all streams counted against one clock | a fixed window keeps rounds comparable |
| cap | the window also ends at 4.7 MB | fixes the per-round data cost in advance |
| first end | the window also ends when any stream reaches its end | RMBT's `t*`: every counted byte falls within a span all streams ran for |

Each stream is read from the moment its headers arrive. A stream without headers at the
download deadline is aborted with end `connect`. A stream still waiting 2 s in triggers
`stall_check`: one request to the download host, one to the `dns_ctl` host and one STUN binding.
Download host slow with the `dns_ctl` host fast indicates the browser or that host; STUN answering
with both slow indicates the TCP path; all three lost indicates the link, and grades `link down`.

The chunk that ends the ramp belongs to the ramp: its bytes crossed during a span that starts
before the window, and counting them in the window without that time overstates the rate. A
window under 100 ms holds no round trip and carries no rate: 9 kB in 3 ms computes to 24 Mb/s
and measures the clock. Those bytes are charged against the longest span they could have
taken, so a link too fast to time still proves the ceiling: 4 MB within a millisecond clears
it at 100 ms, 9 kB does not.

**The cap sets a ceiling.** A window of `T` capped at `B` bytes reports at most `B × 8 ÷ T`,
here **25 Mb/s**. Reaching it proves at least that rate, so the reading saturates, the row
prints `≥` and the round is flagged `saturated`. Below the ceiling the value is the link's own
rate. 25 Mb/s is 3.5 times the 1080p edge, so a healthy link grades green; the ceiling bounds
the data cost and limits ranking above 25 Mb/s. Costs are under [Data usage](#data-usage).

Phases run sequentially, as in RMBT. Latency, DNS and UDP probes run first on an otherwise idle
link; the download follows, with one round trip sampled once its window has opened, and the
upload runs last. The loaded sample is `loaded_rtt_ms`, and its difference from the idle value is
the queueing delay under load. A sample started together with the download completes during the
TLS handshakes, before any payload, and repeats the idle measurement. It is null when no window
opened or when the transfer ended before the sample started.

**Upload: one fixed body.** `up` POSTs 40 kB of zero bytes as `text/plain`, a CORS-safelisted
type that needs no preflight. `speed.cloudflare.com/__up` answers once the last byte arrived and
reports the count in `cf-meta-upload-bytes`; a count that differs, or one the browser cannot read,
ends as `short`. The rate is `40 kB × 8 ÷ (responseStart − requestStart)` from the load's
resource-timing entry, which excludes connection setup; without an entry the span runs from fetch
to headers and `rate_source` is `fetch`. 40 kB crosses the 300 kb/s edge in 1.07 s and the
100 kb/s edge in 3.2 s. Throttled to 200 kb/s upstream in Chromium, the span read 1602-1634 ms.

On a fast uplink the body leaves in two slow-start flights, so the span is two to three round
trips whatever the uplink carries: 40 kB read 12 Mb/s on a Wi-Fi uplink that carried over
100 Mb/s, and 3-6 Mb/s on KPN at a 22-40 ms round trip. A span under five round trips of the
round's literal marks the reading `saturated`, a lower bound printed with `≥`; `ceiling_bps` is the
rate at five round trips. Every such reading clears the call edges.

**Deadlines and scheduling.** Each probe gets 8 s, capped at the interval minus 500 ms. The
download gets what the idle phase leaves of the interval, since the phases run sequentially and
an interval-sized budget for each overruns the slot; the upload gets what the download leaves,
and with under a second left it is not sent and records `no_budget`. Each STUN sample is capped at
3 s: a binding answers within a round trip or is lost. The loaded round trip times out at the
download deadline. The 8 s value follows from recorded probes succeeding at 3885 ms, which a
4000 ms deadline classified as failures.

Rounds are scheduled from the previous tick. On a fixed grid, lateness pulls the next slot
closer, so after a freeze two rounds fire milliseconds apart and measure the same instant
twice. A slot that comes due while a round is running starts no round: a `skip` event records
the running round, its elapsed time and the probes it waits on, and the next slot runs on
schedule. A slot that comes due while an interrupted round settles starts the next round as soon
as it has, with no skip.

Lateness is read from both the wall clock and the monotonic clock. `performance.now()` stops
while an iOS device sleeps: across seq 7 to 8 of one recording the wall clock advanced
4,331,556 ms and the monotonic clock 2,551,966 ms, a 29.7-minute difference. On the monotonic
clock alone, a gap made entirely of sleep produces no `pause` event.

**iOS limits.**

| limit | handling |
|---|---|
| `coords.speed` filled on 0, 2 and 51 of 158, 75 and 243 rounds across three journeys | speed derived from consecutive fixes when both are under 100 m |
| accuracy falls to tower estimates: 30 of 74 rounds at exactly 1414 m in one journey | `accuracy_class` separates `gps` from `coarse`; coarse pairs produced 682 km/h on a train, so rates above 400 km/h are discarded |
| the system reclaims the wake lock without hiding the page, typically in Low Power Mode | reacquired on release, every round and on visibility change; every row carries `wake_lock` |
| a locked screen or background tab freezes JavaScript | the gap is a `pause` event with `late_ms`. A round in flight is `interrupted`: on the wake-lock release, which iOS sends before it suspends the page, or when a 250 ms timer fires over 1 s late on either clock. `visibilitychange` reported `visible` on every departure in one recording |
| the location watch repeats `unavailable` on each timeout while it holds only tower estimates | one `no location (…)` note per change of error state; the notice clears on the next fix |
| Safari evicts storage after about a week unvisited | never-exported sessions are flagged in the list |

**Operator and connection type** are entered by the user: no browser API exposes either, and
Safari implements no `navigator.connection`. The recorded egress IP makes the entry checkable,
since carrier ranges and home Wi-Fi resolve to different ASNs.

## Compared with RMBT

RTR's [RMBT specification](https://github.com/rtr-nettest/rmbt-server/blob/master/RMBT_specification.md)
is the reference method. RMBT controls both endpoints; this tool controls neither and runs in a
page. The differences:

| RMBT | here | difference |
|---|---|---|
| seven phases, none overlapping | three: idle probes, the download, the upload | the loaded round trip runs *during* the download and is ungraded; it measures queueing |
| downlink pre-test of 2 s, chunk size doubling from 4 kB | ramp of 300 ms or 1 MB, chunk size set by the browser | data cost; a page cannot set a chunk size |
| latency measured after the pre-test, on an active radio | latency measured first, on a possibly idle radio | the median of ten discards the wake-up; its cost is reported as `first_packet_ms`, 373 ms against a 21 ms median in one KPN round |
| latency from 10-200 pings timed **by the server**, median | 10 samples timed by the client around a full HTTPS request, median | **shortcoming**: the value includes TLS resumption, HTTP framing and browser scheduling, so it is an upper bound on the round trip. Agreement within 2 ms across three endpoints is the only available check |
| downlink window 7 s | 1.5 s | data cost; a shorter window has higher variance and sits earlier in the transfer |
| `R = Σ b_k / t*`, per-thread bytes interpolated to `t*` | all streams counted against one clock; the window ends at the first stream's end, the cap or the clock | the shared clock removes interpolation; ending at the first stream's end is `t*` |
| uplink pre-test and 7 s uplink measurement | one 40 kB POST, timed to the server's confirmation | **shortcoming**: a fixed body tests whether a call's upstream rate is met; a reading set by the round trips is flagged `≥`, and capacity above it is unmeasured |
| server-side view of every connection | Cloudflare's `server-timing` `cfL4` block: RTT, retransmits, losses, delivery rate, cwnd | partial parity, on the one endpoint that sends it. Behind an operator TCP proxy the block describes the proxy leg (KPN: `min_rtt` ≈ 2 ms) |
| a token schedules each measurement | rounds run on a fixed interval | uncoordinated with other tests |

Two further limits apply here only: the endpoints are public infrastructure that can rate-limit
or intercept, and every request phase except the download's and the upload's is zeroed
cross-origin, so DNS time is inseparable from connect and handshake time.

## Running it

Static files, no build step, no runtime dependencies. Serve over HTTPS; GitHub Pages suffices.
`npm run serve` serves `http://localhost:8731`, a secure context, so geolocation, wake lock and
service workers work without certificates.

A service worker caches the shell, so the page loads and a crashed session recovers on a network
too degraded to fetch the files.

## Development

```
npm ci          # playwright and eslint, development only
npm run lint
npm test        # every suite
npm run test:unit / test:security / test:browser
```

Unit, grading and edge-case suites run without a browser or network. `tests/replay.mjs` runs four
anonymised recorded journeys through grading and the rollup.

`tests/browser.mjs` drives a real browser for IndexedDB, crash recovery, the service worker, the
CSP and the phone layout, **once per engine**: Chromium for desktop and Android Chrome, WebKit for
Safari and iOS, since streaming reads, connection reuse and storage differ between them.
`WTS_ENGINES=chromium,webkit,firefox npm test` selects the set; each engine needs
`npx playwright install <engine>`. A missing engine prints a note locally and fails on CI, where a
silent skip reports unrun tests as passed.

`node tools/check-hosts.mjs` checks that every probe host still advertises the transport and
sends the headers the probes read; `.github/workflows/hosts.yml` runs it daily.

`node tools/anonymise.mjs <recording> <fixture>` converts a recording into a fixture: coordinates
removed, addresses and user agents redacted, timestamps shifted to a fixed epoch with intervals
preserved, measurements unchanged.

Machine-local files go in `.dev/`, ignored as a directory: a recording contains a home address, a
workplace and a daily timetable, and the repository is public. Security tests enforce it: every
path under `.dev/` is untracked, and every committed file lacks the shape of a journey export.

`package.json` holds the version; `js/session.js` and `sw.js` restate it, since no build step
injects it. A security test fails the build when the three differ. A push to `main` publishes to
Pages; a new version number also tags a release.

## Security properties

`tests/security.mjs` fails the build when any of these breaks:

- Network access is limited to the probe endpoints and the Google reference host.
- The only network call site is one `fetch`. Its only request body is the upload's zero bytes of a
  fixed length, sent as `text/plain` to `speed.cloudflare.com`; `sendBeacon`, `WebSocket`,
  `XMLHttpRequest` and URL-carrying elements are absent.
- Requests carry no credentials and no referrer.
- Dynamic code execution and markup writes are absent; all DOM content is set as text.
- Third-party code is absent at build time and runtime.
- The peer connection gathers ICE candidates only.
- The service worker passes probe requests through untouched and omits `skipWaiting`, so a new
  version waits for running sessions to end.

Recorded data leaves the device only through an export.

The page restricts scripts, styles, images, the manifest and the worker to its own origin under
`default-src 'none'`. `connect-src` is `'self' https:`: the CSP host-source grammar cannot express
a bracketed IPv6 literal, and naming the IPv6 endpoint makes the browser block that probe. The URL
allowlist in `tests/security.mjs` enforces the endpoint list.

## The exported file

One session per JSON file: metadata, environment, a recomputable rollup, every sample and every
event. Every field is listed in **[docs/data-format.md](docs/data-format.md)**.

## Licence

[0BSD](LICENSE). Public-domain-equivalent: use without restriction or attribution.
