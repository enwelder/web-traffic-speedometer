// Turns a recorded journey into a committable fixture.
//
// A recording contains a home address, a workplace and a daily timetable. Identifying fields are
// removed; every value the measurement code reads is kept, so fixtures still test that code.
//
//   node tools/anonymise.mjs .dev/logs/<file>.json tests/fixtures/<name>.json
import {readFileSync, writeFileSync} from 'node:fs';

// Fixed epoch, which removes travel dates. Intervals are preserved exactly for the scheduler tests.
const EPOCH = Date.parse('2026-01-01T09:00:00Z');

const REDACT = '<redacted>';

function scrubProbe(r) {
  if (!r || typeof r !== 'object') return r;
  const out = {...r};
  // The egress address identifies the subscriber's operator session.
  if ('egress_ip' in out) out.egress_ip = out.egress_ip ? REDACT : out.egress_ip;
  if ('public_ips' in out) out.public_ips = (out.public_ips || []).map(() => REDACT);
  // Hostnames are random per round; only the shape is asserted on.
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
    // Coordinates are dropped. Accuracy is kept, since the accuracy-class rules are tested
    // against it.
    out.lat = null;
    out.lon = null;
    delete out.heading;
    out.probes = Object.fromEntries(Object.entries(s.probes || {}).map(([k, v]) => [k, scrubProbe(v)]));
    return out;
  });

  // A typed note or mark can name a street, so only machine-written text is kept; the
  // scheduler and wake-lock tests read it.
  const machine = x => x != null && MACHINE_TEXT.some(re => re.test(x));
  const events = (doc.events || []).map(e => ({
    ...e, t: t(e.t), lat: null, lon: null,
    text: machine(e.text) ? e.text : (e.text == null ? e.text : REDACT)
  }));

  const session = {...doc.session, started: t(doc.session.started), stopped: t(doc.session.stopped),
                   exportedAt: t(doc.session.exportedAt)};
  session.name = 'anonymised session';
  session.note = '';
  if (session.environment) {
    session.environment = {
      ...session.environment,
      // The user agent is a fingerprint.
      user_agent: REDACT,
      timezone: REDACT,
      screen: REDACT
    };
  }

  return {
    format: 'nulog/fixture',
    version: 1,
    source_app_version: doc.session?.environment?.app_version ?? doc.app_version ?? null,
    note: 'Anonymised recording. Coordinates removed, addresses redacted, timestamps shifted ' +
          'to a fixed epoch. Every measurement is unchanged.',
    session, samples, events
  };
}

// The probe endpoints are public infrastructure and appear in the recorded configuration.
// Removing them before the scan keeps it aimed at subscriber data.
const PUBLIC_ENDPOINTS = [
  '1.1.1.1', '2606:4700:4700::1111', 'stun:stun.cloudflare.com:3478',
  'speed.cloudflare.com', 'www.gstatic.com', 'nulog-dns-control.github.io'
];

