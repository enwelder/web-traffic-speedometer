// Runs every suite. All but the browser suite need only node; the browser suite needs
// Playwright and starts its own server.
import {spawnSync} from 'node:child_process';

const suites = ['unit', 'stuck', 'wakelock', 'position', 'grading', 'edges', 'replay', 'regressions', 'security', 'browser', 'simulation'];
const only = process.argv.slice(2);
// An unknown suite name fails, so a mistyped name in the CI workflow cannot pass with zero cases.
const unknown = only.filter(n => !suites.includes(n));
if (unknown.length) {
  console.error(`unknown suite(s): ${unknown.join(', ')}\nknown: ${suites.join(', ')}`);
  process.exit(2);
}
let failed = 0;

// The browser suite runs once per engine: streaming reads, connection reuse, storage and the
// service worker differ between engines.
const ENGINES = (process.env.NULOG_ENGINES || 'chromium,webkit').split(',');

for (const name of suites) {
  if (only.length && !only.includes(name)) continue;
  console.log(`\n${name}`);
  for (const engine of name === 'browser' ? ENGINES : [null]) {
    const r = spawnSync(process.execPath, [new URL(`${name}.mjs`, import.meta.url).pathname],
                        {stdio: 'inherit', env: engine ? {...process.env, NULOG_ENGINE: engine} : process.env});
    if (r.status !== 0) failed++;
  }
}

console.log(failed ? `\n${failed} suite(s) failed` : '\nall suites passed');
process.exit(failed ? 1 : 0);
