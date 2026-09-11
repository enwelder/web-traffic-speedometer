// End-to-end tests in a real browser, covering what exists only there: IndexedDB
// persistence, crash recovery, the service worker, downloads and the phone layout.
import assert from 'node:assert';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {chromium, webkit, firefox} from 'playwright';
import {suite} from './helpers.mjs';
import {ACTIVITY_IDS, ACTIVITIES} from '../js/grade.js';
import {PROBES} from '../js/probe.js';
import * as ui from '../js/ui.js';
import {APP_VERSION} from '../js/session.js';

const PORT = 8799;
// ?interval shortens the round; the app honours it on localhost only.
const BASE = `http://127.0.0.1:${PORT}/?interval=2000`;
const PLAIN = `http://127.0.0.1:${PORT}/`;   // real profile intervals, for the cost projection
const root = new URL('..', import.meta.url).pathname;

// Bound to the loopback address: binding every interface is refused in some sandboxes, and
// the interval override is honoured on a loopback host only.
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
                     {cwd: root, stdio: 'ignore'});
const stop = () => { try { server.kill(); } catch { /* already gone */ } };
process.on('exit', stop);
await new Promise(r => setTimeout(r, 800));

// Streaming reads, connection reuse, storage and the service worker differ between engines.
// NULOG_ENGINE selects one; npm test runs each.
const ENGINES = {chromium, webkit, firefox};
const engineName = process.env.NULOG_ENGINE || 'chromium';
const engine = ENGINES[engineName];
if (!engine) throw new Error(`unknown NULOG_ENGINE ${engineName}: ${Object.keys(ENGINES)}`);

// CI installs Playwright's pinned browsers; without that download an installed Chrome runs the
// suite.
const browser = await (async () => {
  if (process.env.PW_CHANNEL) return chromium.launch({channel: process.env.PW_CHANNEL});
  try {
    return await engine.launch();
  } catch {
    if (engineName !== 'chromium') {
      // A missing engine prints a note locally and fails on CI, where the workflow installs engines.
      if (process.env.CI) throw new Error(`${engineName} is not installed on this runner`);
      console.log(`  ..    ${engineName} is not installed; run npx playwright install ${engineName}`);
      process.exit(0);
    }
    console.log('  ..    bundled chromium missing, falling back to installed Chrome');
    return chromium.launch({channel: 'chrome'});
  }
})();

