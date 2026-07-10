// Calculator 2 — Service Worker
// v3: fixes the page (index.html) never being cached, and adds
// stale-while-revalidate so the offline cache keeps itself fresh
// automatically instead of going stale after "a long time".
const CACHE_NAME = 'calc-v3-cache';

// Cache buckets we never want to sweep on activate (e.g. the
// Transformers.js model cache, which stores its own large files).
const PROTECTED_CACHES = [CACHE_NAME, 'transformers-cache'];

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CACHE_URLS') {
    event.waitUntil(
      caches.open(CACHE_NAME).then(async (cache) => {
        const urls = event.data.payload || [];
        // Cache each URL individually (not cache.addAll) so a single
        // failing/opaque cross-origin request can't abort the whole batch.
        await Promise.all(urls.map(async (url) => {
          try {
            const req = new Request(url, { cache: 'reload' });
            const res = await fetch(req);
            if (res && (res.ok || res.type === 'opaque')) {
              await cache.put(req, res);
            }
          } catch (e) {
            // Ignore individual failures (e.g. offline) — best effort.
          }
        }));
        // Tell the page we're done so it can update the UI.
        const clientsList = await self.clients.matchAll();
        clientsList.forEach(c => c.postMessage({ type: 'CACHE_URLS_DONE' }));
      })
    );
  }
});

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => !PROTECTED_CACHES.includes(k)).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle simple GETs over http(s) — everything else passes straight through.
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;

  // Page navigations: network-first (so you always get the latest page
  // when online), falling back to whatever we have cached when offline.
  // This is the fix for "the page itself never loads offline" — previously
  // index.html was never added to the cache at all.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match('./'))
        )
    );
    return;
  }

  // Hugging Face model/weight files: Transformers.js already caches
  // these itself (in the 'transformers-cache' bucket) using its own
  // download/retry logic, which handles these large multi-hundred-MB
  // files better than a blind cache.put here would. We still let
  // caches.match() below find them there for offline use — we just
  // don't duplicate the storage.
  const host = (() => { try { return new URL(req.url).hostname; } catch(e){ return ''; } })();
  const isModelHost = /huggingface\.co$|hf\.co$/.test(host);

  // Everything else (CDN scripts/styles/fonts/etc): cache-first for
  // instant + offline-safe responses, but always refresh the cache in
  // the background when a network connection is available
  // (stale-while-revalidate). This means the cache keeps itself up to
  // date every time the app is used online, so it never goes "stale"
  // from lack of a manual re-save.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (!isModelHost && res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => null);
      return cached || network;
    })
  );
});
