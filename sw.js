// Offline copy of Training Plan.
// The app itself: network first (so updates show up right away), falling back to the saved copy.
// Google Fonts: cache first (they never change). Everything else (GitHub sync) goes straight to the network.
const CACHE = "training-plan-v1";

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.add("./")).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === "opaque") c.put(req, res.clone());
      return res;
    }));
    return;
  }

  if (url.origin !== location.origin) return;
  // Version checks (?check=…) must always hit the network and never be saved.
  if (url.searchParams.has("check")) return;

  // Every page URL (?v=…, #share=…) shares one cached copy of the app.
  const key = req.mode === "navigate" ? "./" : req;
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key).then(hit => hit || caches.match("./"))));
});
