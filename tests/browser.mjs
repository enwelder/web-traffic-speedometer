// End-to-end tests in a real browser: the parts that only exist there — IndexedDB
// persistence, crash recovery, the service worker, downloads, and the layout on a phone.
import assert from 'node:assert';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {suite} from './helpers.mjs';

const PORT = 8799;
// ?interval shortens the round; the app only honours it on localhost.
const BASE = `http://127.0.0.1:${PORT}/?interval=2000`;
const PLAIN = `http://127.0.0.1:${PORT}/`;   // real profile intervals, for the cost projection
const root = new URL('..', import.meta.url).pathname;

// Bound explicitly to the loopback address: binding every interface is refused in some
// sandboxes, and the app only honours the interval override on a loopback host anyway.
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
                     {cwd: root, stdio: 'ignore'});
const stop = () => { try { server.kill(); } catch { /* already gone */ } };
process.on('exit', stop);
await new Promise(r => setTimeout(r, 800));

// CI installs Playwright's pinned Chromium. On a developer machine that download may be
// missing, so fall back to an installed Chrome rather than failing with a download hint.
const browser = await (async () => {
  if (process.env.PW_CHANNEL) return chromium.launch({channel: process.env.PW_CHANNEL});
  try {
    return await chromium.launch();
  } catch {
    console.log('  ..    bundled chromium missing, falling back to installed Chrome');
    return chromium.launch({channel: 'chrome'});
  }
})();

// A network that behaves like the one under investigation: IPv6 only.
async function context(extra = {}) {
  const ctx = await browser.newContext({
    viewport: {width: 393, height: 852}, deviceScaleFactor: 2,
    permissions: ['geolocation'], geolocation: {latitude: 51.9244, longitude: 4.4777, accuracy: 12},
    ...extra
  });
  const state = {mode: 'ok'};
  await ctx.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
    if (u.hostname === '1.1.1.1') return route.abort('connectionfailed');
    if (state.mode === 'fail') return route.abort('connectionfailed');
    if (u.hostname === 'speed.cloudflare.com') return route.fulfill({
      status: 200, body: Buffer.alloc(Number(u.searchParams.get('bytes')) || 250000),
      headers: {'access-control-allow-origin': '*', 'timing-allow-origin': '*',
                'access-control-expose-headers': 'server-timing, cf-meta-colo',
                'cf-meta-colo': 'AMS',
                'server-timing': 'cfL4;desc="?rtt=6212&min_rtt=6209&lost=0&retrans=2&cwnd=53"'}
    });
    if (u.hostname.endsWith('.github.io') || u.hostname === 'www.gstatic.com')
      return route.fulfill({status: 204, body: ''});
    return route.fulfill({status: 200, contentType: 'text/plain',
      headers: {'access-control-allow-origin': '*'},
      body: 'fl=1\nip=2a09:bac5::9\nts=1\ncolo=AMS\n'});
  });
  // Playwright routes cannot intercept STUN, since it is not a fetch. Stubbing the peer
  // connection keeps the suite hermetic and lets the UDP path be failed on demand.
  await ctx.addInitScript(() => {
    window.RTCPeerConnection = class {
      addTransceiver(kind, opts) { window.__wtsTransceiver = {kind, ...opts}; }
      async createOffer() { return {type: 'offer', sdp: 'v=0'}; }
      async setLocalDescription() {
        if (window.__wtsUdpBlocked) return;
        setTimeout(() => this.onicecandidate?.({candidate: {type: 'srflx', address: '2a09:bac5::9'}}), 5);
        setTimeout(() => this.onicecandidate?.({candidate: null}), 10);
      }
      close() { window.__wtsClosed = (window.__wtsClosed || 0) + 1; }
    };
  });
  return {ctx, state};
}

const readDb = page => page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const q = indexedDB.open('wts');
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
  const read = s => new Promise((res, rej) => {
    const q = db.transaction(s).objectStore(s).getAll();
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
  return {sessions: await read('sessions'), samples: await read('samples'), events: await read('events')};
});

const b = suite('browser');

