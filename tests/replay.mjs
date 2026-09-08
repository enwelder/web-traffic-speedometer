// Replays recorded journeys through the measurement code. Three anonymised recordings are
// committed: a 5G run, a commute with pauses and coarse positions, and one where a probe
// failed alone for twenty rounds. Unlike synthetic fixtures, their contents were not chosen
// to match the code.
import assert from 'node:assert';
import {readFileSync, readdirSync} from 'node:fs';
import {stubBrowser, suite} from './helpers.mjs';

stubBrowser();
const g = await import('../js/grade.js');
const {summarise, sessionJson} = await import('../js/export.js');
const {anonymise, assertClean} = await import('../tools/anonymise.mjs');

const dir = new URL('./fixtures/', import.meta.url);
const load = f => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
const files = readdirSync(dir).filter(f => f.endsWith('.json'));
const journeys = Object.fromEntries(files.map(f => [f.replace('.json', ''), load(f)]));

const r = suite('replay');

r.test('the fixtures carry nothing that could place anyone', () => {
  assert.ok(files.length >= 3, `three journeys are committed: ${files.join(', ')}`);
  for (const [name, j] of Object.entries(journeys)) {
    assert.doesNotThrow(() => assertClean(j), `${name} passes the anonymiser's own guard`);
    assert.equal(j.format, 'wts/fixture', `${name} is not mistakable for a real export`);
    assert.ok(j.samples.every(s => s.lat === null && s.lon === null), `${name} has no coordinates`);
    assert.ok(j.samples.some(s => s.accuracy != null),
              `${name} keeps accuracy, which the position rules are tested against`);
    // Timestamps are shifted and intervals preserved, since the scheduler is tested on them.
    const gaps = j.samples.slice(1).map((s, i) => s.t - j.samples[i].t).filter(x => x > 0);
    assert.ok(gaps.length > 5 && Math.min(...gaps) > 0, `${name} preserves round spacing`);
  }
});

r.test('anonymising is repeatable and loses only what it claims to', () => {
  const original = {
    session: {started: 1700000000000, stopped: 1700000100000, name: 'Morning KPN',
              environment: {app_version: '9.9.9', user_agent: 'Mozilla/5.0 (iPhone)', timezone: 'Europe/Amsterdam'}},
    samples: [{
      seq: 0, t: 1700000000000, pos_t: 1700000000000 - 500, lat: 51.9244, lon: 4.4777,
      accuracy: 12, heading: 71, speed: 30,
      probes: {ip6: {ok: true, ms: 33, egress_ip: '2a02:a473::9'},
               dns: {ok: true, ms: 190, host: 'deadbeefdeadbeef.github.io'},
               udp: {ok: true, ms: 50, public_ips: ['2a02:a473::9', '80.60.65.96']}}
    }],
    events: [{t: 1700000000500, type: 'mark', lat: 51.9, lon: 4.4, text: 'stalled'}]
  };
  const a = anonymise(original);
  assert.doesNotThrow(() => assertClean(a));
  assert.equal(a.samples[0].lat, null);
  assert.equal(a.samples[0].heading, undefined, 'a bearing places you too');
  assert.equal(a.samples[0].accuracy, 12, 'accuracy is a measurement, not a position');
  assert.equal(a.samples[0].speed, 30, 'and so is speed');
  assert.equal(a.samples[0].probes.ip6.ms, 33, 'every measurement survives untouched');
  assert.notEqual(a.samples[0].probes.ip6.egress_ip, '2a02:a473::9');
  assert.match(a.samples[0].probes.dns.host, /^x+\.github\.io$/, 'the hostname keeps its shape only');
  assert.equal(a.session.environment.user_agent, '<redacted>');
  assert.equal(a.events[0].text, '<redacted>', 'a typed mark can name a street; the time of it cannot');
  assert.equal(a.session.environment.app_version, '9.9.9', 'the version is needed to read the file');
  // Intervals preserved, absolute time shifted.
  assert.notEqual(a.samples[0].t, original.samples[0].t);
  assert.equal(a.samples[0].t - a.session.started, original.samples[0].t - original.session.started);
  assert.deepEqual(anonymise(original), a, 'the same input gives the same fixture');
});

