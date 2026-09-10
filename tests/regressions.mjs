// Regressions for defects that only recorded journeys exposed. Each case states the
// measurement that has to hold and the condition that breaks it.
import assert from 'node:assert';
import {stubBrowser, fakeStore, TRACE, bodyOf, netError, sleep, suite} from './helpers.mjs';

stubBrowser();
const probe = await import('../js/probe.js');
const {createRecorder} = await import('../js/session.js');

const P = Object.fromEntries(probe.PROBES.map(p => [p.id, p]));
const PROBE_IDS = probe.PROBES.map(p => p.id);
const r = suite('regressions');
const {createStuckTracker} = await import('../js/stuck.js');
const okResponse = () => ({ok: true, status: 200, type: 'opaque', headers: {get: () => null},
                          body: bodyOf(1000), text: async () => TRACE});

function stubStun(ok = true) {
  globalThis.RTCPeerConnection = class {
    addTransceiver() {} async createOffer() { return {}; }
    async setLocalDescription() {
      setTimeout(() => this.onicecandidate?.({candidate: ok ? {type: 'srflx', address: '2a09::9'} : null}), 1);
      setTimeout(() => this.onicecandidate?.({candidate: null}), 3);
    }
    close() {}
  };
}

// Short windows and samples, so many rounds fit the test duration.
const session = (over = {}) => ({id: 's', name: 't', operator: 'KPN', connection: 'cellular',
                                 intervalMs: 100, downloadBytes: 1000, started: Date.now(),
                                 download: {windowMs: 30, rampMs: 0, streams: 1,
                                            maxBytes: 20000, capBytes: 20000},
                                 ipv4_available: true, ipv4_check: null, ...over});

// Adding one interval to a due time already further behind than that leaves it in the past,
// so the next timer fires immediately and collides with the round still running. Observed as
// a round 13.7 s late on a 10 s interval followed by a tick 11 ms later.
r.test('createRecorder MUST keep rounds evenly spaced and record no skip WHEN the loop freezes for under two intervals', async () => {
  stubStun();
  globalThis.fetch = async () => okResponse();
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session());
  await sleep(250);

  // Block the loop for 1.4 intervals: past one missed slot, under two.
  const until = Date.now() + 140;
  while (Date.now() < until) { /* a suspended tab */ }
  await sleep(400);
  await rec.stop();

  const rows = store.written.samples;
  const skips = store.written.events.filter(e => e.type === 'skip');
  assert.equal(skips.length, 0, `a missed slot must not manufacture a skip: ${skips.length}`);

  // Rounds stay evenly spaced.
  const gaps = rows.map(x => x.mono).sort((a, b) => a - b)
                   .map((v, i, all) => (i ? v - all[i - 1] : null)).filter(Boolean);
  assert.ok(gaps.every(g => g >= 80), `no round follows another instantly: ${gaps.join(',')}`);
});

// A frozen tab suspends the abort timer, so a round can outlast every deadline in it: every
// probe hit its 4 s deadline in a round that took 16.7 s. How long the running round has run
// separates a slow round from a stalled app.
r.test('createRecorder MUST record how long the running round has run on each skip event WHEN the round outlasts its slot', async () => {
  stubStun();
  globalThis.fetch = (url, o) => new Promise((res, rej) => {
    const t = setTimeout(() => res(okResponse()), 260);
    o.signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('a'), {name: 'AbortError'})); }, {once: true});
  });
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session());
  await sleep(900);
  await rec.stop();

  const skips = store.written.events.filter(e => e.type === 'skip');
  assert.ok(skips.length > 0, 'a slow round still outlasts the next slot');
  assert.ok(skips.every(e => e.running_ms >= 90),
            `every skip carries the running time: ${skips.map(e => e.running_ms)}`);
});

