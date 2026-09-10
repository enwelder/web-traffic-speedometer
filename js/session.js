// The round loop. Every round that runs produces a row, failed ones included: a failed attempt
// is a measurement. A slot that comes due while a round is still running is a `skip` event.

import {PROBES, runRound, checkPaths, clearTimings, timeoutFor, relayAbort,
        DOWN_STREAMS, DOWN_WINDOW_MS, DOWN_CAP_BYTES, DOWN_CEILING_BPS,
        DOWN_RAMP_BYTES} from './probe.js';
import {gradeActivities, gradeProbes, roundTripFailed} from './grade.js';
import {createStuckTracker} from './stuck.js';
import {createWakeLock} from './wakelock.js';
import {createPositionTracker} from './position.js';
import * as realStore from './store.js';

const PATHS = [['ip6', 'ipv6_available', 'IPv6'], ['ip4', 'ipv4_available', 'IPv4']];
const LITERAL_IPS = {ip6: '2606:4700:4700::1111', ip4: '1.1.1.1'};

// Byte estimates for the data-used figure at the browser worst case: Safari opens a connection
// per request, so each sample is charged a handshake, full on first contact with an origin and
// resumed after. Each sample of a `fresh` probe reaches an uncontacted host and pays a full one.
const FIRST_CONTACT_BYTES = 5000;
const RESUMED_BYTES = 1500;
const WARM_BYTES = {trace: 420, opaque: 220, download: 400, upload: 400, stun: 400};
const REFUSED_BYTES = 100;      // an IPv4 literal with no path never gets a connection up
// STUN is UDP: no handshake to charge and no connection to resume.
const handshakes = (probe, attempts, first) =>
  probe.kind === 'stun' ? 0
  : probe.fresh ? FIRST_CONTACT_BYTES * attempts
  : (first ? FIRST_CONTACT_BYTES : RESUMED_BYTES) + RESUMED_BYTES * (attempts - 1);
// The projection is steady state: by the second round every origin has been contacted.
const cost = p => (WARM_BYTES[p.kind] * (p.samples || 1)) + handshakes(p, p.samples || 1, false) +
                  (p.bodyBytes || 0);

export const APP_VERSION = '3.14.0';

// The download runs every round, so the interval is what controls data use.
export const PROFILES = {
  fine:   {label: 'Fine — every 15 s',   intervalMs: 15000},
  coarse: {label: 'Coarse — every 30 s', intervalMs: 30000}
};

// Download settings, copied into every export so each file carries its saturation point.
export const DOWNLOAD_DEFAULTS = {
  streams: DOWN_STREAMS,
  windowMs: DOWN_WINDOW_MS,
  capBytes: DOWN_CAP_BYTES,
  ceilingBps: DOWN_CEILING_BPS
};


// Worst-case data cost: ramp plus capped window per round. A link below the ceiling costs
// proportionally less.
export function projectedBytes(intervalMs, settings = DOWNLOAD_DEFAULTS, minutes = 40) {
  const rounds = Math.round((minutes * 60000) / intervalMs);
  const small = PROBES.reduce((n, p) => n + cost(p), 0);
  return rounds * (small + DOWN_RAMP_BYTES + settings.capBytes);
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
  // An IPv4 literal without a path opens no connection.
  if (r.expected && !r.ok) return REFUSED_BYTES;
  // No request sent: the probe rested, the round threw first, or the round left no budget.
  if (r.fail === 'resting' || r.fail === 'error' || r.fail === 'no_budget') return 0;
  const attempts = r.ms_samples ? r.ms_samples.length : 1;
  // A sent upload body is charged in full, whatever the server confirmed.
  const n = WARM_BYTES[probe.kind] * attempts + (probe.kind === 'download' ? r.bytes || 0 : probe.bodyBytes || 0)
          + handshakes(probe, attempts, !contacted.has(probe.id));
  contacted.add(probe.id);
  return n;
}

// `contacted` carries across rounds, so a session's handshakes are charged once each. The
// reference request runs only in rounds where Cloudflare failed, and is charged a first contact.
function roundBytes(row, contacted) {
  const reference = row.reference && row.reference.fail !== 'abort'
    ? WARM_BYTES.opaque + FIRST_CONTACT_BYTES : 0;
  return reference + PROBES.reduce((n, p) => n + probeBytes(p, row.probes?.[p.id], contacted), 0);
}

