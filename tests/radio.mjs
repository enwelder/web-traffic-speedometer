// The radio join: the patterns the log is read with, and the rules that decide what a round is
// allowed to claim. Log records here are written by hand, since a real archive carries a home
// address and the phone's identifiers.
import assert from 'node:assert';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {suite} from './helpers.mjs';
import {PATTERNS, REQUIRED, predicate} from '../tools/radio-patterns.mjs';
import {createCollector, enrich, extractSysdiagnose, isSysdiagnoseArchive, prefix64,
        withoutDeviceAddresses} from '../tools/radio-join.mjs';

const r = suite('radio');

const AT = Date.parse('2026-09-12T15:00:00.000+02:00');
// A record as `log show --style ndjson` writes one.
const record = (pattern, message, offsetMs = 0) => ({
  timestamp: new Date(AT + offsetMs).toISOString(),
  subsystem: pattern.subsystem,
  category: Array.isArray(pattern.category) ? pattern.category[0] : pattern.category,
  eventMessage: message
});
const byName = name => PATTERNS.find(p => p.name === name);
const collect = records => {
  const c = createCollector();
  for (const rec of records) c.add(rec);
  return c;
};
const signal = (offsetMs, rsrp) =>
  record(byName('lte_signal'), `QMI.NAS.2: received LTE SigInfo rssi -80 snr 1 rsrq -14 rsrp ${rsrp}`,
         offsetMs);
const identity = (offsetMs, eci) =>
  record(byName('rat_info'), `QMI.DSD.1 RAT Info: kLTE, MCC 204, MNC 8, TAC 32004, cell_id ${eci}`,
         offsetMs);
const session = rounds => ({
  session: {intervalMs: 20000, operator: 'KPN', environment: {timezone: 'Europe/Amsterdam'}},
  samples: rounds
});
const round = (seq, offsetMs, over = {}) =>
  ({seq, t: AT + offsetMs, round_ms: 4000, probes: {}, grades: {voice: 'green'}, ...over});

r.test('every pattern MUST match its own example WHEN the registry is read', () => {
  for (const p of PATTERNS) {
    assert.match(p.example, p.regex, `${p.name} no longer matches the line it was written for`);
    assert.ok(p.read(p.example.match(p.regex)), `${p.name} reads nothing from its example`);
  }
  assert.ok(REQUIRED.length >= 4, `required patterns: ${REQUIRED.join(', ')}`);
  assert.match(predicate(), /subsystem == "com\.apple\.WirelessRadioManager\.iRAT"/);
});

r.test('createCollector MUST drop the record and keep no value WHEN it carries a device identifier', () => {
  const c = collect([
    record(byName('rat_info'),
           '<CTMobileEquipmentInfo 0x1, IMEI=350719113624127, ICCID=(null), IMSI=(null)> ' +
           'QMI.DSD.1 RAT Info: kLTE, MCC 204, MNC 8, TAC 32004, cell_id 16461107'),
    identity(10, 16461107)
  ]);
  assert.equal(c.state.identifiers_dropped, 1);
  assert.equal(c.events.length, 1, 'only the clean record is kept');
  assert.equal(c.counts.rat_info, 1);
});

r.test('createCollector MUST null a zeroed field and keep the rest WHEN a report is partly absent', () => {
  const c = collect([record(byName('serving_cell'),
    'Index: 0, MCC: 204, MNC: 08, Band info: 0, Area code: 32004, Cell ID: <private>, ' +
    'EARFCN: 0, PID: 253, Bandwidth: 0')]);
  const [config] = c.events;
  assert.equal(config.tac, 32004, 'a real area code survives a zeroed band');
  assert.deepEqual([config.band, config.earfcn, config.bw_rb], [null, null, null]);
  assert.equal(config.pci, 253, 'PCI 0 is a valid identity and is not treated as absent');
  assert.ok(c.state.sentinels_dropped >= 3, `dropped ${c.state.sentinels_dropped}`);
});

