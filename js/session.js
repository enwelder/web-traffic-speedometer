// The round loop. Every scheduled round produces a row, including the ones that failed and
// the ones that could not run at all — a failed attempt is the measurement, and must never
// be represented by a missing row.

import {PROBES, runRound, checkIpv4, clearTimings, timeoutFor,
        STUCK_AFTER, STUCK_COOLDOWN, DEFAULT_DOWN_BUDGET_MS,
        DEFAULT_DOWN_MAX_BYTES} from './probe.js';
import {gradeRound} from './grade.js';
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

export const APP_VERSION = '3.3.0';

// Two profiles instead of loose settings. The download is the only probe that measures
// throughput rather than reachability, so it runs every round and the interval carries the
// cost instead.
export const PROFILES = {
  fine:   {label: 'Fine — every 15 s',   intervalMs: 15000},
  coarse: {label: 'Coarse — every 30 s', intervalMs: 30000}
};

export const DOWNLOAD_DEFAULTS = {
  budgetMs: DEFAULT_DOWN_BUDGET_MS,
  maxBytes: DEFAULT_DOWN_MAX_BYTES
};

const EARTH_M = 6371000;
// Above this a fix is a cell-tower estimate, not a position. Deriving a speed from one
// produced 682 km/h on a train: two coarse fixes hundreds of metres apart in opposite
// directions look like motion. iOS reports exactly 1414 m for that class of fix.
const FINE_ACCURACY_M = 100;
// 400 km/h. Above a Thalys at full speed, and far above anything on this route.
const MAX_PLAUSIBLE_MS = 111;
// The failures that a fresh connection could plausibly fix.
const WEDGE_FAILS = new Set(['timeout', 'network', 'stalled']);
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

// The download is time-boxed, so what it pulls depends on the link. The projection assumes
// it reaches its byte ceiling every round, which is what happens on anything fast — the
// worst case, and the one worth showing before pressing Start.
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
    // Absent in Safari on every platform; recorded anyway so a browser that gains it contributes for free.
    network_information: c ? {type: c.type, effectiveType: c.effectiveType, downlink: c.downlink, rtt: c.rtt} : null
  };
}

// What a round is estimated to have cost. `contacted` carries across rounds: the first
// request to a host pays for a handshake, later ones do not.
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