// Bytes already charged by the rows on disk, so a resumed session continues its running
// total.
export function spentSoFar(samples) {
  const contacted = new Set();
  let bytes = 0, downloadBytes = 0;
  for (const row of samples) {
    bytes += roundBytes(row, contacted);
    downloadBytes += row.probes?.down?.bytes || 0;
  }
  return {bytes, downloadBytes};
}

const connectionKind = () => {
  const c = navigator.connection;
  return c ? `${c.type ?? '?'} ${c.effectiveType ?? '?'}` : null;
};

// Page lifecycle and network interface events, which account for gaps in probe results.
// `note(type, text)` receives each one.
function watchPage(note) {
  document.addEventListener('visibilitychange', () => note('page', document.visibilityState));
  for (const type of ['freeze', 'resume']) document.addEventListener(type, () => note('page', type));
  for (const type of ['pagehide', 'pageshow']) globalThis.addEventListener?.(type, () => note('page', type));
  for (const type of ['online', 'offline']) globalThis.addEventListener?.(type, () => note('network', type));
  // Chrome revises downlink and rtt estimates continually; only a change of type or class is
  // recorded.
  let last = connectionKind();
  navigator.connection?.addEventListener?.('change', () => {
    const kind = connectionKind();
    if (kind === last) return;
    last = kind;
    const c = navigator.connection;
    note('network', `connection ${kind}, ${c.downlink ?? '?'} Mb/s, ${c.rtt ?? '?'} ms`);
  });
}

// iOS suspends JS while the app is in the background or the screen is locked. A timer that fires
// a second late was held by that suspension. performance.now() stops in device sleep while the
// wall clock continues, so a gap takes the larger of the two clocks.
const WATCH_MS = 250;
const SUSPENDED_GAP_MS = 1000;

// Calls `onGap` for every gap over SUSPENDED_GAP_MS between timer firings. `end` stops the timer
// and returns the largest gap over the threshold, or null.
function watchGaps(onGap) {
  let lastPerf = performance.now();
  let lastWall = Date.now();
  let largest = 0;
  const check = () => {
    const perf = performance.now();
    const wall = Date.now();
    const gap = Math.max(perf - lastPerf, wall - lastWall);
    lastPerf = perf;
    lastWall = wall;
    largest = Math.max(largest, gap);
    if (gap > SUSPENDED_GAP_MS) onGap();
  };
  const timer = setInterval(check, WATCH_MS);
  return {
    check,
    end() {
      clearInterval(timer);
      check();
      return largest > SUSPENDED_GAP_MS ? Math.round(largest) : null;
    }
  };
}

// Fastest first response in the round, an estimate of radio wake-up cost. Zero values are
// excluded: connect_ms is zero for a reused connection and for unreadable timing. A probe without
// a successful sample stopped at its first failure, so its first sample is a time to fail.
function firstPacket(row) {
  const firsts = [row.probes.ip6, row.probes.dns_ctl, row.probes.udp]
                 .filter(r => r?.samples_ok > 0)
                 .map(r => r.ms_samples[0])
                 .filter(v => v != null && v > 0);
  return firsts.length ? Math.min(...firsts) : null;
}

