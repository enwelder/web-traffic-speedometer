// The wake lock, driven directly. The platform reclaiming a lock, refusing one, and handing
// one back are all states that take seconds of real rounds to reach through a recorder.
import assert from 'node:assert';
import {stubBrowser, suite, sleep} from './helpers.mjs';

stubBrowser();
const {createWakeLock} = await import('../js/wakelock.js');

const s = suite('wake lock');

// A platform that grants locks until told otherwise, and can take one back the way iOS does.
function fakePlatform() {
  const grants = [];
  let refuse = false;
  globalThis.navigator.wakeLock = {
    request: async () => {
      if (refuse) throw Object.assign(new Error('denied'), {name: 'NotAllowedError'});
      const listeners = [];
      const sentinel = {
        released: false,
        addEventListener: (_, fn) => listeners.push(fn),
        release: async () => { sentinel.released = true; },
        systemRelease() { this.released = true; listeners.forEach(fn => fn()); }
      };
      grants.push(sentinel);
      return sentinel;
    }
  };
  return {grants, refuse: v => { refuse = v; }};
}

const track = () => {
  const notices = [], events = [];
  return {notices, events, onNotice: n => notices.push(n), onEvent: e => events.push(e)};
};

s.test('a lock taken back by the system is reacquired', async () => {
  const platform = fakePlatform();
  const log = track();
  const wake = createWakeLock(log);

  await wake.acquire();
  assert.equal(platform.grants.length, 1, 'the lock is taken');
  assert.equal(wake.held(), true);

  platform.grants[0].systemRelease();
  await sleep(10);
  assert.equal(platform.grants.length, 2, 'and taken again');
  assert.equal(wake.held(), true, 'the current one is live');
  assert.ok(log.events.includes('screen wake lock released'), 'the loss is on the record');
  assert.ok(log.notices.some(n => /released/.test(n)), 'and on the screen');
});

s.test('a sentinel the system has flagged as released does not count as held', async () => {
  const platform = fakePlatform();
  const wake = createWakeLock({});
  await wake.acquire();
  assert.equal(wake.held(), true);
  // The system can set `released` on the sentinel it granted without the page ever becoming
  // hidden. Reading the variable alone reports the screen as held for the rest of the run.
  platform.grants[0].released = true;
  assert.equal(wake.held(), false);
});

s.test('a refusal is reported once, and recovers when the platform allows it', async () => {
  const platform = fakePlatform();
  const log = track();
  const wake = createWakeLock(log);

  platform.refuse(true);
  await wake.acquire();
  assert.equal(wake.held(), false);
  assert.equal(log.events.filter(e => /refused/.test(e)).length, 1, 'said once');
  await wake.acquire();
  assert.equal(log.events.filter(e => /refused/.test(e)).length, 1, 'and not again on retry');

  platform.refuse(false);
  await wake.acquire();
  assert.equal(wake.held(), true, 'the lock comes back');
  assert.ok(log.events.includes('screen stays awake again'), 'and the recovery is recorded');
  assert.equal(log.notices.at(-1), '', 'the warning is cleared');
});

s.test('releasing on purpose is not a loss', async () => {
  const platform = fakePlatform();
  const log = track();
  const wake = createWakeLock(log);

  await wake.acquire();
  await wake.release();
  assert.equal(wake.held(), false);
  // Stopping a session releases the lock; the handler must not read that as the system
  // taking it, or every session would end by logging a loss and asking for it back.
  platform.grants[0].systemRelease();
  await sleep(10);
  assert.deepEqual(log.events, [], 'nothing logged');
  assert.equal(platform.grants.length, 1, 'and nothing reacquired');
});

s.test('a lost lock does not report a recovery in the next session', async () => {
  const platform = fakePlatform();
  const log = track();
  const wake = createWakeLock(log);

  platform.refuse(true);
  await wake.acquire();
  await wake.release();

  platform.refuse(false);
  wake.reset();
  await wake.acquire();
  assert.ok(!log.events.includes('screen stays awake again'),
            'a new session starts clean');
});

s.test('a hidden page does not ask for a lock it cannot get', async () => {
  const platform = fakePlatform();
  document.visibilityState = 'hidden';
  const wake = createWakeLock({});
  await wake.acquire();
  assert.equal(platform.grants.length, 0);
  document.visibilityState = 'visible';
  await wake.acquire();
  assert.equal(platform.grants.length, 1, 'and takes one as soon as the page is back');
});

await s.run();
