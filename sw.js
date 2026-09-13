const CACHE_NAME = 'su-shell-__BUILD_ID__';
const SHELL = ['/', '/index.html', '/styles.css', '/config.js', '/app.js', '/boot.js', '/manifest.webmanifest', '/favicon.svg', '/apple-touch-icon.png'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL.map(path => new Request(path, { cache: 'reload' })));
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if ((name.startsWith('su-shell-') || name.startsWith('su-netlify-')) && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => { if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting(); });
async function shellResponse(request, path) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(path);
  if (cached) return cached;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (!response.ok) throw new Error('unavailable');
    return response;
  } catch {
    if (request.mode === 'navigate') return new Response('<!doctype html><html lang="tr"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Su</title><body style="font:18px system-ui;padding:32px;background:#f2f1eb;color:#10262e"><h1>Su</h1><p>Uygulama dosyaları henüz bu cihaza kaydedilmemiş. İnternet bağlantısıyla tekrar aç.</p><button style="font:inherit;padding:12px" onclick="location.reload()">Tekrar dene</button></body></html>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    return new Response('Bağlantı kurulamadı.', { status: 503 });
  } finally { clearTimeout(timer); }
}
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/.netlify/')) return;
  if (event.request.mode === 'navigate') event.respondWith(shellResponse(event.request, '/index.html'));
  else if (SHELL.includes(url.pathname)) event.respondWith(shellResponse(event.request, url.pathname));
});
self.addEventListener('push', event => {
  let data;
  try { data = event.data?.json() || {}; } catch { data = {}; }
  event.waitUntil(self.registration.showNotification(data.title || 'Su', {
    body: data.body || 'Su içmeyi unutma.', icon: '/apple-touch-icon.png', badge: '/apple-touch-icon.png',
    tag: data.tag || 'su-hatirlatma', data: { url: data.url || '/' }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.navigate(target.href); return existing.focus(); }
    return self.clients.openWindow(target.href);
  })());
});