// An IPv6-only network, as the carriers under test provide.
// WebKit stops delivering requests to a route handler once a service worker controls the
// page, so a suite that fails probes on demand cannot also let the worker take over. Tests
// that are about the worker itself opt back in.
async function context(extra = {}) {
  const ctx = await browser.newContext({
    viewport: {width: 393, height: 852}, deviceScaleFactor: 2,
    permissions: ['geolocation'], geolocation: {latitude: 51.9244, longitude: 4.4777, accuracy: 12},
    serviceWorkers: 'block',
    ...extra
  });
  const state = {mode: 'ok'};
  await ctx.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
    if (u.hostname === '1.1.1.1') return route.abort('connectionfailed');
    if (state.mode === 'fail') return route.abort('connectionfailed');
    if (u.hostname === 'speed.cloudflare.com' && u.pathname === '/__up') return route.fulfill({
      status: 200, body: '',
      headers: {'access-control-allow-origin': '*', 'timing-allow-origin': '*',
                'access-control-expose-headers': 'server-timing, cf-meta-colo, cf-meta-upload-bytes',
                'cf-meta-upload-bytes': String(route.request().postDataBuffer()?.length ?? 0),
                'server-timing': 'cfL4;desc="?proto=TCP&rtt=6212&min_rtt=6209&lost=0&retrans=0"'}
    });
    if (u.hostname === 'speed.cloudflare.com') return route.fulfill({
      // The probe requests more bytes than a window reads; the stub caps the body at 2 MB.
      status: 200, body: Buffer.alloc(Math.min(Number(u.searchParams.get('bytes')) || 250000, 2e6)),
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
  // Playwright routes cannot intercept STUN, which is not a fetch. Stubbing the peer
  // connection keeps the suite hermetic and allows the UDP path to be failed on demand.
  await ctx.addInitScript(() => {
    window.RTCPeerConnection = class {
      addTransceiver(kind, opts) { window.__nulogTransceiver = {kind, ...opts}; }
      async createOffer() { return {type: 'offer', sdp: 'v=0'}; }
      async setLocalDescription() {
        if (window.__nulogUdpBlocked) return;
        setTimeout(() => this.onicecandidate?.({candidate: {type: 'srflx', address: '2a09:bac5::9'}}), 5);
        setTimeout(() => this.onicecandidate?.({candidate: null}), 10);
      }
      close() { window.__nulogClosed = (window.__nulogClosed || 0) + 1; }
    };
  });
  return {ctx, state};
}

const readDb = page => page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const q = indexedDB.open('nulog');
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
  const read = s => new Promise((res, rej) => {
    const q = db.transaction(s).objectStore(s).getAll();
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
  return {sessions: await read('sessions'), samples: await read('samples'), events: await read('events')};
});

const b = suite(`browser (${engineName})`);

b.test('the readout MUST label the strips from ACTIVITIES and show one row per probe pair WHEN the page loads', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  // The strips name activities and the rows above them name probes. Both are read from the
  // modules that define them, so neither can drift from a rename.
  const names = await page.$$eval('.strip-row>span', els => els.map(e => e.textContent.trim()));
  assert.deepEqual(names, ACTIVITY_IDS.map(c => ACTIVITIES[c].label),
                   `activities, not probes: ${names.join(' | ')}`);
  const rows = await page.$$eval('.probe', els => els.map(e => e.id));
  // The two address families share the route row, so there is one row fewer than probes.
  assert.equal(rows.length, PROBES.length - 1, `${rows.length} rows for ${PROBES.length} probes: ${rows.join(' ')}`);
  assert.equal(rows[0], 'probe-route', 'the route leads');
  assert.equal(await page.locator('#m-udp').count(), 0, 'no probe readings among the counters');
  await ctx.close();
});

b.test('the page MUST load with no script error and offer only the fields it cannot derive WHEN opened', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  // The DNS probe draws 404s by design; only script errors matter here.
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE, {waitUntil: 'networkidle'});
  assert.deepEqual(errors, []);
  assert.equal(await page.title(), 'Network Usability Log');
  for (const gone of ['#f-route', '#f-name', '#f-adaptive', '#f-interval', '#f-download']) {
    assert.equal(await page.locator(gone).count(), 0, `${gone} is derived from the session`);
  }
  await page.selectOption('#f-connection', 'wifi');
  assert.equal(await page.locator('#row-operator').isHidden(), true, 'the operator field is hidden on Wi-Fi');
  await page.selectOption('#f-connection', 'cellular');
  await ctx.close();
});

b.test('the budget projection MUST double WHEN the interval halves', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  await page.goto(PLAIN, {waitUntil: 'networkidle'});
  const read = () => page.$eval('#budget', e => e.textContent);
  await page.selectOption('#f-profile', 'coarse');
  const coarse = await read();
  await page.selectOption('#f-profile', 'fine');
  const fine = await read();

  // A round streams a byte-capped window, so the interval sets the cost and the projection is the
  // exact worst case.
  const mb = t => {
    const [, n, unit] = t.match(/≈ ([\d.]+) (GB|MB)/);
    return Number(n) * (unit === 'GB' ? 1000 : 1);
  };
  assert.ok(Math.abs(mb(fine) - mb(coarse) * 2) < mb(coarse) * 0.1,
            `halving the interval doubles the bill: ${mb(coarse)} then ${mb(fine)} MB`);
  assert.match(fine, /per hour/, 'the estimate covers an hour');
  assert.equal(await page.$eval('#budget', e => e.classList.contains('warn')), true,
               'a run in the hundreds of megabytes is flagged, not just stated');
  await ctx.close();
});

b.test('the setup screen MUST state the purpose and hide the readout WHEN the page opens', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  assert.match(await page.textContent('#intro'), /not a speed test/);
  assert.equal(await page.$eval('#readout', e => e.hidden), true);
  assert.equal(await page.textContent('#btn-start'), 'Start');
  await ctx.close();
});

