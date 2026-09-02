# Spoormeter

A browser-based mobile connectivity logger for train journeys. It records whether the
network is reachable, how fast it answers, and where you were — continuously, on a few
hundred kilobytes, with no backend and no runtime dependencies.

It is a logger only. Analysis happens elsewhere, where the data can be joined against
timetables, track maps and cell databases.

## Deploying

Static files; push to a GitHub Pages branch and open the URL. HTTPS is required for
geolocation, and the service worker caches the shell so the page still loads — and a
crashed session still recovers — with no usable network.

Locally, `python3 -m http.server` on `http://localhost` counts as a secure context, so
geolocation, wake lock and service workers all work without certificates.

## Measurement

Three probes fire in parallel each round:

| Probe | URL | Isolates |
|---|---|---|
| `ip` | `https://1.1.1.1/cdn-cgi/trace` | the radio link, with no DNS involved |
| `dns` | `https://one.one.one.one/cdn-cgi/trace` | the same server via hostname — the difference against `ip` is DNS |
| `web` | `https://www.gstatic.com/generate_204` | different infrastructure, as a control |

If only `dns` fails, name resolution is the problem. If all three fail together, it is the
radio link. If only `web` fails, the fault is specific to one provider's edge.

The two Cloudflare endpoints send `access-control-allow-origin: *`, so they are fetched
with `mode: 'cors'` and their bodies read — the same bytes an opaque request already
transferred. That yields the operator's egress IP, the Cloudflare PoP, and real HTTP
status codes, and it makes an intercepting proxy detectable: under `no-cors` an opaque
redirect resolves as a success, which it is not. `generate_204` sends no CORS header and
stays opaque, so its success means only that the request completed and its status is
recorded as unknown rather than as zero.

Every scheduled round produces a row — including rounds that failed, rounds that could not
start because the previous one was still in flight, and rounds delayed by iOS freezing the
tab. A failed attempt is the measurement; it is never represented by a missing row.

## Data

Sessions live in IndexedDB until exported. Only raw samples are stored: no outage
durations, no counts, no summaries. Where the line falls between noise and an outage is an
analysis decision, and it has to stay revisable.

Export formats: **JSON** (canonical and lossless), **CSV** samples, **CSV** events, **GPX**,
**GeoJSON**. "Export everything" writes every session to one JSON file.

### Sample columns

| Column | Meaning |
|---|---|
| `session_id` `session_name` `operator` `connection` `route` | session identity, repeated per row so files from different days stack |
| `seq` | round number; a gap means a row was lost, which should never happen |
| `t` | wall clock, ISO 8601 |
| `mono` | milliseconds on a monotonic clock since session start; survives wall-clock jumps, and is bridged across a reload using `t` |
| `late_ms` | how far behind schedule this round ran |
| `skipped` | `overlap` when the previous round had not returned yet; empty otherwise |
| `round_error` | exception message if the round itself threw |
| `lat` `lon` `accuracy` `speed` `heading` | GPS fix; speed in m/s |
| `pos_t` | timestamp **of the fix**, not of the round — a stale fix on a moving train is off by a kilometre and this is the only way to see it |
| `pos_error` | `denied`, `timeout` or `unavailable` when there is no position |
| `interval_ms` | the interval actually used for this round |
| `<probe>_ok` | 1 or 0, per probe `ip` / `dns` / `web` |
| `<probe>_ms` | round trip, **also filled in on failure** — time-to-fail separates a refused connection from a link that hung to the deadline |
| `<probe>_status` | HTTP status; empty for the opaque probe, where it cannot be known |
| `<probe>_fail` | `timeout`, `network`, `http`, `parse` or `abort` |
| `<probe>_egress_ip` | the operator's public IP, from the trace body |
| `<probe>_colo` | Cloudflare PoP |

`parse` means the endpoint answered but the body was not trace-shaped — something replied
on Cloudflare's behalf.

### Event rows

Only what cannot be derived from the samples: `mark` (pressed by hand), `pause` (JavaScript
was frozen, with the bridged duration) and `note`.

## Operator and connection type

No browser API exposes the carrier or whether the radio is cellular or Wi-Fi;
`navigator.connection` is not implemented in Safari on any platform. Both are therefore
fields you set before the run. The recorded egress IP makes the label checkable afterwards:
a carrier CGNAT range and a home Wi-Fi address resolve to different ASNs. If the egress IP
changes mid-session while the label does not, the screen says so at the time.

One SIM is active at a time, so an operator comparison is a comparison between journeys.

## Data usage

Roughly 1 kB per round once connections are warm, plus about 5 kB whenever TLS has to be
re-established — which a moving train forces often, and most often during the trouble you
are trying to record. A 40-minute run at 5 seconds is on the order of half a megabyte; at
10 seconds, half that. The on-screen counter is an estimate and is labelled as one.

The adaptive interval trades even sampling for fewer bytes: it speeds up while probes are
failing and slows down while they are stable. It is off by default, because an even
interval makes two journeys directly comparable.

## iOS notes

- Wake lock is requested at start and re-requested when the tab becomes visible. If it is
  refused, set auto-lock to a longer interval.
- Locking the screen or backgrounding the tab freezes JavaScript. The gap is recorded as a
  `pause` event and as `late_ms` on the next row, so it is never mistaken for an outage.
- Safari can evict storage for sites left unvisited for about a week. Sessions that have
  never been exported are flagged in the list; export a journey before it matters.
