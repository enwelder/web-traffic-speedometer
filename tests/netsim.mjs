// A simulated mobile cell for the browser suites: per-probe latency, failures, and a download and
// upload that deliver bytes over time. Bad networks are rare and brief in the field, so the
// conditions worth testing are reproduced here instead of driven to.
//
// Two mechanisms, because one cannot do both jobs:
//   - latency and failures come from the route layer, which fulfils a whole body at once;
//   - a rate needs bytes paced across the measurement window, so the transfers are answered by a
//     local HTTPS origin the request is rewritten to.
// The rewrite is a WebKit mechanism: Chromium refuses a cross-origin `route.continue` target, and
// neither its CDP throughput emulation nor a host-resolver mapping reaches a fulfilled body.
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export const PROFILE_DIR = new URL('profiles/', import.meta.url);

export const loadProfile = name =>
  JSON.parse(readFileSync(new URL(`${name}.json`, PROFILE_DIR), 'utf8'));

// Deterministic noise: a profile replays identically for a given seed.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

// The probe a request belongs to, so a profile names probes rather than URLs.
function probeOf(u) {
  if (u.hostname === '1.1.1.1') return 'ip4';
  if (u.hostname.includes('2606:4700:4700::1111')) return 'ip6';
  if (u.hostname === 'speed.cloudflare.com') return u.pathname === '/__up' ? 'up' : 'down';
  if (u.hostname === 'www.gstatic.com') return 'reference';
  if (u.hostname.endsWith('.github.io')) {
    return u.hostname.startsWith('nulog-dns-control') ? 'dns_ctl' : 'dns';
  }
  return 'other';
}

const TRACE = 'fl=1\nip=2a09:bac5::9\nts=1\ncolo=AMS\n';
const CORS = {'access-control-allow-origin': '*', 'timing-allow-origin': '*'};
const CF_TIMING = 'cfL4;desc="?proto=TCP&rtt=6212&min_rtt=6209&lost=0&retrans=0"';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Small and frequent: the measurement window can close a few hundred ms after it opens, and a rate
// has to hold over a short window as well as a long one.
const CHUNK_BYTES = 4000;

