// DOM rendering only. Nothing here is persisted; the screen is a live readout.

import {PROBES} from './probe.js';

const STRIP_BARS = 48;
const SLOW_MS = 400;

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

export function notice(text) { $('notice').textContent = text || ''; }

export function classify(sample) {
  if (sample.skipped) return 'skip';
  const r = id => sample.probes[id];
  const failed = PROBES.filter(p => !r(p.id).ok);
  if (!failed.length) return PROBES.some(p => r(p.id).ms > SLOW_MS) ? 'slow' : 'up';
  if (!r('dns').ok && r('ip').ok) return 'dns';
  return 'down';
}

export function setSignals(sample, fails) {
  for (const p of PROBES) {
    const cell = $(`sig-${p.id}`);
    const r = sample?.probes?.[p.id];
    cell.classList.remove('up', 'slow', 'down');
    if (!sample || sample.skipped) {
      $(`val-${p.id}`).textContent = sample ? '–' : '—';
    } else if (!r.ok) {
      cell.classList.add('down');
      $(`val-${p.id}`).textContent = r.fail === 'timeout' ? 'to' : r.fail === 'http' ? String(r.status) : 'gone';
    } else {
      cell.classList.add(r.ms > SLOW_MS ? 'slow' : 'up');
      $(`val-${p.id}`).textContent = r.ms;
    }
    $(`fail-${p.id}`).textContent = `${fails[p.id] || 0} failed`;
  }
}

export function pushStrip(kind) {
  const strip = $('strip');
  const bar = document.createElement('i');
  bar.className = kind;
  strip.appendChild(bar);
  while (strip.children.length > STRIP_BARS) strip.removeChild(strip.firstChild);
}

export function clearStrip() { $('strip').replaceChildren(); }

export function pushLog(text, cls) {
  const log = $('log');
  const line = document.createElement('div');
  line.textContent = text;
  if (cls) line.className = cls;
  log.appendChild(line);
  while (log.children.length > 300) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

export function clearLog(placeholder) {
  $('log').replaceChildren();
  if (placeholder) pushLog(placeholder);
}

export function sampleLine(sample) {
  const time = clock(sample.t);
  if (sample.skipped) return `${time}  skipped: ${sample.skipped} (${sample.late_ms} ms late)`;
  if (sample.round_error) return `${time}  round error: ${sample.round_error}`;
  const failed = PROBES.filter(p => !sample.probes[p.id].ok);
  if (failed.length) {
    return `${time}  ` + failed.map(p => `${p.id} ${sample.probes[p.id].fail}`).join('  ');
  }
  return `${time}  ` + PROBES.map(p => `${p.id} ${sample.probes[p.id].ms}`).join('  ');
}

export function setStats({rounds, elapsed, pos, speed, data, marks}) {
  $('m-rounds').textContent = rounds;
  $('m-time').textContent = elapsed;
  $('m-pos').textContent = pos;
  $('m-speed').textContent = speed;
  $('m-data').textContent = data;
  $('m-marks').textContent = marks;
}

export function setRunning(running) {
  const start = $('btn-start');
  start.textContent = running ? 'Stop' : 'Start';
  start.className = running ? 'stop' : 'start';
  // Idle, Start is the only action; it takes the whole thumb zone.
  $('btn-mark').hidden = !running;
  $('btn-mark').disabled = !running;
  // The fields describe a session that has already begun; hiding them frees the screen
  // for the readout and removes any way to edit what is already recorded.
  $('setup').hidden = running;
}

export function switchView(name) {
  for (const view of document.querySelectorAll('.view')) {
    view.hidden = view.id !== `view-${name}`;
  }
  for (const tab of document.querySelectorAll('nav button')) {
    tab.classList.toggle('on', tab.dataset.view === name);
  }
}

const dateLabel = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
    title.textContent = session.name || '(unnamed)';
    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = dateLabel(session.started);
    top.append(title, when);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const secs = Math.round(((session.stopped || session.started) - session.started) / 1000);
    const bits = [
      `${session.operator} · ${session.connection}`,
      session.route || '—',
      `${duration(secs)}`,
      `${count} rounds`,
      `${session.intervalMs / 1000}s${session.adaptive ? ' adaptive' : ''}`
    ];
    for (const b of bits) {
      const s = document.createElement('span');
      s.textContent = b;
      meta.appendChild(s);
    }
    if (!session.stopped) {
      const s = document.createElement('span');
      s.className = 'flag';
      s.textContent = 'never closed';
      meta.appendChild(s);
    }
    if (!session.exportedAt) {
      const s = document.createElement('span');
      s.className = 'flag';
      s.textContent = 'not exported';
      meta.appendChild(s);
    }

    card.append(top, meta);

    if (session.note) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = session.note;
      card.appendChild(note);
    }

    const exports = document.createElement('div');
    exports.className = 'actions';
    for (const [format, label] of [['json', 'JSON'], ['csv', 'CSV'], ['events', 'Events'],
                                   ['gpx', 'GPX'], ['geojson', 'GeoJSON']]) {
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = label;
      b.onclick = () => handlers.export(session, format);
      exports.appendChild(b);
    }
    const manage = document.createElement('div');
    manage.className = 'actions';
    for (const [label, fn] of [['Rename', 'rename'], ['Note', 'note'], ['Delete', 'remove']]) {
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = label;
      b.onclick = () => handlers[fn](session);
      manage.appendChild(b);
    }

    card.append(exports, manage);
    list.appendChild(card);
  }
}
