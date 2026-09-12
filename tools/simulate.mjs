// Runs the app against a simulated cell, so a profile can be watched and adjusted. The suite in
// tests/simulation.mjs asserts against the same module.
//
//   node tools/simulate.mjs --profile delft-tunnel [--seconds 30] [--headed] [--interval 2000]
//
// Profiles live in tests/profiles/. Without --seconds it runs until ctrl-c. WebKit only: the rate
// is paced by a local origin the transfers are rewritten to, which Chromium refuses.
import {spawn} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {webkit} from 'playwright';
import {simContext, startCell, loadProfile, readDb, PROFILE_DIR} from '../tests/netsim.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const profileName = flag('profile', 'delft-tunnel');
const interval = flag('interval', '2000');
const seconds = Number(flag('seconds', 0));
const headed = args.includes('--headed');

const known = readdirSync(PROFILE_DIR).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5));
if (!known.includes(profileName)) {
  console.error(`unknown profile ${profileName}\nknown: ${known.join(', ')}`);
  process.exit(2);
}

const PORT = 8803;
const root = new URL('..', import.meta.url).pathname;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
                     {cwd: root, stdio: 'ignore'});
await new Promise(r => setTimeout(r, 800));

const profile = loadProfile(profileName);
const cell = await startCell();
const browser = await webkit.launch({headless: !headed});
const ctx = await simContext(browser, profile, {cell});
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${PORT}/?interval=${interval}`, {waitUntil: 'networkidle'});

console.log(`profile ${profileName}: ${profile.note}`);
console.log(`rounds every ${interval} ms${seconds ? `, stopping after ${seconds} s` : ', ctrl-c to stop'}\n`);
await page.click('#btn-start');

// Each new log line as the app writes it, which is what the screen shows.
let seen = 0;
const follow = setInterval(async () => {
  try {
    const lines = await page.evaluate(() =>
      [...document.querySelectorAll('#log div')].map(l => l.textContent).reverse());
    for (const line of lines.slice(seen)) console.log(' ', line);
    seen = lines.length;
  } catch { /* the page is gone */ }
}, 1000);

async function report() {
  clearInterval(follow);
  try {
    await page.click('#btn-start');
    const db = await readDb(page);
    const rows = db.samples.filter(r => !r.interrupted && r.grades);
    const tally = a => rows.reduce((acc, r) => {
      const g = r.grades[a] ?? 'unrated';
      acc[g] = (acc[g] || 0) + 1;
      return acc;
    }, {});
    console.log(`\n${rows.length} graded rounds`);
    for (const activity of ['voice', 'news', 'streaming']) {
      console.log(`  ${activity.padEnd(10)} ${JSON.stringify(tally(activity))}`);
    }
    const down = rows.map(r => r.probes.down?.bps).filter(Boolean);
    if (down.length) {
      console.log(`  download   ${(Math.min(...down) / 1e6).toFixed(1)}-${(Math.max(...down) / 1e6).toFixed(1)} Mb/s`);
    }
  } catch (e) {
    console.error('could not read the session:', e.message);
  }
  await browser.close().catch(() => {});
  cell.close();
  server.kill();
  process.exit(0);
}

if (seconds) setTimeout(report, seconds * 1000);
process.on('SIGINT', report);
process.on('SIGTERM', report);
