// The round loop. Every scheduled round produces a row, including the ones that failed and
// the ones that could not run at all — a failed attempt is the measurement, and must never
// be represented by a missing row.

import {PROBES, runRound, checkIpv4, clearTimings, timeoutFor,
        STUCK_AFTER, STUCK_COOLDOWN, DEFAULT_DOWNLOAD_BYTES} from './probe.js';
import * as realStore from './store.js';

// Estimates. Safari opens a fresh connection per request rather than reusing one, so every
// repeat contact is charged a resumed TLS handshake; only the first contact with an origin
// pays a full one.
const FIRST_CONTACT_BYTES = 5000;
const RESUMED_BYTES = 1500;
const WARM_BYTES = {trace: 420, opaque: 220, download: 400, stun: 400};
const REFUSED_BYTES = 100;      // an IPv4 literal with no path never gets a connection up
// STUN is UDP: there is no handshake to charge, and no connection to resume.
const cost = p => (WARM_BYTES[p.kind] * (p.samples || 1)) + (p.kind === 'stun' ? 0 : RESUMED_BYTES);

export const APP_VERSION = '2.3.0';

// Two profiles instead of loose settings. The download is the only probe that measures
// throughput rather than reachability, so it runs every round and the interval carries the
// cost instead.
export const PROFILES = {
  fine:   {label: 'Fine — every 15 s',  intervalMs: 15000, downloadBytes: DEFAULT_DOWNLOAD_BYTES},
  coarse: {label: 'Coarse — every 30 s', intervalMs: 30000, downloadBytes: DEFAULT_DOWNLOAD_BYTES}
};