b.test('the tiles are named for where they go', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  // The screen answers what you can do, not which endpoint answered: a probe's number means
  // nothing until it is held against a threshold that belongs to it.
  const names = await page.$$eval('.signal .name', els => els.map(e => e.textContent.trim()));
  assert.deepEqual(names, ['calls & real-time', 'tapping a link', 'opening a new site',
                           'video & downloads'],
                   `capabilities, not probes: ${names.join(' | ')}`);
  assert.equal(await page.locator('#m-udp').count(), 0, 'no probe readings among the counters');
  await ctx.close();
});

b.test('the page loads clean, and the setup asks only what it cannot know', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  // The DNS probe deliberately draws 404s; only script errors matter.
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE, {waitUntil: 'networkidle'});
  assert.deepEqual(errors, []);
  assert.equal(await page.title(), 'Web Traffic Speedometer');
  for (const gone of ['#f-route', '#f-name', '#f-adaptive', '#f-interval', '#f-download']) {
    assert.equal(await page.locator(gone).count(), 0, `${gone} is derived, not asked for`);
  }
  await page.selectOption('#f-connection', 'wifi');
  assert.equal(await page.locator('#row-operator').isHidden(), true, 'no operator asked for on Wi-Fi');
  await page.selectOption('#f-connection', 'cellular');
  await ctx.close();
});

b.test('the projection says where the cost goes and when the speed probe stops', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  await page.goto(PLAIN, {waitUntil: 'networkidle'});
  const read = () => page.$eval('#budget', e => e.textContent);
  await page.selectOption('#f-profile', 'coarse');
  const coarse = await read();
  await page.selectOption('#f-profile', 'fine');
  const fine = await read();

  // A time-boxed download reaches its ceiling every round on a fast link, so the cap decides
  // the total and the interval decides how much of the journey gets throughput data.
  const mb = t => Number(t.match(/≈ (\d+) MB/)[1]);
  assert.ok(Math.abs(mb(fine) - mb(coarse)) < 20,
            `both land near the cap: ${mb(coarse)} and ${mb(fine)} MB`);
  const minutes = t => Number(t.match(/about (\d+) minutes/)[1]);
  assert.ok(minutes(coarse) > minutes(fine) * 1.8,
            `and the coarse profile keeps measuring longer: ${minutes(fine)} vs ${minutes(coarse)} min`);
  assert.match(fine, /speed probe stops/, 'and it says so before Start rather than mid-journey');
  await ctx.close();
});

