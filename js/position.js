// Where the device is, how fast it is moving, and how much either figure is worth.

const EARTH_M = 6371000;

// Above this accuracy a fix is a cell-tower estimate. Two such fixes hundreds of metres
// apart in opposite directions yield speeds around 680 km/h; iOS reports exactly 1414 m for
// that class of fix.
export const FINE_ACCURACY_M = 100;

// 400 km/h, above the top speed of any train on the routes measured.
export const MAX_PLAUSIBLE_MS = 111;

// Metres per second between two fixes, or null where the pair cannot support a figure.
function derivedSpeed(prevFix, fix) {
  // Both fixes must be fine: a coarse fix anywhere in the pair makes the distance
  // meaningless.
  if (!fix.fine || !prevFix?.fine || fix.t <= prevFix.t) return null;
  const seconds = (fix.t - prevFix.t) / 1000;
  // Under a second the rate is dominated by fix jitter; over two minutes it averages away
  // everything that happened in between.
  if (seconds < 1 || seconds > 120) return null;
  const rate = metresBetween(prevFix, fix) / seconds;
  // Two fixes accurate to 10 m can still be hundreds of metres apart if one is wrong, so a
  // rate above the plausible ceiling is discarded. The coordinates stay on both rows, so the
  // analysis can derive speed differently.
  return rate <= MAX_PLAUSIBLE_MS ? rate : null;
}

// Haversine distance.
export function metresBetween(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function createPositionTracker({onNote, onNotice, onChange} = {}) {
  let watchId = null;
  let lastPos = null;
  let error = null;
  let prevFix = null;
  let fineFix = null;

  function start() {
    if (!navigator.geolocation) { error = 'unavailable'; return; }
    watchId = navigator.geolocation.watchPosition(
      p => {
        lastPos = p;
        error = null;
        // Accuracy changes mid-journey (a tunnel, or a fallback to tower positioning) and
        // changes what the coordinates support, so each transition is reported.
        const acc = p.coords.accuracy;
        const nowFine = acc != null && acc <= FINE_ACCURACY_M;
        if (fineFix !== null && nowFine !== fineFix) {
          onNote?.(nowFine ? `location precise again (${Math.round(acc)} m)`
                           : `location degraded to ${Math.round(acc)} m — speed and distance withheld`);
        }
        fineFix = nowFine;
        onChange?.();
      },
      e => {
        error = e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable';
        onNotice?.(`No location (${error}). Measurement continues without coordinates.`);
        onChange?.();
      },
      // maximumAge 0: a cached fix is often a coarse one held from earlier, which puts a
      // large share of rounds at tower accuracy.
      {enableHighAccuracy: true, maximumAge: 0, timeout: 12000}
    );
  }

  function stop() {
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }

  // The position fields of one row. Reading advances the pair used for the next derivation,
  // so a caller that reads twice at one instant gets the same answer and no extra pair.
  function read() {
    if (!lastPos) {
      return {lat: null, lon: null, accuracy: null, accuracy_class: null, speed: null,
              speed_derived: null, speed_source: null, heading: null, pos_t: null,
              pos_error: error};
    }
    const c = lastPos.coords;
    const fix = {lat: c.latitude, lon: c.longitude, t: lastPos.timestamp};

    const accuracy = c.accuracy == null ? null : Math.round(c.accuracy);
    const fine = accuracy != null && accuracy <= FINE_ACCURACY_M;
    fix.fine = fine;

    const derived = derivedSpeed(prevFix, fix);
    if (!prevFix || fix.t !== prevFix.t) prevFix = fix;

    const measured = c.speed == null || c.speed < 0 ? null : c.speed;
    return {
      lat: fix.lat, lon: fix.lon,
      accuracy,
      // gps: usable for position and for deriving speed. coarse: a tower estimate, usable
      // as a rough location only. Consumers filter on this instead of the raw threshold.
      accuracy_class: accuracy == null ? null : fine ? 'gps' : 'coarse',
      speed: measured,
      speed_derived: derived == null ? null : Math.round(derived * 100) / 100,
      speed_source: measured != null ? 'gps' : derived != null ? 'derived' : null,
      heading: c.heading == null || c.heading < 0 ? null : c.heading,
      // The fix's own timestamp, so its age is visible: a 30 s old fix on a 140 km/h train
      // is more than a kilometre from the round's position.
      pos_t: fix.t,
      pos_error: error
    };
  }

  // What the readout shows between rounds: the raw fix, and why there is not one.
  const snapshot = () => ({pos: lastPos, error});

  function reset() { lastPos = null; error = null; prevFix = null; fineFix = null; }

  return {start, stop, read, snapshot, reset};
}
