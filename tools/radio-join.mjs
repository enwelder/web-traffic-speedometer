// Joins an exported session to the phone's baseband log, writing one enriched file: every round
// gains the serving cell and the signal measured while it ran.
//
//   node tools/radio-join.mjs <session.json> <path/to/system_logs.logarchive> [--out <file>]
//
// Both sides are stamped by the same phone clock, so no offset is applied. Needs macOS: it reads
// the archive through `/usr/bin/log`. The extract is personal data and never reaches disk.
import {execFileSync, spawn} from 'node:child_process';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {dirname, basename, join} from 'node:path';
import {createInterface} from 'node:readline';
import {BUILD_SEEN, IDENTIFIERS, PATTERNS, REQUIRED, isSentinel, predicate} from './radio-patterns.mjs';

// A round whose `round_ms` is null never reached `endRound`; the interval bounds it instead.
export const PAD_MS = 5000;
// A window holding fewer signal samples than this, or a gap this long, is `partial`.
const MIN_SAMPLES = 2;
const MAX_GAP_MS = 6000;
// Reports alternate between cells inside a second, so reselections are collapsed to one.
const CHANGE_DEDUPE_MS = 1000;
// NR reports arrive further apart than a round lasts, so an older one still names the round's cell.
// Beyond this it would be inherited across a coverage gap.
const NR_STALE_MS = 120000;

const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] : null;
};
export const stats = xs => (xs.length
  ? {min: Math.min(...xs), med: q(xs, 0.5), max: Math.max(...xs)}
  : {min: null, med: null, max: null});
const iso = ms => new Date(ms).toISOString();
// `log show` reads its range in the host's local time. Bucketing uses each record's own epoch
// value, so the range is only a prefilter.
const localStamp = ms => new Date(ms).toLocaleString('sv-SE').replace(',', '');

// An IPv6 interface identifier names the device, so an address is carried as its /64. A public
// IPv4 address has no such half and is carried whole.
export const prefix64 = ip => (typeof ip === 'string' && ip.includes(':')
  ? `${ip.split(':').slice(0, 4).join(':')}::/64` : ip);

export function withoutDeviceAddresses(row) {
  const probes = {};
  for (const [id, p] of Object.entries(row.probes || {})) {
    probes[id] = {...p};
    if (p?.egress_ip) probes[id].egress_ip = prefix64(p.egress_ip);
    if (Array.isArray(p?.public_ips)) probes[id].public_ips = p.public_ips.map(prefix64);
  }
  return {...row, probes};
}

// Reads log records one at a time, keeping the values the join needs and a tally of what it saw.
export function createCollector() {
  const counts = Object.fromEntries(PATTERNS.map(p => [p.name, 0]));
  const state = {lines_read: 0, identifiers_dropped: 0, sentinels_dropped: 0, unparsed_examples: []};
  const events = [];

  const add = record => {
    const message = record.eventMessage || '';
    // The log holds IMEI, IMSI and ICCID in plain text. Such a record is dropped whole, before
    // anything of it is kept.
    if (IDENTIFIERS.test(message)) { state.identifiers_dropped++; return null; }
    for (const p of PATTERNS) {
      if (record.subsystem !== p.subsystem) continue;
      const categories = Array.isArray(p.category) ? p.category : [p.category];
      if (!categories.includes(record.category)) continue;
      const m = message.match(p.regex);
      if (!m) continue;
      const value = p.read(m);
      counts[p.name]++;
      // Per field, never per line: one report can hold a real area code beside a zeroed EARFCN.
      for (const [k, v] of Object.entries(value)) {
        const zeroed = v === 0 && (p.zeroAbsent || []).includes(k);
        if (typeof v === 'number' && (isSentinel(v) || zeroed)) {
          value[k] = null;
          state.sentinels_dropped++;
        }
      }
      const event = {t: Date.parse(record.timestamp), pattern: p.name, ...value};
      events.push(event);
      return event;
    }
    return null;
  };

  return {
    add,
    addLine(line) {
      if (!line.startsWith('{')) return null;
      state.lines_read++;
      try {
        return add(JSON.parse(line));
      } catch {
        if (state.unparsed_examples.length < 3) state.unparsed_examples.push(line.slice(0, 120));
        return null;
      }
    },
    events, counts, state,
    missingRequired: () => REQUIRED.filter(name => counts[name] === 0)
  };
}

