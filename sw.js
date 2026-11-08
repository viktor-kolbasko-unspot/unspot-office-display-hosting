/* Service worker киоска (R-HS-03). Без внешних зависимостей.
 * - precache: оболочка приложения (index и файлы сборки, найденные в index.html);
 * - подложки планов этажей — CacheFirst (в кэш попадают при первом показе);
 * - остальные GET своего origin — stale-while-revalidate; запросы к API не кэшируются
 *   (последний снимок данных хранится в IndexedDB, T03). */
const VERSION = 'v1';
const SHELL_CACHE = `shell-${VERSION}`;
const UNDERLAY_CACHE = `underlay-${VERSION}`;
const BASE = new URL('./', self.location.href).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const res = await fetch(BASE, { cache: 'reload' });
      const html = await res.clone().text();
      await cache.put(BASE, res);
      const assets = new Set();
      for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        const u = new URL(m[1], self.location.origin + BASE);
        if (u.origin === self.location.origin) assets.add(u.pathname);
      }
      await Promise.all([...assets].map((p) => cache.add(p).catch(() => undefined)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, UNDERLAY_CACHE]);
      for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

// Подложки этажей: публичные ссылки хранилища, по эталону
// https://storage.yandexcloud.net/unspot-prod-assets/<компания>/space-maps/<uuid>.png
// (docs/requirements/02-api-unspot.md R-API-35). Остальные имена — запас для локальных установок.
const PHOTO_HOSTS = new Set(['storage.yandexcloud.net']);
// Фото здания (R-UI-02, C-053): картинка из хранилища, кэшируется для офлайна (R-HS-03).
const isPhoto = (url) =>
  PHOTO_HOSTS.has(url.hostname) && /\.(?:png|jpe?g|webp|gif|svg)$/i.test(url.pathname);
const isUnderlay = (url) =>
  isPhoto(url) ||
  (/\/(?:space-maps|uploads?|storage|media|files|maps?)\//i.test(url.pathname) &&
    /\.(?:png|jpe?g|webp|svg)$/i.test(url.pathname));

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  const net = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || net;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match(BASE)) || Response.error()),
    );
    return;
  }
  if (isUnderlay(url)) {
    event.respondWith(cacheFirst(request, UNDERLAY_CACHE));
    return;
  }
  if (url.origin === self.location.origin && !url.pathname.startsWith('/api/')) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