// After an outage one probe can keep timing out while the others recover, for twenty
// consecutive rounds in one recording: a wedged connection.
r.test('createRecorder MUST rest a probe failing alone and rest none WHEN every probe fails together', async () => {
  stubStun();
  let ctlWedged = true;
  globalThis.fetch = async url => {
    if (String(url).includes('wts-dns-control') && ctlWedged) throw netError();
    return okResponse();
  };
  const notices = [];
  const store = fakeStore();
  const rec = createRecorder({store, onNotice: t => t && notices.push(t)});
  await rec.start(session());
  await sleep(900);

  const rows = store.written.samples.filter(x => !x.skipped);
  assert.ok(rows.length >= 6, 'enough rounds to detect it');
  assert.ok(rows.some(x => x.probes.dns_ctl.stuck), 'the wedged probe is marked stuck');
  assert.ok(rows.some(x => x.probes.dns_ctl.fail === 'resting'),
            'and produces no further identical failures');
  assert.ok(rows.every(x => x.probes.ip6.ok), 'the probes that work are untouched');
  assert.ok(notices.some(n => /resting/.test(n)), 'and the notice carries the reason');

  // Resting applies only to a probe failing alone: when everything fails the network is
  // down, and resting every probe at once blanks the readout.
  const outage = fakeStore();
  const rec2 = createRecorder({store: outage});
  globalThis.fetch = async () => { throw netError(); };
  await rec2.start(session());
  await sleep(900);
  await rec2.stop();
  const dead = outage.written.samples.filter(x => !x.skipped);
  assert.ok(dead.length >= 6, 'enough rounds for a rest to have been triggered');
  assert.ok(dead.every(x => PROBE_IDS.every(id => !x.probes[id]?.stuck)),
            'a total outage marks nothing stuck');
  assert.ok(dead.every(x => PROBE_IDS.every(id => x.probes[id]?.fail !== 'resting')),
            'and rests nothing, so the failure stays visible');
  globalThis.fetch = async url => {
    if (String(url).includes('wts-dns-control') && ctlWedged) throw netError();
    return okResponse();
  };

  // Recovery is picked up within the same session.
  ctlWedged = false;
  await sleep(900);
  await rec.stop();
  const later = store.written.samples.filter(x => !x.skipped).slice(-3);
  assert.ok(later.some(x => x.probes.dns_ctl.ok), 'recovery is picked up automatically');
});

// Small probes have succeeded at 3885, 3883 and 3878 ms, so a deadline near 4 s records
// slow-but-working rounds as failures.
r.test('timeoutFor MUST allow at least 8000 ms per probe WHEN the interval is 15 s or 30 s', async () => {
  for (const interval of [15000, 30000]) {
    for (const p of probe.PROBES) {
      const t = probe.timeoutFor(p, interval);
      assert.ok(t >= 8000, `${p.id} at a ${interval} ms interval allows ${t} ms, under the 8 s floor`);
    }
  }
  globalThis.fetch = async () => { await sleep(120); return {ok: true, status: 200, text: async () => TRACE}; };
  const res = await probe.runProbe(P.ip4, {timeoutMs: probe.timeoutFor(P.ip4, 15000)});
  assert.equal(res.ok, true, 'a response well past the old ceiling still counts as a success');
});

// coords.speed is supplied sporadically (0, 2 and 51 of 158, 75 and 243 rounds), so speed is
// computed from consecutive fixes and the row records which source it came from.
r.test('createRecorder MUST record speed_source derived from consecutive fine fixes and null speed_derived from tower fixes WHEN the platform supplies no speed', async () => {
  stubStun();
  globalThis.fetch = async () => okResponse();
  let watcher;
  const nav = {userAgent: 'node-test', language: 'en',
               geolocation: {watchPosition: cb => { watcher = cb; return 1; }, clearWatch() {}}};
  Object.defineProperty(globalThis, 'navigator', {value: nav, configurable: true});

  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session());
  const base = Date.now();
  // ~1000 m apart, 20 s apart: 50 m/s, with coords.speed absent.
  watcher({coords: {latitude: 51.9244, longitude: 4.4777, accuracy: 10, speed: null, heading: null}, timestamp: base});
  await sleep(250);
  watcher({coords: {latitude: 51.9334, longitude: 4.4777, accuracy: 10, speed: null, heading: null}, timestamp: base + 20000});
  await sleep(250);
  await rec.stop();

  const withSpeed = store.written.samples.filter(x => x.speed_derived != null);
  assert.ok(withSpeed.length > 0, 'a speed is produced without the platform supplying one');
  const s = withSpeed[0];
  assert.equal(s.speed, null, 'the measured field stays empty');
  assert.equal(s.speed_source, 'derived', 'and the row records the source of the number');
  assert.ok(Math.abs(s.speed_derived - 50) < 5, `~50 m/s over 1 km in 20 s, got ${s.speed_derived}`);

  // A pair of tower-class fixes produces no speed: two 1414 m estimates hundreds of metres
  // apart in opposite directions read as 682 km/h on a train.
  const store2 = fakeStore();
  const rec2 = createRecorder({store: store2});
  await rec2.start(session());
  const t2 = Date.now();
  watcher({coords: {latitude: 51.9244, longitude: 4.4777, accuracy: 1414, speed: null, heading: null}, timestamp: t2});
  await sleep(250);
  watcher({coords: {latitude: 51.9334, longitude: 4.4777, accuracy: 1414, speed: null, heading: null}, timestamp: t2 + 20000});
  await sleep(250);
  await rec2.stop();
  assert.ok(store2.written.samples.every(x => x.speed_derived == null),
            'a speed is never derived from tower-class fixes');
  assert.ok(store2.written.samples.some(x => x.accuracy_class === 'coarse'),
            'and the row says the fix was coarse');

  stubBrowser();
  Object.defineProperty(globalThis, 'navigator', {value: {userAgent: 'node-test', language: 'en', geolocation: null}, configurable: true});
});

