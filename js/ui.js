// DOM rendering only. Nothing here is persisted; the screen is a live readout.

import {PROBES} from './probe.js';

const STRIP_BARS = 48;
const SLOW_MS = 400;
const TILES = ['ip6', 'dns', 'web', 'down'];   // ip4 rides along in the ip6 tile's subtitle

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

export function classify(sample) {
  if (sample.skipped) return 'skip';
  const r = id => sample.probes[id] || {};
  const reachable = r('ip6').ok || r('ip4').ok;
  if (!reachable && !r('web').ok) return 'down';
  if (!r('dns').ok && reachable) return 'dns';
  if (!r('down').ok || !r('web').ok) return 'part';
  return PROBES.some(p => p.kind === 'trace' && r(p.id).ok && r(p.id).ms > SLOW_MS) ? 'slow' : 'up';
}

const FLOOR_MS = 2;   // below this the transfer window is shorter than the clock resolves

function tileValue(id, r) {
  if (!r) return '—';
  if (!r.ok) return r.fail === 'timeout' ? 'to' : r.fail === 'http' ? String(r.status) : 'gone';
  if (id !== 'down') return String(r.ms);
  // An unmeasurably short transfer still bounds the rate from below, which beats showing
  // nothing for a download that plainly succeeded.
  return r.bps ? rate(r.bps) : `>${rate((r.bytes * 8) / (FLOOR_MS / 1000))}`;
}

export function setSignals(sample, fails) {
  for (const id of TILES) {
    const cell = $(`sig-${id}`);
    const r = sample && !sample.skipped ? sample.probes[id] : null;
    cell.classList.remove('up', 'slow', 'down');
    if (r) cell.classList.add(!r.ok ? 'down' : (id !== 'down' && r.ms > SLOW_MS) ? 'slow' : 'up');
    $(`val-${id}`).textContent = sample && sample.skipped ? '–' : tileValue(id, r);
    $(`sub-${id}`).textContent = `${fails[id] || 0} failed`;
  }
  // IPv4 is a property of the network rather than of the round, so it reads as a marker
  // on the reachability tile instead of taking a tile of its own.
  const v4 = sample && !sample.skipped ? sample.probes.ip4 : null;
  if (v4) $('sub-ip6').textContent = `${fails.ip6 || 0} failed · v4 ${v4.ok ? 'ok' : 'no'}`;
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
  if (failed.length) return `${time}  ` + failed.map(p => `${p.id} ${sample.probes[p.id].fail}`).join('  ');
  const d = sample.probes.down;
  return `${time}  v6 ${sample.probes.ip6.ms}  dns ${sample.probes.dns.ms}  ${d.bps ? rate(d.bps) : 'fast'}` +
         (d.server && d.server.retrans ? `  retrans ${d.server.retrans}` : '');
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
  $('setup').hidden = running;
}

export function switchView(name) {
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== `view-${name}`;
  for (const tab of document.querySelectorAll('nav button')) tab.classList.toggle('on', tab.dataset.view === name);
}

// Short, because the generated name already carries date and time; this is what keeps the
// date on the card after a rename.
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
