// One format, everything in it. JSON is the only lossless shape for the nested per-probe
// records, and CSV, GPX or GeoJSON are all a few lines to derive from it in the analysis —
// where the enrichment happens anyway.

import {PROBES} from './probe.js';
import {APP_VERSION} from './session.js';
import * as store from './store.js';

export function sessionJson(session, samples, events) {
  return JSON.stringify({
    format: 'wts/session',
    version: 2,
    app_version: APP_VERSION,
    exported: new Date().toISOString(),
    probes: PROBES.map(p => ({id: p.id, url: p.url, kind: p.kind})),
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