// Attaches a `radio` object to every round. Pure over the session and the collected events.
export function enrich(session, events) {
  const rows = (session.samples || []).slice().sort((a, b) => a.seq - b.seq);
  const intervalMs = session.session?.intervalMs ?? 20000;
  const roundEnd = r => r.t + (r.round_ms ?? intervalMs);
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const of = kind => sorted.filter(e => e.kind === kind);
  const identities = of('identity');
  const configs = of('radio_config');
  const nrCells = of('nr_cell');

  const cellAt = t => {
    const last = identities.filter(e => e.t <= t).at(-1);
    if (!last) return null;
    const config = configs.filter(e => e.t <= t && e.tac === last.tac).at(-1);
    const eci = last.eci;
    return {
      gci: `${last.mcc}.${last.mnc}.${last.tac}.${eci}`,
      mcc: last.mcc, mnc: last.mnc, tac: last.tac, eci,
      enb: eci == null ? null : eci >> 8, sector: eci == null ? null : eci & 255,
      pci: config?.pci ?? null, earfcn: config?.earfcn ?? null, band: config?.band ?? null,
      bw_rb: config?.bw_rb ?? null, rat: last.rat, age_ms: t - last.t
    };
  };

  // The last report up to the round's end stands. `offset_ms` is negative when it predates the
  // round.
  const nrCellIn = (start, end) => {
    const last = nrCells.filter(e => e.t <= end && e.t >= start - NR_STALE_MS).at(-1);
    if (!last) return null;
    return {
      arfcn: last.arfcn, dl_mhz: last.dl_mhz, bands: last.bands, pci: last.pci,
      bw_mhz: last.bw_mhz, rsrp: last.rsrp, rsrq: last.rsrq, offset_ms: last.t - start
    };
  };

  const changesIn = (start, end) => {
    const marks = sorted.filter(e => e.kind === 'cell_changed' && e.changed &&
                                     e.t >= start && e.t <= end);
    const distinct = [];
    for (const m of marks) {
      if (!distinct.length || m.t - distinct.at(-1) > CHANGE_DEDUPE_MS) distinct.push(m.t);
    }
    return distinct;
  };

  // `full` needs measured signal, not merely records: the level and its spread come from the
  // signal samples, so a window holding only handover scores is `partial`.
  const coverageOf = (start, end, lte, scores) => {
    const all = [...lte, ...scores].sort((a, b) => a.t - b.t);
    if (!all.length) {
      return {state: 'none', first_offset_ms: null, last_offset_ms: null, gap_max_ms: null};
    }
    const gaps = all.slice(1).map((s, i) => s.t - all[i].t);
    const gap = gaps.length ? Math.max(...gaps) : end - start;
    return {
      state: lte.length < MIN_SAMPLES || gap > MAX_GAP_MS ? 'partial' : 'full',
      first_offset_ms: all[0].t - start, last_offset_ms: all.at(-1).t - start, gap_max_ms: gap
    };
  };

  const radioFor = row => {
    const start = row.t;
    const end = roundEnd(row);
    const inWindow = kind => sorted.filter(e => e.kind === kind && e.t >= start && e.t <= end);
    const lte = inWindow('lte');
    const scores = inWindow('score');
    const nr = inWindow('nr').filter(e => e.rsrp != null);
    const changes = changesIn(start, end);
    const rrc = {};
    for (const s of scores) if (s.rrc != null) rrc[s.rrc] = (rrc[s.rrc] || 0) + 1;
    const rats = inWindow('identity').map(e => e.rat);
    const cov = coverageOf(start, end, lte, scores);
    const pick = (list, field) => list.map(e => e[field]).filter(v => v != null);

    return {
      coverage: cov.state, first_offset_ms: cov.first_offset_ms,
      last_offset_ms: cov.last_offset_ms, gap_max_ms: cov.gap_max_ms,
      cell: cov.state === 'none' ? null : cellAt(start),
      // The RAT field lags, reading `kLTE` on rounds that measured NR signal, so identity alone
      // does not establish an NR leg. A cell is named only where the round measured that signal.
      nr_cell: cov.state !== 'none' && nr.length ? nrCellIn(start, end) : null,
      cell_changes: changes.length,
      cells: changes.length
        ? [...new Set([cellAt(start)?.gci, ...changes.map(t => cellAt(t)?.gci)].filter(Boolean))]
        : [],
      lte: lte.length ? {
        n: lte.length,
        rsrp: stats(pick(lte, 'rsrp')), rsrq: stats(pick(lte, 'rsrq')), snr: stats(pick(lte, 'snr')),
        samples: lte.map(e => [e.t - start, e.rsrp, e.rsrq, e.snr, e.rssi])
      } : null,
      nr: nr.length ? {
        n: nr.length, rsrp: stats(pick(nr, 'rsrp')), snr: stats(pick(nr, 'snr')),
        samples: nr.map(e => [e.t - start, e.rsrp, e.snr])
      } : null,
      rat: rats.at(-1) ?? null,
      rat_transitions: rats.reduce((acc, r, i) => (i && r !== rats[i - 1]
        ? [...acc, [inWindow('identity')[i].t - start, rats[i - 1], r]] : acc), []),
      rrc: Object.keys(rrc).length ? rrc : null,
      score_n: scores.length,
      stalls: inWindow('stall').map(e => [e.t - start, e.stalled]),
      pdn: inWindow('pdn').map(e => ({offset_ms: e.t - start, event: e.event, family: e.family,
                                      ...(e.prefix64 ? {prefix64: e.prefix64} : {})}))
    };
  };

  const samples = rows.map(row => ({...withoutDeviceAddresses(row), radio: radioFor(row)}));

  // A reselection between two rounds leaves no mark inside either window: the cell simply differs.
  // Without this the new cell would replace the old one silently.
  for (const [i, row] of samples.entries()) {
    const previous = i ? samples[i - 1].radio.cell?.gci : null;
    const here = row.radio.cell?.gci;
    const changed = !!(previous && here && previous !== here);
    row.radio.cell_changed_since_previous = changed;
    if (changed) row.radio.cells = [...new Set([previous, ...row.radio.cells, here])];
  }

  return {
    samples, roundEnd,
    plmn: identities.length
      ? `${identities[0].mcc}-${String(identities[0].mnc).padStart(2, '0')}` : null,
    tacs: [...new Set(identities.map(e => e.tac).filter(v => v != null))],
    signal_from: of('lte')[0] ? iso(of('lte')[0].t) : null,
    signal_to: of('lte').at(-1) ? iso(of('lte').at(-1).t) : null
  };
}

