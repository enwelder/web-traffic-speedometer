// Boundary values and mobile-network behaviour. Each case is either an exact threshold,
// where an off-by-one changes a colour, or an event recorded on a train: a handover, a
// captive portal, a tunnel, a saturated cell, a carrier blocking UDP.
import assert from 'node:assert';
import {stubBrowser, fakeStore, bodyOf, netError, sleep, suite} from './helpers.mjs';

stubBrowser();
const probe = await import('../js/probe.js');
const g = await import('../js/grade.js');
const {createRecorder} = await import('../js/session.js');
const ex = await import('../js/export.js');
const {summarise, countsAsFailure} = ex;

const P = Object.fromEntries(probe.PROBES.map(p => [p.id, p]));
const PROBE_IDS = probe.PROBES.map(p => p.id);

const session = () => ({id: 's1', name: 't', operator: 'KPN', connection: 'cellular',
                        intervalMs: 80, started: Date.now(),
                        download: {windowMs: 40, rampMs: 0, streams: 1, maxBytes: 20000, capBytes: 20000},
                        ipv4_available: true, ipv4_check: null});

function stubStun({srflx = true, block = false} = {}) {
  globalThis.RTCPeerConnection = class {
    addTransceiver() {} async createOffer() { return {}; }
    async setLocalDescription() {
      if (block) return;                       // a carrier that drops STUN: nothing ever comes back
      setTimeout(() => srflx && this.onicecandidate?.({candidate: {type: 'srflx', address: '2a09::9'}}), 1);
      setTimeout(() => this.onicecandidate?.({candidate: null}), 3);
    }
    close() {}
  };
}

const trace = (ip = '2a09:bac5::9', colo = 'AMS') =>
  `fl=1\nip=${ip}\nts=1\ncolo=${colo}\nvisit_scheme=https\n`;

const okResponse = (body = trace()) => ({ok: true, status: 200, type: 'opaque',
                                         headers: {get: () => null}, body: bodyOf(1000),
                                         text: async () => body});

/* ---------------- exact thresholds ---------------- */

const t = suite('thresholds');

t.test('gradeValue MUST return the worse grade at the edge and the better one just inside it WHEN every scale edge is read from both sides', () => {
  // Every edge is checked from both sides.
  for (const [scale, edges] of Object.entries(g.SCALES).map(([k, v]) => [k, v.edges])) {
    const low = g.SCALES[scale].dir === 'low';
    edges.forEach((edge, i) => {
      const better = low ? edge - 0.001 : edge + 0.001;
      const worse = low ? edge : edge;    // the edge itself is already the worse side
      assert.equal(g.gradeValue(scale, better), g.GRADES[i],
                   `${scale}: ${better} sits just inside ${g.GRADES[i]}`);
      assert.equal(g.gradeValue(scale, worse), g.GRADES[i + 1],
                   `${scale}: ${worse} is exactly the edge and grades one worse`);
    });
  }
});

t.test('gradeValue MUST return null WHEN the value is null, undefined, NaN, infinite, negative or a string', () => {
  for (const scale of Object.keys(g.SCALES)) {
    for (const v of [null, undefined, NaN, Infinity, -Infinity, -1, '30']) {
      assert.equal(g.gradeValue(scale, v), null,
                   `${scale} must give ${String(v)} no colour`);
    }
  }
  // Zero is a valid reading in both directions: instant, and stopped.
  assert.equal(g.gradeValue('round_trip', 0), 'green');
  assert.equal(g.gradeValue('rate', 0), 'red');
});

t.test('quantile MUST return the nearest rank inside the array WHEN the series is short', () => {
  assert.equal(ex.quantile([], 0.5), null, 'nothing has no median');
  assert.equal(ex.quantile([5], 0.9), 5);
  assert.deepEqual([ex.quantile([1, 2], 0.5), ex.quantile([1, 2], 0.9)], [1, 2]);
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(ex.quantile(ten, 0.9), 9, 'nearest rank: p90 of ten samples is the ninth');
  assert.equal(ex.quantile(ten, 0.5), 5);
  assert.equal(ex.quantile(ten, 0), 1, 'and the ends stay inside the array');
  assert.equal(ex.quantile(ten, 1), 10);
});


t.test('createRecorder MUST record accuracy_class gps at 100 m and coarse at 101 m WHEN the fixes carry those accuracies', async () => {
  const rows = await withFixes([fix(51.9, 4.4, 100), fix(51.9001, 4.4, 100)]);
  assert.ok(rows.some(r => r.accuracy_class === 'gps'), '100 m is still a usable fix');
  const coarse = await withFixes([fix(51.9, 4.4, 101), fix(51.9001, 4.4, 101)]);
  assert.ok(coarse.every(r => r.accuracy_class == null || r.accuracy_class === 'coarse'),
            '101 m is a tower estimate');
  assert.ok(coarse.every(r => r.speed_derived == null), 'and nothing is derived from it');
});

await t.run();

/* ---------------- the download ---------------- */

const d = suite('download edges');

// A stream given as a list of chunks. `stall` never resolves, as a read from a saturated
// cell does not.
const stream = chunks => ({getReader() {
  let i = 0;
  return {
    async read() {
      const c = chunks[i++];
      if (!c) return {done: true};
      if (c.stall) return new Promise(() => {});
      await sleep(c.after || 0);
      if (c.error) throw netError();
      return {done: false, value: new Uint8Array(c.bytes)};
    },
    cancel: async () => {}
  };
}});

const download = async (chunks, opts = {}) => {
  globalThis.fetch = async () => ({ok: true, status: 200, body: stream(chunks),
                                   headers: {get: () => null}});
  return probe.runProbe(P.down, {timeoutMs: 8000, download: {windowMs: 400, rampMs: 0, streams: 1, maxBytes: 1e6, capBytes: 1e6, ...opts}});
};

d.test('runProbe MUST return fail stalled inside the download budget WHEN the headers arrive and the body never does', async () => {
  const r = await download([{stall: true}]);
  assert.equal(r.ok, false);
  assert.equal(r.fail, 'stalled', 'the headers arrived and the body did not');
  assert.equal(r.bytes, 0);
  assert.ok(r.duration_ms >= 350, `the budget ended it before the 8 s deadline: ${r.duration_ms} ms`);
  assert.equal(countsAsFailure(r), true, 'and it counts against the connection');
});

d.test('runProbe MUST return fail empty with zero bytes WHEN the response carries no body', async () => {
  const r = await download([]);
  assert.equal(r.fail, 'empty', 'the endpoint answered with an empty body');
  assert.equal(r.bytes, 0);
});

d.test('runProbe MUST keep the bytes received and set truncated WHEN the stream throws mid-flight', async () => {
  const r = await download([{after: 2, bytes: 200000}, {after: 2, error: true}]);
  assert.equal(r.ok, false);
  assert.equal(r.fail, 'network');
  assert.equal(r.bytes, 200000, 'the bytes that did arrive are still the measurement');
  assert.equal(r.truncated, true);
});