const EARTH_M = 6371000;
// Haversine. iOS fills coords.speed only sporadically — three journeys returned it on 0,
// 2 and 51 of 158, 75 and 243 rounds — so it is derived from consecutive fixes instead,
// with the measured value kept whenever the platform does supply one.
function metresBetween(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function projectedBytes(intervalMs, downloadBytes, minutes = 40) {
  const rounds = Math.round((minutes * 60000) / intervalMs);
  return rounds * (PROBES.reduce((n, p) => n + cost(p), 0) + downloadBytes);
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
                              method: p.method || 'GET', samples: p.samples || 1})),
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
  let prevFix = null;
  let inPause = false;
  let lastRoundMs = null;
  let lastSpeed = null;
  let lastSpeedSource = null;
  let wakeLockLost = false;
  const consecutiveFails = {};
  const restingUntil = {};
  let lastEgress = null;
  let throughput = null;
  let udpMs = null;
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
      running, session, seq, marks, bytes, throughput, udpMs,
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
    if (!lastPos) {
      return {lat: null, lon: null, accuracy: null, speed: null, speed_derived: null,
              speed_source: null, heading: null, pos_t: null, pos_error: posError};
    }
    const c = lastPos.coords;
    const fix = {lat: c.latitude, lon: c.longitude, t: lastPos.timestamp};

    let derived = null;
    if (prevFix && fix.t > prevFix.t) {
      const seconds = (fix.t - prevFix.t) / 1000;
      // Two fixes at the same place seconds apart give a meaningless rate; a gap of minutes
      // averages away everything that happened between them.
      if (seconds >= 1 && seconds <= 120) derived = metresBetween(prevFix, fix) / seconds;
    }
    if (!prevFix || fix.t !== prevFix.t) prevFix = fix;

    const measured = c.speed == null || c.speed < 0 ? null : c.speed;
    return {
      lat: fix.lat, lon: fix.lon,
      accuracy: c.accuracy == null ? null : Math.round(c.accuracy),
      speed: measured,
      speed_derived: derived == null ? null : Math.round(derived * 100) / 100,
      speed_source: measured != null ? 'gps' : derived != null ? 'derived' : null,
      heading: c.heading == null ? null : c.heading,
      // The fix's own timestamp, not the round's: a 30s-old fix on a 140 km/h train is
      // more than a kilometre out, and without this the error is invisible.
      pos_t: fix.t,
      pos_error: posError
    };
  }

  function charge(row) {
    for (const p of PROBES) {
      const r = row.probes[p.id];
      if (!r) continue;
      if (r.expected && !r.ok) { bytes += REFUSED_BYTES; continue; }
      const attempts = r.ms_samples ? r.ms_samples.length : 1;
      bytes += WARM_BYTES[p.kind] * attempts + (p.kind === 'download' ? r.bytes || 0 : 0);
      if (p.kind !== 'stun') {
        bytes += contacted.has(p.id) ? RESUMED_BYTES : FIRST_CONTACT_BYTES;
        contacted.add(p.id);
      }
    }
  }

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
      // iOS suspends a hidden tab; a column is easier to filter on than pause events alone
      visible: document.visibilityState === 'visible',
      // Set on the round that follows a bridged gap, so those rows can be filtered out
      // without matching timestamps against the event list afterwards.
      in_pause: inPause,
      // Whether the screen was being held awake for this round. A journey where this goes
      // false explains its own gaps.
      wake_lock: holdingWakeLock(),
      // The wall time the previous round actually took. A frozen tab suspends the abort
      // timer too, so a round can outlast every deadline in it; without this an overlap is
      // indistinguishable from the app stalling.
      prev_round_ms: lastRoundMs,
      intervalMs: interval(),
      ...pos,
      probes: {}
    };
  }

  // A probe that keeps failing while its peers succeed is not reporting the network: its
  // connection has wedged. Journey data showed the control probe timing out for twenty
  // consecutive rounds after an outage, alone, while every other probe recovered within one.
  function updateStuck(row) {
    const anyOk = PROBES.some(p => row.probes[p.id]?.ok);
    for (const p of PROBES) {
      const r = row.probes[p.id];
      if (!r || r.fail === 'resting') continue;
      if (r.ok) { consecutiveFails[p.id] = 0; delete restingUntil[p.id]; continue; }
      if (r.expected) continue;
      consecutiveFails[p.id] = (consecutiveFails[p.id] || 0) + 1;
      if (anyOk && consecutiveFails[p.id] >= STUCK_AFTER && restingUntil[p.id] == null) {
        r.stuck = true;
        restingUntil[p.id] = seq + STUCK_COOLDOWN;
        onNotice?.(`${p.id} has failed ${consecutiveFails[p.id]} rounds while the others answer; ` +
                   `resting it for ${STUCK_COOLDOWN} rounds to clear the connection.`);
      }
    }
  }

  function resting() {
    const out = new Set();
    for (const [id, until] of Object.entries(restingUntil)) {
      if (seq < until) out.add(id);
      else delete restingUntil[id];
    }
    return out;
  }

  async function measure(late) {
    inFlight = true;
    const startedAt = mono();
    const row = baseRow(late, null);
    inPause = false;
    try {
      row.probes = await runRound({
        signal: abort.signal,
        downloadBytes: session.downloadBytes,
        intervalMs: interval(),
        ipv4Available: session.ipv4_available,
        resting: resting()
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

    if (!holdingWakeLock()) acquireWakeLock();
    updateStuck(row);
    charge(row);
    clearTimings();
    if (row.probes.down?.ok) throughput = row.probes.down.bps_transfer;
    if (row.probes.udp) udpMs = row.probes.udp.ok ? row.probes.udp.ms : null;

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
    // explicitly is the only way it stays distinguishable from an outage afterwards. A whole
    // missed slot is already a freeze worth recording; a threshold of two slots let a 13.7 s
    // delay at a 10 s interval pass unlogged.
    if (late >= interval()) {
      const p = position();
      inPause = true;
      record({sessionId: session.id, t: Date.now(), mono: Math.round(now), type: 'pause',
              lat: p.lat, lon: p.lon, text: `${(late / 1000).toFixed(1)}s bridged`});
    }

    // Scheduled from when this round actually fired, not from a fixed grid. On a grid, any
    // lateness pulls the next slot closer — after a 13.7 s delay at a 10 s interval the next
    // tick fired 11 ms later and collided with the round still running. Rounds are worth
    // 250 kB each, so two of them moments apart measure the same instant twice and risk an
    // overlap; even spacing matters here and grid phase does not.
    due = now + interval();
    timer = setTimeout(tick, Math.max(0, due - mono()));

    if (inFlight) {
      // The previous round had not returned when this one came due. At a short interval
      // that is itself a signal, so it is written down rather than passed over.
      keep(baseRow(late, 'overlap'));
      return;
    }
    current = measure(late);
  }

  // The system takes the wake lock back for its own reasons — Low Power Mode engaging, a
  // call arriving, the screen locking — and does so without the page ever becoming hidden.
  // The sentinel then stays non-null with `released` set, so anything guarding on the
  // variable alone silently stops re-acquiring and the screen sleeps for the rest of the
  // journey. Both the release event and the released flag are therefore honoured.
  const holdingWakeLock = () => !!wakeLock && !wakeLock.released;

  async function acquireWakeLock() {
    if (!navigator.wakeLock || holdingWakeLock()) return;
    if (document.visibilityState !== 'visible') return;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      wakeLock = sentinel;
      sentinel.addEventListener('release', () => onWakeLockRelease(sentinel), {once: true});
      if (wakeLockLost) {
        wakeLockLost = false;
        onNotice?.('');
        if (running) noteEvent('screen stays awake again');
      }
    } catch (e) {
      wakeLock = null;
      if (!wakeLockLost) {
        wakeLockLost = true;
        onNotice?.('The screen will not stay awake. Set auto-lock longer, or turn off Low Power Mode.');
        if (running) noteEvent(`screen wake lock refused (${e && e.name || 'unknown'})`);
      }
    }
  }

  function onWakeLockRelease(sentinel) {
    if (wakeLock === sentinel) wakeLock = null;
    if (!running) return;
    wakeLockLost = true;
    onNotice?.('The screen lock was released. Reacquiring — if it keeps happening, check Low Power Mode.');
    noteEvent('screen wake lock released');
    acquireWakeLock();
  }

  function noteEvent(text) {
    const p = position();
    record({sessionId: session.id, t: Date.now(), mono: Math.round(mono()), type: 'note',
            lat: p.lat, lon: p.lon, text});
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
    udpMs = null;
    wakeLockLost = false;
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
      // Recorded once in the log and on the session; the lamps carry it from then on.
      record({sessionId: session.id, t: Date.now(), mono: Math.round(mono()), type: 'note',
              lat: null, lon: null,
              text: `IPv4 ${v4.available ? 'available' : `absent (${v4.fail} in ${v4.ms} ms)`}`});
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
    if (document.visibilityState === 'visible' && running) acquireWakeLock();
  });

  return {start, stop, mark, note, status, flush};
}
