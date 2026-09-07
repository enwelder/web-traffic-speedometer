// Replays real recordings through the measurement code. Three journeys, anonymised and
// committed, covering a good 5G run, a commute with pauses and coarse positions, and the
// one where a probe wedged for twenty rounds. Synthetic fixtures agree with whatever the
// code does; these do not.
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
    // Timestamps shifted, intervals intact: the scheduler is what they are used for.
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
  assert.equal(a.session.environment.app_version, '9.9.9', 'the version is needed to read the file');
  // Intervals preserved, absolute time not.
  assert.notEqual(a.samples[0].t, original.samples[0].t);
  assert.equal(a.samples[0].t - a.session.started, original.samples[0].t - original.session.started);
  assert.deepEqual(anonymise(original), a, 'the same input gives the same fixture');
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
        // A capability with no usable input must say nothing rather than guess.
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

r.test('a recording from an older build grades without a schema for it', () => {
  // The oldest fixture predates the UDP probe, the steady rate and the grades field. Reading
  // it must produce nulls, not exceptions: journeys outlive the code that made them.
  const old = journeys['stuck-probe'];
  assert.equal(old.source_app_version, '6.0.0');
  assert.ok(!old.samples[0].probes.udp, 'no UDP probe existed then');
  const grades = g.gradeRound(old.samples[0]);
  assert.ok(g.GRADES.includes(grades.realtime), 'what can be graded is');
  assert.equal(grades.video, null, 'and what cannot is left empty');
});

r.test('the run that looked broken was the grading, not the network', () => {
  // Forty rounds on good 5G came back mostly yellow and orange. Under thresholds that
  // belong to each capability, the same rounds read as the connection actually behaved.
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

  // The old scheme judged every probe on one latency scale, which is what painted it yellow.
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
  // Whatever the grading says about the rest, one probe failing alone must not read as green.
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
    // Exporting a fixture must round-trip: the file is the deliverable.
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
    // Lateness is recorded, never silently absorbed.
    assert.ok(j.samples.every(s => typeof s.late_ms === 'number'), `${name}: late_ms on every row`);
  }
});

r.test('the stability figure separates a swinging link from a slow one', () => {
  // Real values rather than invented ones: the two journeys differ in exactly this way.
  const series = name => journeys[name].samples
    .map(s => s.probes.ip6?.ok ? s.probes.ip6.ms : null).filter(v => v != null);
  const good = g.stability(series('good-5g'));
  const mixed = g.stability(series('mixed-commute'));
  assert.ok(good && mixed, 'both have enough readings');
  assert.ok(mixed.ratio > good.ratio,
            `the commute swings more than the stationary run: ×${mixed.ratio} vs ×${good.ratio}`);
  assert.ok(good.ratio >= 1, 'a ratio is never below one');
});

await r.run();