// Allowed keys per level. An allowlist: a denylist scan accepts every field the schema adds. A new
// recorder field requires an entry here with a rule for its value.
const KEYS = {
  root: ['format', 'version', 'source_app_version', 'note', 'session', 'samples', 'events'],
  session: ['id', 'name', 'operator', 'connection', 'note', 'started', 'stopped', 'intervalMs',
            'downloadBytes', 'download', 'profile', 'ipv6_available', 'ipv6_check',
            'ipv4_available', 'ipv4_check',
            'environment', 'exportedAt', 'end_reason'],
  environment: ['app_version', 'user_agent', 'language', 'timezone', 'screen', 'interval_ms',
                'download_bytes', 'download', 'timeouts_ms', 'probes', 'network_information'],
  sample: ['sessionId', 'seq', 't', 'mono', 'late_ms', 'skipped', 'round_error', 'visible',
           'in_pause', 'wake_lock', 'prev_round_ms', 'intervalMs', 'lat', 'lon', 'accuracy',
           'accuracy_class', 'speed', 'speed_derived', 'speed_source', 'heading', 'pos_t',
           'pos_error', 'probes', 'grades', 'pgrades', 'first_packet_ms', 'loaded_rtt_ms', 'loaded_rtt_from',
           'round_ms', 'phase_idle_ms', 'phase_down_ms', 'phase_up_ms', 'visible_end', 'reference', 'interrupted', 'suspended_ms'],
  probe: ['ok', 'ms', 'status', 'fail', 'egress_ip', 'colo', 'ms_samples', 'samples_ok',
          'ms_min', 'ms_max', 'sample_fail', 'expected', 'blocked', 'unused', 'stuck', 'host', 'bytes', 'truncated', 'server',
          'ttfb_ms', 'transfer_ms', 'handshake', 'reused', 'protocol', 'lookup_ms',
          'connect_ms', 'tls_ms', 'retry_suspected', 'parse_reason', 'bps_min', 'complete',
          'warmup_only', 'refused_by', 'bps', 'bps_server', 'saturated', 'ceiling_bps', 'streams', 'ramp_ms',
          'window_bytes', 'window_ms',
          'duration_ms', 'aborted_reason', 'public_ips',
          'candidates', 'per_stream', 'wall_ms', 'samples_end', 'stall_check', 'window_cut',
          'samples_lost', 'sample_starts_ms', 'host_ms_samples', 'upload_bytes', 'rate_source', 'protocol_samples',
          // Fields of recordings from releases up to 3.3.1, kept for replay.
          'bps_transfer', 'bps_end_to_end', 'bps_steady', 'bps_peak', 'warmup_ms',
          'warmup_bytes', 'insufficient_sample'],
  event: ['sessionId', 'id', 't', 'mono', 'type', 'lat', 'lon', 'text', 'late_ms', 'round', 'running_ms', 'waiting_on']
};

// Typed text can identify a location, so event text passes only in these machine-written forms.
const MACHINE_TEXT = [
  /^<redacted>$/,
  /^mark \d+$/,
  /^(fine|slow|broken)$/,
  /^\d+(\.\d+)?s bridged( across reload)?$/,
  /^IPv4 absent \([a-z_]+( in \d+ ms)?\)$/,
  /^IPv[46] (answered|(did not answer|unresolved) \([a-z_]+ in \d+ ms\))$/,
  /^IPv[46] carries traffic; its literal is blocked, not its path$/,
  /^IPv[46] literal refused while IPv[46] carries traffic\. (1\.1\.1\.1|2606:4700:4700::1111) is a public resolver address; a VPN, filter or captive portal commonly intercepts it$/,
  /^no address literal answered, so the round trip has no instrument and calls cannot be graded$/,
  /^screen wake lock (released|refused \([A-Za-z]+\))$/,
  /^screen stays awake again$/,
  /^location (degraded|improved) to \d+ m$/,
  /^no location \((denied|timeout|unavailable)\)$/,
  /^location (precise again \(\d+ m\)|degraded to \d+ m — speed and distance withheld)$/,
  /^[a-z_0-9]+ has failed \d+ rounds while the others answer; resting it for \d+ rounds to clear the connection\.$/,
  /^egress address changed( over IPv[46])?$/,
  /^round \d+ still running after \d+\.\d s(, waiting on [a-z_0-9, ]+)?$/,
  /^(hidden|visible|pagehide|pageshow|freeze|resume|online|offline)$/,
  /^connection [a-z0-9?-]+ [a-z0-9?-]+, [0-9.?]+ Mb\/s, [0-9?]+ ms$/
];

const fail = why => { throw new Error(why); };

function checkKeys(obj, level, where) {
  for (const k of Object.keys(obj)) {
    if (!KEYS[level].includes(k)) {
      fail(`${where}: unknown ${level} field "${k}" — decide what it may contain and list it in KEYS`);
    }
  }
}

