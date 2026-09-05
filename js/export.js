// One format, everything in it. JSON is the only lossless shape for the nested per-probe
// records, and CSV, GPX or GeoJSON are all a few lines to derive from it in the analysis —
// where the enrichment happens anyway.

import {PROBES} from './probe.js';
import {APP_VERSION} from './session.js';
import * as store from './store.js';

// A descriptive rollup, so a reader does not recompute the same six aggregates every time.
// It states no verdict — no outage definition, no thresholds — and every figure in it can be
// rebuilt from the samples, which is what keeps the raw rows the only source of truth.
function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

export function summarise(samples) {
  const ran = samples.filter(s => !s.skipped && !s.round_error);
  const probes = {};
  for (const p of PROBES) {
    const rs = ran.map(s => s.probes[p.id]).filter(Boolean);
    const ok = rs.filter(r => r.ok);
    const ms = ok.map(r => r.ms).filter(v => v != null).sort((a, b) => a - b);
    const fails = {};
    for (const r of rs) if (!r.ok && !r.expected) fails[r.fail] = (fails[r.fail] || 0) + 1;
    const entry = {
      n: rs.length, ok: ok.length,
      expected: rs.filter(r => r.expected).length,
      fails,
      ms_p50: quantile(ms, 0.5), ms_p90: quantile(ms, 0.9), ms_max: ms.at(-1) ?? null
    };
    if (p.id === 'down') {
      const rate = ok.map(r => r.bps_transfer).filter(v => v != null).sort((a, b) => a - b);
      entry.bps_transfer_p10 = quantile(rate, 0.1);
      entry.bps_transfer_p50 = quantile(rate, 0.5);
      entry.bytes_total = ok.reduce((n, r) => n + (r.bytes || 0), 0);
    }
    probes[p.id] = entry;
  }

  const fixed = ran.filter(s => s.accuracy_class === 'gps');
  return {
    generated_by: `wts ${APP_VERSION}`,
    rounds: samples.length,
    ran: ran.length,
    skipped: samples.filter(s => s.skipped).length,
    round_errors: samples.filter(s => s.round_error).length,
    in_pause: ran.filter(s => s.in_pause).length,
    // Rounds in which something failed that was not a known-absent path. Partial failure is
    // what a journey is mostly made of; full outages are rare.
    degraded: ran.filter(s => PROBES.some(p => {
      const r = s.probes[p.id];
      return r && r.ok === false && !r.expected;
    })).length,
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
  const d = new Date(session.started);
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
