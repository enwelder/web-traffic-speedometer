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

s.test('createPositionTracker.read MUST return null lat, accuracy_class and speed_source WHEN no fix has arrived', () => {
  fakeGeolocation();
  const {tracker} = track();
  const row = tracker.read();
  assert.equal(row.lat, null);
  assert.equal(row.accuracy_class, null);
  assert.equal(row.speed_source, null);
});

s.test('createPositionTracker.read MUST derive speed from a pair of fine fixes WHEN the platform reports no speed', () => {
  const geo = fakeGeolocation();
  const {tracker} = track();
  const t0 = 1700000000000;
  // ~1000 m apart, 20 s apart: 50 m/s.
  geo.send(51.9244, 4.4777, t0);
  tracker.read();
  geo.send(51.9334, 4.4777, t0 + 20000);
  const row = tracker.read();

  assert.equal(row.speed, null, 'the measured field stays empty');
  assert.equal(row.speed_source, 'derived', 'and the row records the source of the figure');
  assert.ok(Math.abs(row.speed_derived - 50) < 5, `~50 m/s, got ${row.speed_derived}`);
  assert.equal(row.accuracy_class, 'gps');
});

s.test('createPositionTracker.read MUST report speed with source gps WHEN the fix carries a speed', () => {
  const geo = fakeGeolocation();
  const {tracker} = track();
  geo.send(51.9244, 4.4777, 1700000000000, {speed: 38.5});
  const row = tracker.read();
  assert.equal(row.speed, 38.5);
  assert.equal(row.speed_source, 'gps');
});

s.test('createPositionTracker.read MUST return null speed_derived and accuracy_class coarse WHEN both fixes are tower estimates', () => {
  const geo = fakeGeolocation();
  const {tracker} = track();
  const t0 = 1700000000000;
  // Two 1414 m estimates a kilometre apart read as 180 km/h on a stationary train.
  geo.send(51.9244, 4.4777, t0, {accuracy: 1414});
  tracker.read();
  geo.send(51.9334, 4.4777, t0 + 20000, {accuracy: 1414});
  const row = tracker.read();
  assert.equal(row.speed_derived, null, 'no speed from a pair of estimates');
  assert.equal(row.accuracy_class, 'coarse', 'and the row records the coarse accuracy class');
  assert.equal(row.accuracy, 1414, 'the accuracy itself is kept, being a measurement');
});

s.test('createPositionTracker.read MUST return null speed_derived WHEN one fix of the pair exceeds FINE_ACCURACY_M', () => {
  const geo = fakeGeolocation();
  const {tracker} = track();
  const t0 = 1700000000000;
  geo.send(51.9244, 4.4777, t0, {accuracy: FINE_ACCURACY_M});
  tracker.read();
  geo.send(51.9334, 4.4777, t0 + 20000, {accuracy: FINE_ACCURACY_M + 1});
  assert.equal(tracker.read().speed_derived, null);
});

s.test('createPositionTracker.read MUST return null speed_derived and keep the coordinates WHEN the pair implies a rate above MAX_PLAUSIBLE_MS', () => {
  const geo = fakeGeolocation();
  const {tracker} = track();
  const t0 = 1700000000000;
  geo.send(51.9244, 4.4777, t0);
  tracker.read();
  // 10 km in 20 s is 500 m/s: one of the two fixes is wrong.
  geo.send(52.0143, 4.4777, t0 + 20000);
  const row = tracker.read();
  assert.ok(metresBetween({lat: 51.9244, lon: 4.4777}, {lat: 52.0143, lon: 4.4777}) / 20
            > MAX_PLAUSIBLE_MS, 'the pair is implausible');
  assert.equal(row.speed_derived, null, 'so no speed is reported');
  assert.equal(row.lat, 52.0143, 'while the coordinates stay for the analysis');
});

s.test('createPositionTracker.read MUST return null speed_derived WHEN the fixes are under 1 s or over 2 min apart', () => {
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

s.test('createPositionTracker MUST emit one note WHEN the accuracy class changes', () => {
  const geo = fakeGeolocation();
  const {notes} = track();
  geo.send(51.9244, 4.4777, 1, {accuracy: 10});
  geo.send(51.9244, 4.4777, 2, {accuracy: 12});
  assert.deepEqual(notes, [], 'an unchanged class produces no note');
  geo.send(51.9244, 4.4777, 3, {accuracy: 1414});
  assert.equal(notes.length, 1, 'the degradation is reported');
  assert.match(notes[0], /degraded to 1414 m/);
  geo.send(51.9244, 4.4777, 4, {accuracy: 1200});
  assert.equal(notes.length, 1, 'and not repeated while it stays coarse');
  geo.send(51.9244, 4.4777, 5, {accuracy: 8});
  assert.match(notes[1], /precise again/, 'the recovery is reported too');
});

s.test('createPositionTracker MUST report denied on the row, the snapshot and the notice WHEN permission is refused', () => {
  const geo = fakeGeolocation();
  const notices = [];
  const {tracker} = track({onNotice: n => notices.push(n)});
  geo.fail(1);
  assert.equal(tracker.read().pos_error, 'denied');
  assert.equal(tracker.snapshot().error, 'denied');
  assert.match(notices[0], /No location \(denied\)/);
});

s.test('createPositionTracker MUST emit one note per change of error state WHEN the platform repeats an error', () => {
  // iOS repeats "position unavailable" every watch timeout while it holds only tower estimates.
  const geo = fakeGeolocation();
  const {notes} = track();
  geo.fail(2);
  geo.fail(2);
  geo.fail(3);
  assert.deepEqual(notes, ['no location (unavailable)', 'no location (timeout)']);
});

s.test('createPositionTracker MUST clear its notice WHEN a fix follows an error', () => {
  // Recorded 10 Sep: the notice stayed on screen at 19:08 while fixes had resumed.
  const geo = fakeGeolocation();
  const notices = [];
  const {tracker} = track({onNotice: n => notices.push(n)});
  geo.fail(2);
  geo.send(51.9244, 4.4777, 1, {accuracy: 1414});
  assert.deepEqual(notices, ['No location (unavailable). Measurement continues without coordinates.', '']);
  assert.equal(tracker.read().pos_error, null);
  geo.send(51.9245, 4.4777, 2, {accuracy: 1414});
  assert.equal(notices.length, 2, 'a fix with no error before it writes nothing');
});

s.test('createPositionTracker.reset MUST return null speed_derived WHEN the fix pair spans two sessions', () => {
  const geo = fakeGeolocation();
  const {tracker} = track();
  const t0 = 1700000000000;
  geo.send(51.9244, 4.4777, t0);
  tracker.read();
  tracker.reset();
  // reset() drops the previous session's fix pair.
  geo.send(51.9334, 4.4777, t0 + 20000);
  assert.equal(tracker.read().speed_derived, null);
});

await s.run();
