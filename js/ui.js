// DOM rendering. Nothing here is persisted.

import {PROBES} from './probe.js';
import {CAPABILITIES, GRADES, gradeRound, worse, capabilityValue} from './grade.js';
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

// A round's colour on the strip is its worst capability grade.
export function classify(sample) {
  if (sample.skipped) return 'skip';
  const g = sample.grades || gradeRound(sample);
  let worstGrade = null;
  for (const cap of CAPABILITIES) worstGrade = worse(worstGrade, g?.[cap] ?? null);
  return worstGrade || 'green';
}

// Shown in place of a tile's value while that tile is tapped.
const EXPLAIN = {
  realtime: 'Round trip to Cloudflare by IP address and over UDP, whichever is worse. Calls and live audio break on this before anything else does.',
  tap:      'Round trip to Google, a host your phone already knows. What a tap on a link costs before the page starts arriving.',
  newsite:  'Resolving a hostname never seen before, then reaching it. What visiting somewhere new costs, lookup included.',
  video:    'Sustained rate after the connection has finished ramping up. The ramp is discarded, so this is what the link carries rather than how fast it accelerates.'
};

function displayValue(cap, value) {
  if (value == null) return '—';
  return cap === 'video' ? rate(value) : String(Math.round(value));
}

// Colour and number both come from the round passed in, so a tile describes one moment.
// History is the strip's job.
export function setSignals(sample) {
  const grades = sample && !sample.skipped ? (sample.grades || gradeRound(sample)) : null;
  for (const cap of CAPABILITIES) {
    const cell = $(`cap-${cap}`);
    cell.classList.remove(...GRADES);
    if (grades?.[cap]) cell.classList.add(grades[cap]);
    $(`val-${cap}`).textContent = sample && sample.skipped
      ? '–' : displayValue(cap, capabilityValue(cap, sample));
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

// The strip is always full width with empty slots dimmed; it scrolls right to left.
export function clearStrip() {
  const strip = $('strip');
  strip.replaceChildren();
  for (let i = 0; i < STRIP_BARS; i++) {
    const bar = document.createElement('i');
    bar.className = 'none';
    strip.appendChild(bar);
  }
}

export function pushStrip(kind) {
  const strip = $('strip');
  const bar = document.createElement('i');
  bar.className = kind;
  strip.appendChild(bar);
  while (strip.children.length > STRIP_BARS) strip.removeChild(strip.firstChild);
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
    : d.ok && d.bps_steady ? `  ${rate(d.bps_steady)}`
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

export function renderSessions(rows, handlers) {
  const list = $('session-list');
  list.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No sessions recorded yet.';
    list.appendChild(empty);
    return;
  }

  for (const {session, count} of rows) {
    const card = document.createElement('div');
    card.className = 'session';

    const top = document.createElement('div');
    top.className = 'top';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = session.name;
    top.append(title);

    const meta = document.createElement('div');
    meta.className = 'meta';
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
    card.append(top, meta);

    if (session.note) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = session.note;
      card.appendChild(note);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    const exp = document.createElement('button');
    exp.className = 'small export';
    exp.textContent = 'Export';
    exp.onclick = () => handlers.export(session);
    actions.appendChild(exp);
    for (const [label, fn] of [['Rename', 'rename'], ['Note', 'note'], ['Delete', 'remove']]) {
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = label;
      b.onclick = () => handlers[fn](session);
      actions.appendChild(b);
    }
    card.appendChild(actions);
    list.appendChild(card);
  }
}
