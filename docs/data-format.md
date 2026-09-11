# Exported session format

`format: "wts/session"`, `version: 13`. One button per session writes one JSON file: session
metadata, environment, a rollup, every sample, every event. CSV, GPX and GeoJSON derive from it
directly.

| version | what changed |
|---|---|
| 3 | grades keyed by activity; the download reports a bound |
| 4 | every round carries its per-probe grades beside its activity grades |
| 5 | either address family can be flagged `expected`; the session records both |
| 6 | throughput is graded on the largest of `bps`, `bps_server` and `bps_min` |
| 7 | throughput is streamed on several connections for a fixed window and saturates at a stated ceiling; `bps_min`, `bps_server` and `warmup_only` are gone |
| 8 | a failing address-family literal is judged on its own round: `unused` replaces `expected` on `ip6`/`ip4`, which no longer carry a session-long verdict |
| 9 | an activity whose term could not be measured is unrated; the fresh-name probe is graded on `ttfb`, and the `dns_delta` scale is gone |
| 10 | the download summary reports `bps_p10`, `bps_p50` and `saturated`; a probe survives one failed sample and records it in `sample_fail`; a round that threw has null grades and marks its probes `error`; `short` joins the failure reasons |
| 11 | a slot that comes due while a round is still running is a `skip` event and writes no row, so `skipped` and `prev_round_ms` are gone; rows carry `round_ms`, `phase_idle_ms`, `phase_down_ms` and `visible_end`; sampled probes carry `samples_end` and `wall_ms`; the download carries `per_stream`; `page` and `network` events; `session.end_reason`; a download stream still waiting at the deadline ends as `connect`, and the download carries `window_cut` and, when a stream waits, `stall_check`; sampled probes continue past a lost sample and carry `samples_lost` and `sample_starts_ms`; `udp` carries `host_ms_samples`; the summary counts `slots` |
| 12 | `web` is gone and `up` joins, with `upload_bytes` and `rate_source`; rows carry `interrupted`, `suspended_ms`, `reference` and `phase_up_ms`; `ip6` and `ip4` carry `protocol_samples`; a timed-out literal is never `blocked`; `server` carries `proto`; `no_budget` joins the failure reasons; a `pause` event can carry `round`; the summary counts `interrupted` |
| 13 | `up` carries `saturated` and `ceiling_bps`; `abort` is excluded from failure tallies |

Version 5 changes failure counts. Below it only `ip4` carries `expected`, so every `ip6` failure
counts; from 5, `expected` on `ip6` marks a missing path.

## Per session, under `session`

Settings and values fixed once per session.

| Field | Meaning |
|---|---|
| `id` `name` `started` `stopped` | identity and span |
| `operator` `connection` | entered before the run; no browser API exposes either |
| `profile` `intervalMs` `download` | the settings in force |
| `ipv6_available` `ipv4_available` | whether each family answered at session start or carried traffic later. Informational; no round is graded on it |
| `ipv6_check` `ipv4_check` | the preflight result per family: time to answer and failure reason |
| `environment` | app version, user agent, language, timezone, screen, the deadlines in force, and `download` — the streams, window, cap and ceiling the run measured with |
| `exportedAt` | null until the session has been written out; never-exported sessions are flagged on screen |
| `end_reason` | `stop` when Stop ended the run, `recovered` when it was closed after a reload; absent on a session never closed |

## Rollup

`summary` holds per-probe p50, p90, max, ok and failure counts, the download's and the upload's
rate percentiles and total bytes, and counts of `slots` (rows plus skip events), skipped slots,
`interrupted` rounds, paused rounds and degraded rounds. Interrupted rounds enter no other tally. Outage thresholds are left to analysis; every figure is recomputable
from the samples.

The scales, the activities composed from them, and which scale reads each probe
(`summary.probe_scales`) are copied beside it, so each file carries the definitions its rows were
graded with. `summary.grades` and `summary.grades_by_probe` tally the grades the
run produced.

## Every attempt is recorded

A failed round is written in full, and every failure is an explicit record.

`fail` gives the reason:

| value | meaning |
|---|---|
| `timeout` `network` | the transport |
| `http` | an HTTP error status |
| `parse` | a body that failed validation |
| `short` | bytes crossed, over a span too brief to divide by; `up`: the server's byte count differs from the body, or the browser could not read it |
| `no_budget` | `up`: the round left under a second, and the upload was not sent |
| `error` | the round itself threw before the probe ran |
| `abort` | the app ended the request: a stop, or an interrupted round |
| `stalled` | headers arrived, no body bytes followed |
| `connect` | `down`: no stream had headers by the deadline |
| `empty` | HTTP 200 with an empty body |
| `no_srflx` | candidates gathered, no server-reflexive candidate |
| `resting` | the recorder stood the probe down |
| `unsupported` | the browser has no such API; flagged `expected` |

`resting`, `unsupported`, `short`, `no_budget`, `abort` and `error` are excluded from failure
tallies: each describes the tool or the browser.

