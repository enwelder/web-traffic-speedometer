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

It is a logger. It performs no analysis, computes no summaries and stores no conclusions.
Where the line falls between noise and an outage changes the answer, so that decision
belongs downstream, next to the timetables, track maps and cell databases the data will be
joined against.

## Running it

Static files, no build step, no runtime dependencies. Serve the directory over HTTPS —
GitHub Pages is enough. Locally, `python3 -m http.server` on `http://localhost` counts as a
secure context, so geolocation, wake lock and service workers all work without certificates.

A service worker caches the shell, so the page loads and a crashed session recovers on a
network too degraded to fetch anything, which is the condition the tool exists to record.

## Development

```
npm ci          # playwright, the only development dependency
npm test        # every suite
npm run test:unit / test:security / test:browser
npm run serve   # http://localhost:8731
```

`tests/unit.mjs` exercises the probes, the round loop, classification and export with no
browser and no network; the store is injected, so failure and retry paths are reachable.
`tests/browser.mjs` drives a real browser for the parts that only exist there — IndexedDB,
crash recovery, the service worker, downloads, the CSP and the phone layout — against a
simulated IPv6-only network. `tests/security.mjs` is described below.

Every push runs the functional and security suites and CodeQL. A push to `main` that passes
publishes to GitHub Pages; if `package.json` has a new version, that push is also tagged and
released. The version is stated once in `package.json`, and a security test fails the build
if `APP_VERSION` or the service worker cache name has drifted from it — a stale cache name
would leave clients on the old build.

## Security properties

This records a person's location and network behaviour for forty minutes at a time, so what
is worth guarding is narrow and checkable. `tests/security.mjs` fails the build if any of it
stops being true:

- **It contacts nothing but its seven probes.** Every URL in the source is checked against
  the allowlist.
- **It has no way to upload what it records.** No request may carry a body; no `sendBeacon`,
  `WebSocket`, `EventSource` or `RTCPeerConnection` may appear. Data leaves only when you
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
| `down` | `https://speed.cloudflare.com/__down?bytes=N` | how fast does a page-sized payload actually arrive |
| `udp` | `stun:stun.cloudflare.com:3478` | is there a UDP path out, and what does it map to |

Reading them together:

- `dns` fails while `dns_ctl` succeeds → name resolution is failing. Same host, same path,
  same edge; the only difference is whether the name was already known.
- `dns` and `ip6` both fail → the radio link, not DNS.
- only `web` fails → a fault specific to one provider's edge rather than the network.
- everything answers but `down` collapses → congestion. A saturated cell still replies
  quickly to a small request while delivering almost no throughput, which is why latency
  alone cannot see it.
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
moves it by an order of magnitude. `ip6` is therefore run repeatedly inside its own deadline
and `ms` is the median of the samples that succeeded, with every sample kept in
`ms_samples`. Repetition stops at the first failure — repeating a failed probe within one
round says nothing new and spends budget the round may still need.

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
open a fresh connection, so a probe that fails three rounds running while its peers succeed
is marked `stuck` and rested for six rounds, which lets the browser retire the connection on
idle. Rested rounds are still written, with `fail: "resting"`, so the row stays complete and
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

### The download

The payload is sized to a real page rather than to a token request: 250 kB is about a
text-heavy article with images, the workload that actually fails on a commute. At much
smaller sizes the connection setup dominates and the resulting figure describes the
handshake instead of the link.

It runs in every round, on the same cadence as everything else, so throughput forms a
continuous series alignable with the latency series rather than a sparse one.

The body is streamed and counted rather than awaited whole, so a download cut short by its
deadline still yields a figure. On a congested cell that partial number is the measurement.

Throughput is reported twice and labelled:

- `bps_transfer` — the payload phase alone, `responseStart` to `responseEnd`. This is the
  throughput figure, and it is what a stalled page load experiences.
- `bps_end_to_end` — the whole request including DNS, connect, TLS and time to first byte.
  Always lower, and the gap between them is the cost of setting the connection up.

Either is left empty when its window is under 2 ms, which is shorter than the clock
resolves; `bytes` and `transfer_ms` are always kept so the analysis can judge for itself.

### Deadlines and cadence

No probe may outlive its own round: every deadline is 8 s, capped at the interval minus half
a second, and the values in force are recorded in `environment.timeouts_ms`. Eight seconds
rather than four because journey data showed probes succeeding at 3885 ms against a 4000 ms
ceiling — anything slower was being filed as a failure, which collapses "slow" into "gone"
and that distinction is the point of the measurement.

Each round is scheduled from when the previous one actually fired rather than onto a fixed
grid. On a grid, any lateness pulls the next slot closer, and after a long freeze the next
round fires immediately and collides with the one still running. A round costs a full page
download, so two of them moments apart measure the same instant twice.

### Two profiles

**Fine** runs every 15 s, **Coarse** every 30 s. Both use the same 8 s deadlines and both run
the download in every round, because the download is the only probe that measures throughput
rather than reachability and sampling it occasionally leaves most rounds with none. The
interval carries the cost instead.

## Every attempt is recorded

A round that fails is the measurement. Nothing is dropped, skipped or summarised away, and
no failure is represented only by an absence.

- `fail` gives the reason, not just the fact: `timeout`, `network`, `http`, `parse`, `abort`.
- `ms` is recorded on failure too. How long a probe took to fail separates a refused
  connection from a link that hung until the deadline.
- A round that could not start because the previous one was still in flight is written with
  `skipped: "overlap"` rather than passed over.
- `late_ms` appears on every row. iOS freezes JavaScript when the tab is hidden or the
  screen locks; a round more than twice the interval late also writes a `pause` event with
  the bridged duration, and `visible` records the tab state per row.
