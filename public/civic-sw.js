/* PWA-lite service worker (S-75). Offline shell for /lite: HTML network-first with a cached fallback, hashed assets and the
   Telugu font cache-first. Caches same-origin static assets only. Never caches API responses (private data) and never
   fetches or caches map tiles. Reports made offline are queued by the page itself (localStorage) and sent when it is back online. */
const CACHE = "civic-lite-v2";
const SHELL = ["/lite", "/civic.webmanifest"];
const cacheable = (p) => p.startsWith("/assets/") || p.startsWith("/fonts/") || p === "/civic.webmanifest";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
/* The page lists the assets it loaded before this worker took control, so the very first visit already works offline. */
self.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.type !== "precache" || !Array.isArray(d.urls)) return;
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(d.urls.slice(0, 40).map((u) => {
    const url = new URL(u, self.location.origin);
    if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || !(cacheable(url.pathname) || url.pathname === "/lite")) return null;
    return c.add(url.pathname).catch(() => {});
  }))));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || /tile|\.pbf$/i.test(url.pathname)) return;
  if (req.mode === "navigate" && (url.pathname === "/lite" || url.pathname === "/lite/")) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("/lite", copy)); }
      return res;
    }).catch(() => caches.match("/lite").then((hit) => hit || Response.error())));
    return;
  }
  if (!cacheable(url.pathname)) return;
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }))
  );
});