// in_pause makes the rounds around a bridged gap filterable without matching timestamps
// against the event list.
r.test('createRecorder MUST record one pause per missed slot and set in_pause on the rounds inside it WHEN the loop freezes', async () => {
  stubStun();
  globalThis.fetch = async () => okResponse();
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session());
  await sleep(200);
  const until = Date.now() + 250;
  while (Date.now() < until) { /* frozen */ }
  await sleep(300);
  await rec.stop();

  assert.ok(store.written.events.some(e => e.type === 'pause'), 'the gap is still an event');
  // The threshold is one missed slot: at two, a 13.7 s delay on a 10 s interval goes
  // unlogged. Counting against late_ms pins the number to the schedule. A slot that comes due
  // while a round is running carries its lateness on the skip event.
  const missed = [...store.written.samples, ...store.written.events.filter(e => e.type === 'skip')]
    .filter(x => x.late_ms >= 100);
  const pauses = store.written.events.filter(e => e.type === 'pause');
  assert.ok(missed.length > 0, 'the freeze produced a late round to judge');
  assert.equal(pauses.length, missed.length,
               `one pause per missed slot: ${pauses.length} events, ${missed.length} slots ` +
               `late by ${missed.map(x => x.late_ms)} ms`);
  assert.ok(store.written.samples.some(x => x.in_pause === true),
            'and the round that follows it is filterable without matching timestamps');
  assert.ok(store.written.samples.some(x => x.in_pause === false), 'ordinary rounds are not flagged');
});

// The system can reclaim the wake lock without the page becoming hidden (Low Power Mode is
// one trigger). The released sentinel stays in the variable, so a guard on the variable alone
// blocks every retry for the rest of the session.
r.test('createRecorder MUST reacquire the wake lock and record the loss WHEN the system reclaims it mid-session', async () => {
  stubStun();
  globalThis.fetch = async () => okResponse();

  const grants = [];
  let refuse = false;
  const wakeLock = {
    request: async () => {
      if (refuse) throw Object.assign(new Error('denied'), {name: 'NotAllowedError'});
      const listeners = [];
      const sentinel = {
        released: false,
        addEventListener: (_, fn) => listeners.push(fn),
        // How the platform announces reclaiming the lock.
        systemRelease() { this.released = true; listeners.forEach(fn => fn()); }
      };
      grants.push(sentinel);
      return sentinel;
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: {userAgent: 'node-test', language: 'en', geolocation: null, wakeLock},
    configurable: true
  });

  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session());
  await sleep(250);
  assert.equal(grants.length, 1, 'the lock is taken at the start');
  assert.ok(store.written.samples.every(x => x.wake_lock === true), 'and rows say the screen is held');

  grants[0].systemRelease();
  await sleep(400);
  assert.ok(grants.length >= 2, `the lock is taken back again, not abandoned (${grants.length} grants)`);
  assert.equal(grants.at(-1).released, false, 'and the current one is live');
  assert.ok(store.written.events.some(e => /wake lock released/.test(e.text)),
            'the loss is in the record, so a journey explains its own gaps');

  // A refused request must not stop later retries.
  refuse = true;
  grants.at(-1).systemRelease();
  await sleep(400);
  const held = grants.length;
  refuse = false;
  await sleep(400);
  assert.ok(grants.length > held, 'once the platform allows it again, the lock comes back');

  await rec.stop();
  stubBrowser();
  Object.defineProperty(globalThis, 'navigator', {
    value: {userAgent: 'node-test', language: 'en', geolocation: null}, configurable: true});
});

