const CACHE_NAME = 'gv2vpd-shell-v5-24tab';
const SHELL = ['./', './index.html', './style.css?v=gv2vpd-20261112-24tab', './app.js?v=gv2vpd-20261112-audit', './manifest.webmanifest', './gv2vpd-icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => (key.startsWith('dhanpulse-shell-') || key.startsWith('gv2vpd-shell-')) && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(fetch(request, { cache: 'no-store' }).then(response => {
    if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    return response;
  }).catch(async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') return (await caches.match('./')) || (await caches.match('./index.html'));
    return Response.error();
  }));
});
