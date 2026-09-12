// The radio join: the patterns the log is read with, and the rules that decide what a round is
// allowed to claim. Log records here are written by hand, since a real archive carries a home
// address and the phone's identifiers.
import assert from 'node:assert';
import {suite} from './helpers.mjs';
import {PATTERNS, REQUIRED, predicate} from '../tools/radio-patterns.mjs';
import {createCollector, enrich, prefix64, withoutDeviceAddresses} from '../tools/radio-join.mjs';

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

await r.run();
