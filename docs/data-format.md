# Exported session format

`format: "wts/session"`, `version: 5`. One button per session writes one JSON file: session
metadata, environment, a rollup, every sample, every event. CSV, GPX or GeoJSON are a few
lines to derive from it.

| version | what changed |
|---|---|
| 3 | grades keyed by activity; the download reports a bound rather than a rate |
| 4 | every round carries its per-probe grades beside its activity grades |
| 5 | either address family can be flagged `expected`; the session records both |

Version 5 matters to a reader counting failures: before it, `expected` appeared only on `ip4`,
so an `ip6` failure was always a real one. On a network carrying no IPv6 it now marks a path
that was never there.

## Per session, under `session`

Everything the run was told or settled once, rather than measured per round.

| Field | Meaning |
|---|---|
| `id` `name` `started` `stopped` | identity and span |
| `operator` `connection` | what the operator answered before the run; no browser API exposes either |
| `profile` `intervalMs` `download` | the settings in force |
| `ipv6_available` `ipv4_available` | whether each address family answered the preflight. A network carrying only one is ordinary; failures of the absent family are flagged `expected` and stay out of every tally |
| `ipv6_check` `ipv4_check` | the evidence behind each verdict: time to answer, and the failure reason if it did not |
| `environment` | app version, user agent, language, timezone, screen, and the deadlines in force |
| `exportedAt` | null until the session has been written out; never-exported sessions are flagged on screen |

## Rollup

`summary` holds per-probe p50, p90, max, ok and failure counts, the download's rate-bound
percentiles and total bytes, and counts of skipped, paused and degraded rounds. It defines no
outage, and every figure is recomputable from the samples. It exists so a reader does not
rebuild the same six aggregates every time.

The scales, the activities composed from them, and which scale reads each probe
(`summary.probe_scales`) are copied in beside it, because a file read a year later has to say
which version graded its rows. `summary.grades` and `summary.grades_by_probe` tally the grades
the run actually produced.

## Every attempt is recorded

A round that fails is the measurement. Nothing is dropped, skipped or summarised away, and no
failure is represented only by an absence.

`fail` gives the reason:

| value | meaning |
|---|---|
| `timeout` `network` | the transport |
| `http` | a status the server chose |
| `parse` | a body that was not the endpoint's |
| `abort` | the session ended mid-probe |
| `stalled` | headers arrived, body never did |
| `empty` | a 200 with nothing in it |
| `no_srflx` | candidates gathered, STUN server never reached |
| `resting` | the recorder stood the probe down; flagged `expected` |
| `unsupported` | the browser has no such API; flagged `expected` |

`resting` and `unsupported` are not network failures and stay out of every tally.

`ms` is recorded on failure too: how long a probe took to fail separates a refused connection
from a link that hung until the deadline.

A round that could not start because the previous one was still in flight is written with
`skipped: "overlap"`.

If an IndexedDB write fails, rows stay in memory and are retried, with the pending count on
screen. Silent data loss is the one failure this tool cannot have.

## Per round

| Field | Meaning |
|---|---|
| `seq` | round number; a gap means a lost row, which should never occur |
| `t` | wall clock, epoch ms |
| `mono` | monotonic ms since session start; survives wall-clock jumps, bridged across a reload using `t` |
| `late_ms` | how far behind schedule the round ran |
| `skipped` | `overlap` when the previous round had not returned; otherwise null |
| `round_error` | exception message if the round itself threw |
| `visible` | whether the tab was foregrounded |
| `lat` `lon` `accuracy` `speed` `heading` | GPS fix; `speed` in m/s, often absent |
| `accuracy_class` | `gps` under 100 m, `coarse` above. A coarse fix is a tower estimate: usable as a rough location, not for speed or distance |
| `pos_t` | timestamp **of the fix**, not of the round. A stale fix on a moving train is off by a kilometre |
| `pos_error` | `denied`, `timeout` or `unavailable` when there is no position |
| `intervalMs` | interval in force for this round |
| `in_pause` | this round followed a bridged gap, so it can be filtered without matching timestamps |
| `wake_lock` | whether the screen was held awake |
| `prev_round_ms` | how long the previous round took. A frozen tab suspends the abort timers, so a round can outlast every deadline in it; without this an overlap cannot be told from the app stalling |
| `speed_derived` `speed_source` | speed computed from consecutive fixes, and whether the reported value is `gps` or `derived` |
| `grades` | the three activity grades this round produced, as shown |
| `pgrades` | the seven per-probe grades |
| `first_packet_ms` | quickest first response in the round: the closest thing to the cost of waking the radio. Reported, never graded |

