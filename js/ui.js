// DOM rendering only. Nothing here is persisted; the screen is a live readout.

import {PROBES} from './probe.js';

const STRIP_BARS = 48;

// Grades named for what the connection can actually carry, not for round numbers.
//
//   good    pages open promptly, music streams, chat is instant
//   ok      music and chat fine, pages noticeably slow
//   poor    chat still works, music stutters, pages barely load
//   bad     nothing usable
//
// Latency bounds come from page loads, which spend several round trips before anything
// renders: under 300 ms feels immediate, beyond a second it feels broken. Rate bounds come
// from the two things actually being done on a train — streamed audio needs about 0.3 Mb/s
// sustained, so 0.5 is the floor with room to buffer, and a 2 MB page needs 3 Mb/s to
// arrive in a few seconds rather than half a minute.
const LATENCY_BANDS = [[300, 'good'], [1000, 'ok'], [3000, 'poor']];
const RATE_BANDS = [[3e6, 'good'], [5e5, 'ok'], [1e5, 'poor']];
const GRADE_RANK = {good: 0, ok: 1, poor: 2, bad: 3};

export function gradeLatency(ms) {
  if (ms == null) return null;
  for (const [limit, grade] of LATENCY_BANDS) if (ms < limit) return grade;
  return 'bad';
}

export function gradeRate(bps) {
  if (bps == null) return null;
  for (const [floor, grade] of RATE_BANDS) if (bps >= floor) return grade;
  return 'bad';
}

const worseOf = (a, b) => (GRADE_RANK[a] >= GRADE_RANK[b] ? a : b);
const TILES = ['ip6', 'dns', 'web', 'udp', 'down'];   // ip4 and dns_ctl ride along in subtitles
const P90_WINDOW_MS = 5 * 60 * 1000;

