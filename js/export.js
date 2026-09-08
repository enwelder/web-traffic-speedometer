// One format, everything in it. JSON is the only lossless shape for the nested per-probe
// records, and CSV, GPX or GeoJSON are all a few lines to derive from it in the analysis —
// where the enrichment happens anyway.

import {PROBES} from './probe.js';
import {APP_VERSION} from './session.js';
import {CAPABILITIES, THRESHOLDS, quantile} from './grade.js';
import * as store from './store.js';

// A descriptive rollup, so a reader does not recompute the same six aggregates every time.
// It states no verdict — no outage definition, no thresholds — and every figure in it can be
// rebuilt from the samples, which is what keeps the raw rows the only source of truth.
// A probe resting to clear its own wedged connection has not failed at the network, and an
// IPv4 literal on a network with no IPv4 path was never going to work. Shared with the
// screen so the percentage shown and the count in the file cannot drift; tests pin that.
export const countsAsFailure = r =>
  !!r && r.ok === false && !r.expected && r.fail !== 'resting';

export function summarise(samples) {
  const ran = samples.filter(s => !s.skipped && !s.round_error);
  const probes = {};
  for (const p of PROBES) {
    const rs = ran.map(s => s.probes[p.id]).filter(Boolean);
    const ok = rs.filter(r => r.ok);
    const ms = ok.map(r => r.ms).filter(v => v != null).sort((a, b) => a - b);
    const fails = {};
    const stopped = {};
    for (const r of rs) {
      if (r.ok || r.expected) continue;
      // Failures and deliberate stops are counted apart, so neither hides the other.
      (countsAsFailure(r) ? fails : stopped)[r.fail] = ((countsAsFailure(r) ? fails : stopped)[r.fail] || 0) + 1;
    }
    const entry = {
      n: rs.length, ok: ok.length,
      expected: rs.filter(r => r.expected).length,
      fails, stopped,
      ms_p50: quantile(ms, 0.5), ms_p90: quantile(ms, 0.9), ms_max: ms.at(-1) ?? null
    };
    if (p.id === 'down') {
      // The rate the grades were taken on, over the rounds that produced one.
      const rate = ok.filter(r => !r.insufficient_sample)
                     .map(r => r.bps_steady).filter(v => v != null).sort((a, b) => a - b);
      entry.bps_steady_p10 = quantile(rate, 0.1);
      entry.bps_steady_p50 = quantile(rate, 0.5);
      entry.rated = rate.length;
      entry.insufficient = ok.filter(r => r.insufficient_sample).length;
      entry.bytes_total = ok.reduce((n, r) => n + (r.bytes || 0), 0);
    }
    probes[p.id] = entry;
  }

  // Per capability, the grades actually resolved during the run. Counting them here means a
  // reader can check thresholds against what was felt without recomputing anything.
  const grades = {};
  for (const cap of CAPABILITIES) {
    const seen = {};
    for (const s of ran) {
      const g = s.grades?.[cap];
      if (g) seen[g] = (seen[g] || 0) + 1;
    }
    grades[cap] = seen;
  }

  const fixed = ran.filter(s => s.accuracy_class === 'gps');
  return {
    thresholds: THRESHOLDS,
    grades,
    generated_by: `wts ${APP_VERSION}`,
    rounds: samples.length,
    ran: ran.length,
    skipped: samples.filter(s => s.skipped).length,
    round_errors: samples.filter(s => s.round_error).length,
    in_pause: ran.filter(s => s.in_pause).length,
    // Rounds in which something failed that was not a known-absent path. Partial failure is
    // what a journey is mostly made of; full outages are rare.
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
    version: 2,
    app_version: APP_VERSION,
    exported: new Date().toISOString(),
    probes: PROBES.map(p => ({id: p.id, url: p.url, kind: p.kind})),
    summary: summarise(samples),
    session, samples, events
  }, null, 1);
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';
}

export function filename(session) {
  // A session whose start time is unreadable still has to produce a name a file system will
  // take, rather than wts-NaNNaNNaN.
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
    format: 'wts/bundle', version: 2, app_version: APP_VERSION,
    exported: new Date().toISOString(),
    probes: PROBES.map(p => ({id: p.id, url: p.url, kind: p.kind})),
    sessions: bundles
  }, null, 1), `wts-all-${stamp}.json`);
  return sessions;
}
