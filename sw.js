const CACHE_NAME = "performance-calculators-v9";
const APP_SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./data.js",
  "./lrc_data.js",
  "./lrc_altitude_limits_data.js",
  "./driftdown_data.js",
  "./eo_diversion_data.js",
  "./flaps_up_data.js",
  "./diversion_data.js",
  "./go_around_data.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("message", (event) => {
  if (event?.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) return caches.delete(key);
            return Promise.resolve();
          }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  const appShellPathSet = new Set(APP_SHELL_ASSETS.map((asset) => new URL(asset, self.location.href).pathname));
  const isNavigation = event.request.mode === "navigate";
  const isAppShellAsset = appShellPathSet.has(requestUrl.pathname);

  const networkFirst = async (cacheKey) => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const networkResponse = await fetch(event.request, { cache: "no-store" });
      if (networkResponse && networkResponse.ok) {
        await cache.put(cacheKey, networkResponse.clone());
      }
      return networkResponse;
    } catch (error) {
      const cached = await cache.match(cacheKey, { ignoreSearch: true });
      if (cached) return cached;
      throw error;
    }
  };

  if (isNavigation || isAppShellAsset) {
    event.respondWith(networkFirst(isNavigation ? "./index.html" : event.request));
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cachedResponse = await cache.match(event.request, { ignoreSearch: true });
      const networkPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        })
        .catch(() => null);

      if (cachedResponse) {
        networkPromise.catch(() => {});
        return cachedResponse;
      }
      const networkResponse = await networkPromise;
      if (networkResponse) return networkResponse;
      return new Response("Offline", { status: 503, statusText: "Offline" });
    }),
  );
});