// The build the log came from. The export's user agent is frozen by Safari and cannot say.
export function osVersion(archive) {
  const plist = join(dirname(archive), 'logs', 'SystemVersion', 'SystemVersion.plist');
  if (!existsSync(plist)) return {ios_version: null, ios_build: null};
  try {
    const out = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist],
                                        {encoding: 'utf8'}));
    return {ios_version: out.ProductVersion ?? null, ios_build: out.ProductBuildVersion ?? null};
  } catch {
    return {ios_version: null, ios_build: null};
  }
}

// The archive's own name carries when the sysdiagnose was taken.
export function sysdiagnoseTaken(archive) {
  const m = archive.match(/sysdiagnose_(\d{4})\.(\d{2})\.(\d{2})_(\d{2})-(\d{2})-(\d{2})([+-]\d{4})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, zone] = m;
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${zone.slice(0, 3)}:${zone.slice(3)}`);
}

export const METHOD =
  'Rounds are browser request timing with ten-sample medians and a download ceiling near ' +
  '25 Mb/s. Radio values are the operating system\'s view of the baseband, read from the ' +
  'CommCenter and WirelessRadioManager log subsystems; they are not a DIAG capture.';

export const LIMITATIONS = [
  'Radio detail covers only the stretch the log still held when the sysdiagnose was taken.',
  'Absent values are written as sentinels in the log and are dropped, not read as numbers.',
  'A cell change is read from the log\'s own flag; identity reports alternate within a second.',
  'Cell identity is the phone\'s view: no radio-block utilisation and no scheduling decisions.',
  'The NR cell is listed among neighbours; the aggregated type is the only one carrying a level.',
  'An NR cell is named only for a round that measured NR signal, since reports lag their round.',
  'An NR ARFCN falls in overlapping bands, so `bands` lists candidates and `dl_mhz` is exact.',
  'Position is a phone fix, often a tower estimate, and can precede its round.',
  'The download ceiling makes a saturated round a lower bound.',
  `Line formats are unversioned by Apple and were read on ${BUILD_SEEN}.`
];

export function buildOutput(session, collector, archivePath) {
  const joined = enrich(session, collector.events);
  const rows = joined.samples;
  const taken = sysdiagnoseTaken(archivePath);
  const stopped = session.session?.stopped;

  return {
    format: 'nulog/session+radio',
    version: session.version,
    app_version: session.app_version,
    joined: new Date().toISOString(),
    probes: session.probes,
    summary: session.summary,
    session: {
      ...session.session,
      radio: {
        plmn: joined.plmn,
        operator_entered: session.session?.operator ?? null,
        tacs: joined.tacs,
        window: {
          started_ms: rows[0].t, stopped_ms: joined.roundEnd(rows.at(-1)),
          started: iso(rows[0].t), stopped: iso(joined.roundEnd(rows.at(-1))),
          timezone: session.session?.environment?.timezone ?? null, clock: 'phone'
        },
        sysdiagnose: {
          taken: taken ? iso(taken) : null,
          lag_after_stop_s: taken && stopped ? Math.round((taken - stopped) / 1000) : null,
          archive: basename(archivePath)
        },
        ...osVersion(archivePath),
        // The stretch of the ride the log still held. A count of covered rounds is left to the
        // reader; these two are not derivable from the rounds, since the first and last signal
        // line can fall outside any round.
        signal_from: joined.signal_from,
        signal_to: joined.signal_to,
        // `patterns` counts lines matched. A reselection count is separate, since the flag line
        // is logged on every report and reads 0 on almost all of them.
        parse: {
          ...collector.state, patterns: collector.counts,
          patterns_build: BUILD_SEEN, predicate: predicate()
        },
        method: METHOD,
        limitations: LIMITATIONS
      }
    },
    samples: rows,
    events: session.events
  };
}

async function readArchive(archivePath, from, to, collector) {
  const argv = ['show', archivePath, '--info', '--debug', '--style', 'ndjson',
                '--start', localStamp(from), '--end', localStamp(to), '--predicate', predicate()];
  const child = spawn('/usr/bin/log', argv, {stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  for await (const line of createInterface({input: child.stdout})) collector.addLine(line);
  const code = await new Promise(r => child.on('close', r));
  if (code !== 0) throw new Error(`log show exited ${code}: ${stderr.trim().slice(0, 300)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const [sessionPath, archivePath] = args.filter(a => !a.startsWith('--'));
  if (!sessionPath || !archivePath) {
    console.error('usage: node tools/radio-join.mjs <session.json> <system_logs.logarchive> ' +
                  '[--out <file>]');
    process.exit(2);
  }
  const flag = name => {
    const i = args.indexOf(`--${name}`);
    const value = i === -1 ? null : args[i + 1];
    return value && !value.startsWith('--') ? value : null;
  };

  const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
  const rows = (session.samples || []).slice().sort((a, b) => a.seq - b.seq);
  if (!rows.length) {
    console.error(`${sessionPath}: no rounds`);
    process.exit(1);
  }
  const intervalMs = session.session?.intervalMs ?? 20000;
  const from = rows[0].t - PAD_MS;
  const to = rows.at(-1).t + (rows.at(-1).round_ms ?? intervalMs) + PAD_MS;

  const collector = createCollector();
  try {
    await readArchive(archivePath, from, to, collector);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const missing = collector.missingRequired();
  if (missing.length) {
    console.error(`no line matched: ${missing.join(', ')}\n` +
      `the patterns were read on ${BUILD_SEEN}; this log is ` +
      `${JSON.stringify(osVersion(archivePath))}\nfix tools/radio-patterns.mjs, do not ignore this`);
    process.exit(1);
  }

  const out = buildOutput(session, collector, archivePath);
  const outPath = flag('out') ||
    join(dirname(sessionPath), `${basename(sessionPath, '.json')}-radio.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 1));

  const covered = out.samples.filter(r => r.radio.coverage !== 'none').length;
  console.log(`${outPath}: ${out.samples.length} rounds, ${covered} with radio coverage`);
  console.log(`  parsed ${collector.state.lines_read} records; ` +
    Object.entries(collector.counts).map(([k, v]) => `${k} ${v}`).join(', '));
  console.log(`  dropped ${collector.state.identifiers_dropped} records carrying identifiers, ` +
    `${collector.state.sentinels_dropped} sentinel values`);
}

if (process.argv[1] && process.argv[1].endsWith('radio-join.mjs')) await main();