d.test('runProbe MUST report no rate above DOWN_CEILING_BPS WHEN the body is too small to fill a window', async () => {
  // A single buffered chunk arriving in 2 ms computes to 7.5 Gb/s; an unopened window yields no
  // rate.
  for (const [name, chunks] of [['one tiny chunk', [{after: 2, bytes: 10}]],
                                ['one buffered chunk', [{after: 2, bytes: 5e6}]],
                                ['a stall after one chunk', [{after: 2, bytes: 1000}, {stall: true}]]]) {
    const r = await download(chunks);
    if (r.bps != null) assert.ok(r.bps <= probe.DOWN_CEILING_BPS, `${name}: never above the ceiling`);
    assert.ok(g.gradeActivities({probes: {down: r}}).streaming !== undefined, `${name}: graded either way`);
  }
});

d.test('runProbe MUST open DOWN_STREAMS requests and sum their bytes against one clock WHEN the download runs', async () => {
  // One TCP flow carries its receive window divided by its round trip and no more. A single
  // request read 41 Mb/s on a cell a three-stream reference test read 320 Mb/s on, and the
  // same code read 230-560 Mb/s on a desktop only because the round trip there is shorter.
  let opened = 0;
  globalThis.fetch = async () => {
    opened++;
    return {ok: true, status: 200, headers: {get: () => null},
            body: stream(Array.from({length: 200}, () => ({after: 10, bytes: 20000})))};
  };
  const r = await probe.runProbe(P.down, {timeoutMs: 8000});
  assert.equal(opened, probe.DOWN_STREAMS, 'one request per stream');
  assert.equal(r.streams, probe.DOWN_STREAMS, 'and the row records how many carried it');
  assert.ok(r.window_bytes > 0, 'their bytes are summed against one clock');
});

d.test('runProbe MUST report DOWN_CEILING_BPS with saturated set WHEN the byte cap ends the window', async () => {
  // A capped 1.5 s window separates no rates above the ceiling; the reading is the ceiling, flagged
  // `saturated`.
  globalThis.fetch = async () => ({ok: true, status: 200, headers: {get: () => null},
    body: stream(Array.from({length: 400}, () => ({after: 1, bytes: 250000})))});
  const r = await probe.runProbe(P.down, {timeoutMs: 8000});
  assert.equal(r.saturated, true);
  assert.equal(r.bps, probe.DOWN_CEILING_BPS, 'the reading is the ceiling, not an extrapolation');
  assert.ok(r.window_ms < probe.DOWN_WINDOW_MS, 'the cap ended it before the clock did');
  assert.ok(r.bytes <= probe.DOWN_RAMP_BYTES + probe.DOWN_CAP_BYTES * 1.5,
            `what a round costs is knowable in advance: ${r.bytes} bytes`);
});

d.test('runProbe MUST report the link rate with saturated false WHEN the window clock ends the read', async () => {
  globalThis.fetch = async () => ({ok: true, status: 200, headers: {get: () => null},
    body: stream(Array.from({length: 400}, () => ({after: 30, bytes: 10000})))});
  const r = await probe.runProbe(P.down, {timeoutMs: 8000});
  assert.equal(r.saturated, false);
  assert.ok(r.bps > 5e6 && r.bps < probe.DOWN_CEILING_BPS, `${r.bps} bps is the link's own rate`);
  assert.ok(Math.abs(r.window_ms - probe.DOWN_WINDOW_MS) < 400, 'the clock ended it');
});

d.test('runProbe MUST exclude the ramp bytes from the window WHEN a ramp is configured', async () => {
  // RMBT's 2 s pre-test activates the radio, so a result is independent of prior connection state.
  const slow = Array.from({length: 30}, () => ({after: 20, bytes: 500}));
  const fast = Array.from({length: 300}, () => ({after: 10, bytes: 20000}));
  const r = await download([...slow, ...fast], {rampMs: 600, streams: 1});
  assert.ok(r.ramp_ms > 0, 'a ramp was served');
  assert.ok(r.window_bytes < r.bytes, 'and it is not in the window');
  const whole = Math.round((r.bytes * 8) / ((r.ramp_ms + r.window_ms) / 1000));
  assert.ok(r.bps > whole, `the window beats the whole transfer: ${r.bps} vs ${whole}`);
});

d.test('runProbe MUST set refused_by to connection or server WHEN the download fails, and issue one request WHEN it succeeds', async () => {
  // A server refusal and an unopened connection look identical to the page. An opaque repeat
  // separates them: an unreadable response counts as a success.
  globalThis.fetch = async () => { throw netError(); };
  const dead = await probe.runProbe(P.down, {timeoutMs: 3000});
  assert.equal(dead.fail, 'network');
  assert.equal(dead.refused_by, 'connection', 'neither request was answered');

  let first = true;
  globalThis.fetch = async () => {
    if (first) { first = false; throw netError(); }
    return {ok: true, status: 0, type: 'opaque', headers: {get: () => null}};
  };
  const blocked = await probe.runProbe(P.down, {timeoutMs: 3000});
  assert.equal(blocked.refused_by, 'server', 'the server answered, just not readably');

  // A successful download issues no repeat request.
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {ok: true, status: 200, body: bodyOf(1000), headers: {get: () => null}};
  };
  await probe.runProbe(P.down, {timeoutMs: 3000, download: {windowMs: 500, rampMs: 0, streams: 1}});
  assert.equal(calls, 1, 'a working download costs one request and no more');
});

d.test('runProbe MUST set aborted_reason eof or done WHEN the body ends first or the window closes first', async () => {
  // 16 kB a chunk is what both engines hand over on a real body.
  const short = await download(Array.from({length: 20}, () => ({after: 8, bytes: 16000})),
                               {windowMs: 2000, rampMs: 0, streams: 1});
  assert.equal(short.aborted_reason, 'eof', 'the body ran out first');
  assert.equal(short.ok, true);
  assert.ok(short.window_ms >= probe.DOWN_MIN_SPAN_MS,
            `over a span long enough to divide by: ${short.window_ms} ms`);

  const cut = await download(Array.from({length: 400}, () => ({after: 5, bytes: 20000})),
                             {windowMs: 300, rampMs: 0, streams: 1});
  assert.equal(cut.aborted_reason, 'done', 'the window closed it');
  assert.ok(cut.window_ms < 600, `stopped near the window: ${cut.window_ms} ms`);
  assert.equal(cut.ok, true, 'a read stopped by its own window is a measurement, not a failure');
});

// Download rate overstatement cases, each with its arithmetic.