// A self-signed certificate, generated per run and never stored in the repository.
function certificate() {
  const dir = mkdtempSync(join(tmpdir(), 'nulog-cell-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
                           '-days', '1', '-nodes', '-subj', '/CN=localhost',
                           '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
               {stdio: 'ignore'});
  return {key: readFileSync(key), cert: readFileSync(cert)};
}

// The transfers a rate applies to. `rule` is replaced per profile; `starve` holds the streams that
// get headers and no bytes, as a loaded cell does.
export async function startCell() {
  let rule = {rateBps: 25e6, firstByteMs: 50, starveStreams: 0, uploadMs: 30};
  let opened = 0;
  const server = https.createServer(certificate(), async (req, res) => {
    const u = new URL(req.url, 'https://127.0.0.1');
    if (u.pathname === '/__up') {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      const bytes = body.reduce((n, b) => n + b.length, 0);
      await sleep(rule.uploadMs);
      res.writeHead(200, {...CORS, 'cf-meta-upload-bytes': String(bytes),
                          'access-control-expose-headers': 'server-timing, cf-meta-colo, cf-meta-upload-bytes',
                          'server-timing': CF_TIMING});
      return res.end();
    }
    const index = opened++ % 3;
    res.writeHead(200, {...CORS, 'content-type': 'application/octet-stream',
                        'access-control-expose-headers': 'server-timing, cf-meta-colo',
                        'cf-meta-colo': 'AMS', 'server-timing': CF_TIMING});
    await sleep(rule.firstByteMs);
    // A starved stream holds its connection open with nothing on it.
    if (index < rule.starveStreams) return;
    // `rateBps` is what the link carries, so the streams still delivering share it.
    const perStream = rule.rateBps / 8 / Math.max(1, 3 - rule.starveStreams);
    // About fifty writes a second: frequent enough that a short window still measures the rate,
    // large enough that a fast link is not held back by the timer.
    const chunk = Math.max(CHUNK_BYTES, Math.round(perStream / 50));
    const gapMs = Math.max(10, Math.round((chunk / perStream) * 1000));
    const deadline = Date.now() + 6000;
    while (!res.writableEnded && Date.now() < deadline) {
      if (!res.write(Buffer.alloc(chunk))) break;
      await sleep(gapMs);
    }
    res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    set(next) { rule = {...rule, ...next}; opened = 0; },
    close() { server.close(); }
  };
}

// A context wired to one profile. `ignoreHTTPSErrors` covers the cell's self-signed certificate.
export async function simContext(browser, profile, {seed = 1, cell} = {}) {
  const ctx = await browser.newContext({
    viewport: {width: 393, height: 852}, permissions: ['geolocation'],
    geolocation: {latitude: 51.9244, longitude: 4.4777, accuracy: 12},
    serviceWorkers: 'block', ignoreHTTPSErrors: true
  });
  const random = rng(seed);
  const rules = profile.hosts || {};
  const transfers = {...(rules.down || {}), uploadMs: (rules.up || {}).latencyMs ?? 30};
  cell?.set({rateBps: transfers.rateBps ?? 25e6, firstByteMs: transfers.latencyMs ?? 50,
             starveStreams: transfers.starveStreams ?? 0, uploadMs: transfers.uploadMs});

  await ctx.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
    const probe = probeOf(u);
    const rule = {...(rules.default || {}), ...(rules[probe] || {})};

    if (rule.fail === 'abort' || (rule.lossRate && random() < rule.lossRate)) {
      return route.abort('connectionfailed');
    }
    // A stalled request is answered by nobody; the probe's own deadline ends it.
    if (rule.fail === 'stall') return new Promise(() => {});

    // The transfers carry a rate, so they are served by the cell rather than fulfilled here.
    if ((probe === 'down' || probe === 'up') && cell) {
      return route.continue({url: `https://127.0.0.1:${cell.port}${u.pathname}${u.search}`});
    }

    const jitter = rule.jitterMs ? Math.round((random() - 0.5) * 2 * rule.jitterMs) : 0;
    const wait = Math.max(0, (rule.latencyMs ?? 0) + jitter);
    if (wait) await sleep(wait);
    if (probe === 'dns' || probe === 'dns_ctl' || probe === 'reference') {
      return route.fulfill({status: 204, body: ''});
    }
    return route.fulfill({status: 200, contentType: 'text/plain', headers: CORS, body: TRACE});
  });

  // STUN is not a fetch, so the peer connection carries the profile's UDP behaviour.
  const udp = profile.udp || {};
  await ctx.addInitScript(({latencyMs, blocked, lossRate, seed: s}) => {
    let state = s >>> 0 || 1;
    const rand = () => {
      state ^= state << 13; state >>>= 0;
      state ^= state >> 17;
      state ^= state << 5; state >>>= 0;
      return state / 0x100000000;
    };
    window.RTCPeerConnection = class {
      addTransceiver(kind, opts) { window.__nulogTransceiver = {kind, ...opts}; }
      async createOffer() { return {type: 'offer', sdp: 'v=0'}; }
      async setLocalDescription() {
        if (blocked || window.__nulogUdpBlocked) return;
        if (!(lossRate && rand() < lossRate)) {
          setTimeout(() => this.onicecandidate?.({candidate: {type: 'srflx', address: '2a09:bac5::9'}}),
                     latencyMs);
        }
        setTimeout(() => this.onicecandidate?.({candidate: null}), latencyMs + 5);
      }
      close() { window.__nulogClosed = (window.__nulogClosed || 0) + 1; }
    };
  }, {latencyMs: udp.latencyMs ?? 5, blocked: !!udp.blocked, lossRate: udp.lossRate ?? 0, seed});
  return ctx;
}

export const readDb = page => page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const q = indexedDB.open('nulog');
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
  const read = s => new Promise((res, rej) => {
    const q = db.transaction(s).objectStore(s).getAll();
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
  return {sessions: await read('sessions'), samples: await read('samples'), events: await read('events')};
});
