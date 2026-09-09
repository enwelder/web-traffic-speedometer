import * as store from './store.js';
import * as ui from './ui.js';
import {PROBES} from './probe.js';
import {createRecorder, environment, projectedBytes, spentSoFar, PROFILES,
        DOWNLOAD_DEFAULTS} from './session.js';
import {exportSession, exportAll} from './export.js';

const PREFS_KEY = 'wts.prefs';
const $ = ui.$;

let degradedRounds = 0;
let scoredRounds = 0;
let listDirty = true;

// Test seam: on localhost only, ?interval=<ms> shortens the round for the browser suite.
function testInterval() {
  if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return null;
  const q = Number(new URLSearchParams(location.search).get('interval'));
  return q >= 500 ? q : null;
}

function profile() {
  const base = PROFILES[$('f-profile').value] || PROFILES.coarse;
  const override = testInterval();
  return override ? {...base, intervalMs: override} : base;
}

let lastFirstPacket = null;
// Start and Stop await storage before the recorder's own flag moves. Without this guard a
// second tap inside that window starts a second session and a second tick loop.
let busy = false;

const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }));

const recorder = createRecorder({
  onSample(sample) {
    // Rounds carrying at least one failure that was not a known-absent path, which is the
    // common case; full outages are rare.
    if (!sample.skipped && !sample.round_error) {
      scoredRounds++;
      if (PROBES.some(p => ui.counts(sample.probes[p.id]))) degradedRounds++;
    }
    ui.setProbes(sample);
    const kind = ui.classify(sample);
    ui.pushStrip(sample);
    if (sample.first_packet_ms != null) lastFirstPacket = sample.first_packet_ms;
    ui.pushLog(ui.sampleLine(sample),
               sample.skipped ? 'warn' : kind === 'green' || kind === 'yellow' ? '' : 'bad');
  },
  onEvent(event) {
    if (event.type === 'pause') ui.pushStripPause();
    ui.pushLog(`${ui.clock(event.t)}  ← ${event.type}${event.text ? ': ' + event.text : ''}`,
               event.type === 'pause' ? 'warn' : 'mark');
  },
  onStatus(s) {
    const c = s.pos?.coords;
    ui.setStats({
      rounds: s.seq,
      elapsed: ui.duration(s.elapsed),
      pos: c ? `${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}` : (s.posError || '—'),
      speed: c && c.speed != null ? `${Math.round(c.speed * 3.6)} km/h` : '—',
      data: ui.bytes(s.bytes) + (s.pending ? ` (${s.pending} held)` : ''),
      marks: s.marks,
      degraded: scoredRounds ? `${Math.round((degradedRounds / scoredRounds) * 100)}%` : '—',
      firstPacket: lastFirstPacket == null ? '—' : `${lastFirstPacket} ms`
    });
  },
  onNotice: ui.notice
});

/* ---- setup ---- */

function readPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; }
}

function writePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      operator: $('f-operator').value,
      operatorOther: $('f-operator-other').value,
      connection: $('f-connection').value,
      profile: $('f-profile').value
    }));
  } catch { /* private mode */ }
}

function applyPrefs() {
  const p = readPrefs();
  if (p.operator) $('f-operator').value = p.operator;
  if (p.operatorOther) $('f-operator-other').value = p.operatorOther;
  if (p.connection) $('f-connection').value = p.connection;
  if (p.profile && PROFILES[p.profile]) $('f-profile').value = p.profile;
  syncSetup();
}

// On Wi-Fi there is no operator to name, so that field is hidden.
function syncSetup() {
  const wifi = $('f-connection').value === 'wifi';
  $('row-operator').hidden = wifi;
  $('f-operator-other').hidden = $('f-operator').value !== '__other';
  const {intervalMs} = profile();
  const mb = projectedBytes(intervalMs, DOWNLOAD_DEFAULTS) / 1048576;
  const el = $('budget');
  // The download pulls for a fixed span, so on a fast link it reaches its byte ceiling every
  // round. Nothing caps the total; the running figure is on the readout.
  el.textContent = `up to ≈ ${Math.round(mb)} MB for a 40-minute run on a fast link, ` +
    `almost all of it the speed probe. Nothing caps it; the running total is shown while ` +
    `recording.`;
  // Past this the projected run is a noticeable share of a monthly data bundle.
  el.classList.toggle('warn', mb > 50);
}