d.test('runProbe MUST return fail short with a null bps WHEN the window span is under DOWN_MIN_SPAN_MS', async () => {
  // A 9 kB body handed over whole, 3 ms after the ramp opened the window: 9000 x 8 / 0.003 is
  // 24 Mb/s, which is the clock's resolution and not the link's.
  const tiny = await download([{after: 1, bytes: 4000}, {after: 3, bytes: 9000}],
                              {windowMs: 1500, rampMs: 0, streams: 1});
  assert.equal(tiny.bps, null, 'no rate is reported');
  assert.equal(tiny.ok, false);
  assert.equal(tiny.fail, 'short', 'the measurement failed, not the link');
  assert.equal(countsAsFailure(tiny), false, 'so it is not counted against the connection');

  // The same bytes charged against the longest span they could have taken clear the ceiling,
  // so a link too fast for the clock is still proven.
  const fast = await download([{after: 1, bytes: 16000}, {after: 0, bytes: 4000000}],
                              {windowMs: 1500, rampMs: 0, streams: 1, capBytes: 4700000});
  assert.equal(fast.saturated, true, '4 MB inside a millisecond clears 25 Mb/s at any span');
  assert.equal(fast.bps, probe.DOWN_CEILING_BPS);
  assert.equal(fast.ok, true);
});

d.test('runProbe MUST close the window on its own clock WHEN the stream stalls mid-window', async () => {
  // 10 Mb/s for 760 ms, then a cell that stops answering. The window is 1.5 s, so it holds
  // about 575 kB of data and 1 s of silence: 3 Mb/s. Left to run to the 8 s deadline the same
  // bytes read 575 kb/s, and the window_ms in the file would contradict the one it declares.
  const per = 25000;
  const paced = Array.from({length: 38}, () => ({after: 20, bytes: per}));
  const r = await download([...paced, {stall: true}],
                           {windowMs: 1500, rampMs: 300, streams: 1, capBytes: 4700000});
  assert.ok(r.window_ms <= 1600, `the window closed on its own clock: ${r.window_ms} ms`);
  assert.ok(r.bps > 2.5e6 && r.bps < 4e6, `and the rate is the window's: ${r.bps}`);
  assert.ok(r.ms < 4000, `without waiting out the 8 s deadline: ${r.ms} ms`);
});

d.test('runProbe MUST exclude the chunk that ended the ramp from window_bytes WHEN it crossed before the window opened', async () => {
  // A 500 kB chunk crosses the link over the 105 ms before the window opens, and then 16 kB
  // arrives every 10 ms, which is 12.8 Mb/s. Counting the ramp's last chunk in the window
  // without its time adds 500 kB to a 200 ms window and reports 33 Mb/s.
  const chunks = [{after: 105, bytes: 500000},
                  ...Array.from({length: 60}, () => ({after: 10, bytes: 16000}))];
  const r = await download(chunks, {windowMs: 200, rampMs: 100, streams: 1, capBytes: 4700000});
  assert.ok(r.window_bytes < 400000,
            `the ramp's 500 kB is not in the window: ${r.window_bytes} bytes`);
  assert.ok(r.bps > 10e6 && r.bps < 15e6, `which leaves the paced rate: ${r.bps}`);
});

d.test('runProbe MUST return fail short that countsAsFailure rejects WHEN the body ends inside the ramp', async () => {
  // One chunk inside the ramp, then the body ends: no measurement, so no failure for throughput
  // activities.
  const r = await download([{after: 2, bytes: 200000}], {windowMs: 1500, rampMs: 300, streams: 1});
  assert.equal(r.window_ms, 0);
  assert.equal(r.window_bytes, 0, 'the ramp is not the window');
  assert.equal(r.bytes, 200000, 'the bytes are still recorded');
  assert.equal(r.fail, 'short');
  assert.equal(countsAsFailure(r), false);
});

d.test('runProbe MUST grade within one band of the link WHEN the link runs from 0.4 to 200 Mb/s', async () => {
  // Above the ceiling the reading saturates with a flag; below it the grade falls within one band
  // of the link's true grade.
  for (const mbps of [200, 50, 10, 1.5, 0.4]) {
    const per = Math.max(1, Math.round((mbps * 1e6 / 8) * 0.02));
    const chunks = Math.ceil(probe.DOWN_REQUEST_BYTES / per);
    const r = await download(Array.from({length: chunks}, () => ({after: 20, bytes: per})),
                             {windowMs: 1000, rampMs: 0, streams: 1, capBytes: probe.DOWN_CAP_BYTES});
    assert.ok(r.bps > 0, `${mbps} Mb/s produces a reading`);
    if (mbps * 1e6 > probe.DOWN_CEILING_BPS) {
      assert.equal(r.saturated, true, `${mbps} Mb/s is above the ceiling and is flagged saturated`);
      continue;
    }
    assert.ok(r.bps <= mbps * 1e6 * 1.15,
              `${mbps} Mb/s: read ${(r.bps / 1e6).toFixed(2)} claims more than the link`);
    const band = g.gradeValue('rate', r.bps);
    const truth = g.gradeValue('rate', mbps * 1e6);
    assert.ok(band === truth || g.GRADES.indexOf(band) === g.GRADES.indexOf(truth) + 1,
              `${mbps} Mb/s graded ${band}, the link itself is ${truth}`);
  }
});

d.test('runProbe MUST record when each stream opened, its first byte, its bytes and why it ended WHEN the download runs on several streams', async () => {
  let call = 0;
  globalThis.fetch = async () => {
    await sleep(40 * call++);
    return {ok: true, status: 200, headers: {get: () => null},
            body: stream(Array.from({length: 40}, () => ({after: 10, bytes: 20000})))};
  };
  const r = await probe.runProbe(P.down, {timeoutMs: 3000,
    download: {windowMs: 400, rampMs: 0, streams: 3, capBytes: 1e9}});
  assert.equal(r.per_stream.length, 3);
  assert.ok(r.per_stream[2].headers_ms >= r.per_stream[0].headers_ms + 60,
            `the late stream is visible: ${r.per_stream.map(s => s.headers_ms)}`);
  assert.ok(r.per_stream.every(s => s.first_byte_ms >= s.headers_ms), 'a byte follows its headers');
  assert.equal(r.per_stream.reduce((n, s) => n + s.bytes, 0), r.bytes, 'the streams add up to the round');
  assert.ok(r.per_stream.every(s => ['eof', 'done', 'time'].includes(s.end)), JSON.stringify(r.per_stream));
});

d.test('runProbe MUST record a stream whose request never opened WHEN the other streams carry the download', async () => {
  let call = 0;
  globalThis.fetch = async () => {
    if (call++ === 1) throw netError();
    return {ok: true, status: 200, headers: {get: () => null},
            body: stream(Array.from({length: 40}, () => ({after: 10, bytes: 20000})))};
  };
  const r = await probe.runProbe(P.down, {timeoutMs: 3000,
    download: {windowMs: 300, rampMs: 0, streams: 3, capBytes: 1e9}});
  assert.equal(r.streams, 2);
  assert.deepEqual([r.per_stream[1].headers_ms, r.per_stream[1].end], [null, 'network']);
});

