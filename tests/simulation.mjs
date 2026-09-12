// The app driven against simulated network conditions. Each case states the conditions and the
// verdict a user would read off the screen, so grades are asserted rather than milliseconds.
//
// WebKit only: a rate needs bytes paced over the measurement window, which reaches the page through
// a rewritten request to a local origin. Chromium refuses that rewrite. WebKit is also the engine
// the recordings under study come from.
import assert from 'node:assert';
import {spawn} from 'node:child_process';
import {webkit} from 'playwright';
import {suite} from './helpers.mjs';
import {simContext, startCell, loadProfile, readDb} from './netsim.mjs';

const engineName = process.env.NULOG_ENGINE || 'webkit';
if (engineName !== 'webkit') {
  console.log(`  ..    simulation runs on webkit; NULOG_ENGINE=${engineName} skipped`);
  process.exit(0);
}

const PORT = 8801;
const base = interval => `http://127.0.0.1:${PORT}/?interval=${interval}`;
const root = new URL('..', import.meta.url).pathname;

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
                     {cwd: root, stdio: 'ignore'});
process.on('exit', () => { try { server.kill(); } catch { /* already gone */ } });
await new Promise(r => setTimeout(r, 800));

const browser = await (async () => {
  try {
    return await webkit.launch();
  } catch {
    if (process.env.CI) throw new Error('webkit is not installed on this runner');
    console.log('  ..    webkit is not installed; run npx playwright install webkit');
    process.exit(0);
  }
})();

const cell = await startCell();
const s = suite('simulation (webkit)');

// Runs one session under a profile and returns the rounds it graded.
async function run(profileName, {ms = 11000, interval = 2000} = {}) {
  const ctx = await simContext(browser, loadProfile(profileName), {cell});
  const page = await ctx.newPage();
  await page.goto(base(interval), {waitUntil: 'networkidle'});
  await page.click('#btn-start');
  await page.waitForTimeout(ms);
  await page.click('#btn-start');
  const db = await readDb(page);
  const rows = db.samples.filter(r => !r.interrupted && !r.round_error).sort((a, b) => a.seq - b.seq);
  await ctx.close();
  assert.ok(rows.length >= 2, `${profileName} produced ${rows.length} graded rounds`);
  return {rows, events: db.events};
}

// How often a grade appears for an activity, so a failure states what the session looked like.
const tally = (rows, activity) => rows.reduce((a, r) => {
  const g = r.grades?.[activity] ?? 'unrated';
  a[g] = (a[g] || 0) + 1;
  return a;
}, {});
const share = (rows, activity, grades) =>
  rows.filter(r => grades.includes(r.grades?.[activity])).length / rows.length;

s.test('every activity MUST grade green WHEN the link is a working 5G cell', async () => {
  const {rows} = await run('good-5g');
  for (const activity of ['voice', 'news', 'streaming']) {
    assert.equal(share(rows, activity, ['green']), 1,
                 `${activity}: ${JSON.stringify(tally(rows, activity))}`);
  }
  assert.ok(rows.every(r => r.probes.down?.saturated),
            'the download reaches the rate the tool can still measure');
});

s.test('streaming MUST grade below green while calls stay green or yellow WHEN the cell starves the download', async () => {
  // A wider interval, so the upload still has budget after the slow idle phase and download.
  const {rows} = await run('delft-tunnel', {ms: 14000, interval: 3000});
  assert.ok(share(rows, 'streaming', ['orange', 'red']) >= 0.75,
            `streaming: ${JSON.stringify(tally(rows, 'streaming'))}`);
  assert.ok(share(rows, 'voice', ['green', 'yellow']) >= 0.75,
            `voice: ${JSON.stringify(tally(rows, 'voice'))}`);
  assert.ok(rows.every(r => r.probes.udp?.ok), 'the UDP path carries the tunnel throughout');
  // The cell is slow rather than broken: the download reports the profile's rate.
  const rates = rows.map(r => r.probes.down?.bps);
  assert.ok(rows.every(r => r.probes.down?.ok), 'the download reports a rate rather than failing');
  assert.ok(rates.every(b => b > 0.6e6 && b < 2.5e6),
            `1.2 Mb/s profile measured as ${rates.map(b => (b / 1e6).toFixed(2)).join(' ')}`);
  // The slow idle phase and download leave the upload without a second, which the recorder records
  // as `no_budget`: the tool standing down rather than a link failure.
  assert.ok(rows.every(r => r.probes.up?.ok || r.probes.up?.fail === 'no_budget'),
            `upload: ${JSON.stringify(rows.map(r => r.probes.up?.fail))}`);
});

s.test('reading MUST grade below green WHEN name resolution takes hundreds of milliseconds', async () => {
  const {rows} = await run('delft-tunnel');
  assert.ok(share(rows, 'news', ['yellow', 'orange', 'red']) >= 0.75,
            `news: ${JSON.stringify(tally(rows, 'news'))}`);
  assert.ok(rows.every(r => r.probes.dns.ok && r.probes.dns.ms > 300),
            'the fresh-name lookup is slow rather than failing');
});

s.test('every activity MUST grade red with the TCP probes failing and UDP answering WHEN every TCP path hangs', async () => {
  // Every TCP probe holds its deadline, so a round costs seconds and few of them fit.
  const {rows} = await run('tcp-stall', {ms: 16000});
  for (const activity of ['voice', 'news', 'streaming']) {
    assert.ok(share(rows, activity, ['red']) >= 0.75,
              `${activity}: ${JSON.stringify(tally(rows, activity))}`);
  }
  assert.ok(rows.every(r => r.probes.udp?.ok), 'STUN answers while TCP hangs');
  assert.ok(rows.every(r => !r.probes.dns_ctl.ok && !r.probes.down.ok),
            'and the TCP probes record the hang');
});

const ok = await s.run();
cell.close();
await browser.close();
server.kill();
process.exit(ok ? 0 : 1);
