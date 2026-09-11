// JSON export.

// Nearest rank: the smallest value at or above the quantile. Rounding the index down puts a
// ten-sample window on its own last element, making p90 the maximum.
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

import {PROBES} from './probe.js';
import {APP_VERSION} from './session.js';
import {ACTIVITY_IDS, SCALES, ACTIVITIES, PROBE_SCALES} from './grade.js';
import * as store from './store.js';

// Probe failure predicate, shared by the screen and the export. Excluded: `resting` (no request
// sent), `expected` (family absent), `blocked` and `unused` literals (address refused, or traffic
// on the other family), `short` (span too brief to divide by, or an upload count the browser
// could not read), `no_budget` (the round had no time left for the upload), `abort` (the app ended
// the request: a stop or an interrupted round) and `error` (the round threw).
const NOT_THE_LINK = new Set(['resting', 'short', 'no_budget', 'abort', 'error']);

export const countsAsFailure = r =>
  !!r && r.ok === false && !r.expected && !r.blocked && !r.unused && !NOT_THE_LINK.has(r.fail);

// One probe across the rounds that ran. Link failures (`fails`), tool stops (`stopped`) and
// `expected`, `blocked` and `unused` literals are counted separately.
function probeSummary(rs) {
  const ok = rs.filter(r => r.ok);
  const ms = ok.map(r => r.ms).filter(v => v != null).sort((a, b) => a - b);
  const fails = {};
  const stopped = {};
  for (const r of rs) {
    if (r.ok || r.expected || r.blocked || r.unused) continue;
    const into = countsAsFailure(r) ? fails : stopped;
    into[r.fail] = (into[r.fail] || 0) + 1;
  }
  return {
    n: rs.length, ok: ok.length,
    expected: rs.filter(r => r.expected).length,
    blocked: rs.filter(r => r.blocked).length,
    unused: rs.filter(r => r.unused).length,
    fails, stopped,
    ms_p50: quantile(ms, 0.5), ms_p90: quantile(ms, 0.9), ms_max: ms.at(-1) ?? null
  };
}

// The download and upload probes report a rate.
function rateSummary(rs) {
  const ok = rs.filter(r => r.ok);
  const rates = ok.map(r => r.bps).filter(v => v != null).sort((a, b) => a - b);
  return {
    // Each value is a lower bound, so these are percentiles of lower bounds.
    bps_p10: quantile(rates, 0.1),
    bps_p50: quantile(rates, 0.5),
    rated: rates.length,
    // Rounds that reached the byte cap: the bound equals the ceiling.
    saturated: ok.filter(r => r.saturated).length,
    bytes_total: ok.reduce((n, r) => n + (r.bytes || 0), 0)
  };
}

// Grades as resolved during the run, for threshold checks against marks without regrading.
function gradeTally(ran, keys, field) {
  const grades = {};
  for (const key of keys) {
    const seen = {};
    for (const s of ran) {
      const g = s[field]?.[key];
      if (g) seen[g] = (seen[g] || 0) + 1;
    }
    grades[key] = seen;
  }
  return grades;
}

// 13: `up` carries `saturated` and `ceiling_bps`; `abort` leaves the failure tallies.
const FORMAT_VERSION = 13;

// A row carrying `skipped` comes from a file written before format 11, where a slot that could
// not start was a row.
export function summarise(samples, events = []) {
  const ran = samples.filter(s => !s.skipped && !s.round_error && !s.interrupted);
  const skips = events.filter(e => e.type === 'skip').length;
  const probes = {};
  for (const p of PROBES) {
    const rs = ran.map(s => s.probes[p.id]).filter(Boolean);
    probes[p.id] = p.id === 'down' || p.id === 'up'
      ? {...probeSummary(rs), ...rateSummary(rs)}
      : probeSummary(rs);
  }

  const fixed = ran.filter(s => s.accuracy_class === 'gps');
  return {
    scales: SCALES,
    activities: ACTIVITIES,
    probe_scales: PROBE_SCALES,
    grades: gradeTally(ran, ACTIVITY_IDS, 'grades'),
    grades_by_probe: gradeTally(ran, Object.keys(PROBE_SCALES), 'pgrades'),
    generated_by: `wts ${APP_VERSION}`,
    rounds: samples.length,
    ran: ran.length,
    // Every slot the scheduler reached: the rounds that ran and the slots that could not start.
    slots: samples.length + skips,
    skipped: samples.filter(s => s.skipped).length + skips,
    round_errors: samples.filter(s => s.round_error).length,
    // Rounds the page left mid-way; their probes enter no tally.
    interrupted: samples.filter(s => s.interrupted && !s.skipped && !s.round_error).length,
    in_pause: ran.filter(s => s.in_pause).length,
    // Rounds with at least one failure outside a known-absent path.
    degraded: ran.filter(s => PROBES.some(p => countsAsFailure(s.probes[p.id]))).length,
    wake_lock_held: ran.filter(s => s.wake_lock).length,
    fixes_gps: fixed.length,
    fixes_coarse: ran.filter(s => s.accuracy_class === 'coarse').length,
    first_t: samples[0]?.t ?? null,
    last_t: samples.at(-1)?.t ?? null,
    probes
  };
}

export function sessionJson(session, samples, events) {
  return JSON.stringify({
    format: 'wts/session',
    version: FORMAT_VERSION,
    app_version: APP_VERSION,
    exported: new Date().toISOString(),
    probes: PROBES.map(p => ({id: p.id, label: p.label, url: p.url, kind: p.kind})),
    summary: summarise(samples, events),
    session, samples, events
  }, null, 1);
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';
}

// Local time, so a file name matches the clock of the person who recorded it.
function localStamp(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function filename(session) {
  // An unreadable start time falls back to the current time, which keeps NaN out of the filename.
  const started = Number.isFinite(session.started) ? session.started : Date.now();
  return `wts-${localStamp(started)}-${slug(session.operator || session.connection)}.json`;
}

export const bundleFilename = exportedAt => `wts-all-${localStamp(exportedAt)}.json`;

function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], {type: 'application/json;charset=utf-8'}));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function exportSession(session) {
  const [samples, events] = await Promise.all([store.getSamples(session.id), store.getEvents(session.id)]);
  download(sessionJson(session, samples, events), filename(session));
  return {samples: samples.length, events: events.length};
}

export async function exportAll() {
  const sessions = await store.allSessions();
  const bundles = [];
  for (const session of sessions) {
    const [samples, events] = await Promise.all([store.getSamples(session.id), store.getEvents(session.id)]);
    bundles.push({session, samples, events});
  }
  download(JSON.stringify({
    format: 'wts/bundle', version: FORMAT_VERSION, app_version: APP_VERSION,
    exported: new Date().toISOString(),
    probes: PROBES.map(p => ({id: p.id, label: p.label, url: p.url, kind: p.kind})),
    sessions: bundles
  }, null, 1), bundleFilename(Date.now()));
  return sessions;
}