b.test('the main button MUST read New session after Stop and restore the setup screen WHEN tapped again', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  const screen = () => page.evaluate(() => ({
    intro: document.querySelector('#intro').hidden, setup: document.querySelector('#setup').hidden,
    readout: document.querySelector('#readout').hidden, label: document.querySelector('#btn-start').textContent,
    log: document.querySelector('#log').textContent
  }));
  await page.click('#btn-start');
  await page.waitForTimeout(2500);
  assert.equal((await screen()).label, 'Stop');
  await page.click('#btn-start');
  await page.waitForFunction(() => document.querySelector('#btn-start').textContent === 'New session');
  const finished = await screen();
  assert.deepEqual([finished.intro, finished.setup, finished.readout], [true, true, false],
                   'the finished session stays on screen');
  assert.match(finished.log, /Session ended/);
  await page.click('#btn-start');
  const setup = await screen();
  assert.deepEqual([setup.intro, setup.setup, setup.readout, setup.label], [false, false, true, 'Start']);
  await ctx.close();
});

b.test('a session MUST record, resume across a reload with a contiguous seq, and export every stored round WHEN driven through the UI', async () => {
  const {ctx, state} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  await page.selectOption('#f-operator', 'Odido');
  await page.click('#btn-start');
  await page.waitForTimeout(3000);
  // The route row shows the family carrying traffic; the absent IPv4 path is excluded.
  assert.equal(await page.textContent('#pname-route'), 'IPv6 round trip');
  assert.match(await page.$eval('#probe-route', e => e.className), /green|yellow|orange/,
               'and the family that works is graded');

  // A row's colour changes with the round it shows, within one round.
  const red = () => page.$eval('#probe-route', e => e.classList.contains('red'));
  state.mode = 'fail';
  await page.waitForTimeout(3000);
  assert.equal(await red(), true, 'a failing round paints its own row');
  state.mode = 'ok';
  await page.waitForTimeout(3000);
  assert.equal(await red(), false, 'and a good one clears it, without waiting for agreement');

  let db = await readDb(page);
  const session = db.sessions[0];
  assert.match(session.name, /^Odido · \d+ \w{3} \d{2}:\d{2}$/, `name generated: ${session.name}`);
  assert.equal(session.ipv4_available, false);
  assert.ok(session.ipv4_check.fail, 'with the evidence kept');
  // The harness has no IPv4 path. In rounds where another family carried traffic the IPv4 failure
  // is `unused` and excluded; in rounds without traffic it counts as a failure.
  const carried = db.samples.filter(x => x.probes.ip6.ok);
  assert.ok(carried.length > 0, 'some round had IPv6 carrying');
  assert.ok(carried.every(x => x.probes.ip4.unused === true),
            'a literal nobody waited on is charged to nothing');
  assert.ok(carried.every(x => !ui.counts(x.probes.ip4)),
            'and does not count against the link');
  assert.ok(db.samples.every(x => x.probes.down), 'every round carries a download');
  // A rested probe issues no lookup, so those rounds carry no hostname.
  const hosts = db.samples.map(x => x.probes.dns?.host).filter(Boolean);
  assert.ok(hosts.length >= 3, `enough lookups to check: ${hosts.length}`);
  assert.equal(new Set(hosts).size, hosts.length, 'the DNS probe never repeats a hostname');

  const udp = db.samples.map(x => x.probes.udp).filter(u => u.ok);
  assert.ok(udp.length > 0, 'the UDP path is probed every round');
  assert.ok(udp.every(u => u.public_ips.includes('2a09:bac5::9')), 'and reports its NAT mapping');
  // The latency probes are sampled the same way, so their medians are comparable.
  for (const id of ['ip6', 'dns_ctl', 'udp']) {
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
  assert.match(await page.textContent('#recover-text'), /not closed/, 'recovery is offered, never silent');
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
  assert.match(download.suggestedFilename(), /^nulog-\d{8}-\d{4}-odido\.json$/, download.suggestedFilename());
  const file = JSON.parse(readFileSync(await download.path(), 'utf8'));
  db = await readDb(page);
  assert.equal(file.format, 'nulog/session');
  assert.equal(file.samples.length, db.samples.length, 'every stored round is in the file');
  assert.equal(file.events.length, db.events.length);
  assert.equal(file.probes.length, PROBES.length, 'the probe set travels with the data');
  assert.ok(file.summary, 'and a rollup so a reader need not recompute the basics');
  assert.equal(file.summary.rounds, file.samples.length);
  assert.ok(file.summary.probes.ip6, 'per probe');
  assert.ok(db.sessions[0].exportedAt, 'and the export is recorded on the session');
  await ctx.close();
});

b.test('the service worker MUST serve the shell and the stored sessions WHEN the context is offline', async () => {
  // Playwright's WebKit build fails a reload of an offline context with an internal error
  // before the page is reached, so this cannot run there. Chromium covers it; the worker
  // itself is checked against the shipped file list by tests/security.mjs on every engine.
  if (engineName === 'webkit') return;
  // Service worker enabled for this test.
  const {ctx} = await context({serviceWorkers: 'allow'});
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
  assert.match(await page.textContent('h1'), /^Network Usability Log/, 'the shell loads offline');
  await page.click('nav button[data-view="sessions"]');
  await page.waitForTimeout(500);
  assert.match(await page.textContent('#session-list'), /not exported/,
               'and the sessions are readable, and flagged');
  await ctx.setOffline(false);
  await ctx.close();
});

b.test('every probe MUST reach its endpoint with no policy violation logged WHEN a session runs under the CSP', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  const blocked = [];
  page.on('console', m => { if (/Content Security Policy|Refused to/.test(m.text())) blocked.push(m.text()); });
  // A 2 s round leaves the upload no budget after the download; 6 s lets the first round send it.
  await page.goto(`${PLAIN}?interval=6000`, {waitUntil: 'networkidle'});
  await page.click('#btn-start');
  await page.waitForTimeout(3000);
  await page.click('#btn-start');
  await page.waitForTimeout(500);
  assert.deepEqual(blocked, [], 'no probe is refused by the policy');
  const db = await readDb(page);
  // Stop aborts the round in flight, so the last row can be cut short; the check reads the last
  // complete round.
  const whole = db.samples.filter(s => !s.skipped && s.probes.down?.fail !== 'abort');
  const last = whole.at(-1).probes;
  for (const id of ['ip6', 'dns', 'dns_ctl', 'down', 'up', 'udp']) {
    assert.equal(last[id].ok, true, `${id} reached its endpoint under the policy`);
  }
  await ctx.close();
});

