// DOM rendering. Nothing here is persisted.

import {PROBES} from './probe.js';
import {CAPABILITIES, GRADES, gradeRound, worse, capabilityReading} from './grade.js';
import {countsAsFailure} from './export.js';

const STRIP_BARS = 48;

export const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');

export const clock = ms => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export function bytes(b) {
  return b < 1e6 ? `${Math.round(b / 1024)} kB` : `${(b / 1048576).toFixed(1)} MB`;
}

export function duration(s) {
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

export function rate(bps) {
  if (bps == null) return '—';
  if (bps < 1e6) return `${Math.round(bps / 1e3)} kb/s`;
  const mb = bps / 1e6;
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} Mb/s`;
}

export function notice(text) { $('notice').textContent = text || ''; }

// One definition of failure, shared with the export, so the percentage on screen and the
// count in the file agree.
export {countsAsFailure as counts} from './export.js';

// One purpose's colour for one round. A skipped round has no measurement to grade.
export function gradeFor(cap, sample) {
  if (sample.skipped) return 'skip';
  return (sample.grades || gradeRound(sample))?.[cap] ?? 'none';
}

// The colour of a round taken as a whole: its worst purpose. Used for the log line, where
// there is one line per round rather than one per purpose.
export function classify(sample) {
  if (sample.skipped) return 'skip';
  const g = sample.grades || gradeRound(sample);
  let worstGrade = null;
  for (const cap of CAPABILITIES) worstGrade = worse(worstGrade, g?.[cap] ?? null);
  return worstGrade || 'green';
}

// Shown in place of a tile's value while that tile is tapped. Each names the measurements the
// purpose is judged on, since no purpose reads a single probe any more.
const EXPLAIN = {
  voice:     'Round trip to Cloudflare by address, the UDP path being open at all, and enough throughput to carry a call. Live audio breaks on any of the three, and the tile shows whichever is worst.',
  news:      'Resolving a hostname never seen before, reaching a host already known, and the time an article of average weight would take over this link. The tile shows whichever of them decides.',
  streaming: 'What the bytes that arrived prove the link carries. A floor, not a top speed: enough to answer whether video will play, which is the question.'
};

// The measurement that decided the grade, so the tile's number and its colour describe the
// same thing. A term with no number — a path that is gone — says so in place of one.
function displayReading(r) {
  if (!r || (r.note == null && r.value == null)) return '—';
  if (r.note) return r.note;
  return r.unit === 'bps' ? `≥${rate(r.value)}` : String(Math.round(r.value));
}

// `rate` writes its own unit, and a term reporting a gone path has none.
const displayUnit = r => (r && !r.note && r.value != null && r.unit === 'ms' ? 'ms' : '');

// Colour and number both come from the round passed in, so a tile describes one moment.
// History is the strip's job.
export function setSignals(sample) {
  const live = sample && !sample.skipped;
  for (const cap of CAPABILITIES) {
    const cell = $(`cap-${cap}`);
    cell.classList.remove(...GRADES);
    const reading = live ? capabilityReading(cap, sample) : null;
    if (reading?.grade) cell.classList.add(reading.grade);
    $(`val-${cap}`).textContent = sample && sample.skipped ? '–' : displayReading(reading);
    $(`unit-${cap}`).textContent = displayUnit(reading);
  }
  renderExplanations();
}

export function renderExplanations() {
  for (const cap of CAPABILITIES) {
    const on = $(`cap-${cap}`).dataset.explain === 'on';
    $(`cap-${cap}`).classList.toggle('explaining', on);
    $(`explain-${cap}`).textContent = on ? EXPLAIN[cap] : '';
  }
}

// One strip per purpose, each always full width with empty slots dimmed, scrolling right to
// left. Separate rows are what make a single failing purpose visible: one combined row shows
// only the worst of them and never says which.
export function clearStrip() {
  for (const cap of CAPABILITIES) {
    const strip = $(`strip-${cap}`);
    strip.replaceChildren();
    for (let i = 0; i < STRIP_BARS; i++) {
      const bar = document.createElement('i');
      bar.className = 'none';
      strip.appendChild(bar);
    }
  }
}

export function pushStrip(sample) {
  for (const cap of CAPABILITIES) {
    const strip = $(`strip-${cap}`);
    const bar = document.createElement('i');
    bar.className = gradeFor(cap, sample);
    strip.appendChild(bar);
    while (strip.children.length > STRIP_BARS) strip.removeChild(strip.firstChild);
  }
}

// A bridged gap belongs on every row: no purpose was measured while the page was frozen.
export function pushStripPause() {
  for (const cap of CAPABILITIES) {
    const strip = $(`strip-${cap}`);
    const bar = document.createElement('i');
    bar.className = 'pause';
    strip.appendChild(bar);
    while (strip.children.length > STRIP_BARS) strip.removeChild(strip.firstChild);
  }
}

export function setStripWindow(intervalMs) {
  const minutes = Math.round((STRIP_BARS * intervalMs) / 60000);
  $('strip-span').textContent = minutes >= 1
    ? `${minutes} min ago`
    : `${Math.round(STRIP_BARS * intervalMs / 1000)}s ago`;
}

// Lit, dim or unlit: which paths carried traffic in this round.
export function setLamps(sample) {
  const set = (id, state) => {
    const el = $(`lamp-${id}`);
    if (!el) return;
    el.classList.remove('on', 'off', 'na');
    el.classList.add(state);
  };
  const p = sample && !sample.skipped ? sample.probes : null;
  if (!p) { for (const id of ['ip6', 'ip4']) set(id, 'na'); return; }
  set('ip6', p.ip6.ok ? 'on' : 'off');
  set('ip4', p.ip4.expected ? 'na' : p.ip4.ok ? 'on' : 'off');
}

// Newest first: the controls sit over the bottom of the log.
export function pushLog(text, cls) {
  const log = $('log');
  const line = document.createElement('div');
  line.textContent = text;
  if (cls) line.className = cls;
  log.insertBefore(line, log.firstChild);
  while (log.children.length > 300) log.removeChild(log.lastChild);
  log.scrollTop = 0;
}

export function clearLog(placeholder) {
  $('log').replaceChildren();
  if (placeholder) pushLog(placeholder);
}

export function sampleLine(sample) {
  const time = clock(sample.t);
  if (sample.skipped) return `${time}  skipped: ${sample.skipped} (${sample.late_ms} ms late)`;
  if (sample.round_error) return `${time}  round error: ${sample.round_error}`;
  const failed = PROBES.filter(p => countsAsFailure(sample.probes[p.id]));
  if (failed.length) return `${time}  ` + failed.map(p => `${p.id} ${sample.probes[p.id].fail}`).join('  ');
  const num = v => (v == null ? '–' : v);
  const d = sample.probes.down;
  const dns = num(sample.probes.dns?.ms);
  const ctl = sample.probes.dns_ctl?.ms;
  const speed = !d ? ''
    : d.ok && d.bps_min ? `  ≥${rate(d.bps_min)}`
    : d.ok ? '  unrated'
    : `  ${d.fail}`;
  return `${time}  v6 ${num(sample.probes.ip6?.ms)}  dns ${dns}${ctl != null ? '/' + ctl : ''}${speed}`;
}

export function setStats({rounds, elapsed, pos, speed, data, marks, degraded, firstPacket}) {
  $('m-rounds').textContent = rounds;
  $('m-time').textContent = elapsed;
  $('m-pos').textContent = pos;
  $('m-speed').textContent = speed;
  $('m-data').textContent = data;
  $('m-marks').textContent = marks;
  $('m-degraded').textContent = degraded;
  $('m-first').textContent = firstPacket;
}

export function setRunning(running) {
  const start = $('btn-start');
  start.textContent = running ? 'Stop' : 'Start';
  start.className = running ? 'stop' : 'start';
  // While idle Start is the only action and takes the whole width.
  $('btn-mark').hidden = !running;
  $('btn-mark').disabled = !running;
  $('setup').hidden = running;
}

// Tap a tile to see what it measures; tap again for the number.
export function bindExplanations() {
  for (const cap of CAPABILITIES) {
    const cell = $(`cap-${cap}`);
    cell.onclick = () => {
      cell.dataset.explain = cell.dataset.explain === 'on' ? 'off' : 'on';
      renderExplanations();
    };
  }
}

export function setExplainAll(on) {
  for (const cap of CAPABILITIES) $(`cap-${cap}`).dataset.explain = on ? 'on' : 'off';
  renderExplanations();
}

export function switchView(name) {
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== `view-${name}`;
  for (const tab of document.querySelectorAll('nav button')) tab.classList.toggle('on', tab.dataset.view === name);
  // Start and Mark act on the measure view only.
  $('controls').hidden = name !== 'measure';
}

// Keeps the date on the card after a rename, which removes it from the generated name.
const dateLabel = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const div = (className, text) => {
  const el = document.createElement('div');
  el.className = className;
  if (text != null) el.textContent = text;
  return el;
};

// A plain string is a fact about the session; a pair is a fact and the class that flags it.
function sessionMeta(session, count) {
  const meta = div('meta');
  const secs = Math.round(((session.stopped || session.started) - session.started) / 1000);
  const bits = [dateLabel(session.started), duration(secs), `${count} rounds`, `${session.intervalMs / 1000}s`];
  if (!session.stopped) bits.push(['never closed', 'flag']);
  if (!session.exportedAt) bits.push(['not exported', 'flag']);
  for (const b of bits) {
    const s = document.createElement('span');
    s.textContent = Array.isArray(b) ? b[0] : b;
    if (Array.isArray(b)) s.className = b[1];
    meta.appendChild(s);
  }
  return meta;
}

function sessionActions(session, handlers) {
  const actions = div('actions');
  for (const [label, fn, className] of [['Export', 'export', 'small export'],
                                        ['Rename', 'rename', 'small'],
                                        ['Note', 'note', 'small'],
                                        ['Delete', 'remove', 'small']]) {
    const b = document.createElement('button');
    b.className = className;
    b.textContent = label;
    b.onclick = () => handlers[fn](session);
    actions.appendChild(b);
  }
  return actions;
}

function sessionCard(session, count, handlers) {
  const card = div('session');
  const top = div('top');
  top.append(div('title', session.name));
  card.append(top, sessionMeta(session, count));
  if (session.note) card.appendChild(div('note', session.note));
  card.appendChild(sessionActions(session, handlers));
  return card;
}

export function renderSessions(rows, handlers) {
  const list = $('session-list');
  list.replaceChildren();
  if (!rows.length) {
    list.appendChild(div('empty', 'No sessions recorded yet.'));
    return;
  }
  for (const {session, count} of rows) list.appendChild(sessionCard(session, count, handlers));
}