d.test('runProbe MUST end a stream still waiting for headers at the deadline as connect WHEN the other streams deliver', async () => {
  let call = 0;
  globalThis.fetch = async (url, o) => {
    if (call++ === 1) {
      return new Promise((res, rej) => o.signal?.addEventListener('abort',
        () => rej(Object.assign(new Error('x'), {name: 'AbortError'})), {once: true}));
    }
    return {ok: true, status: 200, headers: {get: () => null},
            body: stream(Array.from({length: 200}, () => ({after: 10, bytes: 20000})))};
  };
  const t0 = Date.now();
  const r = await probe.runProbe(P.down, {timeoutMs: 1200,
    download: {windowMs: 5000, rampMs: 0, streams: 3, capBytes: 1e9}});
  assert.ok(Date.now() - t0 < 1800, `the download ends with its budget: ${Date.now() - t0} ms`);
  assert.equal(r.per_stream[1].end, 'connect');
  assert.equal(r.streams, 2);
});

d.test('runProbe MUST return fail connect WHEN no stream has headers by the deadline', async () => {
  globalThis.fetch = (url, o) => new Promise((res, rej) => o.signal?.addEventListener('abort',
        () => rej(Object.assign(new Error('x'), {name: 'AbortError'})), {once: true}));
  const r = await probe.runProbe(P.down, {timeoutMs: 800});
  assert.deepEqual([r.ok, r.fail, r.refused_by], [false, 'connect', undefined]);
  assert.ok(r.per_stream.every(s => s.end === 'connect'), JSON.stringify(r.per_stream));
});

d.test('runProbe MUST read a stream from the moment its headers arrive WHEN the other streams are still opening', async () => {
  let call = 0;
  globalThis.fetch = async () => {
    if (call++ > 0) await sleep(500);
    return {ok: true, status: 200, headers: {get: () => null},
            body: stream(Array.from({length: 100}, () => ({after: 10, bytes: 20000})))};
  };
  const r = await probe.runProbe(P.down, {timeoutMs: 3000,
    download: {windowMs: 800, rampMs: 0, streams: 3, capBytes: 1e9}});
  assert.ok(r.per_stream[0].first_byte_ms < r.per_stream[1].headers_ms,
            `stream 0 read before stream 1 opened: ${JSON.stringify(r.per_stream)}`);
});

d.test('runProbe MUST flag window_cut WHEN the download deadline closes the window, and leave it false WHEN the clock does', async () => {
  const body = () => stream(Array.from({length: 200}, () => ({after: 10, bytes: 20000})));
  globalThis.fetch = async () => ({ok: true, status: 200, headers: {get: () => null}, body: body()});
  const cut = await probe.runProbe(P.down, {timeoutMs: 700,
    download: {windowMs: 1500, rampMs: 300, streams: 1, capBytes: 1e9}});
  assert.equal(cut.window_cut, true, `window ${cut.window_ms} ms`);
  const whole = await probe.runProbe(P.down, {timeoutMs: 3000,
    download: {windowMs: 300, rampMs: 0, streams: 1, capBytes: 1e9}});
  assert.equal(whole.window_cut, false, `window ${whole.window_ms} ms`);
});

d.test('runProbe MUST record headers_ms and status for a stream answering with an HTTP error WHEN its headers arrive', async () => {
  let call = 0;
  globalThis.fetch = async () => (call++ === 2
    ? {ok: false, status: 503, headers: {get: () => null}, body: {cancel: async () => {}}}
    : {ok: true, status: 200, headers: {get: () => null},
       body: stream(Array.from({length: 40}, () => ({after: 10, bytes: 20000})))});
  const r = await probe.runProbe(P.down, {timeoutMs: 3000,
    download: {windowMs: 300, rampMs: 0, streams: 3, capBytes: 1e9}});
  assert.deepEqual([r.per_stream[2].end, r.per_stream[2].status], ['http', 503]);
  assert.ok(r.per_stream[2].headers_ms >= 0, JSON.stringify(r.per_stream[2]));
});

d.test('runProbe MUST check the same host, another host and STUN WHEN a stream still waits for headers 2 s in', async () => {
  stubStun();
  let downCalls = 0;
  globalThis.fetch = async (url, o) => {
    const u = String(url);
    if (u.includes('bytes=') && downCalls++ === 1) {
      return new Promise((res, rej) => o.signal?.addEventListener('abort',
        () => rej(Object.assign(new Error('x'), {name: 'AbortError'})), {once: true}));
    }
    if (u.includes('bytes=')) {
      return {ok: true, status: 200, headers: {get: () => null},
              body: stream(Array.from({length: 400}, () => ({after: 10, bytes: 2000})))};
    }
    return {ok: true, status: 200, type: 'opaque'};
  };
  const r = await probe.runProbe(P.down, {timeoutMs: 3000,
    download: {windowMs: 5000, rampMs: 0, streams: 3, capBytes: 1e9}});
  assert.ok(r.stall_check, 'the check ran');
  assert.deepEqual([r.stall_check.same_host.ok, r.stall_check.other_host.ok, r.stall_check.udp.ok],
                   [true, true, true], JSON.stringify(r.stall_check));
});

d.test('runProbe MUST omit stall_check WHEN every stream has headers within 2 s', async () => {
  const r = await download([{after: 2, bytes: 200000}], {windowMs: 300});
  assert.equal(r.stall_check, undefined);
});

d.test('runProbe MUST record transfer_size and encoded_body_size per stream WHEN the browser filed a timing entry', async () => {
  const saved = performance.getEntriesByName;
  performance.getEntriesByName = name =>
    (String(name).includes('s=1-') ? [{transferSize: 900300, encodedBodySize: 900000}] : []);
  try {
    globalThis.fetch = async () => ({ok: true, status: 200, headers: {get: () => null},
      body: stream(Array.from({length: 40}, () => ({after: 10, bytes: 20000})))});
    const r = await probe.runProbe(P.down, {timeoutMs: 3000,
      download: {windowMs: 300, rampMs: 0, streams: 3, capBytes: 1e9}});
    assert.deepEqual(r.per_stream.map(s => s.transfer_size), [null, 900300, null]);
    assert.equal(r.per_stream[1].encoded_body_size, 900000);
  } finally {
    performance.getEntriesByName = saved;
  }
});

await d.run();

/* ---------------- mobile network events ---------------- */

const n = suite('network events');