b.test('the recorder MUST open no download connection WHEN the session is stopped during the idle phase', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  const asked = [];
  page.on('request', r => { if (r.url().includes('speed.cloudflare')) asked.push(Date.now()); });
  await page.goto(BASE, {waitUntil: 'networkidle'});
  await page.click('#btn-start');
  await page.waitForTimeout(120);            // inside the idle phase
  await page.click('#btn-start');
  const cut = Date.now();
  await page.waitForTimeout(2500);
  assert.equal(asked.filter(t => t > cut + 100).length, 0,
               'no download is opened after the stop, so the stop is immediate and free');
  await ctx.close();
});

b.test('the log MUST order the newest line first and the control bar MUST start where the scroll area ends WHEN a session runs', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  await page.click('#btn-start');
  await page.waitForTimeout(7000);

  // Newest first: the controls sit over the bottom of the log.
  const times = await page.$$eval('#log div', els => els.map(e => e.textContent.slice(0, 8)));
  const stamps = times.filter(t => /^\d\d:\d\d:\d\d$/.test(t));
  assert.ok(stamps.length >= 2, 'several lines are logged');
  assert.ok(stamps[0] >= stamps[stamps.length - 1], `newest is first: ${stamps[0]} then ${stamps.at(-1)}`);

  // The bar sits outside the scrolling area, so it cannot overlap the content. Measured on
  // main, whose box is unclipped; main has already clipped the log lines.
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


b.test('the header MUST show APP_VERSION and hide the help control WHEN no session is running', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});

  // The header shows the build version.
  assert.equal(await page.textContent('#app-version'), APP_VERSION);
  assert.equal(await page.$eval('#btn-help', e => e.hidden), true,
               'nothing is measured yet, so there is nothing to explain');
  assert.equal(await page.$eval('#f-profile', e => e.value), 'fine', 'Fine is the default');

  await page.click('#btn-start');
  await page.waitForTimeout(500);
  assert.equal(await page.$eval('#btn-help', e => e.hidden), false, 'and it appears with the rows');
  await page.click('#btn-start');
  await ctx.close();
});