// A resumed session has already spent whatever the rows on disk describe. Without this the
// on-screen total restarted at zero after a reload, understating a run whose only limit is
// the person watching that number.
export function spentSoFar(samples) {
  const contacted = new Set();
  let bytes = 0, downloadBytes = 0;
  for (const row of samples) {
    bytes += roundBytes(row, contacted);
    downloadBytes += row.probes?.down?.bytes || 0;
  }
  return {bytes, downloadBytes};
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
  let wakeLockPending = false;
  let egressIp = null;
  let fineFix = null;
  const consecutiveFails = {};
  const restingUntil = {};
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

  // The in-flight promise, not a boolean: a caller that returned early because a flush was
  // running had no way to wait for it, so stop()'s retries all returned immediately and the
  // final rounds were left in memory — missing from an export taken straight afterwards.
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
      // Rows stay in the buffer and are retried next round; nothing is discarded.
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

    // Only a pair of fine fixes can produce a speed. A coarse one anywhere in the pair makes
    // the distance meaningless, so nothing is reported rather than something invented.
    let derived = null;
    if (fine && prevFix?.fine && fix.t > prevFix.t) {
      const seconds = (fix.t - prevFix.t) / 1000;
      // Two fixes at the same place seconds apart give a meaningless rate; a gap of minutes
      // averages away everything that happened between them.
      if (seconds >= 1 && seconds <= 120) {
        const rate = metresBetween(prevFix, fix) / seconds;
        // Two fixes can both be accurate to 10 m and still be hundreds of metres apart if
        // one of them is wrong. Nothing on this route travels faster than a Thalys, so a
        // rate above that describes a bad fix, not motion. The coordinates stay on both
        // rows either way, so the analysis can derive it differently.
        derived = rate <= MAX_PLAUSIBLE_MS ? rate : null;
      }
    }
    if (!prevFix || fix.t !== prevFix.t) prevFix = fix;

    const measured = c.speed == null || c.speed < 0 ? null : c.speed;
    return {
      lat: fix.lat, lon: fix.lon,
      accuracy,
      // gps: good enough to place and to derive from. coarse: a tower estimate, usable as a
      // rough location but not for speed or distance. Consumers filter on this rather than
      // reimplementing the threshold.
      accuracy_class: accuracy == null ? null : fine ? 'gps' : 'coarse',
      speed: measured,
      speed_derived: derived == null ? null : Math.round(derived * 100) / 100,
      speed_source: measured != null ? 'gps' : derived != null ? 'derived' : null,
      heading: c.heading == null || c.heading < 0 ? null : c.heading,
      // The fix's own timestamp, not the round's: a 30s-old fix on a 140 km/h train is
      // more than a kilometre out, and without this the error is invisible.
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
  // The operator label is typed in and the egress address is not, so a change of address
  // under an unchanged label is the one place the session says it is not what it claims —
  // a hotspot picked up mid-journey, or a handover onto a different core network.
  function noteEgressChange(row) {
    const seen = PROBES.map(p => row.probes[p.id]?.egress_ip).find(Boolean);
    if (!seen) return;
    if (!egressIp) { egressIp = seen; return; }
    if (seen === egressIp) return;
    noteEvent('egress address changed');
    egressIp = seen;
  }

  function updateStuck(row) {
    // "While its peers succeed" has to mean most of them: one probe answering is not evidence
    // that six separate connections have each wedged, and treating an outage that way rested
    // every probe at once — the readout went blank exactly when the network was worst.
    const healthy = PROBES.filter(p => row.probes[p.id]?.ok).length;
    const isolated = healthy > PROBES.length / 2;
    for (const p of PROBES) {
      const r = row.probes[p.id];
      if (!r || r.fail === 'resting') continue;
      if (r.ok) { consecutiveFails[p.id] = 0; delete restingUntil[p.id]; continue; }
      if (r.expected) continue;
      // Only a failure resting could actually fix. A parse failure means the connection
      // worked and delivered a body — a captive portal answering for Cloudflare — and an
      // HTTP status means the server replied; standing the probe down for six rounds hides
      // the very thing it just found and cannot repair either one.
      if (!WEDGE_FAILS.has(r.fail)) { consecutiveFails[p.id] = 0; continue; }
      const n = consecutiveFails[p.id] = (consecutiveFails[p.id] || 0) + 1;
      if (isolated && n >= STUCK_AFTER && restingUntil[p.id] == null) {
        r.stuck = true;
        // seq has already been advanced by baseRow, so this row's own number is seq - 1.
        restingUntil[p.id] = (seq - 1) + STUCK_COOLDOWN + 1;
        consecutiveFails[p.id] = 0;
        onNotice?.(`${p.id} has failed ${n} rounds while the others answer; ` +
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
        download: session.download || DOWNLOAD_DEFAULTS,
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
    downloadBytesUsed += row.probes.down?.bytes || 0;

    // The radio has to wake before anything answers; the quickest first response in the
    // round is the closest measure of that cost. Reported, never graded.
    // connect_ms is zero both for a reused connection and when timing is unreadable, which
    // made this report 0 ms on most rounds. Only real first responses count.
    const firsts = [row.probes.ip6?.ms_samples?.[0], row.probes.web?.ms_samples?.[0],
                    row.probes.dns_ctl?.ms_samples?.[0], row.probes.udp?.ms_samples?.[0]]
                   .filter(v => v != null && v > 0);
    row.first_packet_ms = firsts.length ? Math.min(...firsts) : null;

    // Resolved here, once, so the file says what was shown and the screen does not
    // recompute a second opinion from the same rows.
    row.grades = gradeRound(row);
    lastGrades = row.grades;

    // A radio still waking at session start can refuse the preflight. One success overturns
    // the verdict rather than leaving the probe exempt for the whole journey.
    if (session.ipv4_available === false && row.probes.ip4?.ok) {
      session.ipv4_available = true;
      noteEvent('IPv4 available after all; the preflight caught a sleeping radio');
      store.putSession(session);
    }

    noteEgressChange(row);
    updateStuck(row);
    charge(row);
    clearTimings();
    if (row.probes.down?.ok) throughput = row.probes.down.bps_steady;
    if (row.probes.udp) udpMs = row.probes.udp.ok ? row.probes.udp.ms : null;

    keep(row);
  }

  function tick() {
    if (!running) return;
    const now = mono();
    // Timer rounding can put a tick a hair early; lateness is never negative.
    const late = Math.max(0, Math.round(now - due));

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
    if (!navigator.wakeLock || holdingWakeLock() || wakeLockPending) return;
    if (document.visibilityState !== 'visible') return;
    // Requested from the round loop, from visibilitychange and from the release handler; two
    // concurrent requests orphan a sentinel whose later release logs a loss that never was.
    wakeLockPending = true;
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
    } finally {
      wakeLockPending = false;
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
        // Location quality changes mid-journey — a tunnel, or the platform falling back to
        // towers — and it changes what the coordinates are worth. Logged the way a wake lock
        // change is, so a stretch of unusable positions explains itself.
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
      // maximumAge 0: a cached fix is often the coarse one the platform kept from before,
      // and reusing it is how a journey ends up with half its rounds at tower accuracy.
      {enableHighAccuracy: true, maximumAge: 0, timeout: 12000}
    );
  }

  // `monoBase` continues the monotonic clock across a reload: performance.now() restarts,
  // so the gap is bridged with the wall clock. Both columns are in the data, which is what
  // makes the bridge checkable rather than a silent fudge.
  async function start(s, {resumeSeq = 0, monoBase = 0, resumedGapMs = 0, spent = null} = {}) {
    session = s;
    seq = resumeSeq;
    running = true;
    // One recorder lives for the page, so everything scoped to a session has to be cleared
    // when a new one starts. A rest scheduled by seq in the previous session otherwise
    // silenced a probe for the whole of the next one.
    if (!resumeSeq) {
      for (const k of Object.keys(consecutiveFails)) delete consecutiveFails[k];
      for (const k of Object.keys(restingUntil)) delete restingUntil[k];
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
    // Set after the preflight and the wake lock, or the first row reports the start-up time
    // as scheduling lateness — and a slow radio at start would log a pause that never happened.
    due = mono();
    tick();
    emit();
  }

  async function stop() {
    // Stopping what was never started, or stopping twice: the tab was reloaded mid-session,
    // or two taps landed inside the same await. Neither may throw, and neither may stamp a
    // second end time on a journey that already has one.
    if (!session) return null;
    if (!running && session.stopped) return session;
    running = false;
    clearTimeout(timer);
    timer = null;
    abort?.abort();
    // The aborted round still resolves into a row; wait for it before draining the buffer.
    if (current) { try { await current; } catch { /* recorded as round_error */ } }
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    if (wakeLock) { try { await wakeLock.release(); } catch { /* already gone */ } wakeLock = null; }

    session.stopped = Date.now();
    // Drain rather than fire and hope: each pass now waits for any flush already running, so
    // a row written during one is picked up by the next.
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

  // What the connection felt like, from the person using it. The probes cannot see this,
  // and without it there is nothing to check the thresholds against.
  function label(value) {
    if (!running) return;
    const p = position();
    record({sessionId: session.id, t: Date.now(), mono: Math.round(mono()), type: 'label',
            lat: p.lat, lon: p.lon, text: value});
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

  return {start, stop, mark, note, label, status, flush};
}
