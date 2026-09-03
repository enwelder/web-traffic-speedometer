// The round loop. Every scheduled round produces a row, including the ones that failed and
// the ones that could not run at all — a failed attempt is the measurement, and must never
// be represented by a missing row.

import {PROBES, runRound, checkIpv4, clearTimings, timeoutFor} from './probe.js';
import * as realStore from './store.js';

// Estimates. Safari opens a fresh connection per request rather than reusing one, so every
// repeat contact is charged a resumed TLS handshake; only the first contact with an origin
// pays a full one.
const FIRST_CONTACT_BYTES = 5000;
const RESUMED_BYTES = 1500;
const WARM_BYTES = {trace: 420, opaque: 220, download: 400};
const REFUSED_BYTES = 100;      // an IPv4 literal with no path never gets a connection up

export const APP_VERSION = '1.0.0';

export function projectedBytes(intervalMs, downloadBytes, minutes = 40) {
  const rounds = Math.round((minutes * 60000) / intervalMs);
  const perRound = PROBES.reduce((n, p) => n + WARM_BYTES[p.kind] + RESUMED_BYTES, 0) + downloadBytes;
  return rounds * perRound;
}

export function environment(intervalMs, downloadBytes) {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return {
    app_version: APP_VERSION,
    user_agent: navigator.userAgent,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    interval_ms: intervalMs,
    download_bytes: downloadBytes,
    timeouts_ms: Object.fromEntries(PROBES.map(p => [p.id, timeoutFor(p, intervalMs)])),
    probes: PROBES.map(p => ({id: p.id, url: p.url, kind: p.kind,
                              mode: p.kind === 'opaque' ? 'no-cors' : 'cors',
                              method: p.method || 'GET'})),
    // Absent in Safari on every platform; recorded anyway so a browser that gains it contributes for free.
    network_information: c ? {type: c.type, effectiveType: c.effectiveType, downlink: c.downlink, rtt: c.rtt} : null
  };
}

// `store` is injectable so the round loop can be exercised against a fake one; everything
// else defaults to the real module.
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
  let wakeLock = null;
  let lastPos = null;
  let posError = null;
  let lastEgress = null;
  let throughput = null;
  let flushing = false;
  let writeFailed = false;
  let current = null;

  const contacted = new Set();
  const pendingSamples = [];
  const pendingEvents = [];

  const mono = () => performance.now() - t0;
  const interval = () => session.intervalMs;

  function status() {
    return {
      running, session, seq, marks, bytes, throughput,
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
      if (!r) continue;
      if (r.expected && !r.ok) { bytes += REFUSED_BYTES; continue; }
      bytes += WARM_BYTES[p.kind] + (p.kind === 'download' ? r.bytes || 0 : 0);
      bytes += contacted.has(p.id) ? RESUMED_BYTES : FIRST_CONTACT_BYTES;
      contacted.add(p.id);
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
      // iOS suspends a hidden tab; a column is easier to filter on than pause events alone
      visible: document.visibilityState === 'visible',
      intervalMs: interval(),
      ...position(),
      probes: {}
    };
  }

  async function measure(late) {
    inFlight = true;
    const row = baseRow(late, null);
    try {
      row.probes = await runRound({
        signal: abort.signal,
        downloadBytes: session.downloadBytes,
        intervalMs: interval(),
        ipv4Available: session.ipv4_available
      });
    } catch (e) {
      row.round_error = String(e && e.message || e);
      for (const p of PROBES) {
        if (!row.probes[p.id]) row.probes[p.id] = {ok: false, ms: null, status: null, fail: 'network'};
      }
    } finally {
      inFlight = false;
    }

    charge(row);
    clearTimings();
    if (row.probes.down?.ok) throughput = row.probes.down.bps_transfer;

    const egress = row.probes.ip6.egress_ip || row.probes.down?.egress_ip;
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
      const p = position();
      record({sessionId: session.id, t: Date.now(), mono: Math.round(now), type: 'pause',
              lat: p.lat, lon: p.lon, text: `${(late / 1000).toFixed(1)}s bridged`});
      due = now;
    }

    due += interval();
    timer = setTimeout(tick, Math.max(0, due - mono()));

    if (inFlight) {
      // The previous round had not returned when this one came due. At a short interval
      // that is itself a signal, so it is written down rather than passed over.
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
    bytes = 0;
    throughput = null;
    inFlight = false;
    contacted.clear();
    abort = new AbortController();
    store.setActive(session.id);
    clearTimings();
    startGeolocation();
    await acquireWakeLock();

    // Established once, so an IPv6-only network does not spend the whole session reporting
    // the same absent path as though each round were news.
    if (session.ipv4_available == null) {
      const v4 = await checkIpv4(abort.signal);
      session.ipv4_available = v4.available;
      session.ipv4_check = v4;
      await store.putSession(session);
      if (!v4.available) onNotice?.(`No IPv4 path (${v4.fail} in ${v4.ms} ms). IPv4 probe failures are expected and not counted.`);
    }

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
