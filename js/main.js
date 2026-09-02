import * as store from './store.js';
import * as ui from './ui.js';
import {PROBES} from './probe.js';
import {createRecorder, environment} from './session.js';
import {exportSession, exportAll} from './export.js';

const PREFS_KEY = 'spoormeter.prefs';
const $ = ui.$;

const fails = {};
let listDirty = true;

const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }));

const recorder = createRecorder({
  onSample(sample) {
    if (!sample.skipped && !sample.round_error) {
      for (const p of PROBES) if (!sample.probes[p.id].ok) fails[p.id] = (fails[p.id] || 0) + 1;
    }
    ui.setSignals(sample, fails);
    ui.pushStrip(ui.classify(sample));
    ui.pushLog(ui.sampleLine(sample), sample.skipped ? 'warn' : ui.classify(sample) === 'up' ? '' : 'bad');
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
      pos: c ? `${c.latitude.toFixed(3)},${c.longitude.toFixed(3)}` : (s.posError || '—'),
      speed: c && c.speed != null ? `${Math.round(c.speed * 3.6)} km/h` : '—',
      data: ui.bytes(s.bytes) + (s.pending ? ` (${s.pending} held)` : ''),
      marks: s.marks
    });
  },
  onNotice: ui.notice
});

/* ---- form ---- */

function readPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; }
}

function writePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      operator: $('f-operator').value,
      operatorOther: $('f-operator-other').value,
      connection: $('f-connection').value,
      route: $('f-route').value,
      interval: $('f-interval').value,
      adaptive: $('f-adaptive').checked
    }));
  } catch { /* private mode */ }
}

function applyPrefs() {
  const p = readPrefs();
  if (p.operator) $('f-operator').value = p.operator;
  if (p.operatorOther) $('f-operator-other').value = p.operatorOther;
  if (p.connection) $('f-connection').value = p.connection;
  if (p.route) $('f-route').value = p.route;
  if (p.interval) $('f-interval').value = p.interval;
  $('f-adaptive').checked = !!p.adaptive;
  syncOperatorField();
}

function syncOperatorField() {
  $('f-operator-other').hidden = $('f-operator').value !== '__other';
}

function operatorName() {
  const sel = $('f-operator').value;
  return sel === '__other' ? ($('f-operator-other').value.trim() || 'unknown') : sel;
}

function defaultName() {
  const d = new Date();
  return `${d.getDate()}/${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function newSession() {
  const intervalMs = +$('f-interval').value;
  return {
    id: uuid(),
    name: $('f-name').value.trim() || defaultName(),
    operator: operatorName(),
    connection: $('f-connection').value,
    route: $('f-route').value.trim(),
    note: '',
    started: Date.now(),
    stopped: null,
    intervalMs,
    adaptive: $('f-adaptive').checked,
    environment: environment(intervalMs),
    exportedAt: null
  };
}

/* ---- run control ---- */

async function begin() {
  for (const p of PROBES) fails[p.id] = 0;
  ui.clearLog();
  ui.clearStrip();
  ui.notice('');
  $('readout').hidden = false;
  writePrefs();

  const session = newSession();
  await store.putSession(session);
  ui.pushLog(`${ui.clock(session.started)}  session "${session.name}" — ${session.operator} / ${session.connection}`, 'mark');
  await recorder.start(session);
  ui.setRunning(true);
  listDirty = true;
}

async function end() {
  const session = await recorder.stop();
  ui.setRunning(false);
  ui.pushLog(`${ui.clock(Date.now())}  session closed — export it from the Sessions tab`, 'mark');
  listDirty = true;
  return session;
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
    ui.clearLog();
    ui.clearStrip();
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

/* ---- sessions view ---- */

async function renderSessions() {
  const sessions = await store.allSessions();
  const rows = [];
  for (const session of sessions) {
    rows.push({session, count: await store.countSamples(session.id)});
  }
  ui.renderSessions(rows, handlers);
  listDirty = false;
}

const handlers = {
  async export(session, format) {
    try {
      const {samples, events} = await exportSession(session, format);
      session.exportedAt = Date.now();
      await store.putSession(session);
      ui.notice(`Exported ${samples} rounds and ${events} events as ${format.toUpperCase()}.`);
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
$('f-operator').onchange = syncOperatorField;
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
