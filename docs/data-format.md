# Exported session format

`format: "wts/session"`, `version: 11`. One button per session writes one JSON file: session
metadata, environment, a rollup, every sample, every event. CSV, GPX or GeoJSON are a few
lines to derive from it.

| version | what changed |
|---|---|
| 3 | grades keyed by activity; the download reports a bound |
| 4 | every round carries its per-probe grades beside its activity grades |
| 5 | either address family can be flagged `expected`; the session records both |
| 6 | throughput is graded on the largest of `bps`, `bps_server` and `bps_min` |
| 7 | throughput is streamed on several connections for a fixed window and saturates at a stated ceiling; `bps_min`, `bps_server` and `warmup_only` are gone |
| 8 | a failing address-family literal is judged on its own round: `unused` replaces `expected` on `ip6`/`ip4`, which no longer carry a session-long verdict |
| 9 | an activity whose term could not be measured is unrated; the fresh-name probe is graded on `ttfb`, and the `dns_delta` scale is gone |
| 10 | the download summary reports `bps_p10`, `bps_p50` and `saturated`; a probe survives one failed sample and records it in `sample_fail`; a round that threw grades nothing and marks its probes `error`; `short` joins the failure reasons |
| 11 | a slot that comes due while a round is still running is a `skip` event and writes no row, so `skipped` and `prev_round_ms` are gone; rows carry `round_ms`, `phase_idle_ms`, `phase_down_ms` and `visible_end`; sampled probes carry `samples_end` and `wall_ms`; the download carries `per_stream`; `page` and `network` events; `session.end_reason` |

Version 5 changes failure counts. Files below it carry `expected` only on `ip4`, so every
`ip6` failure in them is a real one. From 5, `expected` on `ip6` marks a path that was never
there.

## Per session, under `session`

Everything the run was told or settled once.

| Field | Meaning |
|---|---|
| `id` `name` `started` `stopped` | identity and span |
| `operator` `connection` | what the operator answered before the run; no browser API exposes either |
| `profile` `intervalMs` `download` | the settings in force |
| `ipv6_available` `ipv4_available` | whether each family answered at session start, and whether one was seen carrying traffic later. Recorded for the reader; no round is judged by it |
| `ipv6_check` `ipv4_check` | the evidence behind each verdict: time to answer, and the failure reason if it did not |
| `environment` | app version, user agent, language, timezone, screen, the deadlines in force, and `download` — the streams, window, cap and ceiling the run measured with |
| `exportedAt` | null until the session has been written out; never-exported sessions are flagged on screen |
| `end_reason` | `stop` when Stop ended the run, `recovered` when it was closed after a reload; absent on a session never closed |

## Rollup

`summary` holds per-probe p50, p90, max, ok and failure counts, the download's rate-bound
percentiles and total bytes, and counts of skipped slots, paused and degraded rounds. It defines no
outage, and every figure is recomputable from the samples.

The scales, the activities composed from them, and which scale reads each probe
(`summary.probe_scales`) are copied in beside it, so a file read a year later states which
version graded its rows. `summary.grades` and `summary.grades_by_probe` tally the grades the
run produced.

## Every attempt is recorded

A failed round is written in full. Nothing is dropped, skipped or summarised away, and no
failure is represented only by an absence.

`fail` gives the reason:

| value | meaning |
|---|---|
| `timeout` `network` | the transport |
| `http` | a status the server chose |
| `parse` | a body that failed validation |
| `short` | bytes crossed, over a span too brief to divide by; flagged `expected` |
| `error` | the round itself threw before the probe ran; flagged `expected` |
| `abort` | the session ended mid-probe |
| `stalled` | headers arrived, body never did |
| `empty` | a 200 with nothing in it |
| `no_srflx` | candidates gathered, STUN server never reached |
| `resting` | the recorder stood the probe down; flagged `expected` |
| `unsupported` | the browser has no such API; flagged `expected` |

`resting`, `unsupported`, `short` and `error` stay out of every tally: none of them is the link failing.

`ms` is recorded on failure too: how long a probe took to fail separates a refused connection
from a link that hung until the deadline.

A slot that comes due while the previous round is still running starts nothing and writes no
row; a `skip` event names that round, how long it has run, and what it is waiting on.

If an IndexedDB write fails, rows stay in memory and are retried, with the pending count on
screen.

## Per round

| Field | Meaning |
|---|---|
| `seq` | round number; a gap means a lost row, which should never occur |
| `t` | wall clock, epoch ms |
| `mono` | monotonic ms since session start; survives wall-clock jumps, bridged across a reload using `t` |
| `late_ms` | how far behind schedule the round ran |
| `round_error` | exception message if the round itself threw |
| `visible` `visible_end` | whether the tab was foregrounded when the round started, and when it ended |
| `lat` `lon` `accuracy` `speed` `heading` | GPS fix; `speed` in m/s, often absent |
| `accuracy_class` | `gps` under 100 m, `coarse` above. A coarse fix is a tower estimate: usable as a rough location, unusable for speed or distance |
| `pos_t` | timestamp **of the fix**, which can precede the round. A stale fix on a moving train is off by a kilometre |
| `pos_error` | `denied`, `timeout` or `unavailable` when there is no position |
| `intervalMs` | interval in force for this round |
| `in_pause` | this round followed a bridged gap, so it can be filtered without matching timestamps |
| `wake_lock` | whether the screen was held awake |
| `round_ms` `phase_idle_ms` `phase_down_ms` | the round's wall time, and its two phases: the idle probes, then the download with the round trip taken across it. A frozen tab suspends the abort timers, so a round can outlast every deadline in it |
| `speed_derived` `speed_source` | speed computed from consecutive fixes, and whether the reported value is `gps` or `derived` |
| `loaded_rtt_ms` `loaded_rtt_from` | a round trip taken while the download was running, and which probe took it — the same one that answered idle, so the pair is one measurement made twice. The gap between them is what this link queues under load. Null when no window opened, or when the transfer ended before the sample could start |
| `grades` | the three activity grades this round produced, as shown. `null` in place of the object means the round threw and measured nothing; `null` for one activity means unrated, where a term it needs had no measurement |
| `pgrades` | the seven per-probe grades |
| `first_packet_ms` | quickest first response in the round, approximating the cost of waking the radio. Reported, never graded |

