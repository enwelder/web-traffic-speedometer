// Replays anonymised recorded journeys through the measurement code: a 5G run, a commute with
// pauses and coarse positions, and a probe failing alone for twenty rounds. The fixtures are
// recordings, independent of the code under test.
import assert from 'node:assert';
import {readFileSync, readdirSync} from 'node:fs';
import {stubBrowser, suite} from './helpers.mjs';

stubBrowser();
const g = await import('../js/grade.js');
const {summarise, sessionJson} = await import('../js/export.js');
const {anonymise, assertClean} = await import('../tools/anonymise.mjs');
// Imported, so a threshold change in the source applies to these assertions.
const {MAX_PLAUSIBLE_MS, FINE_ACCURACY_M} = await import('../js/position.js');

const dir = new URL('./fixtures/', import.meta.url);
const load = f => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
const files = readdirSync(dir).filter(f => f.endsWith('.json'));
const journeys = Object.fromEntries(files.map(f => [f.replace('.json', ''), load(f)]));

const r = suite('replay');

r.test('the committed fixtures MUST carry no coordinates and keep accuracy and round spacing WHEN each is read', () => {
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

r.test('anonymise MUST strip position, egress and typed text while keeping every measurement WHEN run twice on the same export', () => {
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

// assertClean is an allowlist; each case below passes a denylist scan.
r.test('assertClean MUST throw WHEN a document carries coordinates, a bearing, typed text, a time zone or an unshifted timestamp', () => {
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

r.test('assertClean MUST accept the fields format 11 adds WHEN an anonymised export carries them', () => {
  const doc = anonymise({
    session: {started: 1700000000000, stopped: 1700000100000, name: 'x', note: '', end_reason: 'stop',
              environment: {app_version: '3.14.0', user_agent: 'Mozilla/5.0', timezone: 'Europe/Amsterdam',
                            screen: '393x852@3'}},
    samples: [{seq: 0, t: 1700000000000, mono: 0, round_ms: 2400, phase_idle_ms: 900, phase_down_ms: 1500,
               visible: true, visible_end: true,
               probes: {ip6: {ok: true, ms: 30, ms_samples: [30, 900], sample_starts_ms: [0, 31], samples_ok: 1,
                              samples_lost: 1, samples_end: 'count', wall_ms: 931},
                        udp: {ok: true, ms: 40, ms_samples: [40], host_ms_samples: [3]},
                        down: {ok: true, bps: 2e7, window_cut: false,
                               stall_check: {same_host: {ok: true, ms: 80, fail: null},
                                             other_host: {ok: true, ms: 60, fail: null},
                                             udp: {ok: true, ms: 40, fail: null}},
                               per_stream: [{headers_ms: 120, first_byte_ms: 140, bytes: 900000, end: 'done',
                                             transfer_size: 900300, encoded_body_size: 900000},
                                            {headers_ms: null, first_byte_ms: null, bytes: 0, end: 'connect'}]}}}],
    events: [
      {t: 1700000015000, mono: 15000, type: 'skip', round: 0, running_ms: 15000, waiting_on: ['down', 'loaded_rtt'],
       text: 'round 0 still running after 15.0 s, waiting on down, loaded_rtt'},
      {t: 1700000016000, mono: 16000, type: 'page', text: 'hidden'},
      {t: 1700000017000, mono: 17000, type: 'network', text: 'offline'},
      {t: 1700000018000, mono: 18000, type: 'network', text: 'connection cellular 3g, 1.2 Mb/s, 300 ms'}
    ]
  });
  assert.doesNotThrow(() => assertClean(doc));
});

r.test('gradeActivities MUST return a known grade or null for every round WHEN replayed over each recording', () => {
  for (const [name, j] of Object.entries(journeys)) {
    let graded = 0;
    for (const s of j.samples) {
      const grades = g.gradeActivities(s);
      if (s.skipped) { assert.equal(grades, null, `${name}: a skipped round is not graded`); continue; }
      assert.ok(grades, `${name} seq ${s.seq}`);
      for (const [activity, val] of Object.entries(grades)) {
        assert.ok(val === null || g.GRADES.includes(val),
                  `${name} seq ${s.seq}: ${activity} produced ${val}`);
        // An activity without usable input has no grade and no value.
        if (val === null) {
          assert.equal(g.activityValue(activity, s), null,
                       `${name} seq ${s.seq}: ${activity} had a value but no grade`);
        }
      }
      graded++;
    }
    assert.ok(graded > 20, `${name}: ${graded} rounds graded`);
  }
});

r.test('summarise MUST produce finite non-negative figures WHEN replayed over every recorded round', () => {
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
      for (const k of ['late_ms', 'mono', 'accuracy', 'prev_round_ms', 'first_packet_ms', 'round_ms',
                       'phase_idle_ms', 'phase_down_ms']) {
        nonNegative(s[k], `${at}.${k}`);
      }
      nonNegative(s.speed_derived, `${at}.speed_derived`);
      for (const [id, probe] of Object.entries(s.probes || {})) {
        if (!probe) continue;
        for (const k of ['ms', 'ms_min', 'ms_max', 'bytes', 'duration_ms', 'ttfb_ms',
                         'bps', 'bps_transfer', 'bps_end_to_end']) {
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

r.test('the recorded speed_derived MUST exceed MAX_PLAUSIBLE_MS only WHEN the fix is coarser than FINE_ACCURACY_M', () => {
  // The recordings contain rates up to 189 m/s (681 km/h) from trains doing 140. Every such
  // row must be caught by one of the two rules: a coarse fix, which produces no speed at all,
  // or a rate above the plausible ceiling.
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

r.test('the vpn-blocked-literal recording MUST report a saturated three-stream download at the ceiling WHEN its rows are read', () => {
  // The one committed recording that supplies a rate, so the throughput reading is asserted
  // against a real journey.
  const j = journeys['vpn-blocked-literal'];
  const down = j.samples.map(s => s.probes.down).filter(d => d?.ok);
  assert.equal(down.length, j.samples.length, 'every round measured throughput');

  assert.ok(down.every(d => d.streams === 3), 'on three connections, as RMBT does');
  assert.ok(down.every(d => d.saturated === true), 'a fibre link reaches the cap every round');
  assert.ok(down.every(d => d.bps === d.ceiling_bps),
            'so the reading is the ceiling, which is all a window this size can prove');
  assert.ok(down.every(d => d.window_ms > 0 && d.window_bytes > 0), 'over a real window');

  // Per-round cost follows the ceiling.
  const mb = down.reduce((n, d) => n + d.bytes, 0) / down.length / 1e6;
  assert.ok(mb < 8, `a round costs what it was told to: ${mb.toFixed(1)} MB`);
});


r.test('gradeActivities MUST grade the terms present and return null for the rest WHEN the recording predates a probe', () => {
  // The oldest fixture predates the UDP probe, the steady rate and the grades field. Missing
  // fields must grade as null.
  const old = journeys['stuck-probe'];
  assert.equal(old.source_app_version, '6.0.0');
  assert.ok(!old.samples[0].probes.udp, 'no UDP probe existed then');
  const grades = g.gradeActivities(old.samples[0]);
  assert.ok(g.GRADES.includes(grades.voice), 'what can be graded is');
  assert.equal(grades.video, null, 'and what cannot is left empty');
});

r.test('gradeActivities MUST return null for streaming WHEN the recorded rows carry no rate', () => {
  // The committed journeys predate throughput measurement, so their rate terms are empty. An
  // activity with an empty term is unrated.
  const old = journeys['good-5g'];
  assert.ok(old.samples.every(s => s.probes.down.bps == null), 'these rows carry no rate');
  for (const s of old.samples) {
    const a = g.gradeActivities(s);
    assert.equal(a.streaming, null, 'streaming is only throughput, so it cannot be graded');
  }

  // Latency grades: fresh lookups at ~200 ms and 30-60 ms round trips; news is unrated because the
  // rate is missing.
  const news = old.samples.map(s => g.activityReading('news', s));
  assert.ok(news.every(r => r.grade !== 'red'), 'nothing here is a failure');
  assert.ok(news.every(r => r.grade !== null || r.missing.includes('article')),
            'and where it is unrated, it says which measurement is missing');
});

r.test('activityReading MUST return a null grade for voice naming round_trip as missing WHEN the ip4 literal is blocked and ip6 is unused', () => {
  // Recorded on a desktop behind a corporate VPN: 1.1.1.1 refused every round while IPv4
  // carried the traffic, and IPv6 had no route. Calls have no round trip to grade, so UDP and
  // throughput alone cannot settle them.
  const j = journeys['vpn-blocked-literal'];
  assert.ok(j, 'the recording is committed');

  for (const s of j.samples) {
    assert.equal(g.probeReading('ip4', s).state, 'blocked', 'the literal is refused');
    assert.equal(g.probeReading('ip6', s).state, 'unused', 'and the other family carried');

    const voice = g.activityReading('voice', s);
    assert.equal(voice.grade, null, 'so calls are unrated');
    assert.deepEqual(voice.missing, ['round_trip'], 'and say what is missing');
  }

  // News and streaming grade green on the same rounds.
  const tally = a => j.samples.reduce((n, s) => n + (g.gradeActivities(s)[a] === 'green' ? 1 : 0), 0);
  assert.equal(tally('news'), j.samples.length, 'reading articles was fine');
  assert.equal(tally('streaming'), j.samples.length, 'so was video');
});


r.test('gradeActivities MUST grade news red WHEN the recorded control probe fails alone for twenty rounds', () => {
  const j = journeys['stuck-probe'];
  // The control probe failed alone for the last twenty rounds while the rest recovered.
  const tail = j.samples.slice(-20);
  assert.ok(tail.every(s => !s.probes.web.ok), 'the control never recovered');
  assert.ok(tail.filter(s => s.probes.ip6.ok).length >= 18, 'while the link was fine');
  // The failing control probe grades news red in every round.
  const grades = tail.map(s => g.gradeActivities(s).news);
  assert.ok(grades.every(x => x === 'red'), 'and the activity it feeds grades red');
});

r.test('summarise MUST return ordered percentiles and a round-tripping export WHEN run over each recording', () => {
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

r.test('the recordings MUST carry a contiguous seq, two clocks and late_ms on every row WHEN each is read', () => {
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


r.test('probeReading MUST return a known state, a valid grade and a finite or null value WHEN run over every recorded round', () => {
  const states = ['none', 'resting', 'absent', 'blocked', 'unused', 'refused', 'failed', 'ok'];
  let readings = 0;
  for (const [name, j] of Object.entries(journeys)) {
    for (const s of j.samples) {
      for (const id of Object.keys(g.PROBE_SCALES)) {
        const r0 = g.probeReading(id, s);
        readings++;
        assert.ok(states.includes(r0.state), `${name} ${id}: state ${r0.state}`);
        assert.ok(r0.grade === null || g.GRADES.includes(r0.grade),
                  `${name} ${id}: grade ${r0.grade}`);
        assert.ok(r0.value === null || Number.isFinite(r0.value),
                  `${name} ${id}: a row never prints a value that is not a number`);
      }
    }
  }
  assert.ok(readings > 1000, `enough rounds to be worth asserting on: ${readings}`);
});

await r.run();