r.test('createCollector MUST null a sentinel reading WHEN the log writes one in place of a value', () => {
  const c = collect([record(byName('nr_signal'),
                            'QMI.NAS.2: received New SigInfo snr -3276 rsrp -32768')]);
  assert.deepEqual([c.events[0].snr, c.events[0].rsrp], [null, null]);
  assert.equal(c.state.sentinels_dropped, 2);
});

r.test('createCollector MUST report the patterns that matched nothing WHEN a required line is absent', () => {
  const c = collect([identity(0, 16461107)]);
  const missing = c.missingRequired();
  assert.ok(missing.includes('lte_signal'), `missing: ${missing.join(', ')}`);
  assert.ok(!missing.includes('rat_info'), 'a pattern that matched is not missing');
});

r.test('enrich MUST report coverage none and no cell WHEN no radio record falls in the round', () => {
  const {samples} = enrich(session([round(0, 0)]), []);
  assert.equal(samples[0].radio.coverage, 'none');
  assert.equal(samples[0].radio.cell, null);
  assert.equal(samples[0].radio.lte, null);
});

r.test('enrich MUST report coverage partial WHEN the round holds one signal sample', () => {
  const events = collect([identity(0, 16461107), signal(500, -103)]).events;
  const {samples} = enrich(session([round(0, 0)]), events);
  assert.equal(samples[0].radio.coverage, 'partial');
  assert.equal(samples[0].radio.lte.n, 1);
  assert.equal(samples[0].radio.cell.gci, '204.8.32004.16461107');
});

r.test('enrich MUST report coverage full and the sample spread WHEN the round holds a run of samples', () => {
  const events = collect([identity(0, 16461107), signal(500, -103), signal(2000, -95),
                          signal(3500, -99)]).events;
  const {samples} = enrich(session([round(0, 0)]), events);
  const {radio} = samples[0];
  assert.equal(radio.coverage, 'full');
  assert.deepEqual(radio.lte.rsrp, {min: -103, med: -99, max: -95});
  assert.deepEqual(radio.lte.samples.map(s => s[0]), [500, 2000, 3500], 'offsets from the round');
});

r.test('enrich MUST derive the eNB and sector WHEN the identity carries a cell id', () => {
  const events = collect([identity(0, 1426188), signal(100, -121), signal(1000, -120)]).events;
  const {samples} = enrich(session([round(0, 0)]), events);
  assert.deepEqual([samples[0].radio.cell.enb, samples[0].radio.cell.sector], [5571, 12]);
});

r.test('enrich MUST count one reselection WHEN the flag repeats inside a second', () => {
  const flag = byName('cell_changed');
  const events = collect([
    identity(0, 16461107), signal(100, -100), signal(1200, -101),
    record(flag, 'updateConnectedStateSummary 1, Cell Changed 1, nrCellType: 0', 900),
    record(flag, 'updateConnectedStateSummary 1, Cell Changed 1, nrCellType: 0', 1100),
    record(flag, 'updateConnectedStateSummary 1, Cell Changed 0, nrCellType: 0', 1500)
  ]).events;
  const {samples} = enrich(session([round(0, 0)]), events);
  assert.equal(samples[0].radio.cell_changes, 1, 'two marks 200 ms apart are one reselection');
});

r.test('enrich MUST flag the change and list both cells WHEN the cell differs between rounds', () => {
  const events = collect([
    identity(0, 16461107), signal(100, -100), signal(1000, -101),
    identity(6000, 16458509), signal(6100, -120), signal(7000, -122)
  ]).events;
  const {samples} = enrich(session([round(0, 0), round(1, 6000)]), events);
  assert.equal(samples[0].radio.cell_changed_since_previous, false, 'the first round has no prior');
  assert.equal(samples[1].radio.cell_changed_since_previous, true);
  assert.deepEqual(samples[1].radio.cells,
                   ['204.8.32004.16461107', '204.8.32004.16458509'],
                   'a change between windows still names the cell it left');
});