async function record(fetchImpl, ms = 500, opts = {}) {
  if (!opts.stun?.keep) stubStun(opts.stun || {});
  globalThis.fetch = fetchImpl;
  const store = fakeStore();
  const notices = [];
  const rec = createRecorder({store, onNotice: x => x && notices.push(x)});
  await rec.start(session());
  if (opts.during) await opts.during(rec, store);
  else await sleep(ms);
  await rec.stop();
  return {rows: store.written.samples.filter(x => !x.skipped), events: store.written.events,
          notices, store};
}

n.test('createRecorder MUST record fail parse with a parse_reason WHEN a captive portal answers for the trace endpoint', async () => {
  const {rows} = await record(async url => String(url).includes('speed.cloudflare')
    ? okResponse()
    : ({ok: true, status: 200, type: 'basic', headers: {get: () => null},
        text: async () => '<html><body>Sign in to WiFi in de trein</body></html>'}), 300);
  const traces = rows.map(x => x.probes.ip6).filter(Boolean);
  assert.ok(traces.length > 0);
  assert.ok(traces.every(x => x.ok === false && x.fail === 'parse'),
            'a plausible-looking body is not accepted for a trace');
  assert.ok(traces.every(x => x.parse_reason), 'and the row carries the parse reason');
});

n.test('createRecorder MUST record fail http with the status WHEN the endpoint answers 429', async () => {
  const {rows} = await record(async () => ({ok: false, status: 429, type: 'basic',
                                            headers: {get: () => null}, text: async () => ''}), 300);
  const ip6 = rows.map(x => x.probes.ip6).filter(Boolean);
  assert.ok(ip6.every(x => x.fail === 'http' && x.status === 429),
            'the status is kept so a busy endpoint is not read as an outage');
});

n.test('createRecorder MUST grade voice red and leave the TCP activities graded WHEN the carrier drops STUN', async () => {
  const {rows} = await record(async () => okResponse(), 400, {stun: {block: true}});
  const settled = rows.filter(x => x.probes.udp);
  assert.ok(settled.length > 0);
  assert.ok(settled.every(x => x.probes.udp.ok === false), 'STUN never completes');
  assert.ok(settled.every(x => x.grades.voice === 'red'), 'calls are red');
  assert.ok(settled.some(x => x.grades.tap !== 'red'), 'while everything over TCP is fine');
});

n.test('looksLikeRetry MUST flag only resolver retry timers WHEN given a range of latencies', () => {
  for (const ms of [2000, 1750, 5000, 5250]) {
    assert.equal(probe.looksLikeRetry(ms), true, `${ms} ms sits on a retry timer`);
  }
  for (const ms of [200, 1500, 2400, 4000, 6000]) {
    assert.equal(probe.looksLikeRetry(ms), false, `${ms} ms does not`);
  }
  const row = {probes: {dns: {ok: true, ms: 2000, retry_suspected: true}}};
  assert.equal(g.gradeActivities(row).news, 'red', 'and a lost first query is red however fast the retry');
});

n.test('createRecorder MUST write a row per round with no rests and unique seqs WHEN every probe fails through an outage and then recovers', async () => {
  let down = false;
  // A tunnel removes the radio, so UDP fails as well.
  globalThis.RTCPeerConnection = class {
    addTransceiver() {} async createOffer() { return {}; }
    async setLocalDescription() {
      if (down) return;
      setTimeout(() => this.onicecandidate?.({candidate: {type: 'srflx', address: '2a09::9'}}), 1);
      setTimeout(() => this.onicecandidate?.({candidate: null}), 3);
    }
    close() {}
  };
  const {rows} = await record(async () => { if (down) throw netError(); return okResponse(); }, 0, {
    stun: {keep: true},
    // Long enough for several rounds: a STUN probe that never answers holds its own
    // deadline, so an outage produces fewer complete rounds than a healthy stretch.
    during: async () => { await sleep(200); down = true; await sleep(2500); down = false; await sleep(1500); }
  });
  const dead = rows.filter(x => PROBE_IDS.every(id => !x.probes[id]?.ok));
  assert.ok(dead.length >= 2, `the outage is in the data as rows, not as a gap: ${dead.length}`);
  assert.ok(dead.every(x => PROBE_IDS.every(id => x.probes[id]?.fail !== 'resting')),
            'and nothing is rested during it, so the failure stays visible');
  // Rows reach the store as their rounds finish, so a slow round can be written after a
  // later quick one. The sequence number carries the order.
  const inOrder = [...rows].sort((a, b) => a.seq - b.seq);
  assert.ok(inOrder.at(-1).probes.ip6?.ok, 'recovery needs no intervention');
  assert.equal(new Set(inOrder.map(x => x.seq)).size, inOrder.length, 'and no round is recorded twice');
});

n.test('createRecorder MUST record one egress-change event WHEN the egress address changes mid-session', async () => {
  let ip = '2a09:bac5::9';
  const {events} = await record(async () => okResponse(trace(ip)), 0, {
    during: async () => { await sleep(250); ip = '77:77::77'; await sleep(400); }
  });
  const logged = events.filter(e => /egress address changed/.test(e.text || ''));
  assert.equal(logged.length, 1, `one event, not one per round: ${logged.length}`);
});

n.test('createRecorder MUST record both colo values and keep grading WHEN the PoP changes mid-session', async () => {
  let colo = 'AMS';
  const {rows} = await record(async () => okResponse(trace('2a09:bac5::9', colo)), 0, {
    during: async () => { await sleep(250); colo = 'FRA'; await sleep(300); }
  });
  const seen = new Set(rows.map(x => x.probes.ip6?.colo).filter(Boolean));
  assert.deepEqual([...seen].sort(), ['AMS', 'FRA'], 'both PoPs are on the rows');
  assert.ok(rows.every(x => x.grades), 'and a routing change is not graded as a fault');
});

n.test('createRecorder MUST record a skip event naming what the running round waits on WHEN a slot comes due mid-round', async () => {
  // Every request takes 200 ms against an 80 ms interval, so every round outlasts its slot.
  const {rows, events} = await record(async () => { await sleep(200); return okResponse(); }, 1400);
  const skips = events.filter(e => e.type === 'skip');
  assert.ok(skips.length > 0, 'a slot came due mid-round');
  assert.ok(skips.some(e => e.waiting_on.length > 0), JSON.stringify(skips.map(e => e.waiting_on)));
  assert.ok(skips.every(e => e.waiting_on.every(id => PROBE_IDS.includes(id) || id === 'loaded_rtt')),
            'and names only what a round runs');
  assert.ok(rows.every(x => x.grades), 'the rounds that ran are graded');
});

