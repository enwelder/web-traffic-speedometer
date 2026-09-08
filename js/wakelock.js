// The screen wake lock, and the two ways it goes wrong.
//
// The system reclaims the lock without the page ever becoming hidden — Low Power Mode
// engaging, a call arriving, the screen locking. The sentinel stays non-null with `released`
// set, so whether the lock is held is decided by that flag as well as by the release event.
//
// `acquire` is called from the round loop, from visibilitychange and from the release
// handler, so a request in flight is tracked: two concurrent requests orphan a sentinel
// whose later release reports a loss that did not happen.

export function createWakeLock({onNotice, onEvent} = {}) {
  let sentinel = null;
  let lost = false;
  let pending = false;
  // Whether the session wants the screen held. False while stopping, so releasing on purpose
  // is not read as a loss and does not ask for the lock back.
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
      granted.addEventListener('release', () => onRelease(granted), {once: true});
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

  function onRelease(granted) {
    if (sentinel === granted) sentinel = null;
    if (!active) return;
    lost = true;
    onNotice?.('The screen lock was released. Reacquiring — if it keeps happening, check Low Power Mode.');
    onEvent?.('screen wake lock released');
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
