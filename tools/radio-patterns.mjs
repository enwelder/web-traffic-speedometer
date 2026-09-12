// Line patterns for the radio values the phone's unified log carries, one entry per value the join
// reads. `subsystem` and `category` narrow the log query; `regex` runs against a record's
// `eventMessage`. `example` is a line seen on the build below, and the suite asserts every regex
// still matches its own example.
//
// Apple versions none of these formats. They were read on iOS 27.0, build 24A435, a beta: expect
// them to change, and expect a required pattern matching nothing to be the first sign of it.

export const BUILD_SEEN = 'iOS 27.0 (24A435)';

const IRAT = 'com.apple.WirelessRadioManager.iRAT';
const COMMCENTER = 'com.apple.CommCenter';

// The query is narrowed to these pairs. `Coex/Trace` alone is a third of the records and carries
// nothing read here.
export const SOURCES = [
  {subsystem: IRAT, categories: ['TraceCellular', 'TraceHandoverManager', 'TraceMetrics']},
  {subsystem: COMMCENTER, categories: ['cm.2', '5wi.evt.2', '5wi.sd.2', 'DATA.PDP:0:']}
];

// A record whose message carries any of these is dropped before anything is retained: the log
// holds them in plain text.
export const IDENTIFIERS = /\b(IMEI|IMSI|ICCID|currentSubscriberId|currentMobileId)\s*=/;

// "No value", written as a number. A field carrying one is dropped and counted; the rest of the
// line is kept, since a report can hold a real area code beside a zeroed EARFCN.
export const SENTINELS = new Set([32767, -32768, -3276, 4294934528, 3276.7, -3276.8]);
export const isSentinel = n => n == null || Number.isNaN(n) || SENTINELS.has(n);

const num = s => (s == null ? null : Number(s));

// NR levels are printed as unsigned 32-bit: -75 arrives as 4294967221.
const signed32 = n => (n > 2 ** 31 ? n - 2 ** 32 : n);

// 3GPP 38.104 5.4.2.1, FR1. The phone reports `Is SA: 0` and FR1 throughout.
const nrDlMhz = n => (n < 600000 ? n * 0.005 : 3000 + (n - 600000) * 0.015);

// 38.104 table 5.4.2.3-1. The ranges overlap, so an ARFCN names every band it could belong to and
// never one; the frequency is exact.
const NR_BANDS = [['n1', 422000, 434000], ['n3', 361000, 376000], ['n7', 524000, 538000],
  ['n8', 185000, 192000], ['n20', 158200, 164200], ['n28', 151600, 160600],
  ['n38', 514000, 524000], ['n40', 460000, 480000], ['n41', 499200, 537999],
  ['n65', 422000, 440000], ['n75', 286400, 303400], ['n77', 620000, 680000],
  ['n78', 620000, 653333], ['n79', 693334, 733333]];
const nrBands = n => NR_BANDS.filter(([, lo, hi]) => n >= lo && n <= hi).map(([b]) => b);

