// Offline shell: recovery after a crash requires the page to load on a degraded network.

const CACHE = 'wts-v3.12.0';

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
  'js/export.js',
  'js/grade.js',
  'js/stuck.js',
  'js/wakelock.js',
  'js/position.js'
];

self.addEventListener('install', e => {
  // `cache: 'reload'`: addAll takes whatever the HTTP cache holds, which on a version bump
  // is the previous build.
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.all(SHELL.map(u => fetch(new Request(u, {cache: 'reload'})).then(r => {
      if (!r.ok) throw new Error(`${u}: ${r.status}`);
      return c.put(u, r);
    })))
  ));
  // No skipWaiting: a new version must not take over a tab that is mid-session.
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
  // Probes must reach the network untouched, or the tool measures itself.
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request, {ignoreSearch: true}).then(hit => hit || fetch(e.request).catch(() => {
      return e.request.mode === 'navigate' ? caches.match('index.html') : Response.error();
    }))
  );
});
