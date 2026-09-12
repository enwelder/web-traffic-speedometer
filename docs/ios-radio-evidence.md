# Enriching a session with iPhone baseband data

A session says when a path degraded. It cannot say which cell carried it, because no browser exposes
cell identity or signal. An iPhone's baseband log carries both, and Apple's Telephony Logging
profile makes that log readable with no jailbreak and no private API: the entitlements reaching
these metrics are issued by Apple and checked by the telephony daemon, so a self-signed build gets
nothing.

This procedure is iPhone-only. Needed: the iPhone and a Mac.

## Capturing

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

The phone keeps a limited window of radio detail, so a sysdiagnose taken after the session may not
reach back to its start. For a session longer than that window, trigger one during the session as
well and join each in turn.

## Joining

```
node tools/radio-join.mjs <session.json> <sysdiagnose.tar.gz>
```

The archive is taken as AirDropped. Only `system_logs.logarchive` and the build plist are unpacked,
into a temporary directory that is removed when the run ends, including when it fails. An already
unpacked `system_logs.logarchive` is accepted in place of the archive and is read where it lies.

Writes `<session>-radio.json`: the session with a `radio` object on every round carrying the serving
cell, the NR cell, the signal samples taken while it ran, the RAT, the RRC state, cell changes,
stall detections and PDN events, plus a `session.radio` header naming the PLMN, the window, the iOS
build and what each pattern matched. Device identifiers never reach it, and addresses are carried as
a `/64`.

A required pattern that matches nothing fails the run and names itself.

Both sides carry the same clock: a row's `t` is `Date.now()` on the phone, and the log lines carry
that phone's system time. A round covers `t` to `t + round_ms`, and `phase_idle_ms`, `phase_down_ms`
and `phase_up_ms` split it further.

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

Reporting follows radio activity, so the number of samples differs per round. The join records how
many fell inside each one.

## Reading it by hand

These are the commands the tool runs, against an unpacked bundle:

```
/usr/bin/log show <bundle>/system_logs.logarchive --info --debug --style syslog \
  --predicate 'subsystem == "com.apple.CommCenter" OR subsystem BEGINSWITH "com.apple.WirelessRadioManager"'

date -r $((T / 1000))            # T is a row's `t`; prints it as local time
/usr/bin/log show <bundle>/system_logs.logarchive --info --debug --style syslog \
  --start 'YYYY-MM-DD HH:MM:SS' --end 'YYYY-MM-DD HH:MM:SS' \
  --predicate 'subsystem == "com.apple.CommCenter"'
```

`log stream` takes no device argument, so live viewing from a connected phone runs through
Console.app.

## Limits

Rows marked *log format* describe lines read on iOS 27.0 (24A435). Apple versions none of them.

| limit | basis | consequence |
|---|---|---|
| the log retains a limited window | not documented, and varies with how much the device logs | a sysdiagnose need not reach back to the session's start, so read `coverage` on each round instead of assuming the session is covered |
| an absent value is written as a sentinel | log format | `32767`, `-32768`, `-3276`, unsigned `4294934528`, and `Band info: 0`, `EARFCN: 0`, `Area code: 0`; read as numbers they produce nonsense |
| the NR cell has no serving-cell block | log format | it is listed under `NR Neighbor cells`, where `Neighbor Type: 1` is the aggregated leg and the only type carrying a level; its RSRP and RSRQ are unsigned 32-bit, so `4294967221` is −75 dBm |
| identity reports alternate between cells inside a second | log format | a cell change is read from `Cell Changed`, since comparing consecutive identities overstates reselections |
| an NR report need not fall inside its round | tool rule | a cell is named only for a round that measured NR signal, and never from a report over 120 s older than the round |
| an NR ARFCN does not name one band | 3GPP TS 38.104 table 5.4.2.3-1 | the FR1 ranges overlap, so 646848 is 3702.72 MHz in either n77 or n78; the frequency is exact and the band is a candidate list |
| it is the phone's own view | by construction | no radio-block utilisation, no scheduling decisions, no other user's experience, so it names a cell without proving what the cell did |
| line formats are unversioned | by construction | a required pattern matching nothing fails the run and names itself |
| the profile expires after 7 days | Apple: `DurationUntilRemoval` is 604800 s in `Baseband.mobileconfig` | reinstall before a trip, and remove it afterwards under Settings → General → VPN & Device Management, then restart |

## Before sharing any of it

The profile's consent text states the files may contain the contents of SMS messages, device
identifiers and names, the IP addresses and recent location history of the device, phone numbers,
the Apple Accounts signed in, and logs of calls and audio routes. Send the joined output or the
cellular lines for the window in question, never the archive.