// The guard rejects anything it cannot account for, since a scan for known-bad shapes
// accepts whatever the schema grows next. Each case below is a shape that passed such a
// scan.
r.test('the anonymiser refuses anything it has not been taught to clean', () => {
  const base = anonymise({
    session: {started: 1700000000000, stopped: 1700000100000, name: 'Morning KPN', note: '',
              environment: {app_version: '9.9.9', user_agent: 'Mozilla/5.0 (iPhone)',
                            timezone: 'Europe/Amsterdam', screen: '393x852@3'}},
    samples: [{seq: 0, t: 1700000000000, pos_t: 1700000000000, lat: 51.9244, lon: 4.4777,
               accuracy: 12, heading: 71, probes: {ip6: {ok: true, ms: 33}}}],
    events: []
  });
  const clone = () => JSON.parse(JSON.stringify(base));
  const cases = {
    'a compressed IPv6 address': d => { d.samples[0].probes.ip6.egress_ip = '2a02:a473::9'; },
    'coordinates under a new name': d => { d.samples[0].latitude = 51.9244; },
    'a coordinate as a string': d => { d.samples[0].lat = '51.9244'; },
    'coordinates inside an array': d => { d.samples[0].pos = [51.9244, 4.4777]; },
    'a bearing': d => { d.samples[0].heading = 71; },
    'a typed note': d => { d.events.push({t: d.session.started, type: 'note', lat: null, lon: null,
                                          text: 'left home at Stationsplein 1'}); },
    'a journey in the session name': d => { d.session.name = 'Rotterdam-Utrecht 08:14'; },
    'a session note': d => { d.session.note = 'got off at Gouda'; },
    'a time zone': d => { d.session.environment.timezone = 'Europe/Amsterdam'; },
    'an unshifted timestamp': d => { d.session.exportedAt = 1757000000000; },
    'a user agent without the obvious words': d => {
      d.session.environment.user_agent = 'Version/17.0 Safari/605.1';
    }
  };
  for (const [what, mutate] of Object.entries(cases)) {
    const doc = clone();
    mutate(doc);
    assert.throws(() => assertClean(doc), undefined, `${what} was accepted`);
  }
  assert.doesNotThrow(() => assertClean(base), 'and a clean fixture still passes');
});

r.test('grading runs over every recording without inventing or crashing', () => {
  for (const [name, j] of Object.entries(journeys)) {
    let graded = 0;
    for (const s of j.samples) {
      const grades = g.gradeRound(s);
      if (s.skipped) { assert.equal(grades, null, `${name}: a skipped round is not graded`); continue; }
      assert.ok(grades, `${name} seq ${s.seq}`);
      for (const [cap, val] of Object.entries(grades)) {
        assert.ok(val === null || g.GRADES.includes(val),
                  `${name} seq ${s.seq}: ${cap} produced ${val}`);
        // A capability with no usable input yields no grade and no value.
        if (val === null) {
          assert.equal(g.capabilityValue(cap, s), null,
                       `${name} seq ${s.seq}: ${cap} had a value but no grade`);
        }
      }
      graded++;
    }
    assert.ok(graded > 20, `${name}: ${graded} rounds graded`);
  }
});

