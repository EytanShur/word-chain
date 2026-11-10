// Offline support: every file is cached on first visit. Pages are served from the cache at once and
// refreshed in the background, so a new version shows up on the next launch.
const CACHE = 'wordchain-v1';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'memory.js', 'packs.js', 'manifest.webmanifest',
  'fonts/anton.ttf', 'fonts/bebas_neue.ttf',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
  ...['beep', 'buzz', 'correct', 'fanfare', 'go', 'skip', 'tap', 'tick', 'timesup', 'unlock', 'wrong']
    .map(s => `sounds/${s}.wav`),
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req)
      .then(res => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => hit);
    if (hit) {
      e.waitUntil(fresh);
      return hit;
    }
    return fresh;
  }));
});
