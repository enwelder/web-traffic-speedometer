// DOM rendering only. Nothing here is persisted; the screen is a live readout.

import {PROBES} from './probe.js';

const STRIP_BARS = 48;
const SLOW_MS = 400;
const TILES = ['ip6', 'dns', 'web', 'down'];   // ip4 and dns_ctl ride along in subtitles
const P90_WINDOW_MS = 5 * 60 * 1000;

// Tapped, a tile says what it measures. Keeping this off the screen by default is the
// difference between a readout and a wall of text.
const EXPLAIN = {
  ip6: 'Cloudflare by IP address, so no name lookup happens. If this is up, the radio link works.',
  dns: 'A hostname never used before, so your operator has to resolve it for real. Compare with the cached one beside it.',
  web: 'A different provider than the other probes. If only this fails, the fault is theirs, not the network.',
  down: 'A page-sized download. Reachability can look fine while there is no usable speed.'
};

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

// A failure counts only if the probe ran and was not expected to fail: an absent record is
// not a failure, and neither is an IPv4 literal on a network with no IPv4 path.
export const counts = r => !!r && r.ok === false && !r.expected;

export function classify(sample) {
  if (sample.skipped) return 'skip';
  const r = id => sample.probes[id] || {};
  const reachable = r('ip6').ok || r('ip4').ok;
  if (!reachable && !r('web').ok) return 'down';
  if (!r('dns').ok && reachable) return 'dns';
  if (counts(r('web')) || counts(r('down'))) return 'part';
  return PROBES.some(p => p.kind === 'trace' && r(p.id).ok && r(p.id).ms > SLOW_MS) ? 'slow' : 'up';
}

const FLOOR_MS = 2;   // below this the transfer window is shorter than the clock resolves

function tileValue(id, r) {
  if (!r) return '—';
  if (!r.ok) return r.fail === 'timeout' ? 'to' : r.fail === 'http' ? String(r.status) : 'gone';
  if (id !== 'down') return String(r.ms);
  // An unmeasurably short transfer still bounds the rate from below, which beats showing
  // nothing for a download that plainly succeeded.
  return r.bps_transfer ? rate(r.bps_transfer) : `>${rate((r.bytes * 8) / (FLOOR_MS / 1000))}`;
}

// A rolling p90 per probe. The median across a whole journey was 82 ms and said nothing;
// the p90 over the last few minutes is the number that moves when the connection does.
const history = {};

export function trackLatency(sample) {
  if (!sample || sample.skipped) return;
  for (const id of TILES) {
    const r = sample.probes[id];
    if (!r || !r.ok || r.ms == null) continue;
    (history[id] ??= []).push({t: sample.t, ms: r.ms});
    const cutoff = sample.t - P90_WINDOW_MS;
    while (history[id].length && history[id][0].t < cutoff) history[id].shift();
  }
}

export function p90(id) {
  const h = history[id];
  if (!h || h.length < 5) return null;
  const v = h.map(x => x.ms).sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(v.length * 0.9))];
}

export function resetHistory() { for (const k of Object.keys(history)) delete history[k]; }

export function setSignals(sample, fails, rounds) {
  for (const id of TILES) {
    const cell = $(`sig-${id}`);
    const r = sample && !sample.skipped ? sample.probes[id] : null;
    cell.classList.remove('up', 'slow', 'down');
    if (r) cell.classList.add(!r.ok ? 'down' : (id !== 'down' && r.ms > SLOW_MS) ? 'slow' : 'up');
    $(`val-${id}`).textContent = sample && sample.skipped ? '–' : tileValue(id, r);
    if ($(`sig-${id}`).dataset.explain === 'on') continue;
    const n = fails[id] || 0;
    const worst = p90(id);
    $(`sub-${id}`).textContent =
      (worst == null ? 'p90 —' : id === 'down' ? `p90 ${rate(worst)}` : `p90 ${worst}`) +
      (n ? ` · ${n}/${rounds} failed` : '');
  }

  const p = sample && !sample.skipped ? sample.probes : null;
  if (p) {
    // IPv4 is a property of the network rather than of the round, so it reads as a marker
    // on the reachability tile instead of taking a tile of its own.
    if ($('sig-ip6').dataset.explain !== 'on') {
      const v4 = p.ip4.expected ? 'n/a' : p.ip4.ok ? 'ok' : 'no';
      const worst = p90('ip6');
      $('sub-ip6').textContent = `${worst == null ? 'p90 —' : 'p90 ' + worst} · v4 ${v4}` +
        ((fails.ip6 || 0) ? ` · ${fails.ip6}/${rounds} failed` : '');
    }
    // The cached-name control shares the DNS probe's destination, so the pair separates a
    // resolution failure from the destination simply being unreachable.
    if (p.dns_ctl && $('sig-dns').dataset.explain !== 'on') {
      const worst = p90('dns');
      $('sub-dns').textContent = `${worst == null ? 'p90 —' : 'p90 ' + worst} · cached ${p.dns_ctl.ok ? p.dns_ctl.ms : 'no'}`;
    }
    // Both rates on the tile: the payload phase as the headline, end-to-end beneath it,
    // since at these sizes the difference between them is the connection setup.
    if (p.down && $('sig-down').dataset.explain !== 'on') {
      const e2e = p.down.bps_end_to_end ? rate(p.down.bps_end_to_end) : '—';
      $('sub-down').textContent = p.down.truncated
        ? `cut short at ${(p.down.bytes / 1000) | 0} kB`
        : `e2e ${e2e}` + ((fails.down || 0) ? ` · ${fails.down}/${rounds} failed` : '');
    }
  }
}

// The strip is always full width, with empty slots dimmed. Filling it up from the left
// would read as progress towards something; it is a history, scrolling right to left.
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
  $('strip-span').textContent = minutes >= 1 ? `last ${minutes} min` : `last ${Math.round(STRIP_BARS * intervalMs / 1000)}s`;
}

// Newest first. Appending put the line that matters at the bottom, where the controls sit
// over it and reading it meant scrolling on a moving train.
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
  const failed = PROBES.filter(p => counts(sample.probes[p.id]));
  if (failed.length) return `${time}  ` + failed.map(p => `${p.id} ${sample.probes[p.id].fail}`).join('  ');
  const d = sample.probes.down;
  const dns = sample.probes.dns.ms;
  const ctl = sample.probes.dns_ctl?.ms;
  return `${time}  v6 ${sample.probes.ip6.ms}  dns ${dns}${ctl != null ? '/' + ctl : ''}` +
         (d ? `  ${d.bps_transfer ? rate(d.bps_transfer) : 'fast'}` : '');
}

export function setStats({rounds, elapsed, pos, speed, data, marks, udp, degraded}) {
  $('m-rounds').textContent = rounds;
  $('m-time').textContent = elapsed;
  $('m-pos').textContent = pos;
  $('m-speed').textContent = speed;
  $('m-data').textContent = data;
  $('m-marks').textContent = marks;
  $('m-udp').textContent = udp;
  $('m-degraded').textContent = degraded;
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

// Tap a tile to see what it measures; tap again to get the numbers back.
export function bindExplanations() {
  for (const id of TILES) {
    const cell = $(`sig-${id}`);
    cell.onclick = () => {
      const on = cell.dataset.explain === 'on';
      cell.dataset.explain = on ? 'off' : 'on';
      if (!on) $(`sub-${id}`).textContent = EXPLAIN[id];
    };
  }
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
