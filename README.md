# Web Traffic Speedometer

[![release](https://github.com/enwelder/web-traffic-speedometer/actions/workflows/release.yml/badge.svg)](https://github.com/enwelder/web-traffic-speedometer/actions/workflows/release.yml)
[![codeql](https://github.com/enwelder/web-traffic-speedometer/actions/workflows/codeql.yml/badge.svg)](https://github.com/enwelder/web-traffic-speedometer/actions/workflows/codeql.yml)
[![release version](https://img.shields.io/github/v/release/enwelder/web-traffic-speedometer?label=release&color=4C9BE8)](https://github.com/enwelder/web-traffic-speedometer/releases/latest)
[![licence 0BSD](https://img.shields.io/github/license/enwelder/web-traffic-speedometer?color=35B37E)](LICENSE)

**[Open the logger](https://enwelder.github.io/web-traffic-speedometer/)**

A browser page that logs mobile connectivity for the length of a journey. Every 15 or 30
seconds it runs seven probes in parallel, records a GPS fix alongside, and writes the round
to IndexedDB. One session exports as one JSON file.

iOS gives a browser no radio metrics: no RSRP, RSRQ, SINR or cell ID. Timing requests is the
only measurement available. There are seven probes rather than one so that a failure can be
attributed to a layer.

Nothing is aggregated away. Every grade shown on screen can be recomputed from the exported
rows.

## The probes

| Probe | Target | Answers |
|---|---|---|
| `ip6` | `https://[2606:4700:4700::1111]/cdn-cgi/trace` | is the radio link up over IPv6, with no name resolution involved |
| `ip4` | `https://1.1.1.1/cdn-cgi/trace` | the same, over IPv4 |
| `dns` | `https://<random>.github.io/` (HEAD) | can the carrier's resolver resolve a name it cannot have cached |
| `dns_ctl` | `https://wts-dns-control.github.io/` (HEAD) | is that destination reachable with the name already cached |
| `web` | `https://www.gstatic.com/generate_204` | is a provider other than Cloudflare reachable |
| `down` | `https://speed.cloudflare.com/__down` | what rate does the link sustain |
| `udp` | `stun:stun.cloudflare.com:3478` | is there a UDP path out, and what does it map to |

Read together:

- `dns` fails, `dns_ctl` succeeds → name resolution is failing.
- `dns` and `ip6` both fail → the radio link, not DNS.
- `web` alone fails → one provider's edge, not the network.
- everything answers but `down` collapses → congestion. A saturated cell still replies
  quickly to small requests.
- `udp` alone fails → the carrier shapes UDP differently from TCP. Calls and streaming ride
  on UDP.

Latency probes are sampled three times per round; `ms` is the median. `down` measures a
lower bound on throughput, not a rate.

## On screen

Three tiles, one per purpose: **calls & live audio**, **opening an article**, **video &
downloads**. Each reads several measurements and takes the worst. A tile shows the
measurement that decided its grade. Below them, one history strip per purpose and two lamps
for the IPv4 and UDP paths.

Grading scales are absolute, never relative to the session:

| scale | green | yellow | orange | red | source |
|---|---|---|---|---|---|
| round trip | <100 ms | <200 ms | <400 ms | ≥400 ms | ITU-T G.114 |
| TTFB | <800 ms | <1800 ms | <3000 ms | ≥3000 ms | web.dev |
| article | <2.5 s | <4 s | <8 s | ≥8 s | Core Web Vitals LCP |
| rate | >10 Mb/s | >5 Mb/s | >1.5 Mb/s | ≤1.5 Mb/s | Netflix tiers |
| call rate | >300 kb/s | >100 kb/s | >30 kb/s | ≤30 kb/s | Opus, RFC 6716 |

**Degraded** is the share of rounds with any probe failure. It is the useful figure: full
outages are rare, while partially failing rounds reached 47% over the worst recorded stretch
at a median latency of 96 ms.

## Data usage

The two download requests are almost the whole cost; the six small probes total ~12 kB per
round. The projection assumes the 4 MB ceiling every round: ~530 MB for 40 minutes on Fine
(15 s), ~270 MB on Coarse (30 s). Both are shown before a run and tracked during it. Nothing
stops a run partway.

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

Recordings are anonymised into fixtures with `node tools/anonymise.mjs <recording>
<fixture>`. Coordinates are removed, addresses and user agents redacted, timestamps shifted
to a fixed epoch with intervals preserved, measurements untouched.

Machine-local files go in `.dev/`, ignored as a directory. A recording carries a home
address, a workplace and a daily timetable, and this repository is public. Security tests
enforce it: nothing under `.dev/` may be tracked, and no committed file may have the shape of
a journey export.

The version is stated once in `package.json`. A push to `main` publishes to Pages; a new
version number also tags and releases.

## Security properties

`tests/security.mjs` fails the build if any of these stops being true:

- It contacts nothing but its seven probes.
- It has no way to upload what it records: one `fetch`, no request bodies, no `sendBeacon`,
  `WebSocket` or `XMLHttpRequest`, no URL reaching the network via an image or a `src`.
- It sends no credentials or referrer.
- It executes no dynamic code and writes no markup. Everything reaches the DOM as text.
- It ships no third-party code, at build time or runtime.
- The peer connection gathers ICE candidates and nothing else: no data channel, no track, no
  remote description, receive-only transceiver.
- The service worker never touches a probe and never takes over a tab mid-session.

Data leaves only when you export it.

## More

- [docs/design.md](docs/design.md) — why each probe is built the way it is, and what the
  field recordings changed.
- [docs/data-format.md](docs/data-format.md) — every field in an exported session.

## Licence

[0BSD](LICENSE). Public-domain-equivalent: use it for anything, no attribution required.