n.test('countsAsFailure MUST return true for network reasons and false for resting, expected and unsupported WHEN given each failure reason', () => {
  const network = ['timeout', 'network', 'http', 'parse', 'abort', 'stalled', 'empty', 'no_srflx'];
  const notNetwork = ['resting'];
  for (const fail of network) {
    assert.equal(countsAsFailure({ok: false, fail}), true, `${fail} is a failure`);
  }
  for (const fail of notNetwork) {
    assert.equal(countsAsFailure({ok: false, fail}), false, `${fail} is not`);
  }
  assert.equal(countsAsFailure({ok: false, fail: 'network', expected: true}), false,
               'a known-absent path is not an outage');
  assert.equal(countsAsFailure({ok: true}), false);
  assert.equal(countsAsFailure(undefined), false, 'a probe that produced no row at all');
  assert.equal(countsAsFailure({ok: false, fail: 'unsupported', expected: true}), false,
               'a browser without the API is a missing activity, not an outage');
});

// The UDP probe is the only one that is not a fetch, so each outcome is produced explicitly
// here. A carrier blocking STUN, a symmetric NAT and a browser without WebRTC are
// indistinguishable from the outside and are recorded differently.
n.test('runProbe MUST return unsupported, network, no_srflx or timeout WHEN the UDP path fails in each distinct way', async () => {
  const stun = impl => { globalThis.RTCPeerConnection = impl; return probe.runProbe(P.udp, {timeoutMs: 300}); };
  const gathering = candidates => class {
    addTransceiver() {} async createOffer() { return {}; }
    async setLocalDescription() {
      candidates.forEach((c, i) => setTimeout(() => this.onicecandidate?.({candidate: c}), i + 1));
      setTimeout(() => this.onicecandidate?.({candidate: null}), candidates.length + 2);
    }
    close() { globalThis.__closed = (globalThis.__closed || 0) + 1; }
  };

  globalThis.__closed = 0;
  const absent = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = undefined;
  const none = await probe.runProbe(P.udp, {timeoutMs: 300});
  assert.deepEqual([none.fail, none.expected], ['unsupported', true],
                   'no WebRTC at all is flagged the way an absent IPv4 path is');
  globalThis.RTCPeerConnection = absent;

  const refused = await stun(class {
    addTransceiver() {} async createOffer() { throw new Error('no media'); }
    async setLocalDescription() {} close() {}
  });
  assert.equal(refused.fail, 'network');
  assert.equal(refused.parse_reason, 'no media', 'and why it refused is kept');

  const symmetric = await stun(gathering([{type: 'host', address: '192.168.1.5'}]));
  assert.deepEqual([symmetric.fail, symmetric.candidates], ['no_srflx', 1],
                   'candidates gathered but none reflexive: the packet never reached the server');
  assert.notEqual(symmetric.expected, true, 'which is a real failure of the UDP path');

  const blocked = await stun(class {
    addTransceiver() {} async createOffer() { return {}; }
    async setLocalDescription() {} close() { globalThis.__closed++; }
  });
  assert.equal(blocked.fail, 'timeout', 'a carrier dropping STUN never answers at all');

  const dual = await stun(gathering([{type: 'srflx', address: '2a09::9'},
                                     {type: 'srflx', address: '77.1.2.3'}]));
  assert.deepEqual(dual.public_ips, ['2a09::9', '77.1.2.3'],
                   'a dual-stack network maps one address per family and both are kept');
  assert.ok(globalThis.__closed > 0, 'and every peer connection is closed again');
});

await n.run();

/* ---------------- one recorder across several sessions ---------------- */

const l = suite('session lifecycle');

l.test('createRecorder MUST number from zero and carry over no rest, pause or position WHEN a second session starts on the same recorder', async () => {
  stubStun();
  let wedged = true;
  globalThis.fetch = async url => {
    if (String(url).includes('gstatic') && wedged) throw netError();
    return okResponse();
  };
  const store = fakeStore();
  const rec = createRecorder({store});

  // First journey: long enough for the web probe to be marked stuck and rested.
  await rec.start(session());
  await sleep(700);
  await rec.stop();
  const first = store.written.samples.filter(x => !x.skipped);
  assert.ok(first.some(x => x.probes.web?.fail === 'resting'), 'the first journey rested it');

  // Second journey on a healthy network with the same recorder: rests keyed by round number in
  // the first journey must not carry over.
  wedged = false;
  store.written.samples.length = 0;
  await rec.start({...session(), id: 's2'});
  await sleep(400);
  await rec.stop();
  const second = store.written.samples.filter(x => !x.skipped);

  assert.ok(second.length > 0, 'the second journey recorded');
  assert.equal(second[0].seq, 0, 'and numbers its rounds from zero');
  assert.ok(second.every(x => x.probes.web?.fail !== 'resting'),
            'with nothing carried over from the last one');
  assert.ok(second.every(x => x.sessionId === 's2'), 'and every row belongs to it');
  assert.ok(second.every(x => x.in_pause === false), 'a pause from the last journey is not still on');
  assert.ok(second.every(x => x.speed_derived == null),
            'nor a position from a journey that ended somewhere else');
});

l.test('createRecorder MUST record late_ms 0 on the first round and log no pause WHEN start-up is slow', async () => {
  stubStun();
  globalThis.fetch = async () => { await sleep(30); return okResponse(); };
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session());
  await sleep(300);
  await rec.stop();
  const rows = [...store.written.samples].sort((a, b) => a.seq - b.seq);
  assert.equal(rows[0].late_ms, 0,
               `start-up cost is not scheduling lateness: ${rows[0].late_ms} ms`);
  assert.ok(rows.every(x => x.late_ms >= 0), 'and lateness is never negative');
  assert.equal(store.written.events.filter(e => e.type === 'pause').length, 0,
               'a slow radio at start does not log a pause that never happened');
});

l.test('createRecorder MUST continue the seq, the monotonic clock and the spend WHEN a session resumes after a reload', async () => {
  stubStun();
  globalThis.fetch = async () => okResponse();
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session(), {resumeSeq: 41, monoBase: 60000,
                              spent: {bytes: 1234, downloadBytes: 5e6}, resumedGapMs: 30000});
  await sleep(250);
  const st = rec.status();
  await rec.stop();
  const rows = [...store.written.samples].sort((a, b) => a.seq - b.seq);

  assert.equal(rows[0].seq, 41, 'the sequence carries on from the stored rows');
  assert.ok(rows[0].mono >= 60000, 'and so does the monotonic clock, bridged across the gap');
  assert.ok(st.bytes > 1234, 'the estimate continues from what was already spent');
  assert.ok(st.downloadMB >= 5, `and so does the figure on screen: ${st.downloadMB} MB`);
  assert.ok(store.written.events.some(e => e.type === 'pause' && /bridged across reload/.test(e.text)),
            'the gap the reload cost is written down, not left to be inferred');
});

