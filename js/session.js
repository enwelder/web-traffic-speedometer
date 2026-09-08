// The round loop. Every scheduled round produces a row, including rounds that failed and
// rounds that could not run: a failed attempt is a measurement, so it is never left out.

import {PROBES, runRound, checkIpv4, clearTimings, timeoutFor,
        DEFAULT_DOWN_BUDGET_MS, DEFAULT_DOWN_MAX_BYTES} from './probe.js';
import {gradeRound} from './grade.js';
import {createStuckTracker} from './stuck.js';
import {createWakeLock} from './wakelock.js';
import * as realStore from './store.js';

// Byte estimates for the data-used figure. Safari opens a fresh connection per request, so
// every repeat contact is charged a resumed TLS handshake and only the first contact with an
// origin is charged a full one.
const FIRST_CONTACT_BYTES = 5000;
const RESUMED_BYTES = 1500;
const WARM_BYTES = {trace: 420, opaque: 220, download: 400, stun: 400};
const REFUSED_BYTES = 100;      // an IPv4 literal with no path never gets a connection up
// STUN is UDP: no handshake to charge and no connection to resume.
const cost = p => (WARM_BYTES[p.kind] * (p.samples || 1)) + (p.kind === 'stun' ? 0 : RESUMED_BYTES);

export const APP_VERSION = '3.3.1';

// The download runs every round, so the interval is what controls data use.
export const PROFILES = {
  fine:   {label: 'Fine — every 15 s',   intervalMs: 15000},
  coarse: {label: 'Coarse — every 30 s', intervalMs: 30000}
};

export const DOWNLOAD_DEFAULTS = {
  budgetMs: DEFAULT_DOWN_BUDGET_MS,
  maxBytes: DEFAULT_DOWN_MAX_BYTES
};

