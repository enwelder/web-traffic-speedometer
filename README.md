# Spoormeter

A browser-based mobile connectivity logger for train journeys. It records reachability,
latency, throughput and position continuously, with no backend and no runtime dependencies.

It is a logger only. Analysis happens elsewhere, where the data can be joined against
timetables, track maps and cell databases.

## Deploying

Static files; push to a GitHub Pages branch and open the URL. HTTPS is required for
geolocation, and the service worker caches the shell so the page still loads — and a
crashed session still recovers — with no usable network.

Locally, `python3 -m http.server` on `http://localhost` counts as a secure context, so
geolocation, wake lock and service workers all work without certificates.

## The probes

Five small probes fire in parallel each round; the download runs on a fixed cadence of once
a minute.

| Probe | Target | Isolates |
|---|---|---|
| `ip6` | `https://[2606:4700:4700::1111]/cdn-cgi/trace` | the radio link over IPv6, no name resolution |
| `ip4` | `https://1.1.1.1/cdn-cgi/trace` | the same, over IPv4 |
| `dns` | `https://<random>.github.io/` (HEAD) | resolution of a name that cannot be cached |
| `dns_ctl` | `https://spoormeter-dns-control.github.io/` (HEAD) | the same destination with the name already cached |
| `web` | `https://www.gstatic.com/generate_204` | a provider that is not Cloudflare |
| `down` | `https://speed.cloudflare.com/__down?bytes=N` | throughput, once a minute |

If `dns` fails while `ip6` holds, name resolution is the problem. If both fail, it is the
radio link. If only `web` fails, the fault is specific to one provider's edge.

**Why two address families.** Dutch mobile networks run IPv6-only with NAT64/DNS64. iOS has
no CLAT, so it depends on DNS64 synthesising an address during lookup — and an address
literal skips lookup entirely, which means `ip4` simply cannot connect there. That is not a
bug to work around; recording both is how the address family actually in use becomes
visible instead of assumed. Confirmed in the field: on KPN cellular every `ip4` round
returned `network` after about 6 ms — an immediate refusal, not a timeout — with an egress
of `2a09:bac5:…`.

Availability is therefore settled by one preflight at session start, recorded as
`ipv4_available` with the evidence in `ipv4_check`. Subsequent `ip4` failures carry
`expected: true`, are excluded from failure tallies, and do not colour the display. A
failure without that flag is a real one: if IPv4 worked at the start and stops, that is a
finding.

**Why a random hostname, and what its latency is not.** A fixed hostname stops testing DNS
almost immediately: `one.one.one.one` has a 24-hour TTL, so after the first lookup iOS
answers from cache and no query reaches the network — precisely during the long outages that
matter most. `*.github.io` has a wildcard record and a wildcard certificate, so a fresh
random label is resolvable, uncacheable, and cannot have been seen before. `HEAD` keeps the
9 kB 404 body off the wire, and the hostname is recorded per round so freshness is checkable
rather than claimed.

The *latency* of this probe is not DNS latency, and must not be read as such. Measured
against a fixed label at the same destination:

| phase | fixed label | random label | delta |
|---|---|---|---|
| DNS | 1.8 ms | 13.6 ms | +12 ms |
| TCP + TLS | 16.7 ms | 17.0 ms | 0 |
| server | 10.6 ms | 103 ms | +92 ms |

Requesting the *same* new hostname a second time drops it to 30 ms, so the 92 ms is GitHub
caching the hostname, not resolution. `dns_ctl` exists to hold the destination constant:
it is the same host, same path, same edge, with a name that stays cached for an hour. The
pair is a reliable **failure** discriminator — `dns` failing while `dns_ctl` succeeds is a
resolution failure and nothing else — but the latency difference between them is a lookup
plus a cold-hostname penalty, not a lookup alone.

An exact resolution timing would need a wildcard on the same infrastructure as the IP probe.
There is none available: `pages.dev`, `workers.dev` and `cloudflare-dns.com` all lack
wildcard DNS. DNS-over-HTTPS was also rejected — it bypasses the OS resolver entirely, so it
would test Cloudflare's recursive resolver rather than the carrier's, the one under
suspicion.

**Why the download is 250 kB and periodic.** Latency alone cannot see congestion: a saturated
cell answers a small request quickly while delivering almost no throughput. At 25 kB the
handshake dominated — the field trial showed `reused: false` every round, `ttfb_ms` near 58,
and a resulting 5.7 Mb/s that described setup overhead rather than the link. 250 kB is about
the weight of a text-heavy article with images, which is the workload that actually fails on
the commute, and it is large enough that transfer time dominates setup.

The size is selectable (100 / 250 / 500 kB) and the projected session total is shown before
the run. The cadence is fixed at once a minute and is decided before each round runs, never
conditional on network state, so a bad stretch cannot bias which rounds carry a sample.
Rounds without one set `download_round: false` and simply omit `probes.down`.

The body is streamed and counted rather than awaited whole, so a download cut short by the
deadline still yields a figure — on a congested cell that partial number is the measurement.

`speed.cloudflare.com` is also the only endpoint that sends `timing-allow-origin`, which is
what makes `handshake`, `reused` and `ttfb_ms` readable at all; the other five report zeroed
timing cross-origin.

**`Server-Timing: cfL4` is usually empty on iOS.** It carries Cloudflare's own view of the
TCP connection — RTT, retransmits, losses, delivery rate, congestion window — but only once
the connection has accumulated samples. Safari opens a fresh connection for each request, so
the header arrives before any exist: the field trial returned zeros for every field on all 15
rounds, while a desktop run with reused connections showed `cwnd` climbing 53 → 79 → 104 →
117. Treat a cfL4 block of all zeros as "no data", not as a measurement of zero. It costs
nothing to keep, since the header is received either way.

