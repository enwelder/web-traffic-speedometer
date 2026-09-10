// Checks that every probe host still offers the transport and headers the probes rely on. A host
// that starts advertising HTTP/3 lets a browser move a probe off TCP with no change in this code.
//
//   node tools/check-hosts.mjs
import {networkInterfaces} from 'node:os';
import {randomBytes} from 'node:crypto';

globalThis.document ??= {addEventListener() {}, visibilityState: 'visible'};
const {PROBES, UP_BYTES, REFERENCE, STUN_SERVER} = await import('../js/probe.js');

const probe = id => PROBES.find(p => p.id === id);
// Any origin draws the CORS headers; the probes need `*`.
const ORIGIN = 'https://example.org';
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}

const expect = (holds, why) => { if (!holds) throw new Error(why); };
const header = (res, name) => res.headers.get(name) || '';
const exposes = (res, name) =>
  header(res, 'access-control-expose-headers').toLowerCase().split(/,\s*/).includes(name);

function servesTcpOnly(res) {
  expect(!/\bh3\b/.test(header(res, 'alt-svc')), `Alt-Svc advertises HTTP/3: ${header(res, 'alt-svc')}`);
}

// A browser uses HTTP/3 from the first request when the DNS HTTPS record lists it.
async function recordListsNoH3(host) {
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=HTTPS`,
                          {headers: {accept: 'application/dns-json'}});
  const data = ((await res.json()).Answer || []).filter(a => a.type === 65).map(a => a.data);
  expect(!data.some(d => /alpn=[^ ]*h3/.test(d)), `the HTTPS record lists HTTP/3: ${data.join('; ')}`);
}

function readableTransfer(res) {
  expect(res.status === 200, `status ${res.status}`);
  expect(header(res, 'access-control-allow-origin') === '*', 'no access-control-allow-origin *');
  expect(header(res, 'timing-allow-origin') === '*', 'no timing-allow-origin *');
  expect(exposes(res, 'server-timing'), 'server-timing is not exposed');
  expect(/cfL4;desc="[^"]*proto=TCP/.test(header(res, 'server-timing')), 'no cfL4 with proto=TCP');
  servesTcpOnly(res);
}

const hasGlobalIpv6 = Object.values(networkInterfaces()).flat()
  .some(i => i.family === 'IPv6' && !i.internal && !/^fe80:/i.test(i.address));

for (const id of ['ip4', 'ip6']) {
  if (id === 'ip6' && !hasGlobalIpv6) {
    console.log('  skip  ip6 literal: this machine has no global IPv6 address');
    continue;
  }
  await check(`${id} literal serves a readable trace with its protocol, without HTTP/3`, async () => {
    const res = await fetch(`${probe(id).url}?_=${Date.now()}`, {headers: {origin: ORIGIN}});
    expect(res.status === 200, `status ${res.status}`);
    expect(header(res, 'access-control-allow-origin') === '*', 'no access-control-allow-origin *');
    servesTcpOnly(res);
    expect(/^http=/m.test(await res.text()), 'the trace body carries no http= line');
  });
}

const freshName = probe('dns').url.replace('%RANDOM%', randomBytes(8).toString('hex'));
for (const url of [probe('dns_ctl').url, freshName]) {
  const host = new URL(url).hostname;
  await check(`${host} advertises no HTTP/3`, async () => {
    await recordListsNoH3(host);
    servesTcpOnly(await fetch(url, {method: 'HEAD'}));
  });
}

await check('the download endpoint serves readable timing and cfL4 over TCP', async () => {
  await recordListsNoH3(new URL(probe('down').url).hostname);
  const res = await fetch(`${probe('down').url}?bytes=1000`, {headers: {origin: ORIGIN}});
  await res.arrayBuffer();
  readableTransfer(res);
  expect(exposes(res, 'cf-meta-ip'), 'cf-meta-ip is not exposed');
});

await check(`the upload endpoint confirms ${UP_BYTES} bytes with readable timing and cfL4 over TCP`, async () => {
  const res = await fetch(probe('up').url, {method: 'POST', body: new Uint8Array(UP_BYTES),
                                             headers: {origin: ORIGIN, 'content-type': 'text/plain'}});
  await res.arrayBuffer();
  readableTransfer(res);
  expect(exposes(res, 'cf-meta-upload-bytes'), 'cf-meta-upload-bytes is not exposed');
  expect(Number(header(res, 'cf-meta-upload-bytes')) === UP_BYTES,
         `the server confirmed ${header(res, 'cf-meta-upload-bytes')} bytes`);
});

await check('the Google reference answers 204', async () => {
  const res = await fetch(REFERENCE.url);
  expect(res.status === 204, `status ${res.status}`);
});

await check('the STUN host resolves', async () => {
  const host = STUN_SERVER.replace(/^stun:/, '').replace(/:\d+$/, '');
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`,
                          {headers: {accept: 'application/dns-json'}});
  expect(((await res.json()).Answer || []).length > 0, `${host} has no A record`);
});

if (failures.length) {
  console.error(`\n${failures.length} host check(s) failed`);
  process.exit(1);
}
console.log('\nevery probe host holds its transport contract');