b.test('a session records, survives a reload, and exports losslessly', async () => {
  const {ctx, state} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  await page.selectOption('#f-operator', 'Odido');
  await page.click('#btn-start');
  await page.waitForTimeout(3000);
  assert.match(await page.textContent('#sub-realtime'), /v4 n\/a/, 'an absent IPv4 path is not a failure');
  assert.match(await page.textContent('#sub-newsite'), /known host/, 'the cached control shares the row');
  await page.click('#btn-mark');

  // Hysteresis: the window has to agree with itself before the screen repaints, so one bad
  // round does not flash red on a moving train.
  const red = () => page.$eval('#cap-realtime', e => e.classList.contains('red'));
  state.mode = 'fail';
  await page.waitForTimeout(2600);
  assert.equal(await red(), false, 'a single failing round does not repaint the screen');
  await page.waitForTimeout(9000);
  assert.equal(await red(), true, 'sustained failure does');
  state.mode = 'ok';
  await page.waitForTimeout(2500);

  let db = await readDb(page);
  const session = db.sessions[0];
  assert.match(session.name, /^Odido · \d+ \w{3} \d{2}:\d{2}$/, `name generated: ${session.name}`);
  assert.equal(session.ipv4_available, false);
  assert.ok(session.ipv4_check.fail, 'with the evidence kept');
  assert.ok(db.samples.every(x => x.probes.ip4.expected === true), 'every ip4 failure is flagged');
  assert.ok(db.samples.every(x => x.probes.down), 'every round carries a download');
  // Rounds where the probe rested to clear a wedged connection have no hostname to compare.
  const hosts = db.samples.map(x => x.probes.dns?.host).filter(Boolean);
  assert.ok(hosts.length >= 3, `enough lookups to check: ${hosts.length}`);
  assert.equal(new Set(hosts).size, hosts.length, 'the DNS probe never repeats a hostname');

  const udp = db.samples.map(x => x.probes.udp).filter(u => u.ok);
  assert.ok(udp.length > 0, 'the UDP path is probed every round');
  assert.ok(udp.every(u => u.public_ips.includes('2a09:bac5::9')), 'and reports its NAT mapping');
  // All four latency probes are sampled the same way, so their medians are comparable.
  for (const id of ['ip6', 'web', 'dns_ctl', 'udp']) {
    const sampled = db.samples.filter(x => x.probes[id]?.ms_samples);
    assert.ok(sampled.length >= 3, `${id} is sampled, not measured once`);
    assert.ok(sampled.filter(x => x.probes[id].ok)
                     .every(x => x.probes[id].samples_ok >= 1 && x.probes[id].ms_min != null),
              `${id} keeps the spread beside the median`);
  }
  assert.ok(db.samples.every(x => x.grades), 'every round carries the grades it was shown with');
  assert.ok(db.samples.every(x => 'first_packet_ms' in x), 'and the radio wake-up cost');
  const ctlHosts = new Set(db.samples.map(x => x.probes.dns_ctl?.host).filter(Boolean));
  assert.equal(ctlHosts.size, 1, `the control never changes its hostname: ${[...ctlHosts]}`);

  const before = db.samples.length;
  const lastSeq = Math.max(...db.samples.map(x => x.seq));
  await page.reload({waitUntil: 'networkidle'});
  await page.waitForSelector('#recover:not([hidden])');
  assert.match(await page.textContent('#recover-text'), /never closed/, 'recovery is offered, never silent');
  await page.click('#recover-resume');
  await page.waitForTimeout(2500);

  db = await readDb(page);
  assert.ok(db.samples.length > before, 'recording continues');
  const seqs = db.samples.map(x => x.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, seqs.map((_, i) => i), 'seq stays contiguous across the reload');
  assert.ok(Math.max(...seqs) > lastSeq);
  assert.equal(db.events.filter(e => e.type === 'pause' && /reload/.test(e.text)).length, 1,
               'the reload gap is bridged and recorded');

  await page.click('#btn-start');
  await page.waitForTimeout(700);
  await page.click('nav button[data-view="sessions"]');
  await page.waitForTimeout(400);
  assert.deepEqual(await page.locator('#session-list button').allTextContents(),
                   ['Export', 'Rename', 'Note', 'Delete'], 'one export button, one file');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#session-list button:has-text("Export")')
  ]);
  assert.match(download.suggestedFilename(), /^wts-\d{8}-\d{4}-odido\.json$/, download.suggestedFilename());
  const file = JSON.parse(readFileSync(await download.path(), 'utf8'));
  db = await readDb(page);
  assert.equal(file.format, 'wts/session');
  assert.equal(file.samples.length, db.samples.length, 'every stored round is in the file');
  assert.equal(file.events.length, db.events.length);
  assert.equal(file.probes.length, 7, 'the probe set travels with the data');
  assert.ok(file.summary, 'and a rollup so a reader need not recompute the basics');
  assert.equal(file.summary.rounds, file.samples.length);
  assert.ok(file.summary.probes.ip6, 'per probe');
  assert.ok(db.sessions[0].exportedAt, 'and the export is recorded on the session');
  await ctx.close();
});

b.test('the shell and the recorded sessions survive with no network at all', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  await page.click('#btn-start');
  await page.waitForTimeout(2500);
  await page.click('#btn-start');
  await page.waitForTimeout(600);
  await page.evaluate(() => navigator.serviceWorker.ready);

  await ctx.setOffline(true);
  await page.reload({waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(1200);
  assert.match(await page.textContent('h1'), /^Web Traffic Speedometer/, 'the shell loads offline');
  await page.click('nav button[data-view="sessions"]');
  await page.waitForTimeout(500);
  assert.match(await page.textContent('#session-list'), /not exported/,
               'and the sessions are readable, and flagged');
  await ctx.setOffline(false);
  await ctx.close();
});

b.test('the content security policy blocks nothing the probes need', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  const blocked = [];
  page.on('console', m => { if (/Content Security Policy|Refused to/.test(m.text())) blocked.push(m.text()); });
  await page.goto(BASE, {waitUntil: 'networkidle'});
  await page.click('#btn-start');
  await page.waitForTimeout(3000);
  await page.click('#btn-start');
  await page.waitForTimeout(500);
  assert.deepEqual(blocked, [], 'no probe is refused by the policy');
  const db = await readDb(page);
  const last = db.samples.at(-1).probes;
  for (const id of ['ip6', 'dns', 'dns_ctl', 'web', 'down', 'udp']) {
    assert.equal(last[id].ok, true, `${id} reached its endpoint under the policy`);
  }
  await ctx.close();
});

