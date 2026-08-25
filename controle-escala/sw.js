const CACHE_NAME = "lots-escala-v1";
const FILES = [
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./js/app.js",
  "./assets/lots-logo.png",
  "./assets/lots-logo-192.png",
  "./assets/lots-logo-512.png",
  "./data/motoristas.js",
  "./data/motoristas/grupo_01.js",
  "./data/motoristas/grupo_02.js",
  "./data/motoristas/grupo_03.js",
  "./data/motoristas/grupo_04.js",
  "./data/motoristas/grupo_05.js",
  "./data/motoristas/grupo_06.js",
  "./data/motoristas/grupo_07.js",
  "./data/motoristas/grupo_08.js",
  "./data/lideres_turno.js",
  "./data/lideres_patio.js",
  "./data/master_driver.js",
  "./data/adm5x2.js"
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
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then(response => response || caches.match("./index.html"))
    )
  );
});
