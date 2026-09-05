import * as store from './store.js';
import * as ui from './ui.js';
import {PROBES} from './probe.js';
import {createRecorder, environment, projectedBytes, PROFILES} from './session.js';
import {exportSession, exportAll} from './export.js';

const PREFS_KEY = 'wts.prefs';
const $ = ui.$;

const fails = {};
let degradedRounds = 0;
let scoredRounds = 0;
let listDirty = true;

// Test seam. On localhost only, ?interval=<ms> shortens the round so the browser suite does
// not have to sit through 15 s per round. Inert on any deployed origin.
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

const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }));

const recorder = createRecorder({
  onSample(sample) {
    if (!sample.skipped && !sample.round_error) {
      // An expected failure (no IPv4 path) is a known condition, not an outage to tally.
      for (const p of PROBES) if (ui.counts(sample.probes[p.id])) fails[p.id] = (fails[p.id] || 0) + 1;
    }
    // Full outages were rare on the route; what tracked the experience was rounds where
    // some probe failed while the rest looked healthy.
    if (!sample.skipped && !sample.round_error) {
      scoredRounds++;
      if (PROBES.some(p => ui.counts(sample.probes[p.id]))) degradedRounds++;
    }
    ui.trackLatency(sample);
    ui.setSignals(sample, fails, scoredRounds);
    ui.setLamps(sample);
    const kind = ui.classify(sample);
    ui.pushStrip(kind);
    ui.pushLog(ui.sampleLine(sample),
               sample.skipped ? 'warn' : kind === 'good' || kind === 'ok' ? '' : 'bad');
  },
  onEvent(event) {
    if (event.type === 'pause') ui.pushStrip('pause');
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
      degraded: scoredRounds ? `${Math.round((degradedRounds / scoredRounds) * 100)}%` : '—'
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

// On Wi-Fi there is no operator to name, so the field is not asked for.
function syncSetup() {
  const wifi = $('f-connection').value === 'wifi';
  $('row-operator').hidden = wifi;
  $('f-operator-other').hidden = $('f-operator').value !== '__other';
  const {intervalMs, downloadBytes} = profile();
  const mb = projectedBytes(intervalMs, downloadBytes) / 1048576;
  const el = $('budget');
  el.textContent = `≈ ${Math.round(mb)} MB for a 40-minute run. A full page download every round is almost all of it.`;
  // Past this the run costs more than a chunk of a monthly bundle, which is worth seeing
  // before pressing Start rather than afterwards.
  el.classList.toggle('warn', mb > 50);
}

function operatorName() {
  if ($('f-connection').value === 'wifi') return '';
  const sel = $('f-operator').value;
  return sel === '__other' ? ($('f-operator-other').value.trim() || 'unknown') : sel;
}

// Generated, not typed: everything in the name is already known, and a keyboard on a
// moving train is the last thing wanted before pressing Start.
function generatedName(operator, connection, started) {
  const d = new Date(started);
  const month = d.toLocaleString('en', {month: 'short'});
  const when = `${d.getDate()} ${month} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const who = operator || (connection === 'wifi' ? 'Wi-Fi' : connection);
  return `${who} · ${when}`;
}

function newSession() {
  const {intervalMs, downloadBytes} = profile();
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
    downloadBytes,
    profile: $('f-profile').value,
    // Determined by a preflight at start rather than assumed; null until then.
    ipv4_available: null,
    ipv4_check: null,
    environment: environment(intervalMs, downloadBytes),
    exportedAt: null
  };
}

/* ---- run control ---- */

async function begin() {
  for (const p of PROBES) fails[p.id] = 0;
  degradedRounds = scoredRounds = 0;
  ui.resetHistory();
  ui.clearLog();
  ui.clearStrip();
  ui.setStripWindow(profile().intervalMs);
  ui.notice('');
  $('readout').hidden = false;
  writePrefs();

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

/* ---- crash recovery: never resume silently ---- */

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
    $('recover').hidden = true;
    for (const p of PROBES) fails[p.id] = 0;
    degradedRounds = scoredRounds = 0;
    ui.resetHistory();
    ui.clearLog();
    ui.clearStrip();
    ui.setStripWindow(session.intervalMs);
    $('readout').hidden = false;
    ui.pushLog(`${ui.clock(Date.now())}  resumed "${session.name}" at round ${last ? last.seq + 1 : 0}`, 'mark');
    // performance.now() restarts on reload, so the monotonic clock is carried across the
    // gap using the wall clock. Both columns are in the data, so the bridge is checkable.
    const gap = last ? Date.now() - last.t : 0;
    await recorder.start(session, {
      resumeSeq: last ? last.seq + 1 : 0,
      monoBase: last ? last.mono + gap : 0,
      resumedGapMs: gap
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

/* ---- sessions ---- */

async function renderSessions() {
  const sessions = await store.allSessions();
  const rows = [];
  for (const session of sessions) rows.push({session, count: await store.countSamples(session.id)});
  ui.renderSessions(rows, handlers);
  listDirty = false;
}

const handlers = {
  async export(session) {
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
  async rename(session) {
    const name = prompt('Session name', session.name);
    if (name == null) return;
    session.name = name.trim() || session.name;
    await store.putSession(session);
    renderSessions();
  },
  async note(session) {
    const note = prompt('Note', session.note || '');
    if (note == null) return;
    session.note = note.trim();
    await store.putSession(session);
    renderSessions();
  },
  async remove(session) {
    const warning = session.exportedAt ? '' : '\n\nThis session has never been exported.';
    if (!confirm(`Delete "${session.name}" and all its rounds?${warning}`)) return;
    await store.deleteSession(session.id);
    renderSessions();
  }
};

/* ---- wiring ---- */

$('btn-start').onclick = () => (recorder.status().running ? end() : begin());
$('btn-mark').onclick = () => recorder.mark();
for (const id of ['f-connection', 'f-operator', 'f-profile']) $(id).onchange = syncSetup;
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

// One ticker for the lifetime of the page, so a restart cannot stack a second one.
setInterval(() => {
  const s = recorder.status();
  if (s.running) $('m-time').textContent = ui.duration(s.elapsed);
}, 1000);

applyPrefs();
await store.ready();
await checkRecovery();
await renderSessions();

if ('serviceWorker' in navigator) {
  // Recovery after a crash needs the page to load on a degraded network, which is exactly
  // when the tool is wanted. Registration failure is not fatal.
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
