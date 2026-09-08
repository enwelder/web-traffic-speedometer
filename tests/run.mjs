// Runs every suite. All but the browser suite need only node; the browser suite needs
// Playwright and starts its own server.
import {spawnSync} from 'node:child_process';

const suites = ['unit', 'grading', 'edges', 'replay', 'regressions', 'security', 'browser'];
const only = process.argv.slice(2);
// A mistyped name would otherwise select nothing and exit green, so a typo in the CI
// workflow would pass without running a case.
const unknown = only.filter(n => !suites.includes(n));
if (unknown.length) {
  console.error(`unknown suite(s): ${unknown.join(', ')}\nknown: ${suites.join(', ')}`);
  process.exit(2);
}
let failed = 0;

for (const name of suites) {
  if (only.length && !only.includes(name)) continue;
  console.log(`\n${name}`);
  const r = spawnSync(process.execPath, [new URL(`${name}.mjs`, import.meta.url).pathname],
                      {stdio: 'inherit'});
  if (r.status !== 0) failed++;
}

console.log(failed ? `\n${failed} suite(s) failed` : '\nall suites passed');
process.exit(failed ? 1 : 0);
