# Network Usability Log

[![release](https://github.com/enwelder/network-usability-log/actions/workflows/release.yml/badge.svg)](https://github.com/enwelder/network-usability-log/actions/workflows/release.yml)
[![codeql](https://github.com/enwelder/network-usability-log/actions/workflows/codeql.yml/badge.svg)](https://github.com/enwelder/network-usability-log/actions/workflows/codeql.yml)
[![release version](https://img.shields.io/github/v/release/enwelder/network-usability-log?label=release&color=4C9BE8)](https://github.com/enwelder/network-usability-log/releases/latest)
[![licence 0BSD](https://img.shields.io/github/license/enwelder/network-usability-log?color=35B37E)](LICENSE)

**[Open the logger](https://enwelder.github.io/network-usability-log/)**

A browser page that records, round by round, whether a voice call, an article load and a video
stream work on the current network, and which layer fails when one does not. Each round sends
seven requests, each isolating one layer, grades three activities against published thresholds,
and writes the full row to IndexedDB. A session exports as one JSON file with every sample, every
event and the scales the rows were graded with, so every grade is recomputable downstream.
Request timing is the only measurement a browser allows.

## A round

Rounds run every 20 s (Fine) or 60 s (Coarse). Three phases run in sequence, as in RTR's
[RMBT](https://github.com/rtr-nettest/rmbt-server/blob/master/RMBT_specification.md):

| phase | runs | budget |
|---|---|---|
| idle | `ip6` `ip4` `dns` `dns_ctl` `udp` in parallel, on an otherwise idle link | 8 s per probe, capped at the interval minus 500 ms; 3 s per STUN sample |
| download | `down`, with one ungraded round trip sampled inside its window (`loaded_rtt_ms`) | what the idle phase leaves of the interval |
| upload | `up` | what the download leaves; under 1 s the upload is skipped as `no_budget` |

Every round that starts is written, failures included. A round cut by a confirmed suspension (a
250 ms timer firing over 1 s late on the wall or monotonic clock) or by Stop keeps its probes and
carries no grades. A slot that comes due while a round is running writes a `skip` event.

## The probes

| probe | request | samples | isolates |
|---|---|---|---|
| `ip6` | `GET https://[2606:4700:4700::1111]/cdn-cgi/trace` | 10, median | the link over IPv6, no name resolution |
| `ip4` | `GET https://1.1.1.1/cdn-cgi/trace` | 10, median | the same over IPv4 |
| `dns` | `HEAD https://<random>.github.io/` | 5, median, a new name each | first contact with an uncached host: resolution, connect, TLS |
| `dns_ctl` | `HEAD https://nulog-dns-control.github.io/` | 10, median | the same destination under a cached name |
| `down` | `GET https://speed.cloudflare.com/__down`, 3 streams | 1 | sustained downstream throughput |
| `up` | `POST https://speed.cloudflare.com/__up`, 40 kB | 1 | the upstream rate a call needs |
| `udp` | STUN binding to `stun:stun.cloudflare.com:3478` | 10, median | UDP egress and its NAT mapping |

All requests run over TCP and TLS except `udp`. `tools/check-hosts.mjs` runs daily and fails when
a host starts advertising HTTP/3 or drops a header the probes read. Method choices:

| choice | reason |
|---|---|
| median of ten latency samples; a probe fails when no sample succeeds | one round trip varies by an order of magnitude with a cold connection or a retransmission; RMBT reports the median of 10-200. A lost sample after a success is packet loss: `samples_lost` counts it |
| trace body validated: egress is an address, `colo` is a PoP code, scheme is HTTPS, host echoed | a middlebox answering for Cloudflare fails the checks and records `parse` |
| a random `*.github.io` name per `dns` sample, `HEAD` | a fixed name is cached after one round and no query reaches the network; the wildcard record and certificate make any label resolve; `HEAD` keeps the 9 kB 404 body off the wire |
| `down`: 3 streams, a 300 ms or 1 MB discarded ramp, then a 1.5 s window capped at 4.7 MB, ending at the clock, the cap or the first stream's end | one TCP flow carries at most its receive window per round trip; the ramp wakes the radio; the cap fixes the data cost; ending at the first stream's end is RMBT's `t*`. A window under 100 ms holds no round trip and reports no rate |
| `up`: one 40 kB body, timed to the server's byte-count confirmation | 40 kB crosses the 300 kb/s edge in 1.07 s and the 100 kb/s edge in 3.2 s, inside the budget |
| `udp`: ICE candidate gathering against a STUN server, no data channel or track | the only browser mechanism that sends a UDP packet; gathering carries no payload |
| a probe failing `timeout` or `network` for 3 rounds while most others answer rests for 6 rounds | a page cannot discard a wedged connection; `udp`, `down` and `up` hold none and are exempt |

## Grading

An activity takes the worst of its terms. A term is a scaled value or a red flag; one red term
sets red. A scaled term with no measurement leaves the activity unrated unless another term is
red. Edges are absolute, and a value on an edge takes the worse grade; grading reads no session
statistics.

| scale | graded on it | green | yellow | orange | red | source |
|---|---|---|---|---|---|---|
| `round_trip` | `ip6` `ip4` `dns_ctl` `udp` medians | <100 ms | <200 ms | <400 ms | ≥400 ms | [ITU-T G.114](https://www.itu.int/rec/T-REC-G.114) |
| `ttfb` | `dns` median | <800 ms | <1800 ms | <3000 ms | ≥3000 ms | [web.dev TTFB](https://web.dev/articles/ttfb) |
| `article` | the article model below | <2.5 s | <4 s | <8 s | ≥8 s | [Core Web Vitals LCP](https://web.dev/articles/lcp) |
| `rate` | `down` | >7.1 Mb/s | >3.6 Mb/s | >1.6 Mb/s | ≤1.6 Mb/s | [YouTube sustained speeds](https://support.google.com/youtube/answer/78358) for 1080p, 720p, 480p, ÷ 0.7 |
| `call_rate` | `up`, and `down` for calling | >300 kb/s | >100 kb/s | >30 kb/s | ≤30 kb/s | [Opus, RFC 6716](https://www.rfc-editor.org/info/rfc6716) |

How each source is applied:

| scale | adaptation |
|---|---|
| `round_trip` | G.114 budgets one-way mouth-to-ear delay; codec, packetisation and jitter buffer take 80-120 ms, leaving about 100 ms of round trip |
| `ttfb` | defined over a site's 75th percentile; applied to one round's first contact, which includes resolution, connect and TLS since `github.io` sends no `Timing-Allow-Origin` |
| `rate` | YouTube's figures are sustained rates; a 1.5 s window samples an instant. Each edge is divided by 0.7, the bandwidth fraction [ExoPlayer](https://github.com/androidx/media) and [hls.js](https://github.com/video-dev/hls.js) apply before selecting a rendition |
| `call_rate` | a call is latency-bound; these edges detect a link carrying no data |

Article model, an upper bound on the load time of a readable article:

```
2 × dns + 2 × dns_ctl + 500 kB × 8 / down
```

500 kB approximates the critical path: HTML, CSS and fonts total
[221 kB at the mobile median](https://almanac.httparchive.org/en/2025/page-weight), and LCP waits
on the largest image.

Each activity takes the terms below. The note naming the term that set the grade is stored per
round.

| activity | terms | turns red when |
|---|---|---|
| voice & video calling | `round_trip` of the literal that answered (IPv6 first) and of `udp`; `call_rate` of `up` and of `down` | `round trip lost`: neither literal answered and one failed on the link. `no route`: that, with no hostname probe reaching the network. `no UDP` or `no upload`: `udp` or `up` failed on the link. A failed download drops the `call_rate` term and adds no red |
| reading articles | `ttfb` of `dns`; the `article` model | `no lookup` or `host gone`: `dns` or `dns_ctl` failed on the link. `lookup lost`: `dns` answered within 300 ms of a resolver retry timer, so the first query was lost. `no data`: `down` failed on the link |
| streaming video | `rate` of `down` | `no data`: `down` failed on the link |

Two flags apply to all three. `link down`: a download stream still waited for headers 2 s in, and
the check that followed lost both the `dns_ctl` host and STUN. `far end`: every Cloudflare probe
failed while `https://www.gstatic.com/generate_204` answered, which leaves the round unrated.

"Failed on the link" excludes a server refusal, an absent family, a literal that was `blocked` or
`unused`, and the reasons that describe the tool or the browser;
[docs/data-format.md](docs/data-format.md) lists every `fail` value and which ones count.

A failing literal is classified from the current round alone; a network carrying IPv6 only or
IPv4 only is a working connection. A family carried traffic when its literal answered or
completed a handshake, or when any probe reported an egress address of that family:

| the round shows | the literal is | graded |
|---|---|---|
| this family carried traffic; the literal was refused | `blocked`: `1.1.1.1` is a public resolver address that VPNs, filters and captive portals intercept | no |
| this family carried traffic; the literal timed out | a stalled path | red |
| the other family carried traffic | `unused` | no |
| no family carried traffic | a failure | red |

Each probe row is graded on its own scale; `up` shows its rate as a call verdict (`calls ok`,
`voice only`, `choppy`, `too slow`). Uncoloured states: `absent`, `resting`, `refused`, `blocked`, `unused`, `none`.

## Data cost

The download is nearly the whole cost; the six other probes total about 130 kB per round,
handshakes included. The ramp and the byte cap fix the worst case before the run, and a link
below the 25 Mb/s ceiling costs proportionally less:

| interval | rounds per hour | worst case per hour |
|---|---|---|
| 20 s (Fine, default) | 180 | 1.05 GB |
| 60 s (Coarse) | 60 | 350 MB |

## What this cannot measure

| not measured | consequence |
|---|---|
| cell identity, RSRP, RSRQ, SINR, band, radio access technology | no browser exposes them; `navigator.connection` is absent in Safari and reports a coarse type elsewhere |
| download rates above 25 Mb/s | 4.7 MB in 1.5 s is the ceiling; a round that reaches the cap is flagged `saturated`, prints `≥`, and proves a lower bound only |
| upload capacity on a fast uplink | 40 kB leaves in two slow-start flights, so the span holds two to three round trips whatever the uplink carries, and the rate is a lower bound |
| the user's link, in the `server` block | Cloudflare's `cfL4` timing describes the far end's TCP peer, which is the operator's own proxy where it terminates TCP |
| the network's queueing delay | `loaded_rtt_ms` is taken during the tool's own download; its excess over the idle value is queueing the tool itself causes |
| the round trip itself | each latency sample brackets a full HTTPS request: TLS resumption, HTTP framing and browser scheduling are inside it, so the median is an upper bound |
| jitter | ITU-T and the conferencing vendors define it on a paced packet stream; the spread of a request burst is recorded (`ms_min`, `ms_max`, `spread_p50`, `spread_p90`) and ungraded |
| resolution time on its own | every endpoint except Cloudflare's speed host zeroes resource timing cross-origin, so DNS, connect and TLS are one number |
| position on a phone | a fix over 100 m accuracy is a tower estimate, hundreds of metres to 1414 m wide, and it can precede the round by a minute or more, which on a train is kilometres; speed is withheld on coarse pairs and above 400 km/h |
| operator and connection type | entered by the user; the recorded egress address makes the entry checkable against carrier ASNs |
| the endpoints' behaviour | public infrastructure that can rate-limit or intercept; rounds run on a fixed interval uncoordinated with other tests |

## The exported file

One session per JSON file: metadata, environment, a recomputable rollup, every sample, every
event. Every field is listed in [docs/data-format.md](docs/data-format.md). Sessions without an
export are flagged on screen; Safari evicts storage after about a week unvisited.

## Running it

Static files, no build step, no runtime dependencies. Serve over HTTPS; GitHub Pages suffices. A
service worker caches the shell so the page loads on a network too degraded to fetch it.

| command | does |
|---|---|
| `npm run serve` | serves `http://localhost:8731`, a secure context for geolocation, wake lock and the service worker |
| `npm ci` `npm run lint` | playwright and eslint, development only |
| `npm test` | every suite; `test:unit`, `test:security`, `test:browser` select one. `tests/replay.mjs` runs four anonymised recorded journeys through grading and the rollup |
| `NULOG_ENGINES=chromium,webkit,firefox npm test` | browser suites run once per engine (Chromium for Android, WebKit for iOS); each needs `npx playwright install <engine>` |
| `node tools/anonymise.mjs <recording> <fixture>` | strips coordinates, addresses and user agents; shifts timestamps, keeps intervals and measurements |
| `node tools/radio-join.mjs <session.json> <sysdiagnose.tar.gz>` | attaches the serving cell and the signal from the phone's own baseband log to every round, on iOS; [docs/ios-radio-evidence.md](docs/ios-radio-evidence.md) states how to capture one |
| `node tools/profile-from-log.mjs <session.json> <name>`, `node tools/simulate.mjs --profile <name> [--headed]` | derives a simulation profile from a recorded stretch and runs the app under it (WebKit only); `tests/simulation.mjs` asserts the grades a user would read |

Machine-local recordings go in `.dev/`, ignored as a directory: a recording contains a home
address and a daily timetable. `package.json`, `js/session.js` and `sw.js` each state the version;
a security test fails the build when they differ. A push to `main` publishes to Pages and a new
version number tags a release.

## Security properties

`tests/security.mjs` fails the build when any of these breaks:

| property | enforcement |
|---|---|
| network access limited to the probe endpoints and the Google reference host | URL allowlist; CSP `default-src 'none'`, `connect-src 'self' https:` (the host-source grammar cannot express a bracketed IPv6 literal) |
| one `fetch` call site; the only request body is the upload's fixed zero bytes as `text/plain` | `sendBeacon`, `WebSocket`, `XMLHttpRequest` and URL-carrying elements are absent |
| requests carry no credentials and no referrer | `credentials: 'omit'`, `referrerPolicy: 'no-referrer'` |
| no dynamic code execution, no markup writes, no third-party code | all DOM content set as text |
| the peer connection gathers ICE candidates only | no data channel, track or remote description |
| the service worker passes probe requests through untouched and omits `skipWaiting` | a new version waits for running sessions to end |

Recorded data leaves the device only through an export.

## Licence

[0BSD](LICENSE). Public-domain-equivalent: use without restriction or attribution.