l.test('createRecorder.stop MUST leave the store unchanged WHEN called before start or called twice', async () => {
  stubStun();
  globalThis.fetch = async () => okResponse();
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.stop();
  assert.equal(rec.status().running, false, 'stopping before starting is not an error');
  await rec.start(session());
  await sleep(200);
  await rec.stop();
  const after = store.written.samples.length;
  await rec.stop();
  assert.equal(store.written.samples.length, after, 'and a second stop writes no further rows');
  assert.equal(rec.status().running, false);
  rec.mark();
  assert.equal(store.written.events.filter(e => e.type === 'mark').length, 0,
               'a mark after the journey ended belongs to no journey');
});

l.test('createRecorder MUST keep mono monotonic and late_ms small WHEN the wall clock jumps backwards', async () => {
  stubStun();
  globalThis.fetch = async () => okResponse();
  const store = fakeStore();
  const rec = createRecorder({store});
  const realNow = Date.now;
  await rec.start(session());
  await sleep(200);
  // The radio reattaches and the OS corrects the wall clock back by a minute. Both clocks
  // are on every row, so the correction is visible in the data.
  Date.now = () => realNow() - 60000;
  await sleep(300);
  Date.now = realNow;
  await rec.stop();

  const rows = [...store.written.samples].sort((a, b) => a.seq - b.seq);
  assert.ok(rows.length > 3, `enough rounds either side of the jump: ${rows.length}`);
  const monos = rows.map(x => x.mono);
  assert.deepEqual(monos, [...monos].sort((a, b) => a - b),
                   'the monotonic clock never goes backwards, whatever the wall clock does');
  assert.ok(rows.some(x => x.t < rows[0].t), 'the jump itself is on the rows, not smoothed away');
  assert.ok(rows.every(x => x.late_ms < 1000),
            'and lateness is measured on the monotonic clock, so a jump is not a freeze');
  assert.equal(store.written.events.filter(e => e.type === 'pause').length, 0,
               'nor is it logged as one');
});

await l.run();

/* ---------------- the rollup on degenerate sessions ---------------- */

const e = suite('rollup edges');

e.test('summarise MUST return ran 0 and null percentiles WHEN given no rows', () => {
  const s = summarise([]);
  assert.equal(s.ran, 0);
  assert.ok(Object.values(s.probes).every(p => p.ms_p50 == null),
            'no rounds means no percentiles, not zeros');
});

e.test('summarise MUST count every round degraded with null percentiles WHEN every probe failed', () => {
  const rows = Array.from({length: 5}, (_, seq) => ({
    seq, skipped: null, round_error: null,
    probes: Object.fromEntries(PROBE_IDS.map(id => [id, {ok: false, fail: 'timeout', ms: 8000}]))
  }));
  const s = summarise(rows);
  assert.equal(s.ran, 5);
  assert.equal(s.degraded, 5);
  assert.equal(s.probes.ip6.fails.timeout, 5);
  assert.equal(s.probes.ip6.ms_p50, null, 'a median of failures is not a latency');
  assert.equal(s.probes.down.bps_p50, null, 'nor is a median of failures a rate');
});

e.test('summarise MUST return ran 0 and degraded 0 WHEN every row is skipped', () => {
  const rows = Array.from({length: 4}, (_, seq) => ({seq, skipped: 'overlap', probes: {}}));
  const s = summarise(rows);
  assert.equal(s.ran, 0);
  assert.equal(s.skipped, 4);
  assert.equal(s.degraded, 0, 'a round that never ran cannot have degraded');
});

await e.run();

/* ---------------- storage closing mid-session ---------------- */

const st = suite('storage edges');

// A minimal IndexedDB: enough for store.js to open a database, run a transaction and be told
// the connection has closed, which is what iOS does when a tab is backgrounded under storage
// pressure.
function fakeIndexedDB() {
  const state = {opens: 0, closed: false, puts: [], connections: []};
  const later = fn => setTimeout(fn, 0);
  const makeDb = () => {
    const db = {
      objectStoreNames: {contains: () => true},
      createObjectStore: () => ({createIndex() {}}),
      onclose: null, onversionchange: null,
      close() { this.closed = true; },
      closed: false,
      transaction() {
        if (db.closed) throw Object.assign(new Error('closed'), {name: 'InvalidStateError'});
        const t = {oncomplete: null, onerror: null, onabort: null,
                   objectStore: () => ({
                     put: row => state.puts.push(row),
                     get: () => { const req = {}; later(() => req.onsuccess?.()); return req; },
                     index: () => ({getAll: () => { const req = {result: []}; later(() => req.onsuccess?.()); return req; }})
                   })};
        later(() => t.oncomplete?.());
        return t;
      }
    };
    state.connections.push(db);
    return db;
  };
  return {
    state,
    open() {
      state.opens++;
      const req = {};
      later(() => { req.result = makeDb(); req.onsuccess?.(); });
      return req;
    }
  };
}

st.test('putSamples MUST reopen the database and write the row WHEN the system closed the connection', async () => {
  const idb = fakeIndexedDB();
  Object.defineProperty(globalThis, 'indexedDB', {value: idb, configurable: true});
  const store = await import(`../js/store.js?closed=${Date.now()}`);

  await store.putSamples([{sessionId: 'a', seq: 0}]);
  assert.equal(idb.state.opens, 1, 'one connection serves the session');
  assert.equal(idb.state.puts.length, 1);

  // Closed while the tab is in the background; the next write finds out by throwing.
  idb.state.connections.at(-1).closed = true;
  await store.putSamples([{sessionId: 'a', seq: 1}]);
  assert.equal(idb.state.opens, 2, 'the closed connection is replaced');
  assert.equal(idb.state.puts.length, 2, 'and the round that found it closed is still written');

  // The close event announces it before any write fails.
  idb.state.connections.at(-1).onclose?.();
  await store.putSamples([{sessionId: 'a', seq: 2}]);
  assert.equal(idb.state.opens, 3);
  assert.equal(idb.state.puts.length, 3, 'every row is written either way');
});

st.test('putSamples MUST reject with the open error and open a fresh connection on the next call WHEN the database refuses to open', async () => {
  let failing = true;
  const idb = {
    open() {
      const req = {};
      setTimeout(() => {
        if (failing) { req.error = new Error('quota'); req.onerror?.(); }
        else {
          req.result = {objectStoreNames: {contains: () => true}, close() {},
                        transaction: () => { const t = {objectStore: () => ({put() {}})};
                                             setTimeout(() => t.oncomplete?.(), 0); return t; }};
          req.onsuccess?.();
        }
      }, 0);
      return req;
    }
  };
  Object.defineProperty(globalThis, 'indexedDB', {value: idb, configurable: true});
  const store = await import(`../js/store.js?refused=${Date.now()}`);

  await assert.rejects(() => store.putSamples([{sessionId: 'a', seq: 0}]), /quota/,
                       'the caller is told, so the rows stay in memory and are retried');
  // A rejected open is not cached, so the next attempt can succeed.
  failing = false;
  await assert.doesNotReject(() => store.putSamples([{sessionId: 'a', seq: 0}]),
                             'a later attempt opens a fresh connection');
});