// Rounding the rank down puts a ten-sample window on its own last element, which reports the
// maximum as p90.
r.test('quantile MUST return the nearest rank WHEN the series holds 3 to 20 samples', async () => {
  const exq = await import('../js/export.js');
  const asc = n => Array.from({length: n}, (_, i) => i + 1);

  for (const n of [3, 5, 8, 10, 15, 20]) {
    const v = asc(n);
    const p90 = exq.quantile(v, 0.9);
    assert.ok(p90 <= n, 'within range');
    if (n >= 10) assert.ok(p90 < n, `n=${n}: p90 must not be the maximum, got rank ${p90}/${n}`);
    assert.equal(p90, Math.ceil(n * 0.9), `n=${n}: nearest rank`);
  }
  assert.equal(exq.quantile(asc(10), 0.1), 1, 'the low end is the first rank, not the second');
  assert.equal(exq.quantile(asc(20), 0.9), 18);
  assert.equal(exq.quantile([], 0.9), null);
  assert.equal(exq.quantile([7], 0.9), 7);

  // Nine identical readings and one spike: p90 is the reading.
  assert.equal(exq.quantile([10, 10, 10, 10, 10, 10, 10, 10, 10, 900], 0.9), 10);
});

// The operator label is typed in and the egress address is measured, so a hotspot picked up
// mid-journey shows only as an address change.
r.test('createRecorder MUST record one egress-change event WHEN the egress address changes under an unchanged operator label', async () => {
  stubStun();
  let ip = '2a02:a473::9';
  globalThis.fetch = async () => ({ok: true, status: 200, type: 'opaque',
                                   headers: {get: () => null}, body: bodyOf(1000),
                                   text: async () => `fl=1\nip=${ip}\nts=1\ncolo=AMS\nvisit_scheme=https\n`});
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session());
  await sleep(300);
  ip = '2a02:a473::77';
  await sleep(300);
  await rec.stop();

  const notes = store.written.events.filter(e => /egress address changed/.test(e.text || ''));
  assert.equal(notes.length, 1, `one event, not one per round: ${notes.length}`);
});


r.test('createRecorder MUST record a pause sized from the wall clock WHEN performance.now stands still through a device sleep', async () => {
  // iOS stops performance.now() while the device sleeps. Recorded on KPN, seq 7 to 8: the wall
  // clock advanced 4,331,556 ms and the monotonic clock 2,551,966 ms, so 29.7 minutes of the
  // gap were invisible to it. Read from the monotonic clock alone, a gap that is entirely
  // sleep produces no pause event and leaves adjacent bars across a hole.
  globalThis.fetch = async () => okResponse();
  const store = fakeStore();
  const rec = createRecorder({store});
  const realNow = performance.now.bind(performance);
  const realDate = Date.now.bind(Date);
  await rec.start({id: 's1', name: 't', profile: 'fine', intervalMs: 120, started: realDate(),
                   download: {windowMs: 40, rampMs: 0, streams: 1}});
  await sleep(200);

  // The device sleeps: the monotonic clock stands still, the wall clock runs on.
  const frozen = realNow();
  performance.now = () => frozen;
  Date.now = () => realDate() + 1800000;
  await sleep(400);
  performance.now = realNow;
  Date.now = realDate;
  await rec.stop();

  const pauses = store.written.events.filter(e => e.type === 'pause');
  assert.ok(pauses.length > 0, 'the gap is recorded');
  assert.ok(pauses.some(e => parseFloat(e.text) > 1000),
            `and its length comes from the wall clock: ${pauses.map(e => e.text).join(' ')}`);
});

// Round 87 and round 236 of the 10 Sep session: the app went to the background 2.2 s and 0.3 s into
// a round, iOS suspended it, and the rounds finished on return after 97 s and 470 s.

// A platform wake lock the test can take back, and a promise for the first request of a round.
function interruptible() {
  const grants = [];
  const wakeLock = {request: async () => {
    const listeners = [];
    const sentinel = {released: false, addEventListener: (_, fn) => listeners.push(fn),
                      release: async () => { sentinel.released = true; },
                      systemRelease() { this.released = true; listeners.forEach(fn => fn()); }};
    grants.push(sentinel);
    return sentinel;
  }};
  Object.defineProperty(globalThis, 'navigator', {
    value: {userAgent: 'node-test', language: 'en', geolocation: null, wakeLock}, configurable: true
  });
  let started;
  const inRound = new Promise(resolve => { started = resolve; });
  const restore = () => Object.defineProperty(globalThis, 'navigator', {
    value: {userAgent: 'node-test', language: 'en', geolocation: null}, configurable: true
  });
  return {grants, inRound, started: () => started(), restore};
}