r.test('enrich MUST bound a round by the interval WHEN the round never recorded its duration', () => {
  const events = collect([identity(0, 16461107), signal(100, -100), signal(15000, -101)]).events;
  const {samples} = enrich(session([round(0, 0, {round_ms: null})]), events);
  assert.equal(samples[0].radio.lte.n, 2, 'the 20 s interval bounds a round with no round_ms');
});

const nrCell = (offsetMs, over = '') =>
  record(byName('nr_cell'),
         `NRARFCN: 646848, PCI: 119, RSRP: 4294967221, RSRQ: 4294967285, SCS: 0, Is SA: 0, ` +
         `Bandwidth: 100000000, BWP Support: 0, Neighbor Type: ${over || '1'}, Throughput: 0`,
         offsetMs);
const nrSignal = (offsetMs, rsrp) =>
  record(byName('nr_signal'), `QMI.NAS.2: received New SigInfo snr 24 rsrp ${rsrp}`, offsetMs);

r.test('nr_cell MUST read a signed level WHEN the log prints it as an unsigned integer', () => {
  const [cell] = collect([nrCell(0)]).events;
  assert.deepEqual([cell.rsrp, cell.rsrq], [-75, -11]);
  assert.equal(cell.bw_mhz, 100);
});

r.test('nr_cell MUST derive the frequency and every band the ARFCN falls in WHEN it is read', () => {
  const p = byName('nr_cell');
  const read = arfcn => p.read((`NRARFCN: ${arfcn}, PCI: 1, RSRP: 4294967221, RSRQ: 4294967285, ` +
    'SCS: 0, Is SA: 0, Bandwidth: 20000000, BWP Support: 0, Neighbor Type: 1').match(p.regex));
  assert.equal(read(646848).dl_mhz, 3702.72);
  assert.deepEqual(read(646848).bands, ['n77', 'n78'], 'the FR1 band ranges overlap');
  assert.equal(read(432030).dl_mhz, 2160.15);
  assert.deepEqual(read(432030).bands, ['n1', 'n65']);
});

r.test('nr_cell MUST keep no event WHEN the report is a cell the phone did not aggregate', () => {
  const c = collect([nrCell(0, '2')]);
  assert.equal(c.counts.nr_cell, 0);
  assert.equal(c.events.length, 0);
});

r.test('nr_cell MUST null the level and keep the identity WHEN the level is a sentinel', () => {
  const [cell] = collect([record(byName('nr_cell'),
    'NRARFCN: 646848, PCI: 456, RSRP: 4294934528, RSRQ: 4294934528, SCS: 0, Is SA: 0, ' +
    'Bandwidth: 100000000, BWP Support: 0, Neighbor Type: 1, Throughput: 0')]).events;
  assert.deepEqual([cell.rsrp, cell.rsrq], [null, null]);
  assert.equal(cell.pci, 456);
});

const lteRound = (...extra) =>
  collect([identity(0, 16461107), signal(100, -100), signal(1000, -101), ...extra]).events;
const nrCellOf = events => enrich(session([round(0, 0)]), events).samples[0].radio.nr_cell;

r.test('enrich MUST attach the NR cell beside the LTE cell WHEN the round measured NR signal', () => {
  const events = lteRound(nrCell(200), nrSignal(300, -80));
  const {radio} = enrich(session([round(0, 0)]), events).samples[0];
  assert.equal(radio.cell.gci, '204.8.32004.16461107');
  assert.deepEqual([radio.nr_cell.arfcn, radio.nr_cell.pci, radio.nr_cell.rsrp,
                    radio.nr_cell.offset_ms], [646848, 119, -75, 200]);
});

r.test('enrich MUST name no NR cell WHEN the round measured no NR signal', () => {
  assert.equal(nrCellOf(lteRound(nrCell(200))), null);
});

