// Turns part of an exported session into a simulator profile, so a recorded stretch of bad network
// becomes a test case.
//
//   node tools/profile-from-log.mjs <session.json> <profile-name> [--from HH:MM] [--to HH:MM]
//
// Writes tests/profiles/<profile-name>.json. Timings are medians over the selected rounds; no
// position, address or identity is carried across.
import {readFileSync, writeFileSync} from 'node:fs';

const [file, name, ...rest] = process.argv.slice(2);
if (!file || !name) {
  console.error('usage: node tools/profile-from-log.mjs <session.json> <profile-name> [--from HH:MM] [--to HH:MM]');
  process.exit(2);
}
const flag = key => {
  const i = rest.indexOf(`--${key}`);
  return i === -1 ? null : rest[i + 1];
};

const median = xs => {
  const s = xs.filter(v => v != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const clock = t => new Date(t).toTimeString().slice(0, 5);

const j = JSON.parse(readFileSync(file, 'utf8'));
const from = flag('from');
const to = flag('to');
const rows = j.samples.filter(r => !r.interrupted && !r.round_error)
                      .filter(r => (!from || clock(r.t) >= from) && (!to || clock(r.t) <= to));
if (rows.length < 3) {
  console.error(`only ${rows.length} rounds selected; widen the window`);
  process.exit(1);
}

const ms = id => median(rows.map(r => (r.probes[id]?.ok ? r.probes[id].ms : null)));
const rate = median(rows.map(r => (r.probes.down?.ok ? r.probes.down.bps : null)));
// A stream that took headers and no bytes is a starved one, as a loaded cell produces.
const starved = median(rows.map(r =>
  (r.probes.down?.per_stream || []).filter(s => !s.bytes).length));

const profile = {
  name,
  note: `Taken from ${file.split('/').pop()}, ${clock(rows[0].t)}-${clock(rows.at(-1).t)}, ` +
        `${rows.length} rounds: round trips ${ms('ip6') ?? ms('ip4')} ms, download ` +
        `${rate ? (rate / 1e6).toFixed(1) : 'none'} Mb/s.`,
  hosts: {
    default: {latencyMs: ms('ip6') ?? ms('ip4') ?? 50, jitterMs: 25},
    dns: {latencyMs: ms('dns') ?? 200, jitterMs: 100},
    down: {latencyMs: 150, rateBps: rate ? Math.round(rate) : 25e6, starveStreams: starved || 0},
    up: {latencyMs: ms('up') ?? 100}
  },
  udp: {latencyMs: ms('udp') ?? 40, jitterMs: 20}
};

const out = new URL(`../tests/profiles/${name}.json`, import.meta.url).pathname;
writeFileSync(out, `${JSON.stringify(profile, null, 2)}\n`);
console.log(`${out}\n${profile.note}`);
