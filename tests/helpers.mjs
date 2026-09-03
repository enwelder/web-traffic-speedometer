// Shared fixtures. The browser globals the modules touch are stubbed here rather than in
// each test, so a module gaining a new dependency fails loudly in one place.

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

// An in-memory stand-in for the IndexedDB module, injectable into createRecorder.
export function fakeStore() {
  const written = {samples: [], events: [], sessions: []};
  let failures = 0;
  return {
    written,
    failNext(n) { failures = n; },
    async putSamples(s) { if (failures-- > 0) throw new Error('quota exceeded'); written.samples.push(...s); },
    async putEvents(e) { if (failures-- > 0) throw new Error('quota exceeded'); written.events.push(...e); },
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

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// A minimal test runner: named cases, a count, and a non-zero exit on the first failure.
export function suite(name) {
  const cases = [];
  return {
    test: (label, fn) => cases.push([label, fn]),
    async run() {
      let passed = 0;
      for (const [label, fn] of cases) {
        try {
          await fn();
          passed++;
        } catch (e) {
          console.error(`\n  FAIL  ${name} › ${label}\n        ${e.message}\n`);
          process.exitCode = 1;
          return false;
        }
      }
      console.log(`  ok    ${name} (${passed} cases)`);
      return true;
    }
  };
}
