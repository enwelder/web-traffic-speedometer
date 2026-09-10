// The stuck-probe tracker, driven directly. Through a recorder this needs 900 ms of real
// rounds to reach a rest; here a session of any length is a loop over rows.
import assert from 'node:assert';
import {stubBrowser, suite} from './helpers.mjs';

stubBrowser();
const {PROBES, STUCK_AFTER, STUCK_COOLDOWN} = await import('../js/probe.js');
const {createStuckTracker} = await import('../js/stuck.js');
const {gradeActivities} = await import('../js/grade.js');

const s = suite('stuck probes');

// Every probe answers except the ones named. A string is the failure reason; an object is
// the whole probe result, for cases like a known-absent path.
const row = (seq, failing = {}) => ({
  seq,
  probes: Object.fromEntries(PROBES.map(p => {
    const f = failing[p.id];
    if (!f) return [p.id, {ok: true, ms: 30}];
    return [p.id, typeof f === 'string' ? {ok: false, fail: f} : {ok: false, ...f}];
  }))
});

// The recorder numbers a row and then advances, so the seq it passes is always one ahead.
const feed = (tracker, seq, failing) => {
  const r = row(seq, failing);
  tracker.note(r, seq + 1);
  return r;
};

s.test('createStuckTracker MUST rest a probe only after STUCK_AFTER consecutive failures WHEN the other probes answer', () => {
  const notices = [];
  const t = createStuckTracker({onNotice: n => notices.push(n)});
  for (let seq = 0; seq < STUCK_AFTER - 1; seq++) {
    assert.ok(!feed(t, seq, {dns_ctl: 'timeout'}).probes.dns_ctl.stuck,
              `not stuck after ${seq + 1} of ${STUCK_AFTER} failures`);
    assert.equal(t.resting(seq + 1).size, 0, 'and nothing is resting yet');
  }
  const last = feed(t, STUCK_AFTER - 1, {dns_ctl: 'timeout'});
  assert.equal(last.probes.dns_ctl.stuck, true, `stuck on failure ${STUCK_AFTER}`);
  assert.deepEqual([...t.resting(STUCK_AFTER)], ['dns_ctl'], 'and it is the only one rested');
  assert.equal(notices.length, 1, 'one notice');
  assert.match(notices[0], /dns_ctl has failed/, notices[0]);
});

s.test('createStuckTracker.resting MUST hold a rest for exactly STUCK_COOLDOWN rounds WHEN a probe was rested', () => {
  const t = createStuckTracker({});
  for (let seq = 0; seq < STUCK_AFTER; seq++) feed(t, seq, {dns_ctl: 'timeout'});
  const from = STUCK_AFTER;
  assert.deepEqual([...t.resting(from + STUCK_COOLDOWN - 1)], ['dns_ctl'], 'still resting');
  assert.equal(t.resting(from + STUCK_COOLDOWN).size, 0, 'and probed again on the next round');
});

s.test('createStuckTracker MUST leave every probe unrested WHEN all probes fail in the same round', () => {
  const t = createStuckTracker({});
  const everything = Object.fromEntries(PROBES.map(p => [p.id, 'timeout']));
  for (let seq = 0; seq < STUCK_AFTER + 3; seq++) {
    const r = feed(t, seq, everything);
    assert.ok(PROBES.every(p => !r.probes[p.id].stuck), `nothing stuck at round ${seq}`);
  }
  assert.equal(t.resting(99).size, 0);
});

s.test('createStuckTracker MUST leave a probe unrested WHEN its failure reason is parse or http', () => {
  for (const fail of ['parse', 'http']) {
    const t = createStuckTracker({});
    for (let seq = 0; seq < STUCK_AFTER + 3; seq++) {
      assert.ok(!feed(t, seq, {dns_ctl: fail}).probes.dns_ctl.stuck, `${fail} must not rest a probe`);
    }
    assert.equal(t.resting(99).size, 0, `${fail} scheduled a rest`);
  }
});

s.test('createStuckTracker MUST leave a probe unrested WHEN its failure is marked expected', () => {
  const t = createStuckTracker({});
  for (let seq = 0; seq < STUCK_AFTER + 3; seq++) {
    feed(t, seq, {ip4: {fail: 'network', expected: true}});
  }
  assert.equal(t.resting(99).size, 0);
});

s.test('createStuckTracker MUST restart the failure count WHEN the probe succeeds once', () => {
  const t = createStuckTracker({});
  let seq = 0;
  for (let i = 0; i < STUCK_AFTER - 1; i++) feed(t, seq++, {dns_ctl: 'timeout'});
  feed(t, seq++, {});
  for (let i = 0; i < STUCK_AFTER - 1; i++) {
    assert.ok(!feed(t, seq++, {dns_ctl: 'timeout'}).probes.dns_ctl.stuck,
              'the count restarts after the success');
  }
});

s.test('createStuckTracker MUST emit one notice WHEN the rested probe reports resting for the whole cool-down', () => {
  const notices = [];
  const t = createStuckTracker({onNotice: n => notices.push(n)});
  let seq = 0;
  for (let i = 0; i < STUCK_AFTER; i++) feed(t, seq++, {dns_ctl: 'timeout'});
  for (let i = 0; i < STUCK_COOLDOWN; i++) feed(t, seq++, {dns_ctl: 'resting'});
  assert.equal(notices.length, 1, `rested rounds must not re-trigger: ${notices.length} notices`);
});

s.test('createStuckTracker.reset MUST clear every rest WHEN a new session starts', () => {
  const t = createStuckTracker({});
  for (let seq = 0; seq < STUCK_AFTER; seq++) feed(t, seq, {dns_ctl: 'timeout'});
  assert.equal(t.resting(STUCK_AFTER).size, 1, 'resting at the end of the first session');
  t.reset();
  assert.equal(t.resting(0).size, 0, 'and silent from the first round of the next');
});

s.test('createStuckTracker MUST leave the UDP probe unrested WHEN it fails alone', () => {
  const t = createStuckTracker({});
  for (let seq = 0; seq < STUCK_AFTER + 3; seq++) feed(t, seq, {udp: 'timeout'});
  assert.equal(t.resting(99).size, 0);
});

s.test('createStuckTracker MUST leave the upload unrested WHEN it fails alone', () => {
  const t = createStuckTracker({});
  for (let seq = 0; seq < STUCK_AFTER + 3; seq++) feed(t, seq, {up: 'timeout'});
  assert.equal(t.resting(99).size, 0);
});

s.test('gradeActivities MUST grade voice red in every round WHEN a carrier drops STUN for 27 rounds', () => {
  const t = createStuckTracker({});
  const voice = [];
  for (let seq = 0; seq < 27; seq++) {
    const r = feed(t, seq, t.resting(seq).has('udp') ? {udp: 'resting'} : {udp: 'timeout'});
    voice.push(gradeActivities(r).voice);
  }
  assert.deepEqual([...new Set(voice)], ['red']);
});

await s.run();
