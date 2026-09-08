// Shared fixtures. The browser globals the modules touch are stubbed in one place, so a
// module gaining a new dependency fails here rather than in each suite.

export function stubBrowser() {
  globalThis.document ??= {addEventListener() {}, visibilityState: 'visible'};
  if (!('navigator' in globalThis) || !globalThis.navigator.userAgent) {
    Object.defineProperty(globalThis, 'navigator', {
      value: {userAgent: 'node-test', language: 'en', geolocation: null},
      configurable: true
    });
  }
  globalThis.screen ??= {width: 390, height: 844};
  globalThis.devicePixelRatio ??= 3;
  performance.clearResourceTimings ??= () => {};
  performance.getEntriesByName ??= () => [];
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// An in-memory stand-in for the IndexedDB module, injectable into createRecorder.
export function fakeStore() {
  const written = {samples: [], events: [], sessions: []};
  let failures = 0;
  // holdWrites delays a write, so a caller arriving during one can be tested.
  let holdMs = 0;
  return {
    written,
    failNext(n) { failures = n; },
    holdWrites(ms) { holdMs = ms; },
    async putSamples(s) {
      if (holdMs) await sleep(holdMs);
      if (failures-- > 0) throw new Error('quota exceeded');
      written.samples.push(...s);
    },
    async putEvents(e) {
      if (holdMs) await sleep(holdMs);
      if (failures-- > 0) throw new Error('quota exceeded');
      written.events.push(...e);
    },
    async putSession(s) { written.sessions.push(s); },
    setActive() {},
    getActive() { return null; }
  };
}

export const TRACE = 'fl=1\nip=2a09:bac5::9\nts=1\ncolo=AMS\nloc=NL\n';

export const bodyOf = n => ({
  getReader() {
    let sent = false;
    return {read: async () => (sent ? {done: true} : (sent = true, {done: false, value: new Uint8Array(n)}))};
  }
});

export function netError() {
  return Object.assign(new TypeError('Load failed'), {name: 'TypeError'});
}


// A minimal test runner: named cases, a count, and a non-zero exit code on any failure.
export function suite(name) {
  const cases = [];
  return {
    test: (label, fn) => cases.push([label, fn]),
    // Every case runs even after one fails, so a run reports every failure it has.
    async run() {
      let passed = 0, failed = 0;
      for (const [label, fn] of cases) {
        try {
          await fn();
          passed++;
        } catch (e) {
          failed++;
          console.error(`\n  FAIL  ${name} › ${label}\n        ${e.message}\n`);
          process.exitCode = 1;
        }
      }
      if (failed) console.error(`  FAIL  ${name} (${failed} of ${cases.length} cases)`);
      else console.log(`  ok    ${name} (${passed} cases)`);
      return !failed;
    }
  };
}
