// DOM rendering. Nothing here is persisted.

import {PROBES} from './probe.js';
import {ACTIVITY_IDS, GRADES, ACTIVITIES, gradeActivities, worse, probeReading,
        activeRoute} from './grade.js';
import {DOWN_CEILING_BPS} from './probe.js';

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

// One activity's colour for one round. A skipped round has no measurement to grade.
export function gradeFor(activity, sample) {
  if (sample.skipped) return 'skip';
  return (sample.grades || gradeActivities(sample))?.[activity] ?? 'none';
}

// The colour of a round taken as a whole: its worst activity. Used for the log line, which
// carries one line per round.
export function classify(sample) {
  if (sample.skipped) return 'skip';
  const g = sample.grades || gradeActivities(sample);
  let worstGrade = null;
  for (const activity of ACTIVITY_IDS) worstGrade = worse(worstGrade, g?.[activity] ?? null);
  return worstGrade || 'green';
}

// One row per reading: the two address families share a row, since only the family carrying
// traffic says anything.
const ROWS = ['route', 'dns', 'dns_ctl', 'web', 'udp', 'down'];

// Each row names the request it sent, so it matches a line of the probe table. PROBES
// carries the full sentence.
const PROBE_LABELS = {
  ip6: 'GET IPv6', ip4: 'GET IPv4', dns: 'HEAD new host', dns_ctl: 'HEAD same host',
  web: 'GET gstatic', down: 'GET download', udp: 'STUN'
};
// The row id a reading comes from, and the label it carries, both depend on the round.
const rowProbe = (row, sample) =>
  (row === 'route' ? activeRoute(sample && !sample.skipped ? sample.probes : {}) : row);

const ROUTE_EXPLAIN = 'GET to an address literal, no lookup. Whichever family is carrying traffic: a network with only one of them is ordinary.';

// Where a row's number invites a wrong reading. The README argues each one.
const PROBE_CAVEATS = {
  dns: 'The whole cost of reaching a host never contacted before: resolution, connection and handshake together. A page cannot separate them.',
  down: `Three connections read together for a fixed window. Reads up to ${Math.round(DOWN_CEILING_BPS / 1e6)} Mb/s and says ≥ at that point, which is all a window this size can prove.`,
  udp: 'ICE gathering rides on top of the round trip, so this reads slower than the link is.'
};

// A row shows the measurement its colour graded, so the two always describe the same thing.
// A reading with no number — a path that is gone — says so in place of one.
function displayReading(r) {
  if (!r || (r.note == null && r.value == null)) return '—';
  if (r.note) return r.note;
  // A rate reads as itself unless the round saturated, where all that was proved is the
  // ceiling and the ≥ says so.
  if (r.unit === 'bps') return (r.saturated ? '≥' : '') + rate(r.value);
  return String(Math.round(r.value));
}

// `rate` writes its own unit, and a term reporting a gone path has none. The DNS delta says
// what its number is, since every other row prints a plain latency in the same column.
function displayUnit(r) {
  if (!r || r.note || r.value == null || r.unit !== 'ms') return '';
  return 'ms';
}

// Rows are generated from ROWS and named from PROBES; the strips are named from ACTIVITIES.
// Nothing on screen carries a name this file invents.
export function buildProbeRows() {
  const host = $('probes');
  host.textContent = '';
  for (const id of ROWS) {
    const row = document.createElement('div');
    row.className = 'probe';
    row.id = `probe-${id}`;
    const add = (cls, id, text) => {
      const el = document.createElement('span');
      el.className = cls;
      if (id) el.id = id;
      el.textContent = text || '';
      row.appendChild(el);
      return el;
    };
    add('name', `pname-${id}`, PROBE_LABELS[rowProbe(id, null)] ?? id);
    add('value', `pval-${id}`, '—');
    add('unit', `punit-${id}`, '');
    add('explain', `explain-probe-${id}`, '');
    host.appendChild(row);
  }
  for (const activity of ACTIVITY_IDS) {
    $(`strip-name-${activity}`).textContent = ACTIVITIES[activity].label;
  }
}

// Every cell that can explain itself, in the order they appear.
const cells = () => ROWS.map(id => `probe-${id}`);

const explainText = id => {
  const row = id.slice(6);
  return [row === 'route' ? ROUTE_EXPLAIN : PROBES.find(p => p.id === row)?.label,
          PROBE_CAVEATS[row]].filter(Boolean).join(' ');
};