`ms` is recorded on failure: the time to fail separates a refused connection from a link that hung
until the deadline.

A slot that comes due while the previous round is still running starts no round and writes no
row; a `skip` event records that round, its elapsed time and the probes it waits on.

If an IndexedDB write fails, rows stay in memory and are retried, with the pending count on
screen.

## Per round

| Field | Meaning |
|---|---|
| `seq` | round number, contiguous; a gap is a lost row |
| `t` | wall clock, epoch ms |
| `mono` | monotonic ms since session start; survives wall-clock jumps, bridged across a reload using `t` |
| `late_ms` | how far behind schedule the round ran |
| `round_error` | exception message if the round itself threw |
| `interrupted` `suspended_ms` | `wake_lock` when the wake lock was released while the round ran, `suspended` when a 250 ms timer fired over 1 s late on either clock; null otherwise. The row keeps its probes and carries null `grades` and `pgrades`. `suspended_ms` is the largest timer gap over 1 s |
| `reference` | `{ok, ms, fail}` of the request to `https://www.gstatic.com/generate_204`, taken only when both literals, the download, the upload and STUN all failed; null otherwise. When it answered, every activity is unrated with note `far end` |
| `visible` `visible_end` | whether the tab was foregrounded when the round started, and when it ended |
| `lat` `lon` `accuracy` `speed` `heading` | GPS fix; `speed` in m/s, often absent |
| `accuracy_class` | `gps` under 100 m, `coarse` above. A coarse fix is a tower estimate: usable as a rough location, unusable for speed or distance |
| `pos_t` | timestamp **of the fix**, which can precede the round; a 30 s old fix on a 140 km/h train is over 1 km off |
| `pos_error` | `denied`, `timeout` or `unavailable` when there is no position |
| `intervalMs` | interval in force for this round |
| `in_pause` | this round followed a bridged gap, so it can be filtered without matching timestamps |
| `wake_lock` | whether the screen was held awake |
| `round_ms` `phase_idle_ms` `phase_down_ms` `phase_up_ms` | the round's wall time, and its three phases: the idle probes, the download with the round trip taken across it, and the upload. `phase_down_ms` includes up to 1 s of the refusal check after a `network` failure |
| `speed_derived` `speed_source` | speed computed from consecutive fixes, and whether the reported value is `gps` or `derived` |
| `loaded_rtt_ms` `loaded_rtt_from` | a round trip taken during the download window, and the probe that took it: the probe that answered in the idle phase, so the two values are comparable and their difference is the queueing delay under load. Null when no window opened or the transfer ended before the sample started |
| `grades` | the three activity grades as displayed. `null` for the object: the round threw or was interrupted. `null` for one activity: unrated, because a required term has no measurement or the far end failed |
| `pgrades` | the per-probe grades |
| `first_packet_ms` | fastest first response in the round, an estimate of radio wake-up cost; ungraded |

## Per probe, under `probes.<id>`