- If an IndexedDB write fails, rows stay in memory and are retried, with the pending count
  shown on screen. Silent data loss is the one failure this tool cannot have.

## The data

Sessions live in IndexedDB until exported. One button per session writes one JSON file
containing the session metadata, the environment, every sample and every event. CSV, GPX or
GeoJSON are a few lines to derive from it wherever the analysis happens.

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
| `pos_t` | timestamp **of the fix**, not of the round. A stale fix on a moving train is off by a kilometre, and this is the only way to see it |
| `pos_error` | `denied`, `timeout` or `unavailable` when there is no position |
| `intervalMs` | interval in force for this round |
| `in_pause` | this round followed a bridged gap, so it can be filtered without matching timestamps |
| `wake_lock` | whether the screen was being held awake for this round |
| `prev_round_ms` | how long the previous round actually took. A frozen tab suspends the abort timers too, so a round can outlast every deadline in it; without this an overlap cannot be told from the app stalling |
| `speed_derived` `speed_source` | speed computed from consecutive fixes, and whether the reported value is `gps` or `derived` |

### Per probe, under `probes.<id>`

| Field | Probes | Meaning |
|---|---|---|
| `ok` `ms` `fail` | all | success, round trip, failure reason |
| `status` | `ip6` `ip4` `down` | HTTP status; null where the response is opaque and the status is genuinely unknowable |
| `expected` | `ip4` | the failure was a known-absent path rather than an outage, and is excluded from tallies |
| `stuck` | any | the probe was failing alone and has been rested to clear its connection |
| `egress_ip` `colo` | `ip6` `ip4` `down` | the operator's public address and the Cloudflare PoP |
| `ms_samples` `samples_ok` | `ip6` | every latency sample taken this round, and how many succeeded; `ms` is their median |
| `parse_reason` | `ip6` `ip4` | why a trace body was rejected as not Cloudflare's |
| `public_ips` `candidates` | `udp` | the NAT mapping per address family, and how many ICE candidates were gathered |
| `host` | `dns` `dns_ctl` | the hostname used — random each round for `dns`, constant for `dns_ctl` |
| `bytes` `transfer_ms` `ttfb_ms` | `down` | bytes counted, the window they arrived in, and time to first byte |
| `bps_transfer` `bps_end_to_end` | `down` | the two rates described above |
| `truncated` | `down` | the deadline cut the body short; the partial figure still stands |
| `handshake` `reused` `protocol` | `down` | connection setup |
| `server` | `down` | Cloudflare's `cfL4` view: `rtt_us`, `min_rtt_us`, `rtt_var_us`, `lost`, `retrans`, `delivery_rate`, `cwnd` |

Connection setup and `server` are readable only because `speed.cloudflare.com` sends
`timing-allow-origin`; the other five endpoints report zeroed timing cross-origin.
`handshake` is not simply a non-zero `secureConnectionStart` — on a reused connection the
specification sets that field to `fetchStart` — so it is counted only when a TLS phase falls
inside a real connect window.

**`server` is usually all zeros on iOS.** Those fields need a connection that has
accumulated round-trip samples, and Safari opens a fresh connection per request, so the
response header arrives before any exist. Read an all-zero `cfL4` block as *no data*, never
as a measurement of zero. It costs nothing to keep, since the header arrives either way.

### Reading it while travelling

The four tiles are named for where they go — **Cloudflare**, **DNS**, **Google**,
**throughput** — so a failure can be placed by reading down them: if Cloudflare answers the
connection works, if DNS fails beside it the fault is resolution, if only Google fails the
fault is at one company, and if all three answer while throughput collapses the cell is
congested. Tapping a tile says what it measures; the **?** in the header turns all four
explanations on at once.

Below them, three lamps show which paths are carrying traffic — IPv6, IPv4, UDP — lit, dim
where a path is known absent, red where it has failed. That replaces a standing sentence
about IPv4; the verdict is written to the log once and to `ipv4_available` in the file.

The live view shows a rolling p90 over the last five minutes beside each current value. A
median across a whole journey came out at 82 ms and said nothing about the experience; the
p90 over a few minutes is the number that moves when the connection does.

**Degraded** is the share of rounds in which some probe failed. Full outages turned out to be
rare — the longest ran four rounds — while the share of partially failing rounds reached 47%
over the worst stretch with a median latency of a perfectly healthy 96 ms. Outage-only
statistics miss almost all of it.

Each tile explains what it measures when tapped, so the screen carries numbers rather than
captions.

### Events

Only what cannot be derived from the samples. `mark` is the subjective half of the
measurement, pressed when the failure is noticed rather than when the probes see it — the
premise of the exercise is that those two disagree. `pause` records JavaScript being frozen,
with the bridged duration. `note` is free text.

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

A full page download in every round is almost the entire cost; the six small probes come to
roughly 11 kB per round between them, of which the sampled latency probe is about 3 kB and
the UDP probe a few hundred bytes. The projection for the chosen settings is shown before
a run starts and a running estimate during it, and the projection turns amber past 50 MB.

Approximate totals for a 40-minute journey: **Fine ≈ 40 MB**, **Coarse ≈ 20 MB**.

The interval sets both the cost and the resolution: a 30-second interval cannot locate the
start of a dropout more precisely than 30 seconds. The estimate charges a TLS handshake per
probe per round rather than assuming connection reuse, which Safari does not do, so it is
deliberately conservative.

### On iOS, speed is mostly absent

`coords.speed` came back on 0, 2 and 51 of 158, 75 and 243 rounds across three journeys,
with `enableHighAccuracy` already set. There is no way to press the platform harder from a
browser, so speed is also computed from consecutive fixes and their own timestamps.
`speed_source` says which value is being reported and the measured field is left empty rather
than filled in with the derived one.

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
