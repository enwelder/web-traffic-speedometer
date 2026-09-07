// Turns a recorded journey into a committable fixture.
//
// A recording is a home address, a workplace and a daily timetable. Everything that could
// place or identify the person is removed; every number the measurement code reads is kept,
// because a fixture that has been smoothed is not a test of anything.
//
//   node tools/anonymise.mjs .dev/logs/<file>.json tests/fixtures/<name>.json
import {readFileSync, writeFileSync} from 'node:fs';

// A fixed epoch, so a fixture cannot say when anyone travelled. Intervals are preserved
// exactly: they are what the scheduler tests are about.
const EPOCH = Date.parse('2026-01-01T09:00:00Z');

const REDACT = '<redacted>';

function scrubProbe(r) {
  if (!r || typeof r !== 'object') return r;
  const out = {...r};
  // The egress address identifies the subscriber's operator session.
  if ('egress_ip' in out) out.egress_ip = out.egress_ip ? REDACT : out.egress_ip;
  if ('public_ips' in out) out.public_ips = (out.public_ips || []).map(() => REDACT);
  // Hostnames are random per round; the shape is what matters, not the value.
  if ('host' in out && out.host) {
    out.host = out.host.replace(/^[0-9a-f]+\./, 'xxxxxxxxxxxxxxxx.');
  }
  return out;
}

export function anonymise(doc) {
  const shift = doc.samples[0]?.t ? EPOCH - doc.samples[0].t : 0;
  const t = v => (typeof v === 'number' ? v + shift : v);

  const samples = doc.samples.map(s => {
    const out = {...s, t: t(s.t), pos_t: t(s.pos_t)};
    // Position is the whole risk. Accuracy is kept because the accuracy-class rules are
    // tested against it; the coordinates themselves are dropped, not fuzzed.
    out.lat = null;
    out.lon = null;
    delete out.heading;
    out.probes = Object.fromEntries(Object.entries(s.probes || {}).map(([k, v]) => [k, scrubProbe(v)]));
    return out;
  });

  const events = (doc.events || []).map(e => ({...e, t: t(e.t), lat: null, lon: null}));

  const session = {...doc.session, started: t(doc.session.started), stopped: t(doc.session.stopped)};
  session.name = 'anonymised session';
  if (session.environment) {
    session.environment = {
      ...session.environment,
      // The user agent is a fingerprint and, on some browsers, a fiction anyway.
      user_agent: REDACT,
      timezone: REDACT,
      screen: REDACT
    };
  }

  return {
    format: 'wts/fixture',
    version: 1,
    source_app_version: doc.session?.environment?.app_version ?? doc.app_version ?? null,
    note: 'Anonymised recording. Coordinates removed, addresses redacted, timestamps shifted ' +
          'to a fixed epoch. Every measurement is unchanged.',
    session, samples, events
  };
}

// The probe endpoints are public infrastructure and appear in the recorded configuration;
// they are not what needs hiding. Removing them first keeps the scan aimed at subscriber
// data rather than tripping over the addresses the tool is built to contact.
const PUBLIC_ENDPOINTS = [
  '1.1.1.1', '2606:4700:4700::1111', 'stun:stun.cloudflare.com:3478',
  'speed.cloudflare.com', 'www.gstatic.com', 'wts-dns-control.github.io'
];

// Fails loudly rather than committing something that only looks anonymised.
export function assertClean(fixture) {
  let text = JSON.stringify(fixture);
  for (const e of PUBLIC_ENDPOINTS) text = text.split(e).join('<endpoint>');
  const checks = [
    [/"lat":\s*-?\d/, 'a latitude survived'],
    [/"lon":\s*-?\d/, 'a longitude survived'],
    [/\b\d{1,3}(\.\d{1,3}){3}\b/, 'an IPv4 address survived'],
    [/\b[0-9a-f]{1,4}(:[0-9a-f]{0,4}){4,}\b/i, 'an IPv6 address survived'],
    [/iPhone|Android|Mozilla/, 'a user agent survived']
  ];
  for (const [re, why] of checks) {
    const m = re.exec(text);
    if (m) throw new Error(`${why}: ${m[0]}`);
  }
  return true;
}

if (process.argv[1] && process.argv[1].endsWith('anonymise.mjs')) {
  const [, , input, output] = process.argv;
  if (!input || !output) {
    console.error('usage: node tools/anonymise.mjs <recording.json> <fixture.json>');
    process.exit(2);
  }
  const fixture = anonymise(JSON.parse(readFileSync(input, 'utf8')));
  assertClean(fixture);
  writeFileSync(output, JSON.stringify(fixture));
  console.log(`${output}: ${fixture.samples.length} rounds, ${fixture.events.length} events, ` +
              `from ${fixture.source_app_version}`);
}