r.test('createRecorder MUST store a round interrupted by wake_lock with null grades and pgrades WHEN the wake lock is released mid-round', async () => {
  stubStun();
  const platform = interruptible();
  globalThis.fetch = async () => { platform.started(); await sleep(150); return okResponse(); };
  try {
    const store = fakeStore();
    const rec = createRecorder({store});
    await rec.start(session({intervalMs: 2000, ipv6_available: true}));
    await platform.inRound;
    platform.grants[0].systemRelease();
    await sleep(500);
    await rec.stop();
    const row = store.written.samples[0];
    assert.deepEqual([row.interrupted, row.grades, row.pgrades], ['wake_lock', null, null]);
    assert.ok(row.probes.ip6, 'the probes the round took are kept');
  } finally {
    platform.restore();
  }
});

r.test('createRecorder MUST store a round interrupted as suspended with suspended_ms above 1000 WHEN performance.now stands still and the wall clock advances during a round', async () => {
  stubStun();
  let started;
  const inRound = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async () => { started(); await sleep(300); return okResponse(); };
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session({intervalMs: 5000, ipv6_available: true}));
  await inRound;
  const realNow = performance.now.bind(performance);
  const realDate = Date.now.bind(Date);
  const frozen = realNow();
  performance.now = () => frozen;
  Date.now = () => realDate() + 4000;
  try {
    await sleep(400);
  } finally {
    performance.now = realNow;
    Date.now = realDate;
  }
  await rec.stop();
  const row = store.written.samples[0];
  assert.equal(row.interrupted, 'suspended');
  assert.ok(row.suspended_ms > 1000, `largest gap ${row.suspended_ms} ms`);
});

r.test('createRecorder MUST start the next round as the interrupted round settles and record no skip for it WHEN a slot comes due during settling', async () => {
  stubStun();
  const platform = interruptible();
  let slow = true;
  globalThis.fetch = async () => { platform.started(); if (slow) await sleep(500); return okResponse(); };
  try {
    const store = fakeStore();
    const rec = createRecorder({store});
    await rec.start(session({intervalMs: 300, ipv6_available: true}));
    await platform.inRound;
    platform.grants[0].systemRelease();
    slow = false;
    await sleep(900);
    await rec.stop();
    const [first, second] = [...store.written.samples].sort((a, b) => a.seq - b.seq);
    assert.equal(first.interrupted, 'wake_lock');
    assert.ok(second, 'a round followed');
    assert.equal(store.written.events.filter(e => e.type === 'skip' && e.round === first.seq).length, 0);
    const gap = second.mono - (first.mono + first.round_ms);
    assert.ok(gap < 150, `the next round started ${gap} ms after the interrupted one ended`);
  } finally {
    platform.restore();
  }
});

r.test('createRecorder MUST set round on the pause event WHEN the absence interrupted a round', async () => {
  stubStun();
  let started;
  const inRound = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async () => { started(); await sleep(50); return okResponse(); };
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session({intervalMs: 400, ipv6_available: true}));
  await inRound;
  const until = Date.now() + 1200;
  while (Date.now() < until) { /* suspended */ }
  await sleep(600);
  await rec.stop();
  const row = store.written.samples.find(x => x.interrupted);
  const pause = store.written.events.find(e => e.type === 'pause');
  assert.ok(row && pause, 'the suspension produced an interrupted round and a pause');
  assert.equal(pause.round, row.seq);
});

r.test('createRecorder.stop MUST record the aborted round with interrupted null WHEN stop lands mid-round', async () => {
  stubStun();
  let started;
  const inRound = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async () => { started(); await sleep(100); return okResponse(); };
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session({intervalMs: 2000, ipv6_available: true}));
  await inRound;
  await rec.stop();
  assert.equal(store.written.samples[0].interrupted, null, 'a stop is the user ending the session');
});

r.test('createStuckTracker MUST leave the download unrested WHEN it fails alone for timeout, network, stalled or connect', () => {
  // A failed download holds no persistent connection; a rest would remove 90 s of throughput
  // failures from the record.
  const rests = fail => {
    const t = createStuckTracker();
    for (let i = 0; i < 4; i++) {
      const row = {probes: Object.fromEntries(PROBE_IDS.map(id =>
        [id, id === 'down' ? {ok: false, fail} : {ok: true, ms: 20}]))};
      t.note(row, i);
      if (row.probes.down.stuck) return true;
    }
    return false;
  };
  for (const fail of ['timeout', 'network', 'stalled', 'connect']) {
    assert.equal(rests(fail), false, `${fail} rested the download`);
  }
});

const ok = await r.run();
process.exit(ok ? 0 : 1);
