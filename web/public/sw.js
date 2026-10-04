// Offline support: everything the app needs is cached at install, so it works in the garage after a single visit.
// The page itself is network-first (so updates arrive), everything else cache-first.
// The build fills in VERSION (a hash of the built files) and PRECACHE (their list); a new build replaces the old cache.
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(['./', ...PRECACHE])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== self.location.origin && !isFont) return;
  const put = res => { if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return res; };
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(put).catch(() => caches.match(req, { ignoreVary: true }).then(r => r || caches.match('./index.html', { ignoreVary: true }))));
    return;
  }
  // ignoreVary: servers often send `Vary: Origin`, and the page's crossorigin script and stylesheet requests carry an Origin
  // header that the install-time requests didn't, so a strict match would miss them offline
  e.respondWith(caches.match(req, { ignoreVary: true }).then(hit => hit || fetch(req).then(put)));
});