await st.run();

/* ---------------- the exported file, with hostile input ---------------- */

const x = suite('export edges');

const {filename, sessionJson} = await import('../js/export.js');
const meta = over => ({id: 'a', name: 'x', operator: 'KPN', connection: 'cellular',
                       started: Date.parse('2026-09-03T06:14:00Z'), stopped: null,
                       intervalMs: 10000, ...over});

x.test('filename MUST return a name free of path and wildcard characters WHEN the operator field carries them', () => {
  const cases = {
    ['x'.repeat(200)]: 'x'.repeat(40),
    'KPN': 'kpn',
    'KPN / Odido': 'kpn-odido',
    'Ödido — 5G': 'dido-5g',
    '../../etc/passwd': 'etc-passwd',
    'a\\b:c*d?e"f<g>h|i': 'a-b-c-d-e-f-g-h-i',
    '   ': 'session',
    '📶': 'session'
  };
  for (const [operator, expected] of Object.entries(cases)) {
    const name = filename(meta({operator}));
    assert.equal(name, `wts-20260903-0814-${expected}.json`, `operator ${JSON.stringify(operator)}`);
    assert.ok(!/[/\\:*?"<>|]/.test(name.slice(4)), `${name} has no path or wildcard characters`);
  }
  assert.match(filename(meta({operator: '', connection: 'wifi'})), /-wifi\.json$/,
               'on Wi-Fi there is no operator, so the connection names the file');
  assert.doesNotMatch(filename(meta({started: NaN})), /NaN/,
                      'an unreadable start time still produces a usable name');
});

x.test('sessionJson MUST round-trip quotes, newlines, markup and emoji WHEN they appear in the name, note and events', () => {
  const session = meta({name: 'quote " comma , newline \n tab \t backslash \\ unicode ⏱',
                        note: '</script><script>alert(1)</script>'});
  const events = [{sessionId: 'a', t: 1, mono: 1, type: 'note', lat: null, lon: null,
                   text: 'emoji 🚆 and a "quote"'},
                  {sessionId: 'a', t: 2, mono: 2, type: 'label', lat: null, lon: null, text: 'slow'}];
  const text = sessionJson(session, [], events);
  const back = JSON.parse(text);
  assert.equal(back.session.name, session.name, 'the name round-trips exactly');
  assert.equal(back.session.note, session.note, 'and so does anything that looks like markup');
  assert.equal(back.events[0].text, events[0].text);
  assert.equal(back.events.length, 2, 'and every event is in the file as recorded');
});

x.test('sessionJson MUST return a file carrying the probe set and the app version WHEN the session has no rows', () => {
  const back = JSON.parse(sessionJson(meta(), [], []));
  assert.equal(back.format, 'wts/session');
  assert.equal(back.summary.ran, 0);
  assert.deepEqual(back.samples, []);
  assert.ok(back.probes.length > 0, 'the probe configuration is present with no rows measured');
  assert.ok(back.app_version, 'and the version that would have measured it');
});

await x.run();

/* ---------------- the readout ---------------- */

const h = suite('readout edges');

h.test('gradeActivities MUST grade streaming from the rate of that row alone WHEN consecutive rows differ', () => {
  // Colour and number both come from the same round. Smoothing the colour over three rounds
  // while printing the current number paints a round measured at 35.5 Mb/s red because a
  // round three back was slow.
  const rows = [3.4e6, 3.2e6, 33.6e6, 1.1e6, 35.5e6, 12.0e6, 9.2e6, 48.5e6].map((bps, seq) => ({
    seq, skipped: null, probes: {down: {ok: true, bps}}
  }));
  for (const row of rows) {
    const grades = g.gradeActivities(row);
    assert.equal(grades.streaming, g.gradeValue('rate', g.activityValue('streaming', row)),
                 `${(row.probes.down.bps / 1e6).toFixed(1)} Mb/s: the colour is this ` +
                 `round's, taken from the number that produced it`);
  }
  assert.equal(g.gradeActivities(rows[4]).streaming, 'green', '35.5 Mb/s is green, whatever came before it');
  assert.equal(g.gradeActivities(rows[3]).streaming, 'red', 'and 1.1 Mb/s is red, whatever came after');
});

h.test('classify MUST return the worst activity grade gradeActivities produced WHEN given the same row', async () => {
  const ui = await import('../js/ui.js');
  // Each activity takes the worst of its own terms and the log line takes the worst activity,
  // so the two cannot describe different rounds.
  const rows = [
    {probes: {ip6: {ok: true, ms: 30}, web: {ok: true, ms: 30}, dns: {ok: true, ms: 30},
              down: {ok: true, bps: 50e6}}},
    {probes: {ip6: {ok: true, ms: 30}, web: {ok: true, ms: 30}, dns: {ok: true, ms: 2500},
              down: {ok: true, bps: 50e6}}},
    {probes: {ip6: {ok: false, fail: 'timeout'}, web: {ok: true, ms: 30}, dns: {ok: true, ms: 30},
              down: {ok: true, bps: 50e6}}}
  ];
  for (const row of rows) {
    const grades = g.gradeActivities(row);
    let worst = null;
    for (const scale of g.ACTIVITY_IDS) worst = g.worse(worst, grades[scale]);
    assert.equal(ui.classify(row), worst,
                 `the bar is the worst activity: ${JSON.stringify(grades)}`);
  }
});

h.test('gradeActivities MUST return null for a skipped round and a null grade per activity WHEN the round has no probe results', () => {
  assert.equal(g.gradeActivities({skipped: 'overlap', probes: {}}), null);
  const empty = g.gradeActivities({probes: {}});
  assert.ok(g.ACTIVITY_IDS.every(c => empty[c] === null),
            'and a round with no probe results grades nothing');
});

await h.run();

/* ---------------- helpers that need geolocation ---------------- */

function fix(lat, lon, accuracy, t = Date.now(), speed = null) {
  return {coords: {latitude: lat, longitude: lon, accuracy, speed, heading: null}, timestamp: t};
}

async function withFixes(fixes) {
  let watcher;
  const nav = {userAgent: 'node-test', language: 'en',
               geolocation: {watchPosition: cb => { watcher = cb; return 1; }, clearWatch() {}}};
  Object.defineProperty(globalThis, 'navigator', {value: nav, configurable: true});
  stubStun();
  globalThis.fetch = async () => okResponse();
  const store = fakeStore();
  const rec = createRecorder({store});
  await rec.start(session());
  for (const f of fixes) { watcher(f); await sleep(150); }
  await rec.stop();
  stubBrowser();
  return store.written.samples.filter(x => !x.skipped);
}
