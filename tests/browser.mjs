// End-to-end tests in a real browser: the parts that only exist there — IndexedDB
// persistence, crash recovery, the service worker, downloads, and the layout on a phone.
import assert from 'node:assert';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {suite} from './helpers.mjs';

const PORT = 8799;
const BASE = `http://localhost:${PORT}/`;
const root = new URL('..', import.meta.url).pathname;

const server = spawn('python3', ['-m', 'http.server', String(PORT)], {cwd: root, stdio: 'ignore'});
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
    if (u.hostname === 'localhost') return route.continue();
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
  for (const gone of ['#f-route', '#f-name', '#f-adaptive']) {
    assert.equal(await page.locator(gone).count(), 0, `${gone} is derived, not asked for`);
  }
  await page.selectOption('#f-connection', 'wifi');
  assert.equal(await page.locator('#row-operator').isHidden(), true, 'no operator asked for on Wi-Fi');
  await page.selectOption('#f-connection', 'cellular');
  await ctx.close();
});

b.test('the projection tracks the settings and warns when a run gets expensive', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  const read = () => page.$eval('#budget', e => [Number(e.textContent.match(/(\d+) MB/)[1]), e.classList.contains('warn')]);
  await page.selectOption('#f-interval', '30000');
  const [cheap, cheapWarn] = await read();
  await page.selectOption('#f-interval', '5000');
  const [dear, dearWarn] = await read();
  assert.ok(dear > cheap * 4, `a shorter interval costs more: ${cheap} MB vs ${dear} MB`);
  assert.equal(cheapWarn, false);
  assert.equal(dearWarn, true, 'and past 50 MB it says so before Start');
  await ctx.close();
});

b.test('a session records, survives a reload, and exports losslessly', async () => {
  const {ctx, state} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  await page.selectOption('#f-operator', 'Odido');
  await page.selectOption('#f-interval', '2000');
  await page.selectOption('#f-download', '100000');
  await page.click('#btn-start');
  await page.waitForTimeout(3000);
  assert.match(await page.textContent('#sub-ip6'), /v4 n\/a/, 'an absent IPv4 path is not a failure');
  assert.match(await page.textContent('#sub-dns'), /cached/, 'the DNS control shares the tile');
  await page.click('#btn-mark');

  state.mode = 'fail';
  await page.waitForTimeout(3000);
  assert.equal((await page.textContent('#val-ip6')).trim(), 'gone');
  state.mode = 'ok';
  await page.waitForTimeout(2500);

  let db = await readDb(page);
  const session = db.sessions[0];
  assert.match(session.name, /^Odido · \d+ \w{3} \d{2}:\d{2}$/, `name generated: ${session.name}`);
  assert.equal(session.ipv4_available, false);
  assert.ok(session.ipv4_check.fail, 'with the evidence kept');
  assert.ok(db.samples.every(x => x.probes.ip4.expected === true), 'every ip4 failure is flagged');
  assert.ok(db.samples.every(x => x.probes.down), 'every round carries a download');
  const hosts = db.samples.map(x => x.probes.dns.host);
  assert.equal(new Set(hosts).size, hosts.length, 'the DNS probe never repeats a hostname');
  assert.equal(new Set(db.samples.map(x => x.probes.dns_ctl.host)).size, 1, 'the control never changes one');

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
  assert.equal(file.probes.length, 6, 'the probe set travels with the data');
  assert.ok(db.sessions[0].exportedAt, 'and the export is recorded on the session');
  await ctx.close();
});

b.test('the shell and the recorded sessions survive with no network at all', async () => {
  const {ctx} = await context();
  const page = await ctx.newPage();
  await page.goto(BASE, {waitUntil: 'networkidle'});
  await page.selectOption('#f-interval', '2000');
  await page.click('#btn-start');
  await page.waitForTimeout(2500);
  await page.click('#btn-start');
  await page.waitForTimeout(600);
  await page.evaluate(() => navigator.serviceWorker.ready);

  await ctx.setOffline(true);
  await page.reload({waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(1200);
  assert.equal(await page.textContent('h1'), 'Web Traffic Speedometer', 'the shell loads offline');
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
  await page.selectOption('#f-interval', '2000');
  await page.selectOption('#f-download', '100000');
  await page.click('#btn-start');
  await page.waitForTimeout(3000);
  await page.click('#btn-start');
  await page.waitForTimeout(500);
  assert.deepEqual(blocked, [], 'no probe is refused by the policy');
  const db = await readDb(page);
  const last = db.samples.at(-1).probes;
  for (const id of ['ip6', 'dns', 'dns_ctl', 'web', 'down']) {
    assert.equal(last[id].ok, true, `${id} reached its endpoint under the policy`);
  }
  await ctx.close();
});

b.test('the layout holds and every control is reachable on a phone', async () => {
  for (const [name, width, height] of [['SE', 375, 667], ['15 Pro', 393, 852], ['narrow', 320, 568], ['landscape', 852, 393]]) {
    const {ctx} = await context({viewport: {width, height}, isMobile: true, hasTouch: true});
    const page = await ctx.newPage();
    await page.goto(BASE, {waitUntil: 'networkidle'});
    await page.selectOption('#f-interval', '2000');
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