export const PATTERNS = [
  {
    name: 'lte_signal',
    subsystem: IRAT, category: 'TraceCellular', required: true,
    regex: /received LTE SigInfo rssi (-?\d+) snr (-?[\d.]+) rsrq (-?\d+) rsrp (-?\d+)/,
    example: 'QMI.NAS.2: received LTE SigInfo rssi -80 snr 0 rsrq -14 rsrp -112',
    read: m => ({kind: 'lte', rssi: num(m[1]), snr: num(m[2]), rsrq: num(m[3]), rsrp: num(m[4])})
  },
  {
    name: 'nr_signal',
    subsystem: IRAT, category: 'TraceCellular', required: false,
    regex: /received New SigInfo snr (-?[\d.]+) rsrp (-?\d+)/,
    example: 'QMI.NAS.2: received New SigInfo snr 24 rsrp -80',
    read: m => ({kind: 'nr', snr: num(m[1]), rsrp: num(m[2])})
  },
  {
    // The NR leg's identity, listed under the LTE serving cell's `NR Neighbor cells` heading; no
    // `NR Serving Cells` block exists. A report holds exactly one `Neighbor Type: 1` line, the
    // aggregated cell, and it is the only type ever carrying a level, so the type is matched here
    // rather than filtered later. `SCS`, `Is SA` and `BWP Support` read 0 on every line.
    name: 'nr_cell',
    subsystem: COMMCENTER, category: 'cm.2', required: false,
    regex: /NRARFCN: (\d+), PCI: (\d+), RSRP: (-?\d+), RSRQ: (-?\d+), SCS: \d+, Is SA: \d+, Bandwidth: (\d+), BWP Support: \d+, Neighbor Type: 1\b/,
    example: 'NRARFCN: 646848, PCI: 119, RSRP: 4294967221, RSRQ: 4294967285, SCS: 0, Is SA: 0, ' +
             'Bandwidth: 100000000, BWP Support: 0, Neighbor Type: 1, Throughput: 0',
    // A bandwidth of zero means the report carries none. PCI 0 is a valid identity.
    zeroAbsent: ['bw_mhz'],
    read: m => {
      const arfcn = num(m[1]);
      return {kind: 'nr_cell', arfcn, dl_mhz: Math.round(nrDlMhz(arfcn) * 100) / 100,
              bands: nrBands(arfcn), pci: num(m[2]), rsrp: signed32(num(m[3])),
              rsrq: signed32(num(m[4])), bw_mhz: num(m[5]) / 1e6};
    }
  },
  {
    // The identity source: it carries `cell_id` unredacted, which the CommCenter table reports as
    // `Cell ID: <private>`.
    name: 'rat_info',
    subsystem: IRAT, category: 'TraceCellular', required: true,
    regex: /RAT Info: (\w+), MCC (\d+), MNC (\d+), TAC (\d+), cell_id (\d+)/,
    example: 'QMI.DSD.1 RAT Info: kLTE, MCC 204, MNC 8, TAC 32004, cell_id 16461107',
    read: m => ({kind: 'identity', rat: m[1], mcc: num(m[2]), mnc: num(m[3]), tac: num(m[4]),
                 eci: num(m[5])})
  },
  {
    name: 'gci',
    subsystem: IRAT, category: 'TraceCellular', required: false,
    regex: /GCI: (\d+)\.(\d+)\.(\d+)\.(\d+)/,
    example: 'QMI.DSD.1 GCI: 204.8.32004.16461108',
    read: m => ({kind: 'gci', mcc: num(m[1]), mnc: num(m[2]), tac: num(m[3]), eci: num(m[4])})
  },
  {
    // A reselection is read here and nowhere else: consecutive identity reports alternate between
    // two cells inside one second, so comparing identities overstates reselections.
    name: 'cell_changed',
    subsystem: IRAT, category: 'TraceCellular', required: true,
    regex: /Cell Changed (\d)/,
    example: 'updateConnectedStateSummary 1, Cell Changed 1, nrCellType: 0',
    read: m => ({kind: 'cell_changed', changed: m[1] === '1'})
  },
  {
    name: 'score',
    subsystem: IRAT, category: 'TraceHandoverManager', required: true,
    regex: /RRC state: (\d+),.*?RSRP: (-?[\d.]+), SNR: (-?[\d.]+), RSRQ: (-?[\d.]+)/,
    example: 'evaluateCellularScore: RRC state: 1, forceActiveEval:0, RSRP: -103.000000, ' +
             'SNR: 0.400000, RSRQ: -16.000000, data slot: CTSubscriptionSlotTwo',
    read: m => ({kind: 'score', rrc: num(m[1]), rsrp: num(m[2]), snr: num(m[3]), rsrq: num(m[4])})
  },
  {
    // iOS's own stall detector, independent of the tool's stall check.
    name: 'stall',
    subsystem: IRAT, category: 'TraceMetrics', required: false,
    regex: /stall detected (\d)/,
    example: '-[WRM_EnhancedCTService updateDataStallState:stall:]_block_invoke: slot ' +
             'CTSubscriptionSlotTwo stall detected 1',
    read: m => ({kind: 'stall', stalled: m[1] === '1'})
  },
  {
    name: 'pdn_release',
    subsystem: COMMCENTER, category: 'DATA.PDP:0:', required: false,
    regex: /notifyDisconnect:.*disconnected by network on kDataProtocolFamily(IPv6|IPv4)/,
    example: 'notifyDisconnect: DATA.QMIContext.2:0: disconnected by network on ' +
             'kDataProtocolFamilyIPv6',
    read: m => ({kind: 'pdn', event: 'released_by_network', family: m[1]})
  },
  {
    name: 'pdn_up',
    subsystem: COMMCENTER, category: 'DATA.PDP:0:', required: false,
    regex: /ipv6ServiceUp: addr = ([0-9a-fA-F:]+)/,
    example: 'ipv6ServiceUp: addr = 2a02:a420:27f7:31:39:ec33:998:9a7f',
    read: m => ({kind: 'pdn', event: 'up', family: 'IPv6',
                 prefix64: `${m[1].split(':').slice(0, 4).join(':')}::/64`})
  },
  {
    // Band, bandwidth and PCI, which the identity line does not carry. `Cell ID` is redacted here.
    name: 'serving_cell',
    subsystem: COMMCENTER, category: ['cm.2', '5wi.evt.2', '5wi.sd.2'], required: false,
    regex: /Index: 0, MCC: (\d+), MNC: (\d+), Band info: (\d+), Area code: (\d+), Cell ID: (\S+?), EARFCN: (\d+), PID: (\d+)(?:.*?Bandwidth: (\d+))?/,
    example: 'Index: 0, MCC: 204, MNC: 08, Band info: 7, Area code: 32004, Cell ID: <private>, ' +
             'EARFCN: 3150, PID: 253, Latitude: <private>, Longitude: <private>, Bandwidth: 50',
    // A band, area code or EARFCN of zero means the report carries none, and one report can hold a
    // real area code beside a zeroed EARFCN. PCI 0 is a valid identity.
    zeroAbsent: ['band', 'tac', 'earfcn', 'bw_rb'],
    read: m => ({kind: 'radio_config', mcc: num(m[1]), mnc: num(m[2]), band: num(m[3]),
                 tac: num(m[4]), earfcn: num(m[6]), pci: num(m[7]), bw_rb: num(m[8])})
  }
];

export const REQUIRED = PATTERNS.filter(p => p.required).map(p => p.name);

// The predicate for `log show`, built from SOURCES so the query and the patterns cannot drift.
export const predicate = () => SOURCES
  .map(s => `(subsystem == "${s.subsystem}" AND (${
    s.categories.map(c => `category == "${c}"`).join(' OR ')}))`)
  .join(' OR ');