| Field | Probes | Meaning |
|---|---|---|
| `ok` `ms` `fail` | all | success, round trip, failure reason |
| `status` | `ip6` `ip4` `down` | HTTP status; null where the response is opaque and the status is unknowable |
| `unused` | `ip6` `ip4` | another family carried the round's traffic. Excluded from tallies |
| `blocked` | `ip6` `ip4` | this family carried traffic in the round and the literal address was refused. A literal that timed out is never `blocked`. Excluded from tallies |
| `protocol_samples` | `ip6` `ip4` | per sample, the HTTP version the trace endpoint received the request over (`http/1.1`, `http/2`, `http/3`); null for a failed sample |
| `expected` | `udp` | the browser has no such API. Excluded from tallies |
| `stuck` | any | the probe failed alone and was rested |
| `egress_ip` `colo` | `ip6` `ip4` `down`; `colo` also `up` | the operator's public address and the Cloudflare PoP |
| `ms_samples` `samples_ok` `ms_min` `ms_max` | `ip6` `ip4` `dns` `dns_ctl` `udp` | every latency sample, the success count, and the spread the median omits; `ms` is the median of the successful samples |
| `sample_fail` `samples_lost` | sampled probes | on a probe with at least one success: the reason of the first failed sample and the count of failed samples. Each sample gets the remaining probe budget |
| `sample_starts_ms` | sampled probes | start offset of each sample from the probe start; idle probes start together, so offsets align across probes |
| `samples_end` `wall_ms` | sampled probes | why sampling stopped — the `count` was reached, the `budget` could not hold another sample, or a `failure` before any sample answered — and the wall time of all samples. A STUN sample's `ms` is its first srflx candidate, and gathering continues after it |
| `parse_reason` | `ip6` `ip4` | which check the trace body failed |
| `public_ips` `candidates` | `udp` | the NAT mapping per address family, and how many ICE candidates were gathered |
| `host_ms_samples` | `udp` | per sample, time to the first host candidate; `ms` minus this value approximates the STUN exchange |
| `host` | `dns` `dns_ctl` | the hostname used: random each round for `dns`, constant for `dns_ctl` |
| `retry_suspected` | `dns` | the answer arrived within 300 ms of a resolver retry timer (2 s or 5 s), so the first query was lost. Red regardless of the value |
| `bytes` `duration_ms` `ttfb_ms` | `down` | bytes read, read duration, time to first byte |
| `bps` | `down` | the rate over the window across all streams, and the graded value. Null for a window under 100 ms, shorter than a round trip |
| `bps` `ttfb_ms` `rate_source` | `up` | the upload rate, `bodyBytes × 8000 ÷ span`; the span `responseStart − requestStart` when `rate_source` is `timing`, fetch to headers when it is `fetch`. The span holds one round trip, so `bps` is a lower bound |
| `saturated` `ceiling_bps` | `up` | the span was under five round trips of the round's literal, which set it, so `bps` is a lower bound and the row prints `≥`; `ceiling_bps` is the rate at five round trips. Absent when no literal answered |
| `upload_bytes` `bytes` | `up` | the byte count the server reported in `cf-meta-upload-bytes`; 0 when the browser could not read it |
| `saturated` | `down` | the window reached its byte cap first, so `bps` is the ceiling and a lower bound on the link. The row prints `≥` |
| `ceiling_bps` | `down` | the highest rate this round can report |
| `streams` | `down` | number of connections that opened |
| `per_stream` | `down` | one entry per connection: `headers_ms` and `first_byte_ms` from the start of the download, `bytes` read, and `end` — `eof`, `done`, `time`, `aborted` or `network` for a stream that opened; `connect` for one still waiting at the deadline; `http` (with its `status`), `aborted` or `network` for one that did not open. `transfer_size` and `encoded_body_size` come from the load's resource-timing entry: WebKit files entries for completed loads only, so a size on a cancelled stream counts bytes received unread |
| `stall_check` | `down` | present when a stream was still waiting for headers 2 s in: `same_host`, `other_host` (the `dns_ctl` host) and `udp`, each `{ok, ms, fail}`. Download host slow with the other host fast: browser or host. UDP answering with both slow: TCP path. The other host and UDP both lost: link, graded `link down` |
| `window_cut` | `down` | the download deadline closed the window before `windowMs` elapsed; `bps` covers a shorter span |
| `window_bytes` `window_ms` | `down` | the bytes and span `bps` is computed over. The window closes on its own clock, so a stall inside it leaves `window_ms` unchanged |
| `ramp_ms` | `down` | discarded streaming time before the window opened |
| `refused_by` | `down` | on a `network` failure: `server` or `connection` |
| `aborted_reason` | `down` | how the read ended: `done` when the window or the cap closed it, `eof`, `time`, `aborted` or `network` |
| `truncated` | `down` | a network error cut the body short; the round is a failure |
| `handshake` `reused` `protocol` `lookup_ms` `connect_ms` `tls_ms` | `down` `up` | connection setup, phase by phase |
| `server` | `down` `up` | Cloudflare's `cfL4` view: `proto` (the transport the server terminated), `rtt_us`, `min_rtt_us`, `rtt_var_us`, `lost`, `retrans`, `delivery_rate`, `cwnd` |

Connection setup and `server` are readable because `speed.cloudflare.com` sends
`timing-allow-origin`; every other endpoint returns zeroed timing cross-origin. `handshake`
requires a TLS phase inside a nonzero connect window: on a reused connection the specification
sets `secureConnectionStart` to `fetchStart`.

**`server` can be all zeros.** The fields require round-trip samples on the connection; a small or
infrequent download can receive the header before any exist. An all-zero `cfL4` block means *no
data*.

**`server` can describe a proxy.** An operator that terminates TCP in its core network makes that
proxy Cloudflare's TCP peer. On KPN `min_rtt_us` is about 2,000 against a radio round trip of 20 ms
or more; `lost` and `retrans` then cover the proxy–Cloudflare leg only.

`environment.user_agent` is stored raw and is untrusted: some browsers freeze or spoof it, so a
parsed OS version can be wrong.

## Events

Records not derivable from the samples.

| event | meaning |
|---|---|
| `mark` | the user's timestamp of a perceived failure; probe failures can occur at other times |
| `pause` | JavaScript frozen, with the bridged duration; `round` names the interrupted round the absence cut short, which stands for it on the strip |
| `note` | free text and recorder notices: wake lock lost or regained, position accuracy class change, a change of location error state (`no location (…)`), probe rested, egress address change under an unchanged operator label |
| `skip` | a slot came due `late_ms` behind schedule while round `round` was still running: `running_ms` so far, and `waiting_on`, the unsettled probe ids (`loaded_rtt` for the loaded round trip, `reference` for the Google request) |
| `page` | the tab `hidden` or `visible`, `pagehide` or `pageshow`, `freeze` or `resume` |
| `network` | `online` or `offline`, and a change of connection type or class where the browser exposes `navigator.connection`. Safari lacks it, so an iPhone records `online` and `offline` only |
