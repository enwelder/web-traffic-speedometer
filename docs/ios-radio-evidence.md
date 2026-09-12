# Enriching a session with baseband data on iOS

An exported session says when a path degraded. The phone's baseband log says which cell it was on
and at what signal. Apple's Telephony Logging profile makes that log readable, with no jailbreak and
no private API: the entitlements that reach these metrics are issued by Apple and checked by the
telephony daemon, so a self-signed build gets nothing.

Needed: the iPhone, a Mac, a cable.

## Order of operations

1. Install `Baseband.mobileconfig` from Apple's
   [Profiles and Logs](https://developer.apple.com/bug-reporting/profiles-and-logs/) page. Open it
   on the phone, Settings → Profile Downloaded → Install. It installs as **Telephony Logging**.
2. Restart the phone.
3. Turn Wi-Fi off, so the radio under test is the cellular one.
4. Start a session in the app and let it run.
5. Stop the session, then trigger a sysdiagnose within minutes: press and release both volume
   buttons and the side button together. A short vibration confirms it; the screen shows nothing.
6. Wait 10 minutes, then Settings → Privacy & Security → Analytics & Improvements → Analytics Data →
   `sysdiagnose_…` → share → AirDrop to the Mac.
7. Export the session from the app.

A sysdiagnose saves what the phone still holds, so nothing starts or stops in step with the app. On
a ride over an hour, trigger one part way through as well.

## What the log carries

| field | example line |
|---|---|
| signal | `QMI.NAS.2: received LTE SigInfo rssi -80 snr 0 rsrq -14 rsrp -112` |
| radio state | `evaluateCellularScore: RRC state: 1, RSRP: -103, SNR: 0.4, RSRQ: -16` |
| serving cell | `Index: 0, MCC: 204, MNC: 08, Band info: 7, Area code: 32004, Cell ID: <private>, EARFCN: 3150, PID: 253` |
| NR cell | `NRARFCN: 646848, PCI: 119, RSRP: 4294967221, RSRQ: 4294967285, Bandwidth: 100000000, Neighbor Type: 1` |
| cell id, unredacted | `kCTCellMonitorCellId = 16461107` |
| cell change | `updateConnectedStateSummary 1, Cell Changed 1` |
| neighbours | `EARFCN: 6400, PCI: 395, Bandwidth: 50, Neighbor Type: 3` |

Values arrive several times a second while the radio is active.

## Reading it

Pull the log from the connected phone:

```
/usr/bin/log collect --device --last 30m --output ~/Desktop/trip.logarchive
```

`log stream` takes no device, so live viewing runs through Console.app. A sysdiagnose holds the same
material as `system_logs.logarchive` inside the archive.

Extract the cellular lines:

```
/usr/bin/log show ~/Desktop/trip.logarchive --info --debug --style syslog \
  --predicate 'subsystem == "com.apple.CommCenter" OR subsystem == "com.apple.telephony.bb" OR subsystem BEGINSWITH "com.apple.WirelessRadioManager"' \
  > ~/Desktop/trip-cell.txt
```

## Joining it to the session

```
node tools/radio-join.mjs <session.json> <path/to/system_logs.logarchive>
```

Writes `<session>-radio.json`: the session with a `radio` object on every round carrying the serving
cell, the signal samples taken while it ran, the RAT, the RRC state, cell changes, stall detections
and PDN events, plus a `session.radio` header naming the PLMN, the window, the iOS build and what
each pattern matched. Device identifiers never reach it, and addresses are carried as a `/64`.

A required pattern that matches nothing fails the run and names itself: the line formats are
Apple's, unversioned, and read on one build.

The commands below are what the tool runs, for reading the log by hand.

Both sides carry the same clock: a row's `t` is `Date.now()` on the phone, and the log lines carry
that phone's system time. A round covers `t` to `t + round_ms`, and `phase_idle_ms`,
`phase_down_ms` and `phase_up_ms` split it further.

```
date -r $((1757606593))          # a row's t/1000, as local time
/usr/bin/log show ~/Desktop/trip.logarchive --info --debug --style syslog \
  --start '2026-09-12 15:23:20' --end '2026-09-12 15:23:40' \
  --predicate 'subsystem == "com.apple.CommCenter"'
```

## Limits

| limit | consequence |
|---|---|
| the radio detail reaches back about an hour | the busiest log streams roll over before the quiet ones, so a long ride needs a sysdiagnose part way through |
| an absent value is a sentinel | `32767`, `-32768`, `-3276`, and serving-cell lines with `Band info: 0`, `EARFCN: 0` or `Area code: 0`; read as numbers they produce nonsense |
| the NR cell has no serving-cell block | it is listed under `NR Neighbor cells`, where `Neighbor Type: 1` is the aggregated leg and the only type carrying a level; its RSRP and RSRQ are printed as unsigned 32-bit, so `4294967221` is −75 dBm |
| the NR report lags its round | a cell is named only for a round that measured NR signal, and never from a report over 120 s older than the round, so a report is never inherited across a gap |
| an NR ARFCN does not name one band | the FR1 ranges overlap, so 646848 is 3702.72 MHz in either n77 or n78; the frequency is exact and the band is a candidate list |
| the serving cell is reported in bursts | consecutive reports alternate between cells, so a cell change is read from `Cell Changed`, not from comparing identities |
| it is the phone's own view | no radio-block utilisation, no scheduling decisions, no other user's experience, so it names a cell without proving what the cell did |
| the profile expires after 7 days | `DurationUntilRemoval` is 604800 seconds; reinstall before a trip, and remove it afterwards under Settings → General → VPN & Device Management, then restart |

## Before sharing any of it

The profile's consent text states the files may contain the contents of SMS messages, device
identifiers and names, the IP addresses and recent location history of the device, phone numbers,
the Apple Accounts signed in, and logs of calls and audio routes. Send the cellular lines extracted
for the window in question, never the archive.
