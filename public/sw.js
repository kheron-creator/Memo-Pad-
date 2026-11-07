// MemoPad service worker: keeps the app shell available offline. Audio and data come from Supabase and the IndexedDB cache.
const C = 'memopad-v2';
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(['/', '/lame.js', '/mp3-worker.js', '/logo.png', '/icon-192.png', '/favicon-64.png'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (e.request.mode === 'navigate') { const key = ['/listen.html', '/create.html', '/mix.html'].includes(u.pathname) ? u.pathname : '/'; e.respondWith(fetch(e.request).then(r => { const cl = r.clone(); caches.open(C).then(c => c.put(key, cl)); return r; }).catch(() => caches.match(key))); return; }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok && /\/(assets|lame|mp3-worker|logo|icon|favicon)/.test(u.pathname)) { const cl = r.clone(); caches.open(C).then(c => c.put(e.request, cl)); } return r; })));
});
