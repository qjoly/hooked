/// <reference types="@sveltejs/kit" />
import { build, files, version } from '$service-worker';

// Only hashed build assets and static files are cached: they are immutable, so no stale-shell
// risk. Navigations, /api/* and the SSE stream always go to the network — hooked is a live
// dashboard, an offline shell would show a lie.
const CACHE = `hooked-${version}`;
const ASSETS = [...build, ...files];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!ASSETS.includes(url.pathname)) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => (await cache.match(url.pathname)) ?? fetch(request)),
  );
});