// Tapped, a tile says what it measures. Keeping this off the screen by default is the
// difference between a readout and a wall of text.
const EXPLAIN = {
  ip6: 'Cloudflare, reached by IP address so no name lookup is involved. If this answers, the connection itself is working.',
  dns: 'A GitHub Pages hostname never used before, so your operator has to resolve it for real. The figure beside it is the same host asked for again once its name is known.',
  web: 'Google, not Cloudflare. If this is the only one failing, the fault is at one company rather than on your connection.',
  udp: 'A STUN request, the only probe that leaves over UDP. Calls and streaming ride on UDP, and a carrier can treat it differently from the rest.',
  down: 'A page-sized download from Cloudflare. Everything above can answer quickly while there is still no usable speed.'
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

// The grade of a round is the worst thing about it: a fast link that cannot resolve names
// is not a good connection, and neither is a responsive one delivering no bytes.
export function classify(sample) {
  if (sample.skipped) return 'skip';
  const r = id => sample.probes[id] || {};
  const reachable = r('ip6').ok || r('ip4').ok;
  if (!reachable && !r('web').ok) return 'bad';
  // Names not resolving means nothing loads, however quick the link is.
  if (!r('dns').ok && reachable) return 'poor';

  let grade = 'good';
  for (const id of ['ip6', 'dns', 'web']) {
    const p = r(id);
    if (counts(p)) return 'bad';
    if (p.ok) grade = worseOf(grade, gradeLatency(p.ms));
  }
  const d = r('down');
  if (counts(d)) grade = worseOf(grade, 'poor');
  else if (d.ok && d.bps_transfer != null) grade = worseOf(grade, gradeRate(d.bps_transfer));
  return grade;
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
let last = {sample: null, fails: {}, rounds: 0};

// Latency probes contribute their round trip; the download contributes its rate, since a
// millisecond figure rendered as a bitrate is how the tile came to read "p90 0 kb/s".
export function trackLatency(sample) {
  if (!sample || sample.skipped) return;
  for (const id of TILES) {
    const r = sample.probes[id];
    if (!r || !r.ok) continue;
    const v = id === 'down' ? r.bps_transfer : r.ms;
    if (v == null) continue;
    (history[id] ??= []).push({t: sample.t, v});
    const cutoff = sample.t - P90_WINDOW_MS;
    while (history[id].length && history[id][0].t < cutoff) history[id].shift();
  }
}

// Under eight samples a ninetieth percentile is just the largest value, so it is labelled
// as the maximum until there are enough for the word to mean anything. On a 30 s interval
// that fills after a minute and a half instead of showing a dash for four.
const P90_MIN = 8;
const WORST_MIN = 3;

// Nearest-rank: the smallest value at or above the quantile. Rounding the index down
// instead put a ten-sample window on its last element, so anything labelled p90 was in fact
// the maximum, and it read high for a quarter of a journey's windows.
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

export function worst(id) {
  const h = history[id];
  if (!h || h.length < WORST_MIN) return null;
  const v = h.map(x => x.v).sort((a, b) => a - b);
  // For a rate the bad end is the bottom, so the worst recent throughput is the low
  // percentile, not the high one.
  if (id === 'down') {
    return h.length < P90_MIN
      ? {label: 'slowest', value: v[0]}
      : {label: 'p10', value: quantile(v, 0.1)};
  }
  return h.length < P90_MIN
    ? {label: 'max', value: v[v.length - 1]}
    : {label: 'p90', value: quantile(v, 0.9)};
}

export function resetHistory() {
  for (const k of Object.keys(history)) delete history[k];
  last = {sample: null, fails: {}, rounds: 0};
}

export function setSignals(sample, fails, rounds) {
  last = {sample, fails, rounds};
  for (const id of TILES) {
    const cell = $(`sig-${id}`);
    const r = sample && !sample.skipped ? sample.probes[id] : null;
    cell.classList.remove('good', 'ok', 'poor', 'bad');
    if (r) {
      const g = !r.ok ? 'bad'
        : id === 'down' ? (gradeRate(r.bps_transfer) || 'good')
        : (gradeLatency(r.ms) || 'good');
      cell.classList.add(g);
    }
    $(`val-${id}`).textContent = sample && sample.skipped ? '–' : tileValue(id, r);
  }
  renderSubtitles();
}

// Called on every round and again the moment an explanation is dismissed, so a tile never
// keeps showing prose until the next measurement lands — which on the coarse profile would
// leave it there for half a minute.
export function renderSubtitles() {
  const {sample, fails, rounds} = last;
  const p = sample && !sample.skipped ? sample.probes : null;

  for (const id of TILES) {
    if ($(`sig-${id}`).dataset.explain === 'on') { $(`sub-${id}`).textContent = EXPLAIN[id]; continue; }
    const w = worst(id);
    const head = w == null ? '' : id === 'down' ? `${w.label} ${rate(w.value)}` : `${w.label} ${w.value} ms`;
    const n = fails[id] || 0;
    const tail = n ? `${n}/${rounds} failed` : '';
    const extra = [];

    if (id === 'ip6' && p) extra.push(`v4 ${p.ip4.expected ? 'n/a' : p.ip4.ok ? 'ok' : 'no'}`);
    // Named so it reads as a comparison: the same host, asked for again once its name is
    // already known. The gap between the two is what a lookup costs.
    if (id === 'dns' && p?.dns_ctl) {
      extra.push(p.dns_ctl.ok ? `same host cached ${p.dns_ctl.ms} ms` : 'same host unreachable');
    }
    if (id === 'down' && p?.down) {
      if (p.down.truncated) extra.push(`cut short at ${(p.down.bytes / 1000) | 0} kB`);
      else if (p.down.bps_end_to_end) extra.push(`${rate(p.down.bps_end_to_end)} end to end`);
    }

    $(`sub-${id}`).textContent = [head, ...extra, tail].filter(Boolean).join(' · ') || '—';
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
  $('strip-span').textContent = minutes >= 1
    ? `${minutes} min ago`
    : `${Math.round(STRIP_BARS * intervalMs / 1000)}s ago`;
}

// Lit, dim or unlit: which paths are carrying traffic, with no sentence to read.
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

// One control turns every explanation on, since a tile that only reacts to being tapped is
// not discoverable.
export function setExplainAll(on) {
  for (const id of TILES) $(`sig-${id}`).dataset.explain = on ? 'on' : 'off';
  renderSubtitles();
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

export function setStats({rounds, elapsed, pos, speed, data, marks, degraded}) {
  $('m-rounds').textContent = rounds;
  $('m-time').textContent = elapsed;
  $('m-pos').textContent = pos;
  $('m-speed').textContent = speed;
  $('m-data').textContent = data;
  $('m-marks').textContent = marks;
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
      renderSubtitles();
    };
  }
}

export function switchView(name) {
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== `view-${name}`;
  for (const tab of document.querySelectorAll('nav button')) tab.classList.toggle('on', tab.dataset.view === name);
  // Start and Mark belong to measuring; on the session list they would act on nothing.
  $('controls').hidden = name !== 'measure';
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
