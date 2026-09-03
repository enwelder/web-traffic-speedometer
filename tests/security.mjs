// Security tests. This is a static site that records a person's location and network
// behaviour for forty minutes at a time, so the properties worth guarding are: it talks to
// nothing but its six probes, it has no way to upload what it records, it executes no
// dynamic code, and it ships no third-party code at all.
import assert from 'node:assert';
import {readFileSync, readdirSync} from 'node:fs';
import {suite} from './helpers.mjs';

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

s.test('no outbound origin exists outside the declared probe allowlist', () => {
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
  assert.ok(found.size > 0, 'the allowlist check actually inspected something');
});

s.test('no request can carry a body, so nothing recorded can leave the device', () => {
  for (const [file, src] of sources) {
    assert.ok(!/method:\s*['"](POST|PUT|PATCH)['"]/i.test(src), `${file} issues a write request`);
    assert.ok(!/\bbody\s*:/.test(src.replace(/res\.body|\.body\b/g, '')), `${file} attaches a request body`);
    assert.ok(!/navigator\.sendBeacon/.test(src), `${file} uses sendBeacon`);
    assert.ok(!/new\s+(WebSocket|EventSource)/.test(src), `${file} opens a persistent channel`);
  }
});

// The UDP probe needs a peer connection to gather ICE candidates. Gathering alone cannot
// carry data: what makes a peer connection able to send anything is a data channel, a
// track, or a remote description completing the negotiation. Those stay banned, so the
// capability is admitted without admitting the exfiltration path.
s.test('the peer connection can gather candidates and nothing else', () => {
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

s.test('no request may carry credentials to a third party', () => {
  const fetches = read('js/probe.js').match(/fetch\([\s\S]*?\}\)/g) || [];
  assert.ok(fetches.length > 0, 'found the fetch calls');
  for (const f of fetches) {
    assert.match(f, /credentials:\s*'omit'/, 'every fetch omits credentials');
    assert.match(f, /referrerPolicy:\s*'no-referrer'/, 'and sends no referrer');
  }
});

s.test('no dynamic code execution', () => {
  for (const [file, src] of sources) {
    assert.ok(!/\beval\s*\(/.test(src), `${file} uses eval`);
    assert.ok(!/new\s+Function\s*\(/.test(src), `${file} uses new Function`);
    assert.ok(!/setTimeout\s*\(\s*['"`]/.test(src), `${file} passes a string to setTimeout`);
    assert.ok(!/import\s*\(/.test(src), `${file} imports dynamically`);
  }
});

s.test('untrusted text never reaches the DOM as markup', () => {
  for (const [file, src] of sources) {
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      assert.ok(!src.includes(sink), `${file} writes through ${sink}`);
    }
  }
});

s.test('the page loads no third-party resources and carries no inline handlers', () => {
  for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
    const v = m[1];
    assert.ok(!/^https?:|^\/\//.test(v), `index.html loads an external resource: ${v}`);
  }
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'index.html contains an inline event handler');
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), 'index.html contains an inline script');
});

s.test('the content security policy locks down everything it can', () => {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  assert.ok(m, 'a CSP is present');
  const csp = Object.fromEntries(m[1].split(';').map(d => {
    const [k, ...v] = d.trim().split(/\s+/);
    return [k, v.join(' ')];
  }));
  assert.equal(csp['default-src'], "'none'", 'nothing is allowed by default');
  for (const d of ['script-src', 'style-src', 'manifest-src', 'worker-src']) {
    assert.equal(csp[d], "'self'", `${d} is limited to this origin`);
  }
  assert.equal(csp['base-uri'], "'none'");
  assert.equal(csp['form-action'], "'none'");
  // connect-src cannot name the IPv6 probe: the host-source grammar has no syntax for a
  // bracketed literal, and naming it makes the browser ignore the source and block the
  // probe. The allowlist above is the enforcement instead.
  assert.match(csp['connect-src'], /^'self' https:$/);
  // STUN is not fetched, so connect-src does not gate it; webrtc-src is not a directive
  // any browser enforces. The allowlist test above is what constrains it.
});

s.test('the service worker never intercepts a probe', () => {
  const sw = read('sw.js');
  assert.match(sw, /url\.origin !== self\.location\.origin/, 'cross-origin requests pass through untouched');
  assert.match(sw, /e\.request\.method !== 'GET'/, 'and so does anything that is not a GET');
  // The call, not the word: sw.js explains in a comment why it is absent.
  assert.ok(!/\bskipWaiting\s*\(/.test(sw), 'a new version never takes over a tab mid-session');
});

s.test('there are no runtime dependencies to trust', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.dependencies, undefined, 'no runtime dependencies');
  assert.ok(!/from\s+['"][^.]/.test(sources.map(([, s]) => s).join('\n')),
            'no module is imported from outside this repository');
});

s.test('no credential-shaped string is committed', () => {
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

s.test('the test seam cannot take effect on a deployed origin', () => {
  const main = read('js/main.js');
  const fn = /function testInterval\(\)[\s\S]*?\n}/.exec(main);
  assert.ok(fn, 'the override is a single named function');
  assert.match(fn[0], /location\.hostname !== 'localhost'/, 'gated on localhost');
  assert.match(fn[0], /return null/, 'and returns nothing anywhere else');
  const uses = main.match(/testInterval\(\)/g) || [];
  assert.equal(uses.length, 2, 'it is defined once and consulted once');
});

// One description, so the repository, the install prompt and the page cannot drift apart.
s.test('the description is stated once and matches everywhere', () => {
  const desc = JSON.parse(read('package.json')).description;
  assert.ok(desc && desc.length > 40, 'package.json carries the canonical description');
  assert.equal(JSON.parse(read('manifest.webmanifest')).description, desc,
               'the install prompt says the same thing');
  const meta = /<meta name="description" content="([^"]*)">/.exec(html);
  assert.ok(meta, 'the page has a description');
  assert.equal(meta[1], desc, 'and it says the same thing');
});

s.test('the published version is stated once and matches everywhere', () => {
  const version = JSON.parse(read('package.json')).version;
  assert.match(version, /^\d+\.\d+\.\d+$/, 'package.json carries a semantic version');
  const app = /APP_VERSION = '([^']+)'/.exec(read('js/session.js'))[1];
  assert.equal(app, version, `js/session.js APP_VERSION (${app}) must match package.json (${version})`);
  const cache = /const CACHE = '([^']+)'/.exec(read('sw.js'))[1];
  assert.equal(cache, `wts-v${version}`,
               `the service worker cache (${cache}) must be wts-v${version}, or clients keep the old build`);
});

await s.run();