r.test('nothing derived from a real journey is a number that cannot exist', () => {
  // Sweeps every figure derived from the recordings for the products of broken arithmetic:
  // NaN from a division by zero, Infinity from a zero-length window, a negative duration
  // from a clock that moved.
  const finite = (v, where) => {
    if (v == null || typeof v !== 'number') return;
    assert.ok(Number.isFinite(v), `${where} is ${v}`);
  };
  const nonNegative = (v, where) => {
    finite(v, where);
    if (typeof v === 'number') assert.ok(v >= 0, `${where} is negative: ${v}`);
  };

  for (const [name, j] of Object.entries(journeys)) {
    for (const s of j.samples) {
      const at = `${name} seq ${s.seq}`;
      for (const k of ['late_ms', 'mono', 'accuracy', 'prev_round_ms', 'first_packet_ms']) {
        nonNegative(s[k], `${at}.${k}`);
      }
      nonNegative(s.speed_derived, `${at}.speed_derived`);
      for (const [id, probe] of Object.entries(s.probes || {})) {
        if (!probe) continue;
        for (const k of ['ms', 'ms_min', 'ms_max', 'bytes', 'duration_ms', 'ttfb_ms',
                         'bps_steady', 'bps_peak', 'warmup_ms', 'warmup_bytes']) {
          nonNegative(probe[k], `${at}.${id}.${k}`);
        }
        if (probe.ms_samples) {
          assert.ok(probe.ms_samples.every(Number.isFinite), `${at}.${id}.ms_samples`);
          assert.ok(probe.samples_ok <= probe.ms_samples.length,
                    `${at}.${id}: more successes than attempts`);
        }
        if (probe.ok === false) assert.ok(probe.fail, `${at}.${id}: a failure with no reason`);
      }
    }

    const sum = summarise(j.samples);
    const walk = (v, where) => {
      if (typeof v === 'number') return finite(v, where);
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
    };
    walk(sum, `${name}.summary`);
    assert.equal(sum.ran + sum.skipped, j.samples.length,
                 `${name}: every round is either a measurement or a skip, never neither`);
    assert.ok(sum.degraded <= sum.ran, `${name}: more degraded rounds than rounds`);
  }
});

r.test('every impossible speed in the recordings comes from a fix the rules now reject', () => {
  // The recordings contain rates up to 189 m/s (681 km/h) from trains doing 140. Every such
  // row must be caught by one of the two rules: a coarse fix, which now produces no speed at
  // all, or a rate above the plausible ceiling.
  const MAX_PLAUSIBLE_MS = 111;   // 400 km/h, above a Thalys at full speed
  const FINE_ACCURACY_M = 100;
  let impossible = 0;
  for (const [name, j] of Object.entries(journeys)) {
    for (const s of j.samples) {
      if (s.speed_derived == null || s.speed_derived <= MAX_PLAUSIBLE_MS) continue;
      impossible++;
      assert.ok(s.accuracy > FINE_ACCURACY_M,
                `${name} seq ${s.seq}: ${s.speed_derived} m/s from a fix accurate to ` +
                `${s.accuracy} m — neither rule would have caught this`);
    }
  }
  assert.ok(impossible >= 3,
            `the recordings still carry the rows the rules were written for: ${impossible}`);
});

r.test('the recordings cannot yet speak for the throughput probe', () => {
  // Every committed recording predates the time-boxed download, so its rows carry
  // whole-transfer figures and no `bps_steady`; the video capability is graded only against
  // the synthetic streams in tests/edges.mjs. Adding a recording from 3.3.0 or later fails
  // this test, which is when it should become an assertion about the rate.
  const rated = Object.values(journeys)
    .flatMap(j => j.samples)
    .filter(s => s.probes?.down?.bps_steady != null);
  assert.equal(rated.length, 0,
               `a journey now carries a steady rate (${rated.length} rounds): grade it here ` +
               `instead of trusting the synthetic streams`);
});

r.test('a recording from an older build grades without a schema for it', () => {
  // The oldest fixture predates the UDP probe, the steady rate and the grades field. Missing
  // fields must grade as null rather than throw.
  const old = journeys['stuck-probe'];
  assert.equal(old.source_app_version, '6.0.0');
  assert.ok(!old.samples[0].probes.udp, 'no UDP probe existed then');
  const grades = g.gradeRound(old.samples[0]);
  assert.ok(g.GRADES.includes(grades.realtime), 'what can be graded is');
  assert.equal(grades.video, null, 'and what cannot is left empty');
});

