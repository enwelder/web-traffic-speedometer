// The stuck-probe tracker, driven directly. Through a recorder this needs 900 ms of real
// rounds to reach a rest; here a session of any length is a loop over rows.
import assert from 'node:assert';
import {stubBrowser, suite} from './helpers.mjs';

stubBrowser();
const {PROBES, STUCK_AFTER, STUCK_COOLDOWN} = await import('../js/probe.js');
const {createStuckTracker} = await import('../js/stuck.js');

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

s.test('a probe failing alone is rested, and only after STUCK_AFTER rounds', () => {
  const notices = [];
  const t = createStuckTracker({onNotice: n => notices.push(n)});
  for (let seq = 0; seq < STUCK_AFTER - 1; seq++) {
    assert.ok(!feed(t, seq, {web: 'timeout'}).probes.web.stuck,
              `not stuck after ${seq + 1} of ${STUCK_AFTER} failures`);
    assert.equal(t.resting(seq + 1).size, 0, 'and nothing is resting yet');
  }
  const last = feed(t, STUCK_AFTER - 1, {web: 'timeout'});
  assert.equal(last.probes.web.stuck, true, `stuck on failure ${STUCK_AFTER}`);
  assert.deepEqual([...t.resting(STUCK_AFTER)], ['web'], 'and it is the only one rested');
  assert.equal(notices.length, 1, 'said once');
  assert.match(notices[0], /web has failed/, notices[0]);
});

s.test('a rest lasts STUCK_COOLDOWN rounds and then lapses', () => {
  const t = createStuckTracker({});
  for (let seq = 0; seq < STUCK_AFTER; seq++) feed(t, seq, {web: 'timeout'});
  const from = STUCK_AFTER;
  assert.deepEqual([...t.resting(from + STUCK_COOLDOWN - 1)], ['web'], 'still resting');
  assert.equal(t.resting(from + STUCK_COOLDOWN).size, 0, 'and asked again on the next round');
});

s.test('a total outage rests nothing, so the failure stays visible', () => {
  const t = createStuckTracker({});
  const everything = Object.fromEntries(PROBES.map(p => [p.id, 'timeout']));
  for (let seq = 0; seq < STUCK_AFTER + 3; seq++) {
    const r = feed(t, seq, everything);
    assert.ok(PROBES.every(p => !r.probes[p.id].stuck), `nothing stuck at round ${seq}`);
  }
  assert.equal(t.resting(99).size, 0);
});

s.test('only a failure a fresh connection could fix is rested', () => {
  for (const fail of ['parse', 'http']) {
    const t = createStuckTracker({});
    for (let seq = 0; seq < STUCK_AFTER + 3; seq++) {
      assert.ok(!feed(t, seq, {web: fail}).probes.web.stuck, `${fail} must not rest a probe`);
    }
    assert.equal(t.resting(99).size, 0, `${fail} scheduled a rest`);
  }
});

s.test('a known-absent path is never rested', () => {
  const t = createStuckTracker({});
  for (let seq = 0; seq < STUCK_AFTER + 3; seq++) {
    feed(t, seq, {ip4: {fail: 'network', expected: true}});
  }
  assert.equal(t.resting(99).size, 0);
});

s.test('one success clears the count', () => {
  const t = createStuckTracker({});
  let seq = 0;
  for (let i = 0; i < STUCK_AFTER - 1; i++) feed(t, seq++, {web: 'timeout'});
  feed(t, seq++, {});
  for (let i = 0; i < STUCK_AFTER - 1; i++) {
    assert.ok(!feed(t, seq++, {web: 'timeout'}).probes.web.stuck,
              'the count restarts rather than carrying across the success');
  }
});

s.test('a resting probe is not counted as failing again', () => {
  const notices = [];
  const t = createStuckTracker({onNotice: n => notices.push(n)});
  let seq = 0;
  for (let i = 0; i < STUCK_AFTER; i++) feed(t, seq++, {web: 'timeout'});
  for (let i = 0; i < STUCK_COOLDOWN; i++) feed(t, seq++, {web: 'resting'});
  assert.equal(notices.length, 1, `rested rounds must not re-trigger: ${notices.length} notices`);
});

s.test('a rest does not survive into the next session', () => {
  const t = createStuckTracker({});
  for (let seq = 0; seq < STUCK_AFTER; seq++) feed(t, seq, {web: 'timeout'});
  assert.equal(t.resting(STUCK_AFTER).size, 1, 'resting at the end of the first session');
  t.reset();
  assert.equal(t.resting(0).size, 0, 'and silent from the first round of the next');
});

await s.run();
