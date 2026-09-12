// The app driven against simulated network conditions. Each case states the conditions and the
// verdict a user would read off the screen, so grades are asserted and not milliseconds.
//
// WebKit only: a rate needs bytes paced across the measurement window, which reaches the page
// through a rewritten request to a local origin, and Chromium refuses that rewrite. WebKit is the
// engine the recordings under study come from.
//
// Run lengths come from measurement: with every TCP path stalled the preflight costs 5.5 s and a
// round 2.5 s.
import assert from 'node:assert';
import {spawn} from 'node:child_process';
import {connect} from 'node:net';
import {webkit} from 'playwright';
import {suite} from './helpers.mjs';
import {simContext, startCell, loadProfile, readDb} from './netsim.mjs';

const PORT = 8801;
const base = interval => `http://127.0.0.1:${PORT}/?interval=${interval}`;
const root = new URL('..', import.meta.url).pathname;

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
                     {cwd: root, stdio: 'ignore'});
process.on('exit', () => { try { server.kill(); } catch { /* already gone */ } });

// The port answers before the first page load, so a slow start cannot fail a case.
await new Promise((resolve, reject) => {
  const deadline = Date.now() + 10000;
  const attempt = () => {
    const socket = connect(PORT, '127.0.0.1');
    socket.on('connect', () => { socket.end(); resolve(); });
    socket.on('error', () => {
      socket.destroy();
      if (Date.now() > deadline) return reject(new Error(`no server on ${PORT}`));
      setTimeout(attempt, 100);
    });
  };
  attempt();
});

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
async function run(profileName, {ms, interval}) {
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

// The upload needs a second of budget, which a 4 s interval leaves.
s.test('every activity MUST grade green with a saturated download and a measured upload WHEN the link is a working 5G cell', async () => {
  const {rows} = await run('good-5g', {ms: 17000, interval: 4000});
  for (const activity of ['voice', 'news', 'streaming']) {
    assert.equal(share(rows, activity, ['green']), 1,
                 `${activity}: ${JSON.stringify(tally(rows, activity))}`);
  }
  assert.ok(rows.every(r => r.probes.down?.saturated),
            `download: ${JSON.stringify(rows.map(r => r.probes.down?.bps))}`);
  assert.ok(rows.every(r => r.probes.up?.ok),
            `upload: ${JSON.stringify(rows.map(r => r.probes.up?.fail))}`);
});

s.test('streaming MUST grade below green while calls stay green or yellow WHEN the cell delivers 1.2 Mb/s', async () => {
  const {rows} = await run('delft-tunnel', {ms: 14000, interval: 3000});
  assert.ok(share(rows, 'streaming', ['orange', 'red']) >= 0.75,
            `streaming: ${JSON.stringify(tally(rows, 'streaming'))}`);
  assert.ok(share(rows, 'voice', ['green', 'yellow']) >= 0.75,
            `voice: ${JSON.stringify(tally(rows, 'voice'))}`);
  assert.ok(rows.every(r => r.probes.udp?.ok), `udp: ${JSON.stringify(rows.map(r => r.probes.udp?.fail))}`);
});

s.test('the download MUST report the profile rate WHEN the cell is slow and answering', async () => {
  const {rows} = await run('delft-tunnel', {ms: 14000, interval: 3000});
  const rates = rows.map(r => r.probes.down?.bps);
  assert.ok(rows.every(r => r.probes.down?.ok), `download: ${JSON.stringify(rows.map(r => r.probes.down?.fail))}`);
  assert.ok(rates.every(b => b > 0.6e6 && b < 2.5e6),
            `1.2 Mb/s profile measured as ${rates.map(b => (b / 1e6).toFixed(2)).join(' ')}`);
  // Under a second of budget left: the upload is not sent and records `no_budget`, which is
  // excluded from failure tallies.
  assert.ok(rows.every(r => r.probes.up?.ok || r.probes.up?.fail === 'no_budget'),
            `upload: ${JSON.stringify(rows.map(r => r.probes.up?.fail))}`);
});

s.test('reading MUST grade below green while video stays green WHEN a name lookup crosses the ttfb edge', async () => {
  const {rows} = await run('slow-lookup', {ms: 14000, interval: 3000});
  assert.ok(rows.every(r => r.probes.dns?.ok && r.probes.dns.ms > 800),
            `lookups: ${JSON.stringify(rows.map(r => Math.round(r.probes.dns?.ms)))}`);
  assert.ok(share(rows, 'news', ['yellow', 'orange', 'red']) >= 0.75,
            `news: ${JSON.stringify(tally(rows, 'news'))}`);
  assert.ok(share(rows, 'streaming', ['green']) >= 0.75,
            `streaming: ${JSON.stringify(tally(rows, 'streaming'))}`);
});

s.test('every activity MUST grade red with the TCP probes failing and UDP answering WHEN every TCP path hangs', async () => {
  // Each probe holds its deadline, so the preflight costs 5.5 s and a round 2.5 s.
  const {rows} = await run('tcp-stall', {ms: 26000, interval: 4000});
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
