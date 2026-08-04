const CACHE_NAME = "lots-frota-v1";
const FILES = [
  "./index.html",
  "./manifest.webmanifest",
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

self.addEventListener("fetch", event => {
  // só cuidamos da "casca" do app (html/manifest/ícones) offline.
  // chamadas ao Firebase continuam indo direto pra rede (ou pela
  // persistência offline do próprio Firestore).
  if(event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then(response => response || caches.match("./index.html"))
    )
  );
});