r.test('the run that looked broken was the grading, not the network', () => {
  // Forty rounds of 5G at 30-60 ms round trips and ~200 ms fresh lookups grade green under
  // per-capability thresholds.
  const j = journeys['good-5g'];
  const tally = cap => j.samples.reduce((acc, s) => {
    const v = g.gradeRound(s)?.[cap];
    if (v) acc[v] = (acc[v] || 0) + 1;
    return acc;
  }, {});

  const newsite = tally('newsite');
  assert.ok((newsite.green || 0) >= j.samples.length * 0.7,
            `a fresh lookup at ~200 ms is a good result, not a warning: ${JSON.stringify(newsite)}`);

  const realtime = tally('realtime');
  assert.ok((realtime.green || 0) >= j.samples.length * 0.8,
            `30-60 ms round trips are green: ${JSON.stringify(realtime)}`);

  // The rounds that a single shared latency scale would have marked down.
  const oneScale = j.samples.filter(s => s.probes.dns.ms >= 300).length;
  assert.ok(oneScale >= 5,
            `${oneScale} rounds would have been marked down by a shared 300 ms threshold`);
});

r.test('a wedged probe is visible in the recording that showed it', () => {
  const j = journeys['stuck-probe'];
  // The control probe failed alone for the last twenty rounds while the rest recovered.
  const tail = j.samples.slice(-20);
  assert.ok(tail.every(s => !s.probes.web.ok), 'the control never recovered');
  assert.ok(tail.filter(s => s.probes.ip6.ok).length >= 18, 'while the link was fine');
  // One probe failing alone still grades the capability it feeds as red.
  const grades = tail.map(s => g.gradeRound(s).tap);
  assert.ok(grades.every(x => x === 'red'), 'and the capability it feeds says so');
});

r.test('the rollup describes each recording without throwing', () => {
  for (const [name, j] of Object.entries(journeys)) {
    const sum = summarise(j.samples);
    assert.equal(sum.rounds, j.samples.length, name);
    assert.ok(sum.ran > 0 && sum.ran <= sum.rounds);
    assert.ok(sum.degraded >= 0 && sum.degraded <= sum.ran);
    for (const [id, p] of Object.entries(sum.probes)) {
      assert.ok(p.ok <= p.n, `${name}/${id}: ok cannot exceed attempts`);
      if (p.ms_p50 != null && p.ms_p90 != null) {
        assert.ok(p.ms_p90 >= p.ms_p50, `${name}/${id}: p90 below p50`);
        assert.ok(p.ms_max >= p.ms_p90, `${name}/${id}: max below p90`);
      }
    }
    // Export round-trips: every round and the same rollup.
    const out = JSON.parse(sessionJson(j.session, j.samples, j.events));
    assert.equal(out.samples.length, j.samples.length, `${name} exports every round`);
    assert.deepEqual(out.summary, sum);
  }
});

r.test('the recordings agree with what the scheduler promises', () => {
  for (const [name, j] of Object.entries(journeys)) {
    const seqs = j.samples.map(s => s.seq);
    assert.deepEqual(seqs, seqs.map((_, i) => i), `${name}: seq is contiguous, no round lost`);
    for (const s of j.samples) {
      assert.ok(typeof s.t === 'number' && typeof s.mono === 'number', `${name}: two clocks`);
      if (!s.skipped) assert.ok(s.probes && Object.keys(s.probes).length > 0, `${name}: probes present`);
    }
    // Lateness is on every row.
    assert.ok(j.samples.every(s => typeof s.late_ms === 'number'), `${name}: late_ms on every row`);
  }
});


await r.run();