const EARTH_M = 6371000;
// Above this accuracy a fix is a cell-tower estimate. Two such fixes hundreds of metres
// apart in opposite directions yield speeds around 680 km/h; iOS reports exactly 1414 m for
// that class of fix.
const FINE_ACCURACY_M = 100;
// 400 km/h, above the top speed of any train on the routes measured.
const MAX_PLAUSIBLE_MS = 111;
// Haversine distance. iOS fills coords.speed only sporadically (0, 2 and 51 of 158, 75 and
// 243 rounds across three journeys), so speed is derived from consecutive fixes and the
// measured value is kept whenever the platform supplies one.
function metresBetween(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// The download is time-boxed, so what it pulls depends on the link. This assumes it reaches
// its byte ceiling every round, which is the worst case and what a fast link does.
export function projectedBytes(intervalMs, settings = DOWNLOAD_DEFAULTS, minutes = 40) {
  const rounds = Math.round((minutes * 60000) / intervalMs);
  const small = PROBES.reduce((n, p) => n + cost(p), 0);
  return rounds * (small + settings.maxBytes);
}

export function environment(intervalMs, downloadSettings = DOWNLOAD_DEFAULTS) {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return {
    app_version: APP_VERSION,
    user_agent: navigator.userAgent,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    interval_ms: intervalMs,
    download: {...DOWNLOAD_DEFAULTS, ...downloadSettings},
    timeouts_ms: Object.fromEntries(PROBES.map(p => [p.id, timeoutFor(p, intervalMs)])),
    probes: PROBES.map(p => ({id: p.id, url: p.url, kind: p.kind,
                              mode: p.kind === 'opaque' ? 'no-cors' : 'cors',
                              method: p.method || 'GET', samples: p.samples || 1})),
    // Absent in Safari on every platform; recorded for browsers that have it.
    network_information: c ? {type: c.type, effectiveType: c.effectiveType, downlink: c.downlink, rtt: c.rtt} : null
  };
}

// Estimated bytes for one round. `contacted` carries across rounds: only the first request
// to a host is charged a full handshake.
function roundBytes(row, contacted) {
  let n = 0;
  for (const p of PROBES) {
    const r = row.probes?.[p.id];
    if (!r) continue;
    if (r.expected && !r.ok) { n += REFUSED_BYTES; continue; }
    if (r.fail === 'resting') continue;
    const attempts = r.ms_samples ? r.ms_samples.length : 1;
    n += WARM_BYTES[p.kind] * attempts + (p.kind === 'download' ? r.bytes || 0 : 0);
    if (p.kind !== 'stun') {
      n += contacted.has(p.id) ? RESUMED_BYTES : FIRST_CONTACT_BYTES;
      contacted.add(p.id);
    }
  }
  return n;
}

// Bytes already charged by the rows on disk, so a resumed session continues its running
// total rather than restarting at zero.
export function spentSoFar(samples) {
  const contacted = new Set();
  let bytes = 0, downloadBytes = 0;
  for (const row of samples) {
    bytes += roundBytes(row, contacted);
    downloadBytes += row.probes?.down?.bytes || 0;
  }
  return {bytes, downloadBytes};
}

// `store` is injectable so the round loop can run against a fake one.
export function createRecorder({onSample, onEvent, onStatus, onNotice, store = realStore}) {
  let session = null;
  let running = false;
  let timer = null;
  let due = 0;
  let t0 = 0;
  let seq = 0;
  let inFlight = false;
  let abort = null;
  let bytes = 0;
  let marks = 0;
  let watchId = null;
  let lastPos = null;
  let posError = null;
  let prevFix = null;
  let inPause = false;
  let lastRoundMs = null;
  let lastSpeed = null;
  let lastSpeedSource = null;
  let egressIp = null;
  let fineFix = null;
  let throughput = null;
  let udpMs = null;
  let downloadBytesUsed = 0;
  let lastGrades = null;
  let flushing = null;
  let writeFailed = false;
  let current = null;

  const contacted = new Set();
  const pendingSamples = [];
  const pendingEvents = [];
  const stuck = createStuckTracker({onNotice});
  // The event carries the position and the session id, so it is the recorder's to write.
  const wake = createWakeLock({onNotice, onEvent: text => running && noteEvent(text)});

  const mono = () => performance.now() - t0;
  const interval = () => session.intervalMs;

  function status() {
    return {
      running, session, seq, marks, bytes, throughput, udpMs, grades: lastGrades,
      downloadMB: Math.round(downloadBytesUsed / 1e5) / 10,
      speedKmh: lastSpeed == null ? null : Math.round(lastSpeed * 3.6),
      speedSource: lastSpeedSource,
      pending: pendingSamples.length + pendingEvents.length,
      writeFailed, pos: lastPos, posError,
      elapsed: running ? Math.floor(mono() / 1000) : 0
    };
  }

  function emit() { onStatus?.(status()); }

  function record(event) {
    pendingEvents.push(event);
    onEvent?.(event);
    flush();
  }

  // Returns the in-flight promise, so a caller arriving during a flush can await it.
  // stop() depends on this to drain the buffer before the session is closed.
  async function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
    try {
      if (pendingSamples.length) {
        const batch = pendingSamples.slice();
        await store.putSamples(batch);
        pendingSamples.splice(0, batch.length);
      }
      if (pendingEvents.length) {
        const batch = pendingEvents.slice();
        await store.putEvents(batch);
        pendingEvents.splice(0, batch.length);
      }
      if (writeFailed) { writeFailed = false; onNotice?.(''); }
    } catch (e) {
      // Rows stay in the buffer and are retried next round.
      writeFailed = true;
      onNotice?.(`Storage write failed (${e.message}). ${pendingSamples.length} rounds held in memory, retrying.`);
    } finally {
      emit();
    }
    })();
    try { await flushing; } finally { flushing = null; }
  }

  function position() {
    if (!lastPos) {
      return {lat: null, lon: null, accuracy: null, accuracy_class: null, speed: null,
              speed_derived: null, speed_source: null, heading: null, pos_t: null,
              pos_error: posError};
    }
    const c = lastPos.coords;
    const fix = {lat: c.latitude, lon: c.longitude, t: lastPos.timestamp};

    const accuracy = c.accuracy == null ? null : Math.round(c.accuracy);
    const fine = accuracy != null && accuracy <= FINE_ACCURACY_M;
    fix.fine = fine;

    // Both fixes must be fine: a coarse fix anywhere in the pair makes the distance
    // meaningless.
    let derived = null;
    if (fine && prevFix?.fine && fix.t > prevFix.t) {
      const seconds = (fix.t - prevFix.t) / 1000;
      // Under a second the rate is dominated by fix jitter; over two minutes it averages
      // away everything that happened in between.
      if (seconds >= 1 && seconds <= 120) {
        const rate = metresBetween(prevFix, fix) / seconds;
        // Two fixes accurate to 10 m can still be hundreds of metres apart if one is wrong,
        // so a rate above the plausible ceiling is discarded. The coordinates stay on both
        // rows, so the analysis can derive speed differently.
        derived = rate <= MAX_PLAUSIBLE_MS ? rate : null;
      }
    }
    if (!prevFix || fix.t !== prevFix.t) prevFix = fix;

    const measured = c.speed == null || c.speed < 0 ? null : c.speed;
    return {
      lat: fix.lat, lon: fix.lon,
      accuracy,
      // gps: usable for position and for deriving speed. coarse: a tower estimate, usable
      // as a rough location only. Consumers filter on this instead of the raw threshold.
      accuracy_class: accuracy == null ? null : fine ? 'gps' : 'coarse',
      speed: measured,
      speed_derived: derived == null ? null : Math.round(derived * 100) / 100,
      speed_source: measured != null ? 'gps' : derived != null ? 'derived' : null,
      heading: c.heading == null || c.heading < 0 ? null : c.heading,
      // The fix's own timestamp, so its age is visible: a 30 s old fix on a 140 km/h train
      // is more than a kilometre from the round's position.
      pos_t: fix.t,
      pos_error: posError
    };
  }

  function charge(row) { bytes += roundBytes(row, contacted); }

  function keep(row) {
    pendingSamples.push(row);
    onSample?.(row);
    flush();
  }

  function baseRow(late, skipped) {
    const pos = position();
    lastSpeed = pos.speed ?? pos.speed_derived ?? null;
    lastSpeedSource = pos.speed_source;
    return {
      sessionId: session.id,
      seq: seq++,
      t: Date.now(),
      mono: Math.round(mono()),
      late_ms: late,
      skipped,
      round_error: null,
      // iOS suspends a hidden tab; a column filters more easily than the pause events.
      visible: document.visibilityState === 'visible',
      // Set on the round following a bridged gap, so those rows can be filtered without
      // matching timestamps against the event list.
      in_pause: inPause,
      // Whether the screen was held awake for this round, which accounts for gaps.
      wake_lock: wake.held(),
      // Wall time the previous round took. A frozen tab suspends the abort timer, so a round
      // can outlast every deadline in it; this separates an overlap from a stalled app.
      prev_round_ms: lastRoundMs,
      intervalMs: interval(),
      ...pos,
      probes: {}
    };
  }

  // The operator label is typed in, the egress address is measured, so an address change
  // under an unchanged label marks a hotspot picked up mid-journey or a handover onto a
  // different core network.
  function noteEgressChange(row) {
    const seen = PROBES.map(p => row.probes[p.id]?.egress_ip).find(Boolean);
    if (!seen) return;
    if (!egressIp) { egressIp = seen; return; }
    if (seen === egressIp) return;
    noteEvent('egress address changed');
    egressIp = seen;
  }

  async function measure(late) {
    inFlight = true;
    const startedAt = mono();
    const row = baseRow(late, null);
    inPause = false;
    try {
      row.probes = await runRound({
        signal: abort.signal,
        download: session.download || DOWNLOAD_DEFAULTS,
        intervalMs: interval(),
        ipv4Available: session.ipv4_available,
        resting: stuck.resting(seq)
      });
    } catch (e) {
      row.round_error = String(e && e.message || e);
      for (const p of PROBES) {
        if (!row.probes[p.id]) row.probes[p.id] = {ok: false, ms: null, status: null, fail: 'network'};
      }
    } finally {
      inFlight = false;
      lastRoundMs = Math.round(mono() - startedAt);
    }

    if (!wake.held()) wake.acquire();
    downloadBytesUsed += row.probes.down?.bytes || 0;

    // The quickest first response in the round, which approximates the cost of waking the
    // radio. Reported, never graded. Zero values are excluded: connect_ms is zero both for a
    // reused connection and when timing is unreadable.
    const firsts = [row.probes.ip6?.ms_samples?.[0], row.probes.web?.ms_samples?.[0],
                    row.probes.dns_ctl?.ms_samples?.[0], row.probes.udp?.ms_samples?.[0]]
                   .filter(v => v != null && v > 0);
    row.first_packet_ms = firsts.length ? Math.min(...firsts) : null;

    // Resolved once and stored on the row, so the file and the screen carry the same grade.
    row.grades = gradeRound(row);
    lastGrades = row.grades;

    // A radio still waking at session start can refuse the preflight, so one success
    // overturns the result rather than leaving the probe exempt for the whole journey.
    if (session.ipv4_available === false && row.probes.ip4?.ok) {
      session.ipv4_available = true;
      noteEvent('IPv4 available after all; the preflight caught a sleeping radio');
      store.putSession(session);
    }

    noteEgressChange(row);
    stuck.note(row, seq);
    charge(row);
    clearTimings();
    if (row.probes.down?.ok) throughput = row.probes.down.bps_steady;
    if (row.probes.udp) udpMs = row.probes.udp.ok ? row.probes.udp.ms : null;

    keep(row);
  }

  function tick() {
    if (!running) return;
    const now = mono();
    // Timer rounding can fire a tick early; lateness is clamped at zero.
    const late = Math.max(0, Math.round(now - due));

    // iOS freezes JS when the tab is backgrounded or the screen locks. The gap is recorded
    // so it stays distinguishable from an outage. The threshold is one missed slot: at two,
    // a 13.7 s delay on a 10 s interval goes unlogged.
    if (late >= interval()) {
      const p = position();
      inPause = true;
      record({sessionId: session.id, t: Date.now(), mono: Math.round(now), type: 'pause',
              lat: p.lat, lon: p.lon, text: `${(late / 1000).toFixed(1)}s bridged`});
    }

    // Scheduled from when this round fired rather than from a fixed grid: on a grid,
    // lateness pulls the next slot closer, so a 13.7 s delay on a 10 s interval fires the
    // next tick 11 ms later, into the round still running. Even spacing matters here, grid
    // phase does not.
    due = now + interval();
    timer = setTimeout(tick, Math.max(0, due - mono()));

    if (inFlight) {
      // The previous round had not returned when this one came due, which at a short
      // interval is itself a measurement.
      keep(baseRow(late, 'overlap'));
      return;
    }
    current = measure(late);
  }

  function event(type, text) {
    const p = position();
    record({sessionId: session.id, t: Date.now(), mono: Math.round(mono()), type,
            lat: p.lat, lon: p.lon, text});
  }

  const noteEvent = text => event('note', text);

  function startGeolocation() {
    if (!navigator.geolocation) { posError = 'unavailable'; return; }
    watchId = navigator.geolocation.watchPosition(
      p => {
        lastPos = p;
        posError = null;
        // Accuracy changes mid-journey (a tunnel, or a fallback to tower positioning) and
        // changes what the coordinates support, so each transition is logged.
        const acc = p.coords.accuracy;
        const nowFine = acc != null && acc <= FINE_ACCURACY_M;
        if (running && fineFix !== null && nowFine !== fineFix) {
          noteEvent(nowFine ? `location precise again (${Math.round(acc)} m)`
                            : `location degraded to ${Math.round(acc)} m — speed and distance withheld`);
        }
        fineFix = nowFine;
        emit();
      },
      e => {
        posError = e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable';
        onNotice?.(`No location (${posError}). Measurement continues without coordinates.`);
        emit();
      },
      // maximumAge 0: a cached fix is often a coarse one held from earlier, which puts a
      // large share of rounds at tower accuracy.
      {enableHighAccuracy: true, maximumAge: 0, timeout: 12000}
    );
  }

  // `monoBase` continues the monotonic clock across a reload: performance.now() restarts,
  // so the gap is bridged with the wall clock. Both clocks are on every row, so the bridge
  // is checkable.
  async function start(s, {resumeSeq = 0, monoBase = 0, resumedGapMs = 0, spent = null} = {}) {
    session = s;
    seq = resumeSeq;
    running = true;
    // One recorder lives for the page, so session-scoped state is cleared when a new session
    // starts.
    if (!resumeSeq) {
      stuck.reset();
      marks = 0;
      lastRoundMs = null;
      inPause = false;
      prevFix = null;
      egressIp = null;
      lastPos = null;
      posError = null;
      fineFix = null;
      lastSpeed = null;
      lastSpeedSource = null;
    }
    t0 = performance.now() - monoBase;
    due = monoBase;
    bytes = spent?.bytes || 0;
    throughput = null;
    udpMs = null;
    downloadBytesUsed = spent?.downloadBytes || 0;
    lastGrades = null;
    inFlight = false;
    contacted.clear();
    abort = new AbortController();
    store.setActive(session.id);
    clearTimings();
    startGeolocation();
    wake.reset();
    await wake.acquire();

    // Established once per session: on an IPv6-only network every round would otherwise
    // report the same absent path.
    if (session.ipv4_available == null) {
      const v4 = await checkIpv4(abort.signal);
      session.ipv4_available = v4.available;
      session.ipv4_check = v4;
      await store.putSession(session);
      // Recorded once in the log and on the session; the lamps carry it afterwards.
      record({sessionId: session.id, t: Date.now(), mono: Math.round(mono()), type: 'note',
              lat: null, lon: null,
              text: `IPv4 ${v4.available ? 'available' : `absent (${v4.fail} in ${v4.ms} ms)`}`});
    }

    if (resumedGapMs) {
      record({sessionId: session.id, t: Date.now(), mono: Math.round(monoBase), type: 'pause',
              lat: null, lon: null, text: `${(resumedGapMs / 1000).toFixed(1)}s bridged across reload`});
    }
    // Set after the preflight and the wake lock: otherwise the first row reports start-up
    // time as scheduling lateness, and a slow radio logs a pause that did not happen.
    due = mono();
    tick();
    emit();
  }

  async function stop() {
    // Handles stopping what was never started (a reload mid-session) and stopping twice (two
    // taps inside one await): neither throws, and neither overwrites an existing end time.
    if (!session) return null;
    if (!running && session.stopped) return session;
    running = false;
    clearTimeout(timer);
    timer = null;
    abort?.abort();
    // The aborted round still resolves into a row, so it is awaited before the drain.
    if (current) { try { await current; } catch { /* recorded as round_error */ } }
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    await wake.release();

    session.stopped = Date.now();
    // Each pass awaits any flush already running, so a row written during one is picked up
    // by the next.
    for (let i = 0; i < 5 && (pendingSamples.length || pendingEvents.length); i++) await flush();
    await store.putSession(session);
    store.setActive(null);
    emit();
    return session;
  }

  function mark() {
    if (!running) return;
    marks++;
    const p = position();
    record({sessionId: session.id, t: Date.now(), mono: Math.round(mono()), type: 'mark',
            lat: p.lat, lon: p.lon, text: `mark ${marks}`});
    emit();
  }

  function note(text) {
    if (!running || !text) return;
    const p = position();
    record({sessionId: session.id, t: Date.now(), mono: Math.round(mono()), type: 'note',
            lat: p.lat, lon: p.lon, text});
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && running) wake.acquire();
  });

  return {start, stop, mark, note, status, flush};
}