b.test('the newest log line is on top and nothing hides behind the controls', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  await page.click('#btn-start');
  await page.waitForTimeout(7000);

  // Newest first: appending put the line that matters at the bottom, under the controls.
  const times = await page.$$eval('#log div', els => els.map(e => e.textContent.slice(0, 8)));
  const stamps = times.filter(t => /^\d\d:\d\d:\d\d$/.test(t));
  assert.ok(stamps.length >= 2, 'several lines are logged');
  assert.ok(stamps[0] >= stamps[stamps.length - 1], `newest is first: ${stamps[0]} then ${stamps.at(-1)}`);

  // The bar sits outside the scrolling area, which is what makes an overlap impossible
  // rather than something to keep re-checking after every layout change. Measuring the log
  // lines instead would report the ones main has already clipped.
  const box = await page.evaluate(() => {
    const r = s => document.querySelector(s).getBoundingClientRect();
    const m = r('main'), bar = r('.controls');
    return {mainBottom: Math.round(m.bottom), barTop: Math.round(bar.top),
            scrolls: getComputedStyle(document.querySelector('main')).overflowY};
  });
  assert.equal(box.scrolls, 'auto', 'the content area is the thing that scrolls');
  assert.ok(box.barTop >= box.mainBottom - 1,
            `the bar starts where the scroll area ends: bar ${box.barTop}, content ends ${box.mainBottom}`);
  await page.click('#btn-start');
  await ctx.close();
});

b.test('the label buttons record what it felt like', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  assert.equal(await page.locator('#labels').isHidden(), true, 'nothing to label before a run');
  await page.click('#btn-start');
  await page.waitForTimeout(3000);
  assert.equal(await page.locator('#labels').isHidden(), false);

  await page.click('#labels button[data-label="slow"]');
  await page.click('#labels button[data-label="broken"]');
  await page.waitForTimeout(600);
  await page.click('#btn-start');
  await page.waitForTimeout(600);

  const db = await readDb(page);
  const labels = db.events.filter(e => e.type === 'label').map(e => e.text);
  assert.deepEqual(labels, ['slow', 'broken'], 'each tap is its own event');
  assert.ok(db.events.filter(e => e.type === 'label').every(e => e.t && e.mono != null),
            'timestamped on both clocks, so it lines up with the rounds');
  await ctx.close();
});

b.test('the lamps report each path without a sentence to read', async () => {
  const {ctx, state} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  await page.click('#btn-start');
  await page.waitForTimeout(5000);

  const lamps = () => page.$$eval('.lamp', els =>
    Object.fromEntries(els.map(e => [e.textContent, e.className.replace('lamp ', '')])));
  let l = await lamps();
  assert.equal(l.IPv6, 'on', 'the working path is lit');
  assert.equal(l.IPv4, 'na', 'an absent path is dim, not alarming');

  state.mode = 'fail';
  await page.waitForTimeout(4000);
  l = await lamps();
  assert.equal(l.IPv6, 'off', 'and a failing path is unmistakable');

  // The verdict belongs in the log and the file, not in a standing banner.
  assert.match(await page.textContent('#log'), /IPv4 absent/, 'the IPv4 verdict is logged once');
  assert.ok(!/IPv4 probe failures are expected/.test(await page.textContent('#notice')),
            'and no longer occupies the screen');
  await page.click('#btn-start');
  await ctx.close();
});

b.test('the header, the tabs and the content share one column', async () => {
  for (const [w, h] of [[1100, 900], [393, 852]]) {
    const {ctx} = await context({viewport: {width: w, height: h}});
    const page = await ctx.newPage();
    await page.goto(BASE, {waitUntil: 'networkidle'});
    const g = await page.evaluate(() => {
      const r = s => document.querySelector(s).getBoundingClientRect();
      return {main: r('main'), tabs: r('nav .tabs'), h1: r('h1')};
    });
    for (const [name, box] of [['tabs', g.tabs], ['h1', g.h1]]) {
      assert.ok(Math.abs(box.left - g.main.left) < 2 && Math.abs(box.right - g.main.right) < 2,
                `${w}px: ${name} spans ${Math.round(box.left)}-${Math.round(box.right)} but content is ${Math.round(g.main.left)}-${Math.round(g.main.right)}`);
    }
    await ctx.close();
  }
});

