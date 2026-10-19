const CACHE = 'mwe-v2';
const SHELL = ['/', '/index.html', '/logo.png', '/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api')) return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok && u.origin === location.origin) {
          const c = r.clone();
          caches.open(CACHE).then(x => x.put(e.request, c));
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
