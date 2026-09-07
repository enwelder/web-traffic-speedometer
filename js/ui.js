// DOM rendering only. Nothing here is persisted; the screen is a live readout.

import {PROBES} from './probe.js';
import {CAPABILITIES, GRADES, gradeRound, worse, stability, capabilityValue} from './grade.js';

const STRIP_BARS = 48;
const STABILITY_ROUNDS = 10;

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
export const counts = r => !!r && r.ok === false && !r.expected &&
                           r.fail !== 'resting' && r.fail !== 'data_cap';

// The round's colour on the strip is the worst capability in it.
export function classify(sample) {
  if (sample.skipped) return 'skip';
  const g = sample.grades || gradeRound(sample);
  let worstGrade = null;
  for (const cap of CAPABILITIES) worstGrade = worse(worstGrade, g?.[cap] ?? null);
  return worstGrade || 'green';
}

// Tapped, a tile says what it measures. Keeping this off the screen by default is the
// difference between a readout and a wall of text.
const EXPLAIN = {
  realtime: 'Round trip to Cloudflare by IP address and over UDP, whichever is worse. Calls and live audio break on this before anything else does.',
  tap:      'Round trip to Google, a host your phone already knows. What a tap on a link costs before the page starts arriving.',
  newsite:  'Resolving a hostname never seen before, then reaching it. What visiting somewhere new costs, lookup included.',
  video:    'Sustained rate after the connection has finished ramping up. The ramp is discarded, so this is what the link carries rather than how fast it accelerates.'
};

const history = {};
let last = {sample: null, fails: {}, rounds: 0, shown: {}};

export function trackLatency(sample) {
  if (!sample || sample.skipped) return;
  for (const cap of CAPABILITIES) {
    const v = capabilityValue(cap, sample);
    if (v == null) continue;
    (history[cap] ??= []).push({t: sample.t, v});
    while (history[cap].length > STABILITY_ROUNDS) history[cap].shift();
  }
}

export function resetHistory() {
  for (const k of Object.keys(history)) delete history[k];
  last = {sample: null, fails: {}, rounds: 0, shown: {}};
}

export function stabilityOf(cap) {
  return stability((history[cap] || []).map(x => x.v));
}

function displayValue(cap, value) {
  if (value == null) return '—';
  return cap === 'video' ? rate(value) : String(Math.round(value));
}

export function setSignals(sample, fails, rounds, shown) {
  last = {sample, fails, rounds, shown};
  for (const cap of CAPABILITIES) {
    const cell = $(`cap-${cap}`);
    cell.classList.remove(...GRADES);
    const grade = shown?.[cap];
    if (grade) cell.classList.add(grade);
    $(`val-${cap}`).textContent = sample && sample.skipped
      ? '–' : displayValue(cap, capabilityValue(cap, sample));
  }
  renderSubtitles();
}

// Called on every round and again the moment an explanation is dismissed, so a tile never
// keeps showing prose until the next measurement lands — which on the coarse profile would
// leave it there for half a minute.
export function renderSubtitles() {
  const {sample, shown} = last;
  const p = sample && !sample.skipped ? sample.probes : null;

  for (const cap of CAPABILITIES) {
    if ($(`cap-${cap}`).dataset.explain === 'on') { $(`sub-${cap}`).textContent = EXPLAIN[cap]; continue; }
    const parts = [];
    // Variance sits beside the colour and never inside it: a link alternating between 40 ms
    // and 900 ms is a different thing from one steady at 400.
    const st = stabilityOf(cap);
    if (st) parts.push(st.ratio >= 2 ? `swinging ×${st.ratio}` : `steady ×${st.ratio}`);
    if (cap === 'realtime' && p) parts.push(`v4 ${p.ip4?.expected ? 'n/a' : p.ip4?.ok ? 'ok' : 'no'}`);
    if (cap === 'newsite' && p?.dns_ctl) {
      parts.push(p.dns_ctl.ok ? `known host ${p.dns_ctl.ms} ms` : 'known host unreachable');
      if (p.dns?.retry_suspected) parts.push('resolver retried');
    }
    if (cap === 'video' && p?.down) {
      if (p.down.fail === 'data_cap') parts.push('stopped at data cap');
      else if (p.down.insufficient_sample) parts.push('sample too short to rate');
      else if (p.down.bps_peak) parts.push(`peak ${rate(p.down.bps_peak)}`);
    }
    if (shown?.[cap]) parts.push(shown[cap]);
    $(`sub-${cap}`).textContent = parts.filter(Boolean).join(' · ') || '—';
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
  // Idle, Start is the only action; it takes the whole thumb zone.
  $('btn-mark').hidden = !running;
  $('btn-mark').disabled = !running;
  $('setup').hidden = running;
  $('labels').hidden = !running;
}

// Tap a tile to see what it measures; tap again to get the numbers back.


export function bindExplanations() {
  for (const cap of CAPABILITIES) {
    const cell = $(`cap-${cap}`);
    cell.onclick = () => {
      cell.dataset.explain = cell.dataset.explain === 'on' ? 'off' : 'on';
      renderSubtitles();
    };
  }
}

export function setExplainAll(on) {
  for (const cap of CAPABILITIES) $(`cap-${cap}`).dataset.explain = on ? 'on' : 'off';
  renderSubtitles();
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
