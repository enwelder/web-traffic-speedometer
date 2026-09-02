// The round loop. Every scheduled round produces a row, including the ones that failed and
// the ones that could not run at all — a failed attempt is the measurement, and must never
// be represented by a missing row.

import {PROBES, runRound} from './probe.js';
import * as store from './store.js';

const FAST_MS = 2000;
const SLOW_MS = 10000;
const CALM_ROUNDS = 12;
const HANDSHAKE_BYTES = 5000;   // fresh TLS handshake, the dominant cost during trouble
const TRACE_BYTES = 500;        // warm request + 195-byte body + framing
const OPAQUE_BYTES = 250;
const IDLE_RECONNECT_MS = 60000;

export const APP_VERSION = '2.0.0';

export function environment(intervalMs) {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return {
    app_version: APP_VERSION,
    user_agent: navigator.userAgent,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    interval_ms: intervalMs,
    timeout_ms: 4000,
    probes: PROBES.map(p => ({id: p.id, url: p.url, mode: p.kind === 'trace' ? 'cors' : 'no-cors'})),
    // Absent in Safari on every platform; recorded anyway so a browser that gains it contributes for free.
    network_information: c ? {type: c.type, effectiveType: c.effectiveType, downlink: c.downlink, rtt: c.rtt} : null
  };
}