r.test('enrich MUST name no NR cell WHEN no report reaches the round', () => {
  assert.equal(nrCellOf(lteRound(nrSignal(300, -80))), null);
});

r.test('enrich MUST name no NR cell WHEN the report predates the round beyond the bound', () => {
  assert.equal(nrCellOf(lteRound(nrSignal(300, -80), nrCell(-130000))), null);
});

r.test('enrich MUST name the NR cell WHEN the report predates the round within the bound', () => {
  assert.equal(nrCellOf(lteRound(nrSignal(300, -80), nrCell(-60000))).offset_ms, -60000);
});

r.test('withoutDeviceAddresses MUST carry an address as its prefix WHEN a probe reported one', () => {
  const row = withoutDeviceAddresses({probes: {
    down: {egress_ip: '2a02:a420:27a2:805c:3df8:69d4:63d3:56d9'},
    udp: {public_ips: ['2a02:a420:27a2:805c:1:2:3:4', '77.63.125.222']}
  }});
  assert.equal(row.probes.down.egress_ip, '2a02:a420:27a2:805c::/64');
  assert.deepEqual(row.probes.udp.public_ips, ['2a02:a420:27a2:805c::/64', '77.63.125.222'],
                   'a public IPv4 address has no device half and is carried whole');
  assert.equal(prefix64(null), null);
});

r.test('isSysdiagnoseArchive MUST hold only for a packed archive WHEN a path is given', () => {
  assert.equal(isSysdiagnoseArchive('sysdiagnose_2026.09.12_15-50-12+0200_iPhone.tar.gz'), true);
  assert.equal(isSysdiagnoseArchive('/a/b/system_logs.logarchive'), false);
});

r.test('extractSysdiagnose MUST unpack the log bundle alone and remove it WHEN cleanup runs', () => {
  const src = mkdtempSync(join(tmpdir(), 'nulog-fixture-'));
  const name = 'sysdiagnose_2026.09.12_15-50-12+0200_iPhone-OS_iPhone_24A435';
  mkdirSync(join(src, name, 'system_logs.logarchive', 'Persist'), {recursive: true});
  mkdirSync(join(src, name, 'logs', 'SystemVersion'), {recursive: true});
  mkdirSync(join(src, name, 'WiFi'), {recursive: true});
  writeFileSync(join(src, name, 'system_logs.logarchive', 'Persist', '0001.tracev3'), 'trace');
  writeFileSync(join(src, name, 'logs', 'SystemVersion', 'SystemVersion.plist'), 'plist');
  writeFileSync(join(src, name, 'WiFi', 'wifi.log'), 'not part of the join');
  const archive = join(src, `${name}.tar.gz`);
  execFileSync('tar', ['czf', archive, '-C', src, name]);

  const {archive: bundle, cleanup} = extractSysdiagnose(archive);
  assert.ok(existsSync(join(bundle, 'Persist', '0001.tracev3')), 'the log bundle is unpacked');
  assert.ok(existsSync(join(bundle, '..', 'logs', 'SystemVersion', 'SystemVersion.plist')),
            'the build plist is unpacked beside it');
  assert.equal(existsSync(join(bundle, '..', 'WiFi')), false, 'nothing else is unpacked');
  cleanup();
  assert.equal(existsSync(bundle), false, 'the unpacked copy is removed');
  rmSync(src, {recursive: true, force: true});
});

r.test('extractSysdiagnose MUST fail and leave nothing WHEN the archive holds no log bundle', () => {
  const src = mkdtempSync(join(tmpdir(), 'nulog-fixture-'));
  mkdirSync(join(src, 'other'), {recursive: true});
  writeFileSync(join(src, 'other', 'notes.txt'), 'no log bundle here');
  const archive = join(src, 'empty.tar.gz');
  execFileSync('tar', ['czf', archive, '-C', src, 'other']);
  assert.throws(() => extractSysdiagnose(archive), /system_logs\.logarchive/);
  rmSync(src, {recursive: true, force: true});
});

await r.run();
