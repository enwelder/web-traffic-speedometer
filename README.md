# Web Traffic Speedometer

[![release](https://github.com/enwelder/web-traffic-speedometer/actions/workflows/release.yml/badge.svg)](https://github.com/enwelder/web-traffic-speedometer/actions/workflows/release.yml)
[![codeql](https://github.com/enwelder/web-traffic-speedometer/actions/workflows/codeql.yml/badge.svg)](https://github.com/enwelder/web-traffic-speedometer/actions/workflows/codeql.yml)
[![release version](https://img.shields.io/github/v/release/enwelder/web-traffic-speedometer?label=release&color=4C9BE8)](https://github.com/enwelder/web-traffic-speedometer/releases/latest)
[![licence 0BSD](https://img.shields.io/github/license/enwelder/web-traffic-speedometer?color=35B37E)](LICENSE)

**[Open the logger](https://enwelder.github.io/web-traffic-speedometer/)**

## What this is for

On a commute, mobile data drops out for stretches while the signal indicator still shows
bars. Music stops, articles will not load. The question is what is underneath that — cell
congestion, a coverage gap, DNS failure, or handover — and whether it differs between
operators.

iOS exposes no radio metrics to a browser: no RSRP, no RSRQ, no SINR, no cell ID. What a
browser *can* do is send requests and time them. This tool does that continuously for the
length of a journey, records position alongside, and writes one file per session.

It is a logger. Every round is written down whole and nothing is ever aggregated away: the
raw rows are the only source of truth, and both the grades shown on screen and the rollup in
the export are recomputable from them. What it does not do is decide anything — where the
line falls between noise and an outage changes the answer, so that decision belongs
downstream, next to the timetables, track maps and cell databases the data will be joined
against.

## Running it

Static files, no build step, no runtime dependencies. Serve the directory over HTTPS —
GitHub Pages is enough. Locally, `python3 -m http.server` on `http://localhost` counts as a
secure context, so geolocation, wake lock and service workers all work without certificates.

A service worker caches the shell, so the page loads and a crashed session recovers on a
network too degraded to fetch anything, which is the condition the tool exists to record.

## Development

Recordings are anonymised into fixtures with `node tools/anonymise.mjs <recording> <fixture>`.
Coordinates are removed rather than fuzzed, addresses and user agents redacted, timestamps
shifted to a fixed epoch with intervals preserved, and every measurement left untouched. The
tool refuses to write a file that still carries anything identifying, and a security test
re-checks every committed fixture.

Anything local to one machine goes in `.dev/` — recorded journeys, scratch files, notes.
The directory is ignored as a whole rather than by filename, because a recording carries a
home address, a workplace and a daily timetable, and this repository is public. Two security
tests enforce it: nothing under `.dev/` may be tracked, and no committed file may have the
shape of a journey export, wherever it was put.

```
npm ci          # playwright and eslint, development only
npm run lint    # eslint, including a cognitive-complexity ceiling
npm test        # every suite
npm run test:unit / test:security / test:browser
npm run serve   # http://localhost:8731
```

No runtime dependencies. A security test fails the build if any appear.

`tests/unit.mjs` exercises the probes, the round loop, classification and export with no
browser and no network; the store is injected, so failure and retry paths are reachable.
`tests/grading.mjs` covers the scales and the terms each purpose is composed from.
`tests/stuck.mjs`, `tests/wakelock.mjs` and `tests/position.mjs` drive the three modules the
recorder delegates to, without running a recorder: a rest scheduled by round number, a wake
lock the system reclaims, and a speed derived from consecutive fixes.
`tests/replay.mjs` runs three anonymised real journeys — a good 5G run, a commute with pauses
and coarse positions, and the one where a probe wedged for twenty rounds — through the
grading and the rollup. Synthetic fixtures agree with whatever the code does; recordings do
not, and both times the grading was wrong it was a recording that said so.
`tests/edges.mjs` covers the boundaries and the things a network does: a value exactly on a
threshold, a percentile of two samples, a captive portal, a saturated cell whose body never
arrives, a tunnel, a carrier that blocks UDP, a handover that changes the egress address, a
wall clock that jumps backwards, and storage the system closed underneath a running session.
`tests/regressions.mjs` pins bugs found in the field rather than in review.
`tests/browser.mjs` drives a real browser for the parts that only exist there — IndexedDB,
crash recovery, the service worker, downloads, the CSP and the phone layout — against a
simulated IPv6-only network. `tests/security.mjs` is described below.

Every push runs the lint, functional and security suites; CodeQL runs the security and
quality queries on `main` and on pull requests. A push to `main` that passes publishes to GitHub Pages; if `package.json` has a new
version, that push is also tagged and released. The version is stated once in `package.json`,
and a security test fails the build if `APP_VERSION` or the service worker cache name has
drifted from it. Publishing files that changed since the last release under that same version
is refused outright: the service worker keys its cache on the version, so it would leave every
installed client on the old build with nothing to tell it otherwise.

## Security properties

This records a person's location and network behaviour for forty minutes at a time, so what
is worth guarding is narrow and checkable. `tests/security.mjs` fails the build if any of it
stops being true:

- **It contacts nothing but its seven probes.** Every URL in the source is checked against
  the allowlist.
- **It has no way to upload what it records.** There is exactly one `fetch` in the
  application and its URL comes from the probe table; no request may carry a body, and no
  `sendBeacon`, `WebSocket` or `XMLHttpRequest` may appear. Nor may a URL reach the network
  by another route — an image, a stylesheet, a `src` assignment. Data leaves only when you
  export it.
- **It sends no credentials or referrer** to any of those origins.
- **It executes no dynamic code** and writes no markup: no `eval`, no `new Function`, no
  `innerHTML`. Everything reaches the DOM as text.
- **It ships no third-party code**, at build time or at runtime.
- **The peer connection can gather candidates and nothing else.** No data channel, no track,
  no remote description, and the transceiver must be receive-only.
- The service worker never touches a probe, and never takes over a tab mid-session.

The page also carries a Content Security Policy that pins scripts, styles, images, the
manifest and the worker to its own origin, with `default-src 'none'`. `connect-src` is the
exception: the CSP host-source grammar cannot express a bracketed IPv6 literal, and naming
the IPv6 probe endpoint makes the browser ignore the source and block that probe outright.
It is therefore `'self' https:`, and the real allowlist is the CI check above.

## Licence

[0BSD](LICENSE) — the BSD Zero Clause Licence. Public-domain-equivalent: use it for
anything, no attribution required.

## How a round works

Seven probes run in parallel, once per interval. Each isolates a different layer, so a
failure can be attributed rather than merely noted.

| Probe | Target | Answers |
|---|---|---|
| `ip6` | `https://[2606:4700:4700::1111]/cdn-cgi/trace` | is the radio link up, over IPv6, with no name resolution involved |
| `ip4` | `https://1.1.1.1/cdn-cgi/trace` | the same, over IPv4 |
| `dns` | `https://<random>.github.io/` (HEAD) | can the carrier's resolver resolve a name it cannot have cached |
| `dns_ctl` | `https://wts-dns-control.github.io/` (HEAD) | is that same destination reachable with the name already cached |
| `web` | `https://www.gstatic.com/generate_204` | is a provider other than Cloudflare reachable |
| `down` | `https://speed.cloudflare.com/__down?bytes=50000000` | what rate does the connection actually sustain |
| `udp` | `stun:stun.cloudflare.com:3478` | is there a UDP path out, and what does it map to |

Reading them together:

- `dns` fails while `dns_ctl` succeeds → name resolution is failing. Same host, same path,
  same edge; the only difference is whether the name was already known.
- `dns` and `ip6` both fail → the radio link, not DNS.
- only `web` fails → a fault specific to one provider's edge rather than the network.
- everything answers but `down` collapses → congestion. A saturated cell still replies
  quickly to a small request while delivering almost no throughput, which is why latency
  alone cannot see it. This is the case a fixed-size download misses too — see below.
- `udp` fails while the rest hold → the carrier is treating UDP differently from TCP. Calls
  and streaming ride on UDP, so this is a failure the other six cannot see.

### Both address families, deliberately

Dutch mobile networks run IPv6-only with NAT64/DNS64. iOS has no CLAT, so it depends on
DNS64 synthesising an address during name resolution — and an address literal skips
resolution entirely. On such a network `ip4` cannot connect at all, and fails within a few
milliseconds with an immediate refusal.

That is information, not a defect. A preflight at session start settles it once, recording
`ipv4_available` with the evidence in `ipv4_check`. Afterwards `ip4` failures carry
`expected: true`, stay out of failure tallies and do not colour the display. A failure
*without* that flag still means something: IPv4 was there at the start and stopped.

### Latency is a median, not a sample

A single round trip is noise: a cold connection, one retransmission, or a scheduling delay
moves it by an order of magnitude. Every latency probe — `ip6`, `dns_ctl`, `web`, `udp` — is
therefore run three times inside its own deadline, and `ms` is the median of the samples that
succeeded, with every sample kept in `ms_samples`. All four are sampled the same way, so
their medians are comparable; `dns` is the exception, because a repeated lookup would be
answered from cache and stop being a lookup. Repetition stops at the first failure —
repeating a failed probe within one round says nothing new and spends budget the round may
still need.

This follows RMBT, which takes between 10 and 200 latency samples and reports the median for
the same reason. Three is the compromise here, because unlike a one-off speed test this runs
for the length of a journey and pays for every sample.

### A hostname that cannot be cached

A fixed hostname stops testing DNS almost immediately. `one.one.one.one` has a 24-hour TTL,
so after one lookup the OS answers from cache and no query reaches the network — including
throughout the long outages that matter most.

`*.github.io` has both a wildcard DNS record and a wildcard certificate, so any random label
is resolvable and served over TLS. Each round requests a label never used before, forcing a
real lookup through the carrier's resolver. `HEAD` keeps the 9 kB 404 body off the wire, and
the hostname used is recorded per round so freshness is verifiable from the data.

**The latency of this probe is not DNS latency.** Against the cached-name control at the
same destination, roughly a tenth of the difference is resolution and the rest is GitHub's
handling of a hostname it has not seen; requesting the same new name twice collapses it. The
pair is a dependable *failure* discriminator, but the latency delta is not a lookup time and
must not be reported as one.

Two alternatives were ruled out. A wildcard on the same infrastructure as the IP probe would
remove the destination difference entirely, but none exists — `pages.dev`, `workers.dev` and
`cloudflare-dns.com` all lack wildcard DNS. DNS-over-HTTPS bypasses the OS resolver, so it
would measure Cloudflare's recursive resolver rather than the carrier's, which is the one
under suspicion.

### A probe that has wedged is not the network

A connection can end up in a state the browser will not retire: after an outage every other
probe recovers within a round while one keeps timing out, alone, for as long as the session
lasts. Twenty consecutive false failures were recorded that way. A browser cannot be told to
open a fresh connection, so a probe that fails three rounds running while most of the others
answer is marked `stuck` and rested for six rounds, which lets the browser retire the
connection on idle. Only a `timeout`, a `network` error or a `stalled` read counts towards
that, because those are the only failures a fresh connection could fix. A `parse` failure
means the connection worked perfectly and delivered a body — a captive portal answering for
Cloudflare — and resting the probe would hide the portal for six rounds out of every nine
without repairing anything. Most of the others, not merely one: a single probe still answering is no
evidence that six separate connections have each wedged, and treating an outage that way
rested every probe at once and blanked the readout exactly when the network was worst. Rested rounds are still written, with `fail: "resting"`, so the row stays complete and
the reason is in the data rather than looking like more timeouts.

### The body has to be Cloudflare's

A trace response is not accepted merely for being trace-shaped. The egress must parse as an
address, `colo` must be a three-letter PoP code, the scheme must still be HTTPS, and the
host echoed back must be the host that was requested. A middlebox answering on Cloudflare's
behalf, or rewriting the Host on the way through, fails as `parse` with the reason in
`parse_reason` rather than passing as a plausible measurement. This is the equivalent of
RTR's "unmodified content" check, which exists because an intermediary that alters content
is invisible to a test that only checks whether a response arrived.

### UDP, and why it needs a peer connection

`udp` gathers ICE candidates against a STUN server and reads the server-reflexive ones. That
is the only way a browser can put a packet on the wire over UDP, and it is worth doing
because UDP is what real-time traffic uses and a carrier can shape it separately from TCP.

Gathering alone cannot carry data. What makes a peer connection able to send anything is a
data channel, a media track, or a remote description completing the negotiation; none is
ever created, the transceiver is receive-only, and the connection is closed as soon as
gathering finishes. A security test enforces each of those, so the capability is admitted
without the exfiltration path.

Every server-reflexive candidate is kept, because a dual-stack network reports one per
address family, and comparing them against the TCP egress in the same round shows whether
the two transports leave by the same path.

### The download reports a bound, not a rate

The bars need to know which band the link is in, not how fast it is, so the probe publishes a
lower bound: what the bytes that arrived prove the link carries. A bound charged every
uncertainty can only understate, so slow start, WebKit handing bodies over in lumps and clock
jitter all move it the safe way, and none of them has to be corrected for.

Two requests per round, each read to its end:

| request | size | purpose |
|---|---|---|
| warm-up | 96 kB | opens the congestion window |
| measured | 128 kB – 4 MB | sized from the warm-up for ~500 ms of body |

A fresh connection delivers its first bytes at the congestion window's pace rather than the
link's, and iOS opens one every round — `reused` is false on every recorded download row.
Measured over a Mac on a phone's 5G hotspot against a reference test reading 350 Mbit/s:

| condition | measured |
|---|---|
| 625 kB, cold connection | 19.9 Mb/s |
| 625 kB, warm connection | 177 Mb/s |
| 4 MB, warm connection | 293 Mb/s |
| 8 MB, warm connection | 291 Mb/s |

Accuracy stops improving at 4 MB. A fixed 4 MB would take 32 s on a 1 Mb/s cell and be cut
off every round, so the measured request is sized from the rate the warm-up saw.

Fields:

| field | meaning |
|---|---|
| `bps_min` | the bound; graded and displayed |
| `bytes` `duration_ms` | the raw pair the bound comes from |
| `complete` | the body arrived whole; false makes the bound a floor |
| `aborted_reason` | `eof` \| `time` \| `aborted` \| `network` |
| `warmup_only` | the link was too slow for a second request; the warm-up is the measurement |
| `refused_by` | on a `network` failure: `server` \| `connection` |

A download rejecting before any response is repeated once as an opaque request. A response
this origin may not read still counts as one, so opaque success means the far end refused us
and opaque failure means the connection never opened. A refusal by the server does not grade
the link as bad.

Per-round rates on a mobile link are volatile and cannot be made steadier by spending more:
4 MB transfers spread 5.4× across passes, and three samples a round cost 2.7× the data for no
improvement — 3.9× against 3.8×. The variation is between rounds rather than within them.
Steadiness comes from aggregating a journey, not from one round.

### Deadlines and cadence

No probe may outlive its own round: every deadline is 8 s, capped at the interval minus half
a second, and the values in force are recorded in `environment.timeouts_ms`. Eight seconds
rather than four because journey data showed probes succeeding at 3885 ms against a 4000 ms
ceiling — anything slower was being filed as a failure, which collapses "slow" into "gone"
and that distinction is the point of the measurement.

Each round is scheduled from when the previous one actually fired rather than onto a fixed
grid. On a grid, any lateness pulls the next slot closer, and after a long freeze the next
round fires immediately and collides with the one still running. A round costs megabytes, so
two of them moments apart measure the same instant twice and pay twice for it.

### Two profiles

**Fine** runs every 15 s, **Coarse** every 30 s. Both use the same 8 s deadlines and both run
the download in every round, because the download is the only probe that measures throughput
rather than reachability and sampling it occasionally leaves most rounds with none. The
interval therefore sets the cost as well as the resolution, which is the trade the two
profiles are: Fine locates a dropout to within 15 s and costs twice as much doing it.

## Every attempt is recorded

A round that fails is the measurement. Nothing is dropped, skipped or summarised away, and
no failure is represented only by an absence.

- `fail` gives the reason, not just the fact. `timeout` and `network` are the transport;
  `http` is a status the server chose; `parse` is a body that was not the endpoint's;
  `abort` is the session ending mid-probe; `stalled` is a download whose headers arrived and
  whose body never did; `empty` is a 200 with nothing in it; `no_srflx` is a UDP path that
  gathered candidates but never reached the STUN server. Two more are not failures of the
  network and stay out of every tally: `resting`, where the recorder stood the probe down,
  and `unsupported`, where the browser has no such API — flagged `expected`, like an absent
  IPv4 path.
- `ms` is recorded on failure too. How long a probe took to fail separates a refused
  connection from a link that hung until the deadline.
- A round that could not start because the previous one was still in flight is written with
  `skipped: "overlap"` rather than passed over.
- `late_ms` appears on every row. iOS freezes JavaScript when the tab is hidden or the
  screen locks; a round that misses a whole slot also writes a `pause` event with the bridged
  duration, and `visible` records the tab state per row. One missed slot rather than two: at a
  10 s interval a 13.7 s delay went unlogged under the looser rule.
- If an IndexedDB write fails, rows stay in memory and are retried, with the pending count
  shown on screen. Silent data loss is the one failure this tool cannot have.

## The data

Sessions live in IndexedDB until exported. One button per session writes one JSON file
containing the session metadata, the environment, a descriptive rollup, every sample and
every event.

The `summary` block holds per-probe p50, p90, max, ok and failure counts, the download's rate
bound percentiles and total bytes, and counts of skipped, paused and degraded rounds. It
defines no outage, and every figure in it is recomputable from the samples, which is what keeps
the raw rows the only source of truth — it exists so a reader does not rebuild the same six
aggregates every time. The scales and the purposes composed from them are copied in beside it,
because a file read a year later has to say which version graded its rows. `format` is
`wts/session` at `version: 3`; version 2 keyed grades by capability and reported a rate
rather than a bound. CSV, GPX or GeoJSON are
a few lines to derive from it wherever the analysis happens.

### Per round

| Field | Meaning |
|---|---|
| `seq` | round number; a gap would mean a lost row, which should never occur |
| `t` | wall clock, epoch ms |
| `mono` | monotonic ms since session start; survives wall-clock jumps, and is bridged across a reload using `t` |
| `late_ms` | how far behind schedule the round ran |
| `skipped` | `overlap` when the previous round had not returned; otherwise null |
| `round_error` | exception message if the round itself threw |
| `visible` | whether the tab was foregrounded for this round |
| `lat` `lon` `accuracy` `speed` `heading` | GPS fix; `speed` in m/s, and often absent — see `speed_derived` |
| `accuracy_class` | `gps` under 100 m, `coarse` above it. A coarse fix is a tower estimate: usable as a rough location, not for speed or distance |
| `pos_t` | timestamp **of the fix**, not of the round. A stale fix on a moving train is off by a kilometre, and this is the only way to see it |
| `pos_error` | `denied`, `timeout` or `unavailable` when there is no position |
| `intervalMs` | interval in force for this round |
| `in_pause` | this round followed a bridged gap, so it can be filtered without matching timestamps |
| `wake_lock` | whether the screen was being held awake for this round |
| `prev_round_ms` | how long the previous round actually took. A frozen tab suspends the abort timers too, so a round can outlast every deadline in it; without this an overlap cannot be told from the app stalling |
| `speed_derived` `speed_source` | speed computed from consecutive fixes, and whether the reported value is `gps` or `derived` |
| `grades` | the three purpose grades this round produced, as they were shown |
| `first_packet_ms` | the quickest first response in the round: the closest thing to the cost of waking the radio. Reported, never graded |

### Per probe, under `probes.<id>`

| Field | Probes | Meaning |
|---|---|---|
| `ok` `ms` `fail` | all | success, round trip, failure reason |
| `status` | `ip6` `ip4` `down` | HTTP status; null where the response is opaque and the status is genuinely unknowable |
| `expected` | `ip4` | the failure was a known-absent path rather than an outage, and is excluded from tallies |
| `stuck` | any | the probe was failing alone and has been rested to clear its connection |
| `egress_ip` `colo` | `ip6` `ip4` `down` | the operator's public address and the Cloudflare PoP |
| `ms_samples` `samples_ok` `ms_min` `ms_max` | `ip6` `dns_ctl` `web` `udp` | every latency sample taken this round, how many succeeded, and the spread; `ms` is their median. A median of [893, 4275, 52] hides the round's whole story |
| `parse_reason` | `ip6` `ip4` | why a trace body was rejected as not Cloudflare's |
| `public_ips` `candidates` | `udp` | the NAT mapping per address family, and how many ICE candidates were gathered |
| `host` | `dns` `dns_ctl` | the hostname used — random each round for `dns`, constant for `dns_ctl` |
| `retry_suspected` | `dns` | the answer arrived within 300 ms of a resolver retry timer (2 s or 5 s), so the first query was lost. Loss, not slowness, and red regardless of the number |
| `bytes` `duration_ms` `ttfb_ms` | `down` | bytes counted, how long the read ran, and time to first byte |
| `bps_min` `complete` | `down` | the bound, and whether the body arrived whole |
| `warmup_only` `refused_by` | `down` | the link was too slow for a second request; which side refused |
| `aborted_reason` | `down` | how the read ended: `eof`, `time`, `aborted` or `network` |
| `truncated` | `down` | the 8 s deadline cut the body short. Unlike the budget, this is a failure |
| `handshake` `reused` `protocol` `lookup_ms` `connect_ms` `tls_ms` | `down` | connection setup, phase by phase |
| `server` | `down` | Cloudflare's `cfL4` view: `rtt_us`, `min_rtt_us`, `rtt_var_us`, `lost`, `retrans`, `delivery_rate`, `cwnd` |

Connection setup and `server` are readable only because `speed.cloudflare.com` sends
`timing-allow-origin`; the other five endpoints report zeroed timing cross-origin.
`handshake` is not simply a non-zero `secureConnectionStart` — on a reused connection the
specification sets that field to `fetchStart` — so it is counted only when a TLS phase falls
inside a real connect window.

`environment.user_agent` is stored raw and should be treated as untrusted: some browsers
freeze or fake it, so an OS version parsed out of it may be fiction.

**`server` can be all zeros.** Those fields need a connection that has accumulated
round-trip samples. With a page-sized download every round they are populated; with a small
or infrequent one the header can arrive before any samples exist. Read an all-zero `cfL4`
block as *no data*, never as a measurement of zero.

### Purposes are graded, not probes

A probe's number means nothing on its own, and no single probe decides what a person can do.
Each purpose reads several measurements and takes the worst of them, so one requirement
failing sinks it however well the others read.

| purpose | terms |
|---|---|
| calls & live audio | UDP path · route · round trip · throughput for a call |
| opening an article | lookup not on a retry timer · lookup · known host · throughput · TTFB · modelled article time |
| video & downloads | throughput · rate |

Scales, all absolute:

| scale | green | yellow | orange | red | source |
|---|---|---|---|---|---|
| round trip | <100 ms | <200 ms | <400 ms | ≥400 ms | ITU-T G.114 |
| TTFB | <800 ms | <1800 ms | <3000 ms | ≥3000 ms | web.dev |
| article | <2.5 s | <4 s | <8 s | ≥8 s | Core Web Vitals LCP |
| rate | >10 Mb/s | >5 Mb/s | >1.5 Mb/s | ≤1.5 Mb/s | Netflix tiers |
| call rate | >300 kb/s | >100 kb/s | >30 kb/s | ≤30 kb/s | Opus, RFC 6716 |

Each cites its source in `js/grade.js`. A value sitting exactly on an edge takes the worse
side. Nothing consults the session's own statistics: a connection is not good merely because
it is no worse than the rest of the journey. Nothing that is not a finite, non-negative number
is graded at all.

Article time is modelled, not measured: `2 × lookup + 2 × known host + 500 kB / bound`. The
500 kB is the critical path to a readable article — HTML, CSS and fonts are 221 kB at the
mobile median and the largest image is what LCP waits for. It consumes the throughput bound,
so the figure is an upper bound on the wait.

The tile shows the term that decided the grade, with that term's unit, so the number and the
colour describe the same thing. A term reporting a path being gone has no number and says so:
`no UDP`, `host gone`, `no data`. Grades are resolved once per round and stored in the file.

### Reading it while travelling

Three tiles, one per purpose, each naming what a person is doing rather than which probe fed
it: **calls & live audio**, **opening an article**, **video & downloads**. A failure is
placeable by reading down them — calls alone in red is the UDP path, an article alone in red
is resolution, video alone in red is a congested cell while everything else answers.

A tile carries one status: its name, the measurement that decided its grade, and the colour
that measurement grades to. Both come from the same round and the same term, so they cannot
describe different things. History belongs to the strips below, one row per purpose, where
every round is its own bar. Tapping a tile replaces its number with what it measures; the
**?** in the header does that to all three at once.

Below them, two lamps show which paths are carrying traffic — IPv4 and UDP — lit, dim where a
path is known absent, red where it has failed. The IPv4 verdict is written to the log once and
to `ipv4_available` in the file, so the lamp does not have to carry a standing sentence.

**Degraded** is the share of rounds in which some probe failed. Full outages turned out to be
rare — the longest ran four rounds — while the share of partially failing rounds reached 47%
over the worst stretch with a median latency of a perfectly healthy 96 ms. Outage-only
statistics miss almost all of it.

### Events

Only what cannot be derived from the samples. `mark` is the subjective half of the
measurement, pressed when the failure is noticed rather than when the probes see it — the
premise of the exercise is that those two disagree. `pause` records JavaScript being frozen,
with the bridged duration. `note` is free text, and the recorder writes its own notices there too: a wake lock
lost or regained, position quality changing, a probe rested, an egress address changing under
an unchanged operator label.

## Operator and connection type

No browser API exposes the carrier, or whether the radio is cellular or Wi-Fi;
`navigator.connection` is not implemented in Safari on any platform. Connection type is
asked for before a run, and the operator only when it is not Wi-Fi. Everything else about
the session, its name included, is generated from what is already known.

The recorded egress IP makes the label checkable afterwards, since a carrier range and a
home Wi-Fi address resolve to different ASNs. If the egress IP changes mid-session while the
label does not, the screen says so at the time.

One SIM is active at a time, so comparing operators means comparing journeys.

## Data usage

The two download requests are almost the entire cost; the six small probes come to roughly
12 kB per round between them, of which each sampled latency probe is about 1.2 kB. The
projection for the chosen settings is shown before a run starts and a running estimate during
it, and the projection turns amber past 50 MB.

The measured request is sized from the link, so a slow cell costs little and a fast one
reaches the 4 MB ceiling. The projection assumes the ceiling every round: about 530 MB for a
40-minute run on Fine, 270 MB on Coarse. Nothing stops it partway — watching the total is the
operator's job, which is why the running figure sits on the readout.

The interval sets both the cost and the resolution: a 30-second interval cannot locate the
start of a dropout more precisely than 30 seconds. The estimate charges a TLS handshake per
probe per round rather than assuming connection reuse, which Safari does not do, so it is
deliberately conservative.

### On iOS, position quality varies within a journey

`coords.speed` is filled only sporadically, and accuracy swings between a few metres and a
tower estimate — one journey spent 30 of 74 rounds at exactly 1414 m, the signature of a
coarse fix. There is no way to press the platform harder than `enableHighAccuracy` from a
browser, so instead: fixes are never taken from cache, a speed is derived from consecutive
fixes only when *both* are under 100 m, and `accuracy_class` lets a consumer filter without
reimplementing the threshold. Deriving from coarse fixes produced 682 km/h on a train — two
tower estimates hundreds of metres apart look exactly like motion, and three such rows are
still in the committed recordings. A derived rate above 400 km/h is discarded even when both
fixes claim to be accurate, since two fixes can both be wrong; the coordinates stay on the
rows either way, so the analysis can derive it differently.

When precision changes mid-journey it is logged, the way a wake-lock change is, so a stretch
of unusable coordinates explains itself.

## iOS notes

- The screen is held awake for the length of a session. The system can take that lock back
  on its own — Low Power Mode engaging is the usual reason, and it does so without the page
  ever becoming hidden — so the lock is reacquired on release, on every round, and whenever
  the tab becomes visible. Losses and recoveries are written to the log, and every sample
  carries `wake_lock`, so a journey where the display kept sleeping explains its own gaps.
  If it is refused outright the screen says so once; check Low Power Mode and auto-lock.
- Locking the screen or backgrounding the tab freezes JavaScript. The gap is recorded as a
  `pause` event, as `late_ms` on the next row, and as `visible: false`.
- Safari can evict storage for sites left unvisited for about a week. Sessions that have
  never been exported are flagged in the list; export a journey before it matters.