b.test('a graded row and bar MUST compute a painted colour distinct from the neutral WHEN a session has produced grades', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  await page.click('#btn-start');
  await page.waitForTimeout(5000);

  // Computed colours: a class assertion alone passes with the colour rules missing.
  const paint = await page.evaluate(() => {
    const bg = el => getComputedStyle(el).backgroundColor;
    const rail = el => getComputedStyle(el, '::before').backgroundColor;
    const neutral = getComputedStyle(document.documentElement).getPropertyValue('--line').trim();
    const graded = [...document.querySelectorAll('.probe')]
      .filter(e => ['green', 'yellow', 'orange', 'red'].some(g => e.classList.contains(g)));
    const bars = [...document.querySelectorAll('.strip i')]
      .filter(e => ['green', 'yellow', 'orange', 'red'].some(g => e.classList.contains(g)));
    return {rows: graded.length, bars: bars.length, neutral,
            rowPaint: graded.map(rail), barPaint: bars.map(bg)};
  });

  assert.ok(paint.rows > 0, 'at least one row graded, so the paint assertions have subjects');
  assert.ok(paint.bars > 0, 'and some bar too');
  for (const c of paint.rowPaint) {
    assert.ok(c && c !== 'rgba(0, 0, 0, 0)', `a graded row's rail is painted: ${c}`);
  }
  for (const c of paint.barPaint) {
    assert.ok(c && c !== 'rgba(0, 0, 0, 0)', `a graded bar is painted: ${c}`);
  }
  // The neutral fallback is what an ungraded element gets; a graded one must differ from it.
  const neutralRgb = await page.evaluate(v => {
    const d = document.createElement('div');
    d.style.color = v; document.body.appendChild(d);
    const c = getComputedStyle(d).color; d.remove(); return c;
  }, paint.neutral);
  assert.ok(!paint.barPaint.every(c => c === neutralRgb),
            `graded bars must not all be the neutral colour ${neutralRgb}`);
  await ctx.close();
});

b.test('the route row MUST show the family, its grade and its failure reason WHEN the path works and then fails', async () => {
  const {ctx, state} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  await page.click('#btn-start');
  await page.waitForTimeout(5000);

  const row = id => page.$eval(`#probe-${id}`, e =>
    ['green', 'yellow', 'orange', 'red'].filter(g => e.classList.contains(g)).join(''));
  const shown = id => page.textContent(`#pval-${id}`);
  const family = () => page.textContent('#pname-route');
  assert.match(await row('route'), /green|yellow|orange/, 'the working path is graded');
  assert.equal(await family(), 'IPv6 round trip', 'and the row names the family it is reporting');

  state.mode = 'fail';
  await page.waitForTimeout(4000);
  assert.equal(await row('route'), 'red', 'a failing path is unmistakable');
  assert.match(await shown('route'), /timeout|network/, 'with the reason, not just the fact');

  // The IPv4 result goes to the log and the file; the notice area stays clear.
  assert.match(await page.textContent('#log'), /IPv4 did not answer/,
               'what each family did at the start is logged once');
  assert.ok(!/IPv4 probe failures are expected/.test(await page.textContent('#notice')),
            'and the notice area stays clear');
  await page.click('#btn-start');
  await ctx.close();
});

b.test('the header, the tabs and the content MUST share one column WHEN the viewport is 1100 px or 393 px wide', async () => {
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

b.test('the log MUST take more height WHEN the viewport is taller', async () => {
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

b.test('a probe row MUST replace its number with an explanation and restore the number WHEN tapped twice', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  await page.click('#btn-start');
  await page.waitForTimeout(5000);

  const explain = () => page.textContent('#explain-probe-dns');
  const value = () => page.$eval('#pval-dns', e => e.offsetParent !== null);
  assert.equal(await explain(), '', 'a row shows its measurement by default');
  assert.equal(await value(), true);

  await page.click('#probe-dns');
  assert.match(await explain(), /never contacted/, 'tapping shows what the row measures');
  assert.equal(await value(), false, 'in place of the number, not beside it');
  await page.waitForTimeout(2500);
  assert.match(await explain(), /never contacted/, 'and the next round does not overwrite it');

  await page.click('#probe-dns');
  assert.equal(await explain(), '', 'tapping again returns the number');
  assert.equal(await value(), true);

  // One control turns every row's explanation on.
  await page.click('#btn-help');
  await page.waitForTimeout(200);
  const shown = await page.$$eval('.probe .explain', els => els.filter(e => e.textContent.trim()).length);
  assert.equal(shown, PROBES.length - 1, 'the help control shows an explanation on every row');
  await ctx.close();
});

b.test('the layout MUST avoid sideways scroll and keep every tap target at 44 px WHEN viewed at phone sizes', async () => {
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