b.test('the log grows into the space a taller window gives it', async () => {
  const heights = {};
  for (const h of [852, 1100]) {
    const {ctx} = await context({viewport: {width: 393, height: h}});
    const page = await ctx.newPage();
    await page.goto(BASE, {waitUntil: 'networkidle'});
    await page.click('#btn-start');
    await page.waitForTimeout(2500);
    heights[h] = await page.$eval('#log', e => Math.round(e.getBoundingClientRect().height));
    await page.click('#btn-start');
    await ctx.close();
  }
  assert.ok(heights[1100] > heights[852] + 50,
            `a taller window gives the log more room: ${heights[852]} then ${heights[1100]}`);
});

b.test('a tile explains itself on tap and gives the numbers back', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  await page.click('#btn-start');
  await page.waitForTimeout(5000);

  const sub = () => page.textContent('#sub-tap');
  const numbers = await sub();
  assert.ok(!/tap on a link costs/.test(numbers), 'it shows measurements by default');
  await page.click('#cap-tap');
  assert.match(await sub(), /tap on a link costs/, 'tapping says what the row measures');
  await page.waitForTimeout(2500);
  assert.match(await sub(), /tap on a link costs/, 'and the next round does not overwrite it');
  await page.click('#cap-tap');
  await page.waitForTimeout(2500);
  assert.ok(!/tap on a link costs/.test(await sub()), 'tapping again returns the numbers');

  // Tapping is not discoverable on its own, so one control turns them all on.
  await page.click('#btn-help');
  await page.waitForTimeout(200);
  const shown = await page.$$eval('.signal .sub', els => els.filter(e => e.textContent.length > 40).length);
  assert.equal(shown, 4, 'the help button explains every row at once');

  // Dismissing must restore the numbers now. Waiting for the next round would leave prose
  // on the tile for a whole interval — half a minute on the coarse profile.
  await page.click('#btn-help');
  await page.waitForTimeout(150);
  const restored = await page.$$eval('.signal .sub', els => els.map(e => e.textContent));
  assert.ok(restored.every(t => !/Round trip|Resolving|Sustained/.test(t)),
            `numbers come back immediately, not next round: ${restored.join(' | ')}`);

  // The explanation replaced a paragraph that used to sit permanently under the tiles.
  const clutter = await page.$$eval('#readout .hint', els => els.length);
  assert.equal(clutter, 0, 'no standing explanatory paragraph remains');
  await page.click('#btn-start');
  await ctx.close();
});

b.test('the layout holds and every control is reachable on a phone', async () => {
  for (const [name, width, height] of [['SE', 375, 667], ['15 Pro', 393, 852], ['narrow', 320, 568], ['landscape', 852, 393]]) {
    const {ctx} = await context({viewport: {width, height}, isMobile: true, hasTouch: true});
    const page = await ctx.newPage();
    await page.goto(BASE, {waitUntil: 'networkidle'});
    await page.click('#btn-start');
    await page.waitForTimeout(1500);
    await page.click('#btn-start');
    await page.waitForTimeout(400);
    for (const view of ['measure', 'sessions']) {
      await page.click(`nav button[data-view="${view}"]`);
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => ({
        hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        small: [...document.querySelectorAll('button:not([hidden]), select')]
          .map(el => ({id: el.id || el.textContent.trim().slice(0, 10), h: Math.round(el.getBoundingClientRect().height)}))
          .filter(e => e.h > 0 && e.h < 44)
      }));
      assert.equal(r.hScroll, false, `${name} ${width}x${height} / ${view}: the page scrolls sideways`);
      assert.deepEqual(r.small, [], `${name} ${width}x${height} / ${view}: tap target under 44px`);
    }
    await ctx.close();
  }
});

const ok = await b.run();
await browser.close();
stop();
process.exit(ok ? 0 : 1);
