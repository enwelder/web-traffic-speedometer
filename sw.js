// Offline shell. Recovery after a crash means the page has to load on a degraded network,
// which is exactly the condition the tool exists to measure.

const CACHE = 'webspeed-v6.0.0';

const SHELL = [
  './',
  'index.html',
  'app.css',
  'manifest.webmanifest',
  'icon.svg',
  'icon-180.png',
  'icon-512.png',
  'js/main.js',
  'js/ui.js',
  'js/store.js',
  'js/probe.js',
  'js/session.js',
  'js/export.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  // No skipWaiting: a new version must never take over a tab that is mid-session.
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // The probes must reach the network untouched, or the tool would be measuring itself.
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request, {ignoreSearch: true}).then(hit => hit || fetch(e.request).catch(() => {
      return e.request.mode === 'navigate' ? caches.match('index.html') : Response.error();
    }))
  );
});