## Per probe, under `probes.<id>`

| Field | Probes | Meaning |
|---|---|---|
| `ok` `ms` `fail` | all | success, round trip, failure reason |
| `status` | `ip6` `ip4` `down` | HTTP status; null where the response is opaque and the status is unknowable |
| `unused` | `ip6` `ip4` | this family carried nothing while another one carried the traffic, so nobody waited on it. Excluded from tallies |
| `blocked` | `ip6` `ip4` | this family carried traffic in the same round, so the address alone was refused. Excluded from tallies |
| `expected` | `udp` | the browser has no such API. Excluded from tallies |
| `stuck` | any | the probe was failing alone and has been rested |
| `egress_ip` `colo` | `ip6` `ip4` `down` | the operator's public address and the Cloudflare PoP |
| `ms_samples` `samples_ok` `ms_min` `ms_max` | `ip6` `ip4` `dns` `dns_ctl` `web` `udp` | every latency sample, how many succeeded, and the spread; `ms` is the median of the ones that succeeded. A median of [893, 4275, 52] hides the spread |
| `sample_fail` | sampled probes | the reason the last sample failed, on a probe whose earlier samples answered. The probe is a measurement; this is the packet it lost |
| `samples_end` `wall_ms` | sampled probes | why sampling stopped — the `count` was reached, the `budget` could not hold another sample, or a `failure` — and the wall time all the samples took. A STUN sample reports its first candidate before gathering ends, so `ms_samples` alone cannot account for the budget |
| `parse_reason` | `ip6` `ip4` | which check the trace body failed |
| `public_ips` `candidates` | `udp` | the NAT mapping per address family, and how many ICE candidates were gathered |
| `host` | `dns` `dns_ctl` | the hostname used: random each round for `dns`, constant for `dns_ctl` |
| `retry_suspected` | `dns` | the answer arrived within 300 ms of a resolver retry timer (2 s or 5 s), so the first query was lost. Red regardless of the number |
| `bytes` `duration_ms` `ttfb_ms` | `down` | bytes counted, how long the read ran, time to first byte |
| `bps` | `down` | the rate over the window, across every stream. The figure that is graded. Null when the window was shorter than 100 ms, which no round trip fits inside |
| `saturated` | `down` | the window hit its byte cap first, so `bps` is the ceiling and the link carries at least that. The screen prints a `≥` |
| `ceiling_bps` | `down` | the fastest this round could have reported |
| `streams` | `down` | how many connections carried it |
| `per_stream` | `down` | one entry per connection: `headers_ms` and `first_byte_ms` from the start of the download, `bytes` read, and `end` — `eof`, `done`, `time`, `aborted` or `network` for a stream that opened, `http`, `aborted` or `network` for one that never did |
| `window_bytes` `window_ms` | `down` | what `bps` was computed over. The window ends on its own clock, so a stream that stalls inside it shortens no span and lengthens none |
| `ramp_ms` | `down` | how long was streamed before the window opened, and discarded |
| `refused_by` | `down` | on a `network` failure: `server` or `connection` |
| `aborted_reason` | `down` | how the read ended: `eof`, `time`, `aborted` or `network` |
| `truncated` | `down` | the 8 s deadline cut the body short; the round is a failure |
| `handshake` `reused` `protocol` `lookup_ms` `connect_ms` `tls_ms` | `down` | connection setup, phase by phase |
| `server` | `down` | Cloudflare's `cfL4` view: `rtt_us`, `min_rtt_us`, `rtt_var_us`, `lost`, `retrans`, `delivery_rate`, `cwnd` |

Connection setup and `server` are readable only because `speed.cloudflare.com` sends
`timing-allow-origin`; the other five endpoints report zeroed timing cross-origin.
`handshake` is counted only when a TLS phase falls inside a real connect window: on a reused
connection the specification sets `secureConnectionStart` to `fetchStart`.

**`server` can be all zeros.** Those fields need a connection that has accumulated round-trip
samples. With a page-sized download every round they are populated; with a small or infrequent
one the header can arrive before any samples exist. An all-zero `cfL4` block means *no data*.

`environment.user_agent` is stored raw and should be treated as untrusted: some browsers
freeze or fake it, so an OS version parsed out of it may be fiction.

## Events

Only what cannot be derived from the samples.

| event | meaning |
|---|---|
| `mark` | pressed when a person notices a failure. The probes may see it at another time, or not at all |
| `pause` | JavaScript frozen, with the bridged duration |
| `note` | free text, plus the recorder's own notices: a wake lock lost or regained, position quality changing, a probe rested, an egress address changing under an unchanged operator label |
| `skip` | a slot came due `late_ms` behind schedule while round `round` was still running: `running_ms` so far, and `waiting_on`, what it had not settled — probe ids, and `loaded_rtt` for the round trip taken under load |
| `page` | the tab `hidden` or `visible`, `pagehide` or `pageshow`, `freeze` or `resume` |
| `network` | the browser reporting `online` or `offline`, and, where it exposes the connection, a change of its type or class |
