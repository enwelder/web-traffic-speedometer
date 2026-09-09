// The round loop. Every scheduled round produces a row, including rounds that failed and
// rounds that could not run: a failed attempt is a measurement, so it is never left out.

import {PROBES, runRound, checkIpv4, clearTimings, timeoutFor,
        DEFAULT_DOWN_BUDGET_MS, DOWN_MAX_BYTES,
        WARMUP_REQUEST_BYTES} from './probe.js';
import {gradeRound, gradeProbes} from './grade.js';
import {createStuckTracker} from './stuck.js';
import {createWakeLock} from './wakelock.js';
import {createPositionTracker} from './position.js';
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

export const APP_VERSION = '3.6.0';

// The download runs every round, so the interval is what controls data use.
export const PROFILES = {
  fine:   {label: 'Fine — every 15 s',   intervalMs: 15000},
  coarse: {label: 'Coarse — every 30 s', intervalMs: 30000}
};

export const DOWNLOAD_DEFAULTS = {
  budgetMs: DEFAULT_DOWN_BUDGET_MS,
  maxBytes: DOWN_MAX_BYTES
};


// The download costs its full size only on a link quick enough to deliver it inside the
// budget; a slow one transfers less. This is therefore the worst case, and what a fast link
// actually does.
export function projectedBytes(intervalMs, settings = DOWNLOAD_DEFAULTS, minutes = 40) {
  const rounds = Math.round((minutes * 60000) / intervalMs);
  const small = PROBES.reduce((n, p) => n + cost(p), 0);
  // Both download requests: the one that opens the connection and the one measured over it.
  // The measured one is sized from the link, so this is the ceiling a fast one reaches.
  return rounds * (small + WARMUP_REQUEST_BYTES + settings.maxBytes);
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
    probes: PROBES.map(p => ({id: p.id, label: p.label, url: p.url, kind: p.kind,
                              mode: p.kind === 'opaque' ? 'no-cors' : 'cors',
                              method: p.method || 'GET', samples: p.samples || 1})),
    // Absent in Safari on every platform; recorded for browsers that have it.
    network_information: c ? {type: c.type, effectiveType: c.effectiveType, downlink: c.downlink, rtt: c.rtt} : null
  };
}

// What one probe is estimated to have cost. `contacted` is updated as it is read: only the
// first request to a host is charged a full handshake.
function probeBytes(probe, r, contacted) {
  if (!r) return 0;
  // An IPv4 literal with no path never gets a connection up.
  if (r.expected && !r.ok) return REFUSED_BYTES;
  if (r.fail === 'resting') return 0;
  const attempts = r.ms_samples ? r.ms_samples.length : 1;
  let n = WARM_BYTES[probe.kind] * attempts + (probe.kind === 'download' ? r.bytes || 0 : 0);
  if (probe.kind !== 'stun') {
    n += contacted.has(probe.id) ? RESUMED_BYTES : FIRST_CONTACT_BYTES;
    contacted.add(probe.id);
  }
  return n;
}

// `contacted` carries across rounds, so a session's handshakes are charged once each.
function roundBytes(row, contacted) {
  return PROBES.reduce((n, p) => n + probeBytes(p, row.probes?.[p.id], contacted), 0);
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
  let inPause = false;
  let lastRoundMs = null;
  let lastSpeed = null;
  let lastSpeedSource = null;
  let egressIp = null;
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
  const position = createPositionTracker({onNotice, onChange: () => emit(),
                                          onNote: text => running && noteEvent(text)});

  const mono = () => performance.now() - t0;
  const interval = () => session.intervalMs;

  function status() {
    const fix = position.snapshot();
    return {
      running, session, seq, marks, bytes, throughput, udpMs, grades: lastGrades,
      downloadMB: Math.round(downloadBytesUsed / 1e5) / 10,
      speedKmh: lastSpeed == null ? null : Math.round(lastSpeed * 3.6),
      speedSource: lastSpeedSource,
      pending: pendingSamples.length + pendingEvents.length,
      writeFailed, pos: fix.pos, posError: fix.error,
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

  function charge(row) { bytes += roundBytes(row, contacted); }

  function keep(row) {
    pendingSamples.push(row);
    onSample?.(row);
    flush();
  }

  function baseRow(late, skipped) {
    const pos = position.read();
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
    row.pgrades = gradeProbes(row);
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
    if (row.probes.down?.ok) throughput = row.probes.down.bps_min;
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
      const p = position.read();
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
    const p = position.read();
    record({sessionId: session.id, t: Date.now(), mono: Math.round(mono()), type,
            lat: p.lat, lon: p.lon, text});
  }

  const noteEvent = text => event('note', text);

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
      position.reset();
      egressIp = null;
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
    position.start();
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
    position.stop();
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
    const p = position.read();
    record({sessionId: session.id, t: Date.now(), mono: Math.round(mono()), type: 'mark',
            lat: p.lat, lon: p.lon, text: `mark ${marks}`});
    emit();
  }

  function note(text) {
    if (!running || !text) return;
    const p = position.read();
    record({sessionId: session.id, t: Date.now(), mono: Math.round(mono()), type: 'note',
            lat: p.lat, lon: p.lon, text});
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && running) wake.acquire();
  });

  return {start, stop, mark, note, status, flush};
}
