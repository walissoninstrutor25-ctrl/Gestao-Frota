const CACHE_NAME = "lots-rh-v1";
const FILES = [
  "./rh.html",
  "./rh-manifest.webmanifest",
  "./assets/lots-logo.png",
  "./assets/lots-logo-192.png",
  "./assets/lots-logo-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("message", event => {
  if(event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  // só cuidamos da "casca" do app (html/manifest/ícones) offline.
  // chamadas ao Firebase continuam indo direto pra rede (ou pela
  // persistência offline do próprio Firestore).
  if(event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then(response => response || caches.match("./rh.html"))
    )
  );
});
