// Regressions for bugs found in journey data rather than in review. Each names the
// observation that exposed it, so a future change that reintroduces one fails loudly.
import assert from 'node:assert';
import {stubBrowser, fakeStore, TRACE, bodyOf, netError, sleep, suite} from './helpers.mjs';

stubBrowser();
const probe = await import('../js/probe.js');
const {createRecorder} = await import('../js/session.js');

const P = Object.fromEntries(probe.PROBES.map(p => [p.id, p]));
const r = suite('regressions');

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

const session = (over = {}) => ({id: 's', name: 't', operator: 'KPN', connection: 'cellular',
                                 intervalMs: 100, downloadBytes: 1000, started: Date.now(),
                                 ipv4_available: true, ipv4_check: null, ...over});

// Journey 3, seq 240-241: a round ran 13.7 s late at a 10 s interval, and the next tick
// fired 11 ms later and collided with it. Adding one interval to a due time already further
// behind than that leaves it in the past, so the timer fires immediately.
r.test('a freeze shorter than two intervals does not fire the next round instantly', async () => {
  stubStun();
  globalThis.fetch = async () => okResponse();
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session());
  await sleep(250);

  // Block the loop for 1.4 intervals: long enough to miss a slot, short enough that the old
  // two-interval resync threshold ignored it.
  const until = Date.now() + 140;
  while (Date.now() < until) { /* frozen, exactly as a suspended tab */ }
  await sleep(400);
  await rec.stop();

  const rows = store.written.samples;
  const overlaps = rows.filter(x => x.skipped === 'overlap');
  assert.equal(overlaps.length, 0, `a missed slot must not manufacture an overlap: ${overlaps.length}`);

  // Rounds stay on the original grid rather than bunching up to catch up.
  const gaps = rows.filter(x => !x.skipped).map(x => x.mono).sort((a, b) => a - b)
                   .map((v, i, all) => (i ? v - all[i - 1] : null)).filter(Boolean);
  assert.ok(gaps.every(g => g >= 80), `no round follows another instantly: ${gaps.join(',')}`);
});

// Journey 3, seq 222: every probe hit its 4 s deadline yet the round took 16.7 s, because a
// frozen tab suspends the abort timer too. Without the previous round's real duration an
// overlap cannot be told apart from the app stalling.
r.test('a skipped round records how long the round before it actually took', async () => {
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

  const skipped = store.written.samples.filter(x => x.skipped === 'overlap');
  assert.ok(skipped.length > 0, 'a slow round still overlaps the next one');
  assert.ok(store.written.samples.some(x => typeof x.prev_round_ms === 'number' && x.prev_round_ms > 0),
            'and the duration of the round before it is on the row');
});

// Journey 1, seq 138-157: after a genuine outage every probe recovered except the control,
// which then timed out for twenty consecutive rounds on its own. Twenty false failures.
r.test('a probe failing alone is rested rather than believed', async () => {
  stubStun();
  let webWedged = true;
  globalThis.fetch = async url => {
    if (String(url).includes('gstatic') && webWedged) throw netError();
    return okResponse();
  };
  const notices = [];
  const store = fakeStore();
  const rec = createRecorder({store, onNotice: t => t && notices.push(t)});
  await rec.start(session());
  await sleep(900);

  const rows = store.written.samples.filter(x => !x.skipped);
  assert.ok(rows.length >= 6, 'enough rounds to detect it');
  assert.ok(rows.some(x => x.probes.web.stuck), 'the wedged probe is marked stuck');
  assert.ok(rows.some(x => x.probes.web.fail === 'resting'),
            'and is rested instead of producing more identical failures');
  assert.ok(rows.every(x => x.probes.ip6.ok), 'the probes that work are untouched');
  assert.ok(notices.some(n => /resting/.test(n)), 'and the screen says why');

  // Once it works again it is trusted again, without restarting the session.
  webWedged = false;
  await sleep(900);
  await rec.stop();
  const later = store.written.samples.filter(x => !x.skipped).slice(-3);
  assert.ok(later.some(x => x.probes.web.ok), 'recovery is picked up automatically');
});

// Journeys 1-3: successful small probes at 3885, 3883, 3878 ms against a 4000 ms ceiling.
// Anything slower was recorded as a failure, collapsing "slow" into "gone".
r.test('a slow but working probe is not recorded as a failure', async () => {
  for (const interval of [15000, 30000]) {
    for (const p of probe.PROBES) {
      const t = probe.timeoutFor(p, interval);
      if (p.kind === 'stun') continue;
      assert.ok(t >= 8000, `${p.id} at a ${interval} ms interval allows ${t} ms, under the 8 s floor`);
    }
  }
  globalThis.fetch = async () => { await sleep(120); return {ok: true, status: 200, text: async () => TRACE}; };
  const res = await probe.runProbe(P.ip4, {timeoutMs: probe.timeoutFor(P.ip4, 15000)});
  assert.equal(res.ok, true, 'a response well past the old ceiling still counts as a success');
});

// Speed came back on 0, 2 and 51 of 158, 75 and 243 rounds. The web API cannot be pushed
// harder, so it is computed from consecutive fixes and the source is recorded.
r.test('speed is derived from consecutive fixes when the platform will not supply it', async () => {
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
  // ~1000 m apart, 20 s apart: 50 m/s, and coords.speed absent as iOS often leaves it.
  watcher({coords: {latitude: 51.9244, longitude: 4.4777, accuracy: 10, speed: null, heading: null}, timestamp: base});
  await sleep(250);
  watcher({coords: {latitude: 51.9334, longitude: 4.4777, accuracy: 10, speed: null, heading: null}, timestamp: base + 20000});
  await sleep(250);
  await rec.stop();

  const withSpeed = store.written.samples.filter(x => x.speed_derived != null);
  assert.ok(withSpeed.length > 0, 'a speed is produced without the platform supplying one');
  const s = withSpeed[0];
  assert.equal(s.speed, null, 'the measured field stays empty rather than being invented');
  assert.equal(s.speed_source, 'derived', 'and the row says where the number came from');
  assert.ok(Math.abs(s.speed_derived - 50) < 5, `~50 m/s over 1 km in 20 s, got ${s.speed_derived}`);

  stubBrowser();
  Object.defineProperty(globalThis, 'navigator', {value: {userAgent: 'node-test', language: 'en', geolocation: null}, configurable: true});
});

// The pause event existed but correlating it with samples meant matching timestamps by hand.
r.test('rounds inside a bridged gap are flagged on the row', async () => {
  stubStun();
  globalThis.fetch = async () => okResponse();
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session());
  await sleep(200);
  const until = Date.now() + 300;
  while (Date.now() < until) { /* frozen */ }
  await sleep(300);
  await rec.stop();

  assert.ok(store.written.events.some(e => e.type === 'pause'), 'the gap is still an event');
  assert.ok(store.written.samples.some(x => x.in_pause === true),
            'and the round that follows it is filterable without matching timestamps');
  assert.ok(store.written.samples.some(x => x.in_pause === false), 'ordinary rounds are not flagged');
});

const ok = await r.run();
process.exit(ok ? 0 : 1);
