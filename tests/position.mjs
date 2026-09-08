// Fix quality and derived speed, driven directly. Through a recorder this needs a stubbed
// navigator, two sessions and half a second of sleeps to assert one speed.
import assert from 'node:assert';
import {stubBrowser, suite} from './helpers.mjs';

stubBrowser();
const {createPositionTracker, metresBetween, FINE_ACCURACY_M, MAX_PLAUSIBLE_MS} =
  await import('../js/position.js');

const s = suite('position');

// A geolocation the test drives by hand: `send` delivers a fix, `fail` an error.
function fakeGeolocation() {
  let ok = null, err = null;
  navigator.geolocation = {
    watchPosition: (a, b) => { ok = a; err = b; return 7; },
    clearWatch() { navigator.geolocation.cleared = true; }
  };
  return {
    send: (lat, lon, t, over = {}) =>
      ok({coords: {latitude: lat, longitude: lon, accuracy: 10, speed: null, heading: null,
                   ...over}, timestamp: t}),
    fail: code => err({code})
  };
}

const track = (over = {}) => {
  const notes = [];
  const tracker = createPositionTracker({onNote: n => notes.push(n), ...over});
  tracker.start();
  return {tracker, notes};
};

s.test('no fix yet is reported as nothing, not as a position', () => {
  fakeGeolocation();
  const {tracker} = track();
  const row = tracker.read();
  assert.equal(row.lat, null);
  assert.equal(row.accuracy_class, null);
  assert.equal(row.speed_source, null);
});

s.test('speed is derived from a pair of fine fixes when the platform supplies none', () => {
  const geo = fakeGeolocation();
  const {tracker} = track();
  const t0 = 1700000000000;
  // ~1000 m apart, 20 s apart: 50 m/s.
  geo.send(51.9244, 4.4777, t0);
  tracker.read();
  geo.send(51.9334, 4.4777, t0 + 20000);
  const row = tracker.read();

  assert.equal(row.speed, null, 'the measured field stays empty');
  assert.equal(row.speed_source, 'derived', 'and the row says where the figure came from');
  assert.ok(Math.abs(row.speed_derived - 50) < 5, `~50 m/s, got ${row.speed_derived}`);
  assert.equal(row.accuracy_class, 'gps');
});

s.test('a measured speed is preferred and labelled as such', () => {
  const geo = fakeGeolocation();
  const {tracker} = track();
  geo.send(51.9244, 4.4777, 1700000000000, {speed: 38.5});
  const row = tracker.read();
  assert.equal(row.speed, 38.5);
  assert.equal(row.speed_source, 'gps');
});

s.test('a tower-class fix produces no speed and says why', () => {
  const geo = fakeGeolocation();
  const {tracker} = track();
  const t0 = 1700000000000;
  // Two 1414 m estimates a kilometre apart read as 180 km/h on a stationary train.
  geo.send(51.9244, 4.4777, t0, {accuracy: 1414});
  tracker.read();
  geo.send(51.9334, 4.4777, t0 + 20000, {accuracy: 1414});
  const row = tracker.read();
  assert.equal(row.speed_derived, null, 'no speed from a pair of estimates');
  assert.equal(row.accuracy_class, 'coarse', 'and the row explains the gap');
  assert.equal(row.accuracy, 1414, 'the accuracy itself is kept, being a measurement');
});

s.test('one coarse fix in the pair is enough to withhold the speed', () => {
  const geo = fakeGeolocation();
  const {tracker} = track();
  const t0 = 1700000000000;
  geo.send(51.9244, 4.4777, t0, {accuracy: FINE_ACCURACY_M});
  tracker.read();
  geo.send(51.9334, 4.4777, t0 + 20000, {accuracy: FINE_ACCURACY_M + 1});
  assert.equal(tracker.read().speed_derived, null);
});

s.test('a rate no train reaches is discarded, and the coordinates are kept', () => {
  const geo = fakeGeolocation();
  const {tracker} = track();
  const t0 = 1700000000000;
  geo.send(51.9244, 4.4777, t0);
  tracker.read();
  // 10 km in 20 s is 500 m/s: one of the two fixes is wrong.
  geo.send(52.0143, 4.4777, t0 + 20000);
  const row = tracker.read();
  assert.ok(metresBetween({lat: 51.9244, lon: 4.4777}, {lat: 52.0143, lon: 4.4777}) / 20
            > MAX_PLAUSIBLE_MS, 'the pair really is implausible');
  assert.equal(row.speed_derived, null, 'so no speed is reported');
  assert.equal(row.lat, 52.0143, 'while the coordinates stay for the analysis');
});

s.test('fixes too close together or too far apart in time derive nothing', () => {
  for (const gapMs of [500, 130000]) {
    const geo = fakeGeolocation();
    const {tracker} = track();
    const t0 = 1700000000000;
    geo.send(51.9244, 4.4777, t0);
    tracker.read();
    geo.send(51.9334, 4.4777, t0 + gapMs);
    assert.equal(tracker.read().speed_derived, null, `${gapMs} ms apart`);
  }
});

s.test('a change of accuracy class is reported once, on the transition', () => {
  const geo = fakeGeolocation();
  const {notes} = track();
  geo.send(51.9244, 4.4777, 1, {accuracy: 10});
  geo.send(51.9244, 4.4777, 2, {accuracy: 12});
  assert.deepEqual(notes, [], 'staying precise says nothing');
  geo.send(51.9244, 4.4777, 3, {accuracy: 1414});
  assert.equal(notes.length, 1, 'the degradation is reported');
  assert.match(notes[0], /degraded to 1414 m/);
  geo.send(51.9244, 4.4777, 4, {accuracy: 1200});
  assert.equal(notes.length, 1, 'and not repeated while it stays coarse');
  geo.send(51.9244, 4.4777, 5, {accuracy: 8});
  assert.match(notes[1], /precise again/, 'the recovery is reported too');
});

s.test('a refused permission is carried on the row and on the screen', () => {
  const geo = fakeGeolocation();
  const notices = [];
  const {tracker} = track({onNotice: n => notices.push(n)});
  geo.fail(1);
  assert.equal(tracker.read().pos_error, 'denied');
  assert.equal(tracker.snapshot().error, 'denied');
  assert.match(notices[0], /No location \(denied\)/);
});

s.test('a session starts without the previous session\'s fixes', () => {
  const geo = fakeGeolocation();
  const {tracker} = track();
  const t0 = 1700000000000;
  geo.send(51.9244, 4.4777, t0);
  tracker.read();
  tracker.reset();
  // The pair that would have produced a speed is gone with the session that made it.
  geo.send(51.9334, 4.4777, t0 + 20000);
  assert.equal(tracker.read().speed_derived, null);
});

await s.run();