function operatorName() {
  if ($('f-connection').value === 'wifi') return '';
  const sel = $('f-operator').value;
  return sel === '__other' ? ($('f-operator-other').value.trim() || 'unknown') : sel;
}

// Generated from what is already known, so no typing is needed before Start.
function generatedName(operator, connection, started) {
  const d = new Date(started);
  const month = d.toLocaleString('en', {month: 'short'});
  const when = `${d.getDate()} ${month} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const who = operator || (connection === 'wifi' ? 'Wi-Fi' : connection);
  return `${who} · ${when}`;
}

function newSession() {
  const {intervalMs} = profile();
  const connection = $('f-connection').value;
  const operator = operatorName();
  const started = Date.now();
  return {
    id: uuid(),
    name: generatedName(operator, connection, started),
    operator, connection,
    note: '',
    started,
    stopped: null,
    intervalMs,
    download: {...DOWNLOAD_DEFAULTS},
    profile: $('f-profile').value,
    // Determined by a preflight at start; null until then.
    ipv6_available: null,
    ipv6_check: null,
    ipv4_available: null,
    ipv4_check: null,
    environment: environment(intervalMs, DOWNLOAD_DEFAULTS),
    exportedAt: null
  };
}

/* ---- run control ---- */

// Everything on screen that belongs to one session. Both ways into a session reset the
// same set, so state added here cannot carry from one session into the next.
function resetReadout(intervalMs) {
  degradedRounds = scoredRounds = 0;
  lastFirstPacket = null;
  ui.clearLog();
  ui.clearStrip();
  ui.setStripWindow(intervalMs);
  $('readout').hidden = false;
}

async function begin() {
  // A recovery offer on screen must not survive into a new session.
  dismissRecovery();
  resetReadout(profile().intervalMs);
  ui.notice('');
  writePrefs();

  // Blanked before the first round lands, or the previous session's colours stay for a whole
  // interval: 30 s on the coarse profile.
  ui.setProbes(null);

  const session = newSession();
  await store.putSession(session);
  ui.pushLog(`${ui.clock(session.started)}  ${session.name}`, 'mark');
  await recorder.start(session);
  ui.setRunning(true);
  listDirty = true;
}

async function end() {
  await recorder.stop();
  ui.setRunning(false);
  ui.pushLog(`${ui.clock(Date.now())}  session closed — export it from the Sessions tab`, 'mark');
  listDirty = true;
}

/* ---- crash recovery ---- */

async function checkRecovery() {
  const id = store.getActive();
  if (!id) return;
  const session = await store.getSession(id);
  if (!session || session.stopped) { store.setActive(null); return; }

  const samples = await store.getSamples(id);
  const last = samples[samples.length - 1];
  const started = new Date(session.started);
  $('recover-text').textContent =
    `Session "${session.name}" from ${String(started.getHours()).padStart(2, '0')}:${String(started.getMinutes()).padStart(2, '0')} ` +
    `was never closed — ${samples.length} rounds recorded. Resume it, or close it and keep the data?`;
  $('recover').hidden = false;

  $('recover-resume').onclick = async () => {
    // Start may have been pressed while the banner was up.
    if (busy || recorder.status().running) return;
    $('recover').hidden = true;
    resetReadout(session.intervalMs);
    ui.pushLog(`${ui.clock(Date.now())}  resumed "${session.name}" at round ${last ? last.seq + 1 : 0}`, 'mark');
    // performance.now() restarts on reload, so the monotonic clock is carried across the gap
    // with the wall clock. Both clocks are in the data, so the bridge is checkable.
    const gap = last ? Date.now() - last.t : 0;
    await recorder.start(session, {
      resumeSeq: last ? last.seq + 1 : 0,
      monoBase: last ? last.mono + gap : 0,
      resumedGapMs: gap,
      spent: spentSoFar(samples)
    });
    ui.setRunning(true);
  };

  $('recover-close').onclick = async () => {
    $('recover').hidden = true;
    session.stopped = last ? last.t : session.started;
    await store.putSession(session);
    store.setActive(null);
    listDirty = true;
    ui.pushLog(`${ui.clock(Date.now())}  recovered session "${session.name}" closed with ${samples.length} rounds`, 'mark');
  };
}

function dismissRecovery() {
  $('recover').hidden = true;
  $('recover-resume').onclick = null;
  $('recover-close').onclick = null;
}

/* ---- sessions ---- */

async function renderSessions() {
  const sessions = await store.allSessions();
  const rows = [];
  for (const session of sessions) rows.push({session, count: await store.countSamples(session.id)});
  ui.renderSessions(rows, handlers);
  listDirty = false;
}

// The list includes the running session. Edits must go to the recorder's own object:
// stop() writes that object afterwards and would overwrite a copy edited here.
function liveOrGiven(session) {
  const active = recorder.status().session;
  return active && active.id === session.id ? active : session;
}

const handlers = {
  async export(given) {
    const session = liveOrGiven(given);
    try {
      const {samples, events} = await exportSession(session);
      session.exportedAt = Date.now();
      await store.putSession(session);
      ui.notice(`Exported ${samples} rounds and ${events} events.`);
      renderSessions();
    } catch (e) {
      ui.notice(`Export failed: ${e.message}`);
    }
  },
  async rename(given) {
    const session = liveOrGiven(given);
    const name = prompt('Session name', session.name);
    if (name == null) return;
    session.name = name.trim() || session.name;
    await store.putSession(session);
    renderSessions();
  },
  async note(given) {
    const session = liveOrGiven(given);
    const note = prompt('Note', session.note || '');
    if (note == null) return;
    session.note = note.trim();
    await store.putSession(session);
    renderSessions();
  },
  async remove(given) {
    const session = liveOrGiven(given);
    const warning = session.exportedAt ? '' : '\n\nThis session has never been exported.';
    if (!confirm(`Delete "${session.name}" and all its rounds?${warning}`)) return;
    await store.deleteSession(session.id);
    renderSessions();
  }
};

/* ---- wiring ---- */

$('btn-start').onclick = async () => {
  if (busy) return;
  busy = true;
  $('btn-start').disabled = true;
  try {
    await (recorder.status().running ? end() : begin());
  } catch (e) {
    ui.notice(`Could not ${recorder.status().running ? 'stop' : 'start'}: ${e.message}`);
  } finally {
    busy = false;
    $('btn-start').disabled = false;
  }
};
$('btn-mark').onclick = () => recorder.mark();
for (const id of ['f-connection', 'f-operator', 'f-profile']) $(id).onchange = syncSetup;
ui.buildProbeRows();
ui.bindExplanations();

let helpOn = false;
$('btn-help').onclick = () => {
  helpOn = !helpOn;
  $('btn-help').setAttribute('aria-pressed', String(helpOn));
  ui.setExplainAll(helpOn);
};
$('btn-export-all').onclick = async () => {
  try {
    const sessions = await exportAll();
    const now = Date.now();
    for (const s of sessions) { s.exportedAt = now; await store.putSession(s); }
    ui.notice(`Exported ${sessions.length} sessions.`);
    renderSessions();
  } catch (e) {
    ui.notice(`Export failed: ${e.message}`);
  }
};

for (const tab of document.querySelectorAll('nav button')) {
  tab.onclick = () => {
    ui.switchView(tab.dataset.view);
    if (tab.dataset.view === 'sessions' && listDirty) renderSessions();
  };
}

// One ticker for the lifetime of the page, so a restart cannot stack a second.
setInterval(() => {
  const s = recorder.status();
  if (s.running) $('m-time').textContent = ui.duration(s.elapsed);
}, 1000);

applyPrefs();

// A rejected top-level await stops the rest of the module, which in private mode would
// leave the page bound with no service worker and no explanation on screen.
try {
  await store.ready();
  await checkRecovery();
  await renderSessions();
} catch (e) {
  ui.notice(`Storage unavailable: ${e && e.message || e}. Sessions cannot be saved.`);
}

if ('serviceWorker' in navigator) {
  // Recovery after a crash needs the page to load on a degraded network. Registration
  // failure is not fatal.
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
