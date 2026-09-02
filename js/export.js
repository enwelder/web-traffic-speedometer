// Exports are the product, so they are complete rather than convenient. JSON is canonical
// and lossless; the rest are conveniences derived from it.

import {PROBES} from './probe.js';
import * as store from './store.js';

const PROBE_FIELDS = ['ok', 'ms', 'status', 'fail', 'egress_ip', 'colo'];

const SAMPLE_COLUMNS = [
  'session_id', 'session_name', 'operator', 'connection', 'route',
  'seq', 't', 'mono', 'late_ms', 'skipped', 'round_error',
  'lat', 'lon', 'pos_t', 'pos_error', 'accuracy', 'speed', 'heading', 'interval_ms',
  ...PROBES.flatMap(p => PROBE_FIELDS.map(f => `${p.id}_${f}`))
];

const EVENT_COLUMNS = [
  'session_id', 'session_name', 'operator', 'connection', 'route',
  't', 'mono', 'type', 'lat', 'lon', 'text'
];

const iso = ms => (ms == null ? '' : new Date(ms).toISOString());

function csvCell(v) {
  if (v == null) return '';
  if (v === true) return '1';
  if (v === false) return '0';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const csvRow = cells => cells.map(csvCell).join(',');

function xml(v) {
  return String(v).replace(/[<>&'"]/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'}[c]));
}

function identity(session) {
  return [session.id, session.name, session.operator, session.connection, session.route];
}

function sampleRow(session, s) {
  return [
    ...identity(session),
    s.seq, iso(s.t), s.mono, s.late_ms, s.skipped, s.round_error,
    s.lat, s.lon, iso(s.pos_t), s.pos_error, s.accuracy, s.speed, s.heading, s.intervalMs,
    ...PROBES.flatMap(p => {
      const r = s.probes?.[p.id] || {};
      return PROBE_FIELDS.map(f => r[f]);
    })
  ];
}

export function samplesCsv(session, samples) {
  return [csvRow(SAMPLE_COLUMNS), ...samples.map(s => csvRow(sampleRow(session, s)))].join('\n') + '\n';
}

export function eventsCsv(session, events) {
  const rows = events.map(e => csvRow([...identity(session), iso(e.t), e.mono, e.type, e.lat, e.lon, e.text]));
  return [csvRow(EVENT_COLUMNS), ...rows].join('\n') + '\n';
}

export function sessionJson(session, samples, events) {
  return JSON.stringify({format: 'spoormeter/session', version: 1, session, samples, events}, null, 1);
}

export function bundleJson(bundles) {
  return JSON.stringify({format: 'spoormeter/bundle', version: 1, exported: new Date().toISOString(), sessions: bundles}, null, 1);
}

export function gpx(session, samples, events) {
  const fixed = samples.filter(s => s.lat != null && s.lon != null);
  const pts = fixed.map(s =>
    `   <trkpt lat="${s.lat.toFixed(7)}" lon="${s.lon.toFixed(7)}">\n` +
    `    <time>${iso(s.pos_t || s.t)}</time>\n` +
    (s.speed == null ? '' : `    <extensions><spoormeter:speed>${s.speed.toFixed(2)}</spoormeter:speed></extensions>\n`) +
    `   </trkpt>`
  ).join('\n');

  const wpts = events.filter(e => e.lat != null && e.lon != null).map(e =>
    ` <wpt lat="${e.lat.toFixed(7)}" lon="${e.lon.toFixed(7)}">\n` +
    `  <time>${iso(e.t)}</time>\n  <name>${xml(e.text || e.type)}</name>\n  <type>${xml(e.type)}</type>\n </wpt>`
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Spoormeter" xmlns="http://www.topografix.com/GPX/1/1" xmlns:spoormeter="https://github.com/spoormeter">
 <metadata>
  <name>${xml(session.name)}</name>
  <desc>${xml(`${session.operator} / ${session.connection} / ${session.route}`)}</desc>
  <time>${iso(session.started)}</time>
 </metadata>
${wpts}${wpts ? '\n' : ''} <trk>
  <name>${xml(session.name)}</name>
  <trkseg>
${pts}
  </trkseg>
 </trk>
</gpx>
`;
}

// Every sample is emitted as a Point carrying its full properties, so colouring by state
// is a decision made in the analysis rather than baked in here.
export function geojson(session, samples, events) {
  const fixed = samples.filter(s => s.lat != null && s.lon != null);
  const props = s => {
    const o = {seq: s.seq, t: iso(s.t), mono: s.mono, late_ms: s.late_ms, skipped: s.skipped,
               round_error: s.round_error, accuracy: s.accuracy, speed: s.speed, heading: s.heading,
               pos_t: iso(s.pos_t), interval_ms: s.intervalMs};
    for (const p of PROBES) {
      const r = s.probes?.[p.id] || {};
      for (const f of PROBE_FIELDS) o[`${p.id}_${f}`] = r[f] ?? null;
    }
    return o;
  };

  const features = [];
  if (fixed.length > 1) {
    features.push({
      type: 'Feature',
      geometry: {type: 'LineString', coordinates: fixed.map(s => [+s.lon.toFixed(7), +s.lat.toFixed(7)])},
      properties: {kind: 'route', ...identityProps(session)}
    });
  }
  for (const s of fixed) {
    features.push({
      type: 'Feature',
      geometry: {type: 'Point', coordinates: [+s.lon.toFixed(7), +s.lat.toFixed(7)]},
      properties: {kind: 'sample', ...props(s)}
    });
  }
  for (const e of events) {
    if (e.lat == null || e.lon == null) continue;
    features.push({
      type: 'Feature',
      geometry: {type: 'Point', coordinates: [+e.lon.toFixed(7), +e.lat.toFixed(7)]},
      properties: {kind: 'event', type: e.type, t: iso(e.t), mono: e.mono, text: e.text}
    });
  }
  return JSON.stringify({type: 'FeatureCollection', properties: identityProps(session), features}, null, 1);
}

function identityProps(session) {
  return {session_id: session.id, session_name: session.name, operator: session.operator,
          connection: session.connection, route: session.route, started: iso(session.started)};
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';
}

export function filename(session, suffix, ext) {
  const d = new Date(session.started);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
                `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `spoormeter-${stamp}-${slug(session.operator)}-${slug(session.name)}${suffix}.${ext}`;
}

export function download(text, name, mime) {
  const url = URL.createObjectURL(new Blob([text], {type: mime + ';charset=utf-8'}));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function exportSession(session, format) {
  const [samples, events] = await Promise.all([store.getSamples(session.id), store.getEvents(session.id)]);
  const kinds = {
    json:   () => [sessionJson(session, samples, events), '', 'json', 'application/json'],
    csv:    () => [samplesCsv(session, samples), '', 'csv', 'text/csv'],
    events: () => [eventsCsv(session, events), '-events', 'csv', 'text/csv'],
    gpx:    () => [gpx(session, samples, events), '', 'gpx', 'application/gpx+xml'],
    geojson:() => [geojson(session, samples, events), '', 'geojson', 'application/geo+json']
  };
  const [text, suffix, ext, mime] = kinds[format]();
  download(text, filename(session, suffix, ext), mime);
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
  download(bundleJson(bundles), `spoormeter-all-${stamp}.json`, 'application/json');
  return sessions;
}
