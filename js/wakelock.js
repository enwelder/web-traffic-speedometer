// The sentinel stays non-null with `released` set when the system reclaims the lock, so `held`
// reads that flag as well as the release event.
//
// `acquire` is called from the round loop, from visibilitychange and from the release
// handler, so a request in flight is tracked: two concurrent requests orphan a sentinel
// whose later release reports a loss that did not happen.

export function createWakeLock({onNotice, onEvent, onRelease} = {}) {
  let sentinel = null;
  let lost = false;
  let pending = false;
  // Whether the session holds the screen. False while stopping, so a deliberate release logs no
  // loss and requests no new lock.
  let active = false;

  const held = () => !!sentinel && !sentinel.released;

  async function acquire() {
    active = true;
    if (!navigator.wakeLock || held() || pending) return;
    if (document.visibilityState !== 'visible') return;
    pending = true;
    try {
      const granted = await navigator.wakeLock.request('screen');
      sentinel = granted;
      granted.addEventListener('release', () => released(granted), {once: true});
      if (lost) {
        lost = false;
        onNotice?.('');
        onEvent?.('screen stays awake again');
      }
    } catch (e) {
      sentinel = null;
      if (!lost) {
        lost = true;
        onNotice?.('The screen will not stay awake. Set auto-lock longer, or turn off Low Power Mode.');
        onEvent?.(`screen wake lock refused (${e && e.name || 'unknown'})`);
      }
    } finally {
      pending = false;
    }
  }

  function released(granted) {
    if (sentinel === granted) sentinel = null;
    if (!active) return;
    lost = true;
    onNotice?.('Screen lock released and taken again. If this repeats, turn off Low Power Mode.');
    onEvent?.('screen wake lock released');
    // iOS releases the lock before it suspends the page, so the round in flight hears of it first.
    onRelease?.();
    acquire();
  }

  async function release() {
    active = false;
    if (!sentinel) return;
    try { await sentinel.release(); } catch { /* already gone */ }
    sentinel = null;
  }

  // A new session starts with no loss recorded, so its first success does not report a
  // recovery from the previous session's failure.
  function reset() { lost = false; }

  return {acquire, release, held, reset};
}
