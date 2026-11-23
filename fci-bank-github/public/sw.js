const V = 'fci-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.pathname.startsWith('/api/')) return;           // live data is never cached
  if (/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) {                    // fonts: stale-while-revalidate
    e.respondWith(caches.open(V).then(async c => { const hit = await c.match(r); const net = fetch(r).then(x => { c.put(r, x.clone()); return x; }).catch(() => hit); return hit || net; }));
    return;
  }
  if (u.origin !== location.origin) return;
  e.respondWith(fetch(r).then(x => { if (x.ok) { const cp = x.clone(); caches.open(V).then(c => c.put(r.mode === 'navigate' ? '/' : r, cp)); } return x; })
    .catch(() => caches.match(r.mode === 'navigate' ? '/' : r)));                // network first, cached shell when offline
});