export function createRecorder({onSample, onEvent, onStatus, onNotice}) {
  let session = null;
  let running = false;
  let timer = null;
  let due = 0;
  let t0 = 0;
  let seq = 0;
  let inFlight = false;
  let abort = null;
  let cleanStreak = 0;
  let bytes = 0;
  let marks = 0;
  let watchId = null;
  let wakeLock = null;
  let lastPos = null;
  let posError = null;
  let lastEgress = null;
  let flushing = false;
  let writeFailed = false;
  let current = null;

  const lastOk = {};
  const prevFailed = {};
  const pendingSamples = [];
  const pendingEvents = [];

  const mono = () => performance.now() - t0;

  function interval() {
    const base = session.intervalMs;
    if (!session.adaptive) return base;
    if (cleanStreak === 0) return Math.min(base, FAST_MS);
    if (cleanStreak >= CALM_ROUNDS) return Math.max(base, SLOW_MS);
    return base;
  }

  function status() {
    return {
      running, session, seq, marks, bytes,
      pending: pendingSamples.length + pendingEvents.length,
      writeFailed,
      pos: lastPos, posError,
      elapsed: running ? Math.floor(mono() / 1000) : 0,
      interval: session ? interval() : 0
    };
  }

  function emit() { onStatus?.(status()); }

  function record(event) {
    pendingEvents.push(event);
    onEvent?.(event);
    flush();
  }

  async function flush() {
    if (flushing) return;
    flushing = true;
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
      // Rows stay in the buffer and are retried next round; nothing is discarded.
      writeFailed = true;
      onNotice?.(`Storage write failed (${e.message}). ${pendingSamples.length} rounds held in memory, retrying.`);
    } finally {
      flushing = false;
      emit();
    }
  }

  function position() {
    if (!lastPos) return {lat: null, lon: null, accuracy: null, speed: null, heading: null, pos_t: null, pos_error: posError};
    const c = lastPos.coords;
    return {
      lat: c.latitude, lon: c.longitude,
      accuracy: c.accuracy == null ? null : Math.round(c.accuracy),
      speed: c.speed == null ? null : c.speed,
      heading: c.heading == null ? null : c.heading,
      // The fix's own timestamp, not the round's: a 30s-old fix on a 140 km/h train is
      // more than a kilometre out, and without this the error is invisible.
      pos_t: lastPos.timestamp,
      pos_error: posError
    };
  }

  function charge(row) {
    for (const p of PROBES) {
      const r = row.probes[p.id];
      bytes += p.kind === 'trace' ? TRACE_BYTES : OPAQUE_BYTES;
      const last = lastOk[p.id];
      if (prevFailed[p.id] || last == null || row.mono - last > IDLE_RECONNECT_MS) bytes += HANDSHAKE_BYTES;
      prevFailed[p.id] = !r.ok;
      if (r.ok) lastOk[p.id] = row.mono;
    }
  }

  function keep(row) {
    pendingSamples.push(row);
    onSample?.(row);
    flush();
  }

  function baseRow(late, skipped) {
    return {
      sessionId: session.id,
      seq: seq++,
      t: Date.now(),
      mono: Math.round(mono()),
      late_ms: late,
      skipped,
      round_error: null,
      intervalMs: interval(),
      ...position(),
      probes: {}
    };
  }

  async function measure(late) {
    inFlight = true;
    const row = baseRow(late, null);
    try {
      const results = await runRound(abort.signal);
      PROBES.forEach((p, i) => { row.probes[p.id] = results[i]; });
    } catch (e) {
      row.round_error = String(e && e.message || e);
      for (const p of PROBES) {
        if (!row.probes[p.id]) row.probes[p.id] = {ok: false, ms: null, status: null, fail: 'network', egress_ip: null, colo: null};
      }
    } finally {
      inFlight = false;
    }

    const allOk = PROBES.every(p => row.probes[p.id].ok);
    cleanStreak = allOk ? cleanStreak + 1 : 0;
    charge(row);

    const egress = row.probes.ip.egress_ip || row.probes.dns.egress_ip;
    if (egress) {
      if (lastEgress && egress !== lastEgress) {
        onNotice?.(`Egress IP changed (${lastEgress} → ${egress}) while the label still says ${session.operator}.`);
      }
      lastEgress = egress;
    }

    keep(row);
  }

  function tick() {
    if (!running) return;
    const now = mono();
    const late = Math.round(now - due);

    // iOS freezes JS when the tab is backgrounded or the screen locks. Recording the gap
    // explicitly is the only way it stays distinguishable from an outage afterwards.
    if (late > 2 * interval()) {
      record({sessionId: session.id, t: Date.now(), mono: Math.round(now), type: 'pause',
              lat: position().lat, lon: position().lon, text: `${(late / 1000).toFixed(1)}s bridged`});
      due = now;
    }

    due += interval();
    timer = setTimeout(tick, Math.max(0, due - mono()));

    if (inFlight) {
      // The previous round had not returned when this one came due. At a 2s interval with a
      // 4s timeout that is itself a signal, so it is written down rather than passed over.
      keep(baseRow(late, 'overlap'));
      return;
    }
    current = measure(late);
  }

  async function acquireWakeLock() {
    try {
      if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      onNotice?.('Screen cannot be kept awake; set auto-lock to a longer interval.');
    }
  }

  function startGeolocation() {
    if (!navigator.geolocation) { posError = 'unavailable'; return; }
    watchId = navigator.geolocation.watchPosition(
      p => { lastPos = p; posError = null; emit(); },
      e => {
        posError = e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable';
        onNotice?.(`No location (${posError}). Measurement continues without coordinates.`);
        emit();
      },
      {enableHighAccuracy: true, maximumAge: 2000, timeout: 8000}
    );
  }

  // `monoBase` continues the monotonic clock across a reload: performance.now() restarts,
  // so the gap is bridged with the wall clock. Both columns are in the data, which is what
  // makes the bridge checkable rather than a silent fudge.
  async function start(s, {resumeSeq = 0, monoBase = 0, resumedGapMs = 0} = {}) {
    session = s;
    seq = resumeSeq;
    running = true;
    t0 = performance.now() - monoBase;
    due = monoBase;
    cleanStreak = 0;
    bytes = 0;
    inFlight = false;
    abort = new AbortController();
    store.setActive(session.id);
    startGeolocation();
    await acquireWakeLock();
    if (resumedGapMs) {
      record({sessionId: session.id, t: Date.now(), mono: Math.round(monoBase), type: 'pause',
              lat: null, lon: null, text: `${(resumedGapMs / 1000).toFixed(1)}s bridged across reload`});
    }
    tick();
    emit();
  }

  async function stop() {
    running = false;
    clearTimeout(timer);
    timer = null;
    abort?.abort();
    // The aborted round still resolves into a row; wait for it before draining the buffer.
    if (current) { try { await current; } catch { /* recorded as round_error */ } }
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    if (wakeLock) { try { await wakeLock.release(); } catch { /* already gone */ } wakeLock = null; }

    session.stopped = Date.now();
    // Retry the buffer a few times before giving up, so a transient write error does not
    // end the session with rounds stranded in memory.
    for (let i = 0; i < 3 && (pendingSamples.length || pendingEvents.length); i++) await flush();
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
    if (document.visibilityState === 'visible' && running && !wakeLock) acquireWakeLock();
  });

  return {start, stop, mark, note, status, flush};
}