// `store` is injectable so the round loop can run against a fake one.
export function createRecorder({onSample, onEvent, onStatus, onNotice, store = realStore}) {
  let session = null;
  let running = false;
  let timer = null;
  let due = 0;
  // performance.now() stops while an iOS device sleeps and the wall clock continues, so scheduling
  // lateness reads both clocks. Latencies and rates use performance.now() only.
  let dueWall = 0;
  let t0 = 0;
  let seq = 0;
  let inFlight = false;
  let abort = null;
  let bytes = 0;
  let marks = 0;
  let inPause = false;
  // The running round: its number, when it started, and what it has not yet settled.
  let runningSeq = null;
  let runningSince = 0;
  const pending = new Set();
  let lastSpeed = null;
  let lastSpeedSource = null;
  const egressIp = {};
  let throughput = null;
  let udpMs = null;
  let downloadBytesUsed = 0;
  let lastElapsed = 0;
  const said = new Set();
  let lastGrades = null;
  let flushing = null;
  let writeFailed = false;
  let current = null;
  // The round in flight: its abort controller, the cause of an interruption, and its gap watchdog.
  let round = null;
  // The seq of an interrupted round whose absence has no pause event yet.
  let absentRound = null;
  let chained = false;

  const contacted = new Set();
  const pendingSamples = [];
  const pendingEvents = [];
  // Writers share one notice line; each is named so it clears only its own text.
  const noticeFrom = owner => text => onNotice?.(text, owner);
  const storageNotice = noticeFrom('storage');
  const stuck = createStuckTracker({onNotice: noticeFrom('stuck')});
  // The event carries the position and the session id, so it is the recorder's to write.
  const wake = createWakeLock({onNotice: noticeFrom('wake_lock'), onEvent: text => running && noteEvent(text),
                               onRelease: () => interrupt('wake_lock')});
  const position = createPositionTracker({onNotice: noticeFrom('position'), onChange: () => emit(),
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
      // Frozen at stop: a finished session reports its final elapsed time.
      elapsed: running ? (lastElapsed = Math.floor(mono() / 1000)) : lastElapsed
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
      if (writeFailed) { writeFailed = false; storageNotice(''); }
    } catch (e) {
      // Rows stay in the buffer and are retried next round.
      writeFailed = true;
      storageNotice(`Storage write failed (${e.message}). ${pendingSamples.length} rounds held in memory, retrying.`);
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

  function baseRow(late) {
    const pos = position.read();
    lastSpeed = pos.speed ?? pos.speed_derived ?? null;
    lastSpeedSource = pos.speed_source;
    return {
      sessionId: session.id,
      seq: seq++,
      t: Date.now(),
      mono: Math.round(mono()),
      late_ms: late,
      round_error: null,
      // Set when the page left mid-round, `wake_lock` or `suspended`: the row keeps its probes and
      // carries no grades. `suspended_ms` is the largest timer gap the round saw.
      interrupted: null,
      suspended_ms: null,
      // iOS suspends a hidden tab; a column filters more easily than the pause events.
      visible: document.visibilityState === 'visible',
      // Visibility at round end; a tab hidden mid-round cuts probes short.
      visible_end: null,
      // Set on the round following a bridged gap, so those rows can be filtered without
      // matching timestamps against the event list.
      in_pause: inPause,
      // Whether the screen was held awake for this round, which accounts for gaps.
      wake_lock: wake.held(),
      // The round's own wall time and its phases. A frozen tab suspends the abort timers, so a
      // round can outlast every deadline in it; these separate a slow phase from a stalled app.
      round_ms: null,
      phase_idle_ms: null,
      phase_down_ms: null,
      phase_up_ms: null,
      // The Google reference request, taken only when every Cloudflare instrument failed.
      reference: null,
      intervalMs: interval(),
      ...pos,
      probes: {}
    };
  }

  // The operator label is entered and the egress address is measured, so an address change under
  // an unchanged label marks a hotspot or a handover to another core network. Compared per family,
  // since a dual-stack round can report either family first.
  function noteEgressChange(row) {
    for (const r of Object.values(row.probes || {})) {
      if (!r?.egress_ip) continue;
      const family = r.egress_ip.includes(':') ? 'ip6' : 'ip4';
      if (!egressIp[family]) { egressIp[family] = r.egress_ip; continue; }
      if (egressIp[family] === r.egress_ip) continue;
      noteEvent(`egress address changed over ${family === 'ip6' ? 'IPv6' : 'IPv4'}`);
      egressIp[family] = r.egress_ip;
    }
  }

  // A radio still waking at session start can refuse the preflight, so one later success
  // overturns the result.
  function settle(key, label, why) {
    if (session[key] === true) return;
    session[key] = true;
    noteEvent(`${label} ${why}`);
    store.putSession(session);
  }

  // Logged once per session: the cause is constant across rounds, and per-round repeats flood the
  // log.
  function noteOnce(key, text) {
    if (said.has(key)) return;
    said.add(key);
    noteEvent(text);
  }

  // A literal refused while its family carries traffic indicates interception; the notice names
  // the likely causes.
  function noteInterference(row) {
    for (const [id, , label] of PATHS) {
      if (!row.probes[id]?.blocked) continue;
      noteOnce(`blocked-${id}`,
        `${label} literal refused while ${label} carries traffic. ${LITERAL_IPS[id]} is a ` +
        `public resolver address; a VPN, filter or captive portal commonly intercepts it`);
    }
    // Refused or excluded literals leave calls without a round-trip value; a literal that failed on
    // the link grades calls red.
    if (!row.probes.ip6?.ok && !row.probes.ip4?.ok && !roundTripFailed(row.probes)) {
      noteOnce('no-round-trip',
        'no address literal answered, so the round trip has no instrument and calls cannot ' +
        'be graded');
    }
  }

  // The preflight is informational and rounds classify their own literals. A family seen carrying
  // traffic, by its literal or an egress address, is stored as available on the session.
  function revisePaths(row) {
    for (const [id, key, label] of PATHS) {
      if (row.probes[id]?.ok) settle(key, label, 'answered');
    }
    for (const r of Object.values(row.probes || {})) {
      if (!r?.egress_ip) continue;
      const v6 = r.egress_ip.includes(':');
      settle(v6 ? 'ipv6_available' : 'ipv4_available', v6 ? 'IPv6' : 'IPv4',
             'carries traffic; its literal is blocked, not its path');
    }
  }


  // A round the page left mid-way measured the suspension: it keeps its probes and carries no
  // grades. The session abort stays untouched, so the next round runs.
  function interrupt(cause) {
    if (!round || round.interrupted) return;
    round.interrupted = cause;
    absentRound = runningSeq;
    round.ctl.abort();
  }

  // Each round aborts on its own controller, which a stop reaches through the session abort.
  function beginRound() {
    const ctl = new AbortController();
    return {ctl, unlink: relayAbort(abort.signal, ctl), interrupted: null,
            watch: watchGaps(() => interrupt('suspended'))};
  }

  function endRound(row, startedAt) {
    inFlight = false;
    pending.clear();
    // The final gap check runs before the cause is read, so a suspension that ended the round counts.
    row.suspended_ms = round.watch.end();
    row.interrupted = round.interrupted;
    round.unlink();
    round = null;
    row.round_ms = Math.round(mono() - startedAt);
    row.visible_end = document.visibilityState === 'visible';
  }

  // Grades, path notes, the stuck tracker and the readout values come from measured rounds only.
  function settleMeasured(row) {
    // Resolved once and stored on the row, so the file and the screen carry the same grade.
    row.grades = row.round_error ? null : gradeActivities(row);
    row.pgrades = gradeProbes(row);
    lastGrades = row.grades;
    revisePaths(row);
    noteInterference(row);
    noteEgressChange(row);
    stuck.note(row, seq);
    if (row.probes.down?.ok) throughput = row.probes.down.bps;
    if (row.probes.udp) udpMs = row.probes.udp.ok ? row.probes.udp.ms : null;
  }

  async function measure(late) {
    inFlight = true;
    const startedAt = mono();
    const row = baseRow(late);
    runningSeq = row.seq;
    runningSince = startedAt;
    inPause = false;
    absentRound = null;
    round = beginRound();
    try {
      const measured = await runRound({
        signal: round.ctl.signal,
        download: session.download || DOWNLOAD_DEFAULTS,
        intervalMs: interval(),
        resting: stuck.resting(seq),
        pending
      });
      row.probes = measured.probes;
      row.loaded_rtt_ms = measured.loaded_rtt_ms;
      row.loaded_rtt_from = measured.loaded_rtt_from;
      row.phase_idle_ms = measured.phase_idle_ms;
      row.phase_down_ms = measured.phase_down_ms;
      row.phase_up_ms = measured.phase_up_ms;
      row.reference = measured.reference;
    } catch (e) {
      // The round threw before measuring. 'error' excludes it from network tallies and the wedge
      // count; its grades stay null.
      row.round_error = String(e && e.message || e);
      for (const p of PROBES) {
        if (!row.probes[p.id]) row.probes[p.id] = {ok: false, ms: null, status: null, fail: 'error'};
      }
    } finally {
      endRound(row, startedAt);
    }

    if (!wake.held()) wake.acquire();
    downloadBytesUsed += row.probes.down?.bytes || 0;
    row.first_packet_ms = firstPacket(row);
    if (row.interrupted) {
      row.grades = null;
      row.pgrades = null;
    } else {
      settleMeasured(row);
    }
    // The bytes were spent whether or not the round was interrupted.
    charge(row);
    clearTimings();
    keep(row);
  }

  function tick() {
    if (!running) return;
    // A return from suspension is flagged before lateness is read, whichever timer fires first.
    round?.watch.check();
    const now = mono();
    const wall = Date.now();
    // Timer rounding can fire a tick early; lateness is clamped at zero.
    const late = Math.max(0, Math.round(now - due), Math.round(wall - dueWall));

    // iOS freezes JS when the tab is backgrounded or the screen locks. The gap is recorded
    // so it stays distinguishable from an outage. The threshold is one missed slot: at two,
    // a 13.7 s delay on a 10 s interval goes unlogged.
    if (late >= interval()) {
      const p = position.read();
      inPause = true;
      // `round` names the interrupted round that already stands for this absence on the strip.
      record({sessionId: session.id, t: Date.now(), mono: Math.round(now), type: 'pause',
              lat: p.lat, lon: p.lon, ...(absentRound == null ? {} : {round: absentRound}),
              text: `${(late / 1000).toFixed(1)}s bridged`});
      absentRound = null;
    }

    // Scheduled from when this round fired. On a fixed grid, lateness pulls the next slot closer: a
    // 13.7 s delay on a 10 s interval fires the next tick 11 ms later, into the running round. Even
    // spacing takes priority over grid phase.
    due = now + interval();
    dueWall = wall + interval();
    timer = setTimeout(tick, Math.max(0, due - mono()));

    if (inFlight && round?.interrupted) {
      // The interrupted round is settling its aborts; the next round starts once it has, with no
      // skip and no wait for the following slot.
      if (!chained) {
        chained = true;
        current = current.then(() => { chained = false; return running ? measure(late) : null; });
      }
      return;
    }
    if (inFlight) {
      // The running round keeps the link; this slot starts no round and records a skip event with the
      // probes still pending.
      const p = position.read();
      const ranFor = Math.round(now - runningSince);
      const waiting = [...pending];
      record({sessionId: session.id, t: wall, mono: Math.round(now), type: 'skip',
              lat: p.lat, lon: p.lon, late_ms: late, round: runningSeq, running_ms: ranFor,
              waiting_on: waiting,
              text: `round ${runningSeq} still running after ${(ranFor / 1000).toFixed(1)} s` +
                    (waiting.length ? `, waiting on ${waiting.join(', ')}` : '')});
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

  // Preflight result per family, for the log; rounds classify their own literals. A resume keeps
  // the families an earlier run already stored.
  async function preflight() {
    const paths = await checkPaths(abort.signal);
    for (const [id, key, label] of PATHS) {
      if (session[key] != null) continue;
      const c = paths[id];
      session[key] = c.available;
      session[`${key.replace('_available', '')}_check`] = c;
      noteEvent(`${label} ${c.available === null ? `unresolved (${c.fail} in ${c.ms} ms)`
        : c.available ? 'answered' : `did not answer (${c.fail} in ${c.ms} ms)`}`);
    }
    await store.putSession(session);
  }

  async function start(s, {resumeSeq = 0, monoBase = 0, resumedGapMs = 0, spent = null} = {}) {
    session = s;
    seq = resumeSeq;
    running = true;
    // One recorder lives for the page, so session-scoped state is cleared when a new session
    // starts.
    if (!resumeSeq) {
      stuck.reset();
      marks = 0;
      inPause = false;
      position.reset();
      for (const k of Object.keys(egressIp)) delete egressIp[k];
      lastSpeed = null;
      lastSpeedSource = null;
    }
    t0 = performance.now() - monoBase;
    due = monoBase;
    dueWall = Date.now();
    bytes = spent?.bytes || 0;
    throughput = null;
    udpMs = null;
    downloadBytesUsed = spent?.downloadBytes || 0;
    lastElapsed = 0;
    said.clear();
    lastGrades = null;
    inFlight = false;
    round = null;
    absentRound = null;
    chained = false;
    contacted.clear();
    abort = new AbortController();
    store.setActive(session.id);
    clearTimings();
    position.start();
    wake.reset();
    await wake.acquire();

    // Established once per session, so a single-stack network does not report the same absent
    // path every round.
    if (session.ipv6_available == null || session.ipv4_available == null) await preflight();

    if (resumedGapMs) {
      record({sessionId: session.id, t: Date.now(), mono: Math.round(monoBase), type: 'pause',
              lat: null, lon: null, text: `${(resumedGapMs / 1000).toFixed(1)}s bridged across reload`});
    }
    // Set after the preflight and the wake lock: otherwise the first row reports start-up
    // time as scheduling lateness, and a slow radio logs a pause that did not happen.
    due = mono();
    dueWall = Date.now();
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
    session.end_reason = 'stop';
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

  watchPage((type, text) => running && event(type, text));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && running) wake.acquire();
  });

  return {start, stop, mark, note, status, flush};
}