## Every attempt is recorded

A round that fails is the measurement. Nothing is dropped, skipped, or summarised away, and
no failure is represented only by an absence.

- `<probe>_fail` is the reason, not the fact: `timeout`, `network`, `http`, `parse`, `abort`.
- `ms` is recorded on failure too — time-to-fail separates a refused connection from a link
  that hung until the deadline.
- A round that could not start because the previous one was still in flight is written with
  `skipped: "overlap"`, not passed over.
- `late_ms` is on every row. iOS freezes JavaScript when the tab is hidden or the screen
  locks; a round more than twice the interval late also writes a `pause` event with the
  bridged duration, and `visible` records the tab state per row.
- If an IndexedDB write fails, rows stay in memory and are retried, with the pending count
  on screen. Silent data loss is the one failure this tool cannot have.

What is *not* stored is the derived conclusion: no outage events, durations or counts. Where
the line falls between noise and an outage shifts the answer, and that choice belongs with
the analysis, next to the other sources.

## Data

Sessions live in IndexedDB until exported. One button per session writes one JSON file with
the session metadata, the environment, every sample and every event. CSV, GPX or GeoJSON are
a few lines to derive from it where the enrichment happens anyway.

### Per round

| Field | Meaning |
|---|---|
| `seq` | round number; a gap means a row was lost, which should never happen |
| `t` | wall clock, epoch ms |
| `mono` | monotonic ms since session start; survives wall-clock jumps, bridged across a reload using `t` |
| `late_ms` | how far behind schedule the round ran |
| `skipped` | `overlap` when the previous round had not returned; otherwise null |
| `round_error` | exception message if the round itself threw |
| `download_round` | whether the periodic download was scheduled for this round |
| `visible` | whether the tab was foregrounded for this round |
| `lat` `lon` `accuracy` `speed` `heading` | GPS fix; speed in m/s |
| `pos_t` | timestamp **of the fix**, not the round — a stale fix on a moving train is off by a kilometre and this is the only way to see it |
| `pos_error` | `denied`, `timeout` or `unavailable` when there is no position |
| `intervalMs` | interval in force for this round |

### Per probe, under `probes.<id>`

| Field | Probes | Meaning |
|---|---|---|
| `ok` `ms` `fail` | all | success, round trip, failure reason |
| `status` | `ip6` `ip4` `down` | HTTP status; null where the response is opaque and the status is genuinely unknowable |
| `egress_ip` `colo` | `ip6` `ip4` `down` | the operator's public address and the Cloudflare PoP |
| `host` | `dns` `dns_ctl` | the hostname used — random each round for `dns`, constant for `dns_ctl` |
| `expected` | `ip4` | the failure was a known-absent path, not an outage; excluded from tallies |
| `bytes` `transfer_ms` | `down` | bytes counted and the window they arrived in |
| `bps_transfer` | `down` | rate over the payload phase alone (`responseStart`→`responseEnd`). This is the throughput figure — what a stalled article download actually experiences |
| `bps_end_to_end` | `down` | rate over the whole request including DNS, connect, TLS and TTFB. Lower, and at small sizes it is mostly setup |
| `truncated` | `down` | the deadline cut the body short; the partial figure still stands |
| `ttfb_ms` `handshake` `reused` `protocol` | `down` | connection setup. A reused connection reports `connectStart == connectEnd`, and on reuse the spec sets `secureConnectionStart` to `fetchStart`, so a handshake is only counted when the TLS phase falls inside a real connect window |
| `server` | `down` | Cloudflare's `cfL4` view: `rtt_us`, `min_rtt_us`, `rtt_var_us`, `lost`, `retrans`, `delivery_rate`, `cwnd` |

### Events

Only what cannot be derived from the samples.

`mark` is the subjective half of the measurement: pressed when you notice the failure
yourself — audio stalling, a page that will not load. The probes record what the network
did; nothing else records when it felt broken, and the premise of the whole exercise is
that those two disagree. `pause` records JavaScript being frozen, with the bridged
duration. `note` is free text.

## Operator and connection type

No browser API exposes the carrier or whether the radio is cellular or Wi-Fi;
`navigator.connection` is not implemented in Safari on any platform. Connection type is
therefore asked for before the run, and the operator only when it is not Wi-Fi. Everything
else about the session — its name included — is generated from what is already known.

The recorded egress IP makes the label checkable afterwards: a carrier range and a home
Wi-Fi address resolve to different ASNs. If the egress IP changes mid-session while the
label does not, the screen says so at the time.

One SIM is active at a time, so an operator comparison is a comparison between journeys.

## Data usage

Five small probes per round plus one download a minute. At a 5-second interval with a 250 kB
download that projects to roughly 14 MB for a 40-minute run; the figure for the chosen
settings is shown before the run starts, and a running estimate during it.

The projection charges a TLS handshake per probe per round rather than assuming connection
reuse, because the field trial showed `reused: false` on every round. That makes it
deliberately conservative, and it will over-estimate on a network where IPv4 is absent, since
a refused literal never gets a connection up.

## iOS notes

- Wake lock is requested at start and re-requested when the tab becomes visible. If it is
  refused, set auto-lock to a longer interval.
- Locking the screen or backgrounding the tab freezes JavaScript. The gap is recorded as a
  `pause` event, as `late_ms` on the next row, and as `visible: false`.
- Safari can evict storage for sites left unvisited for about a week. Sessions that have
  never been exported are flagged in the list; export a journey before it matters.
