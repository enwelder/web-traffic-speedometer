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

// What counts as a probe failure: a resting probe has not reached the network, and an IPv4
// literal on a network with no IPv4 path is a known-absent path. Shared with the screen so
// the percentage shown and the count in the file agree.
export const countsAsFailure = r =>
  !!r && r.ok === false && !r.expected && r.fail !== 'resting';

// One probe across the rounds that ran. Failures and deliberate stops are counted apart,
// so neither hides the other.
function probeSummary(rs) {
  const ok = rs.filter(r => r.ok);
  const ms = ok.map(r => r.ms).filter(v => v != null).sort((a, b) => a - b);
  const fails = {};
  const stopped = {};
  for (const r of rs) {
    if (r.ok || r.expected) continue;
    const into = countsAsFailure(r) ? fails : stopped;
    into[r.fail] = (into[r.fail] || 0) + 1;
  }
  return {
    n: rs.length, ok: ok.length,
    expected: rs.filter(r => r.expected).length,
    fails, stopped,
    ms_p50: quantile(ms, 0.5), ms_p90: quantile(ms, 0.9), ms_max: ms.at(-1) ?? null
  };
}

// The download probe alone reports a throughput bound.
function rateSummary(rs) {
  const ok = rs.filter(r => r.ok);
  const bound = ok.map(r => r.bps_min).filter(v => v != null).sort((a, b) => a - b);
  return {
    // Bounds, not rates: each is what that round's bytes proved, so a percentile over them
    // is a percentile of proven floors.
    bps_min_p10: quantile(bound, 0.1),
    bps_min_p50: quantile(bound, 0.5),
    rated: bound.length,
    // Rounds whose body arrived whole, where the bound sits close to the rate.
    complete: ok.filter(r => r.complete).length,
    bytes_total: ok.reduce((n, r) => n + (r.bytes || 0), 0)
  };
}

// The grades resolved during the run, so thresholds can be checked against what was felt
// without recomputing anything.
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

// 4: every round carries its per-probe grades beside its activity grades.
const FORMAT_VERSION = 4;

export function summarise(samples) {
  const ran = samples.filter(s => !s.skipped && !s.round_error);
  const probes = {};
  for (const p of PROBES) {
    const rs = ran.map(s => s.probes[p.id]).filter(Boolean);
    probes[p.id] = p.id === 'down'
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
    skipped: samples.filter(s => s.skipped).length,
    round_errors: samples.filter(s => s.round_error).length,
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
    summary: summarise(samples),
    session, samples, events
  }, null, 1);
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';
}

export function filename(session) {
  // A session with an unreadable start time still has to produce a usable filename rather
  // than wts-NaNNaNNaN.
  const d = new Date(Number.isFinite(session.started) ? session.started : Date.now());
  const p = n => String(n).padStart(2, '0');
  return `wts-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}` +
         `-${slug(session.operator || session.connection)}.json`;
}

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
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
  download(JSON.stringify({
    format: 'wts/bundle', version: FORMAT_VERSION, app_version: APP_VERSION,
    exported: new Date().toISOString(),
    probes: PROBES.map(p => ({id: p.id, label: p.label, url: p.url, kind: p.kind})),
    sessions: bundles
  }, null, 1), `wts-all-${stamp}.json`);
  return sessions;
}