// String contents that could identify a subscriber. Applied after the tool's own endpoints
// have been removed from the text.
function checkString(v, where) {
  if (/iPhone|Android|Mozilla|Safari|Chrome/.test(v)) fail(`${where}: a user agent survived: ${v}`);
  if (/\b\d{1,3}(\.\d{1,3}){3}\b/.test(v)) fail(`${where}: an IPv4 address survived: ${v}`);
  // Compressed form included: "2a02:a473::9" carries three groups, so a rule requiring four
  // misses it.
  if (/(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{0,4}/i.test(v) || /[0-9a-f]{1,4}::/i.test(v)) {
    fail(`${where}: an IPv6 address survived: ${v}`);
  }
}

function checkTime(v, where) {
  if (typeof v !== 'number') return;
  // Wall-clock milliseconds far from the epoch reveal the journey date.
  if (v > 1e12 && Math.abs(v - EPOCH) > 86400000) fail(`${where}: an unshifted timestamp: ${v}`);
}

// Throws on the first identifying field.
export function assertClean(fixture) {
  const strip = v => {
    let t = String(v);
    for (const e of PUBLIC_ENDPOINTS) t = t.split(e).join('<endpoint>');
    return t;
  };
  // Values are checked in place, so a failure names the field it is in.
  const scan = (v, where, textAllowed = false) => {
    if (v == null) return;
    if (typeof v === 'string') {
      if (!textAllowed) checkString(strip(v), where);
      return;
    }
    if (typeof v === 'number') return checkTime(v, where);
    if (Array.isArray(v)) return v.forEach((x, i) => scan(x, `${where}[${i}]`, textAllowed));
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) scan(x, `${where}.${k}`, textAllowed);
    }
  };

  checkKeys(fixture, 'root', 'fixture');
  scan(fixture.format, 'format');
  scan(fixture.version, 'version');
  scan(fixture.source_app_version, 'source_app_version');

  const session = fixture.session || fail('fixture: no session');
  checkKeys(session, 'session', 'session');
  if (session.name !== 'anonymised session') fail(`session.name was not replaced: ${session.name}`);
  if (session.note) fail(`session.note carries free text: ${session.note}`);
  for (const k of ['started', 'stopped', 'exportedAt']) checkTime(session[k], `session.${k}`);
  scan({...session, environment: undefined, note: undefined}, 'session');

  if (session.environment) {
    checkKeys(session.environment, 'environment', 'session.environment');
    for (const k of ['user_agent', 'timezone', 'screen']) {
      if (session.environment[k] !== REDACT) fail(`session.environment.${k} was not redacted`);
    }
    scan({...session.environment, user_agent: undefined, timezone: undefined, screen: undefined},
         'session.environment');
  }

  fixture.samples.forEach((s, i) => {
    const at = `samples[${i}]`;
    checkKeys(s, 'sample', at);
    if (s.lat != null || s.lon != null) fail(`${at}: a coordinate survived`);
    if ('heading' in s) fail(`${at}: heading survived`);
    for (const k of ['t', 'pos_t']) checkTime(s[k], `${at}.${k}`);
    for (const [id, r] of Object.entries(s.probes || {})) {
      if (!r) continue;
      checkKeys(r, 'probe', `${at}.probes.${id}`);
      if (r.egress_ip && r.egress_ip !== REDACT) fail(`${at}.probes.${id}.egress_ip survived`);
      if (r.public_ips?.some(x => x !== REDACT)) fail(`${at}.probes.${id}.public_ips survived`);
    }
    scan({...s, lat: undefined, lon: undefined}, at);
  });

  (fixture.events || []).forEach((e, i) => {
    const at = `events[${i}]`;
    checkKeys(e, 'event', at);
    if (e.lat != null || e.lon != null) fail(`${at}: a coordinate survived`);
    checkTime(e.t, `${at}.t`);
    if (e.text != null && !MACHINE_TEXT.some(re => re.test(e.text))) {
      fail(`${at}: text is not machine-written and may say where someone was: ${JSON.stringify(e.text)}`);
    }
    scan({...e, text: undefined, lat: undefined, lon: undefined}, at);
  });

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
