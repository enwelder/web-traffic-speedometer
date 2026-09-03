// Runs every suite. Unit and security tests need nothing but node; the browser suite needs
// Playwright and starts its own server.
import {spawnSync} from 'node:child_process';

const suites = ['unit', 'security', 'browser'];
const only = process.argv.slice(2);
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
