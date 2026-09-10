// DOM rendering; no persistence.

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

// Base 10 throughout, matching the bit rates beside it: 1,000,000 bytes divided by 1024 reads
// as 977 kB, one byte more reads as 1.0 MB.
export function bytes(b) {
  return b < 1e6 ? `${Math.round(b / 1e3)} kB` : `${(b / 1e6).toFixed(1)} MB`;
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

// One activity's colour for one round.
export function gradeFor(activity, sample) {
  return (sample.grades || gradeActivities(sample))?.[activity] ?? 'none';
}

// The colour of a round taken as a whole: its worst activity. Used for the log line, which
// carries one line per round.
export function classify(sample) {
  const g = sample.grades || gradeActivities(sample);
  let worstGrade = null;
  for (const activity of ACTIVITY_IDS) worstGrade = worse(worstGrade, g?.[activity] ?? null);
  return worstGrade || 'green';
}

// One row per reading; both address families share the route row, which shows the family
// carrying traffic.
const ROWS = ['route', 'dns', 'dns_ctl', 'web', 'udp', 'down'];

// Row labels name the request, matching the probe table; PROBES holds the full label.
const PROBE_LABELS = {
  ip6: 'GET IPv6', ip4: 'GET IPv4', dns: 'HEAD new host', dns_ctl: 'HEAD same host',
  web: 'GET gstatic', down: 'GET download', udp: 'STUN'
};
// The row id a reading comes from, and the label it carries, both depend on the round.
const rowProbe = (row, sample) =>
  (row === 'route' ? activeRoute(sample ? sample.probes : {}) : row);

const ROUTE_EXPLAIN = 'GET to an address literal, no lookup. Whichever family is carrying traffic: a network with only one of them is ordinary.';

// Caveats for rows whose value is easily misread; the README documents each.
const PROBE_CAVEATS = {
  dns: 'The whole cost of reaching a host never contacted before: resolution, connection and handshake together. A page cannot separate them.',
  down: `Three connections read together for a fixed window. Reads up to ${Math.round(DOWN_CEILING_BPS / 1e6)} Mb/s and says ≥ at that point, which is all a window this size can prove.`,
  udp: 'ICE gathering rides on top of the round trip, so this reads slower than the link is. Calls grade on it, since call audio travels over UDP.'
};

// A row shows the measurement its colour graded. A reading without a value shows its note.
function displayReading(r) {
  if (!r || (r.note == null && r.value == null)) return '—';
  if (r.note) return r.note;
  // A saturated rate is a lower bound and prints with ≥.
  if (r.unit === 'bps') return (r.saturated ? '≥' : '') + rate(r.value);
  return String(Math.round(r.value));
}

// `rate` formats its own unit; a note has no unit; latency values print ms.
function displayUnit(r) {
  if (!r || r.note || r.value == null || r.unit !== 'ms') return '';
  return 'ms';
}

// Rows are generated from ROWS and labelled from PROBES; strips are labelled from ACTIVITIES.
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

// Cells with an explanation, in display order.
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
    const reading = sample ? probeReading(probe, sample) : null;
    if (reading?.grade) cell.classList.add(reading.grade);
    // A note in place of a value is styled apart from a measurement.
    cell.classList.toggle('words', !!reading?.note);
    $(`pname-${id}`).textContent = PROBE_LABELS[probe] ?? probe;
    $(`pval-${id}`).textContent = displayReading(reading);
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

// One strip per activity, full width with empty slots dimmed, scrolling right to left. Separate
// strips show which activity failed.
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

// A bridged gap marks every strip: the page was frozen and no round ran.
export function pushStripPause() {
  for (const activity of ACTIVITY_IDS) {
    const strip = $(`strip-${activity}`);
    const bar = document.createElement('i');
    bar.className = 'pause';
    strip.appendChild(bar);
    while (strip.children.length > STRIP_BARS) strip.removeChild(strip.firstChild);
  }
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


// Log lines for probe state transitions since the previous round.

// One line per changed probe; without a previous round, one line per probe state other than ok.
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
  if (sample.round_error) return [`${time}  round error: ${sample.round_error}`];

  // Probe transitions only; activity grades are on the strips.
  return transitions(PROBES.map(p => p.id), {
    label: id => id,
    now: id => probeReading(id, sample).state,
    then: id => (prev ? probeReading(id, prev).state : null),
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
  // While idle, Start takes the full width and the help control is hidden, since no rows show.
  $('btn-mark').hidden = !running;
  $('btn-mark').disabled = !running;
  $('btn-help').hidden = !running;
  $('setup').hidden = running;
}

// Build version, identifying the running build.
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

// A string is a session fact; a pair is a fact and its flag class.
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