## Per probe, under `probes.<id>`

| Field | Probes | Meaning |
|---|---|---|
| `ok` `ms` `fail` | all | success, round trip, failure reason |
| `status` | `ip6` `ip4` `down` | HTTP status; null where the response is opaque and the status is unknowable |
| `expected` | `ip4` | the failure was a known-absent path, excluded from tallies |
| `stuck` | any | the probe was failing alone and has been rested |
| `egress_ip` `colo` | `ip6` `ip4` `down` | the operator's public address and the Cloudflare PoP |
| `ms_samples` `samples_ok` `ms_min` `ms_max` | `ip6` `dns_ctl` `web` `udp` | every latency sample, how many succeeded, and the spread; `ms` is their median. A median of [893, 4275, 52] hides the round's story |
| `parse_reason` | `ip6` `ip4` | why a trace body was rejected as not Cloudflare's |
| `public_ips` `candidates` | `udp` | the NAT mapping per address family, and how many ICE candidates were gathered |
| `host` | `dns` `dns_ctl` | the hostname used: random each round for `dns`, constant for `dns_ctl` |
| `retry_suspected` | `dns` | the answer arrived within 300 ms of a resolver retry timer (2 s or 5 s), so the first query was lost. Loss, not slowness, and red regardless of the number |
| `bytes` `duration_ms` `ttfb_ms` | `down` | bytes counted, how long the read ran, time to first byte |
| `bps_min` `complete` | `down` | the throughput bound, and whether the body arrived whole |
| `warmup_only` | `down` | the link was too slow for a second request; the warm-up is the measurement |
| `refused_by` | `down` | on a `network` failure: `server` or `connection` |
| `aborted_reason` | `down` | how the read ended: `eof`, `time`, `aborted` or `network` |
| `truncated` | `down` | the 8 s deadline cut the body short. Unlike the budget, this is a failure |
| `handshake` `reused` `protocol` `lookup_ms` `connect_ms` `tls_ms` | `down` | connection setup, phase by phase |
| `server` | `down` | Cloudflare's `cfL4` view: `rtt_us`, `min_rtt_us`, `rtt_var_us`, `lost`, `retrans`, `delivery_rate`, `cwnd` |

Connection setup and `server` are readable only because `speed.cloudflare.com` sends
`timing-allow-origin`; the other five endpoints report zeroed timing cross-origin.
`handshake` is not simply a non-zero `secureConnectionStart` — on a reused connection the
specification sets that field to `fetchStart` — so it is counted only when a TLS phase falls
inside a real connect window.

**`server` can be all zeros.** Those fields need a connection that has accumulated round-trip
samples. With a page-sized download every round they are populated; with a small or
infrequent one the header can arrive before any samples exist. Read an all-zero `cfL4` block
as *no data*, never as a measurement of zero.

`environment.user_agent` is stored raw and should be treated as untrusted: some browsers
freeze or fake it, so an OS version parsed out of it may be fiction.

## Events

Only what cannot be derived from the samples.

| event | meaning |
|---|---|
| `mark` | pressed when a failure is noticed, not when the probes see it. The premise of the exercise is that those two disagree |
| `pause` | JavaScript frozen, with the bridged duration |
| `note` | free text, plus the recorder's own notices: a wake lock lost or regained, position quality changing, a probe rested, an egress address changing under an unchanged operator label |