// Each probe's own measurement and the colour it grades to, from the round passed in.
export function setProbes(sample) {
  for (const id of ROWS) {
    const cell = $(`probe-${id}`);
    if (!cell) continue;
    const probe = rowProbe(id, sample);
    cell.classList.remove(...GRADES);
    const reading = sample && !sample.skipped ? probeReading(probe, sample) : null;
    if (reading?.grade) cell.classList.add(reading.grade);
    // A word in place of a number is a reason, and is styled apart from a measurement.
    cell.classList.toggle('words', !!reading?.note);
    $(`pname-${id}`).textContent = PROBE_LABELS[probe] ?? probe;
    $(`pval-${id}`).textContent = sample?.skipped ? '–' : displayReading(reading);
    $(`punit-${id}`).textContent = displayUnit(reading);
  }
}

export function renderExplanations() {
  for (const id of cells()) {
    const cell = $(id);
    if (!cell) continue;
    const on = cell.dataset.explain === 'on';
    cell.classList.toggle('explaining', on);
    $(`explain-${id}`).textContent = on ? explainText(id) : '';
  }
}

// One strip per activity, each always full width with empty slots dimmed, scrolling right to
// left. Separate rows are what make a single failing activity visible: one combined row shows
// only the worst of them and never says which.
export function clearStrip() {
  for (const activity of ACTIVITY_IDS) {
    const strip = $(`strip-${activity}`);
    strip.replaceChildren();
    for (let i = 0; i < STRIP_BARS; i++) {
      const bar = document.createElement('i');
      bar.className = 'none';
      strip.appendChild(bar);
    }
  }
}

export function pushStrip(sample) {
  for (const activity of ACTIVITY_IDS) {
    const strip = $(`strip-${activity}`);
    const bar = document.createElement('i');
    bar.className = gradeFor(activity, sample);
    strip.appendChild(bar);
    while (strip.children.length > STRIP_BARS) strip.removeChild(strip.firstChild);
  }
}

// A bridged gap belongs on every row: no activity was measured while the page was frozen.
export function pushStripPause() {
  for (const activity of ACTIVITY_IDS) {
    const strip = $(`strip-${activity}`);
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


// What changed since the round before. Thirty rounds of an unremarkable connection produced
// thirty near-identical lines, and the one fact that mattered — a family that had stopped
// answering — was invisible among them. A line now marks a transition.

// One line per thing that moved. With no round before it, only what is not already fine is
// worth saying.
function transitions(ids, {label, now, then, fine}) {
  const out = [];
  for (const id of ids) {
    const to = now(id);
    const from = then(id);
    if (from === null) { if (to !== fine) out.push(`${label(id)} ${to}`); continue; }
    if (from !== to) out.push(`${label(id)} ${from} → ${to}`);
  }
  return out;
}

export function changes(sample, prev) {
  const time = clock(sample.t);
  if (sample.skipped) return [`${time}  skipped: ${sample.skipped} (${sample.late_ms} ms late)`];
  if (sample.round_error) return [`${time}  round error: ${sample.round_error}`];

  // Only what a strip cannot already show. An activity changing colour is on screen as a bar;
  // which probe moved, and to what, is not anywhere else.
  const before = prev && !prev.skipped ? prev : null;
  return transitions(PROBES.map(p => p.id), {
    label: id => id,
    now: id => probeReading(id, sample).state,
    then: id => (before ? probeReading(id, before).state : null),
    fine: 'ok'
  }).map(line => `${time}  ${line}`);
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
  // While idle Start is the only action and takes the whole width, and there is nothing on
  // screen for the help control to explain.
  $('btn-mark').hidden = !running;
  $('btn-mark').disabled = !running;
  $('btn-help').hidden = !running;
  $('setup').hidden = running;
}

// Which build is on screen, so a tester can tell one from another without opening a file.
export function setVersion(v) { $('app-version').textContent = v; }

// Tap a row to see what it measures; tap again for the number.
export function bindExplanations() {
  for (const id of cells()) {
    const cell = $(id);
    if (!cell) continue;
    cell.onclick = () => {
      cell.dataset.explain = cell.dataset.explain === 'on' ? 'off' : 'on';
      renderExplanations();
    };
  }
}

export function setExplainAll(on) {
  for (const id of cells()) { const c = $(id); if (c) c.dataset.explain = on ? 'on' : 'off'; }
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
