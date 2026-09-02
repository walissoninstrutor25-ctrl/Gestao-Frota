// Sobe junto com o "?v=" do index.html a cada deploy (ver APP_BUILD no
// topo do index.html) — força o navegador a buscar os arquivos de novo
// em vez de continuar servindo uma versão antiga do cache HTTP normal,
// que o fetch() abaixo (rede primeiro) não contorna sozinho.
const BUILD = "20260826-26";
const CACHE_NAME = "lots-escala-" + BUILD;
const FILES = [
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css?v=" + BUILD,
  "./js/app.js?v=" + BUILD,
  "./js/firebase-sync.js?v=" + BUILD,
  "./assets/lots-logo.png",
  "./assets/lots-logo-192.png",
  "./assets/lots-logo-512.png",
  "./data/motoristas.js?v=" + BUILD,
  "./data/motoristas/grupo_01.js?v=" + BUILD,
  "./data/motoristas/grupo_02.js?v=" + BUILD,
  "./data/motoristas/grupo_03.js?v=" + BUILD,
  "./data/motoristas/grupo_04.js?v=" + BUILD,
  "./data/motoristas/grupo_05.js?v=" + BUILD,
  "./data/motoristas/grupo_06.js?v=" + BUILD,
  "./data/motoristas/grupo_07.js?v=" + BUILD,
  "./data/motoristas/grupo_08.js?v=" + BUILD,
  "./data/lideres_turno.js?v=" + BUILD,
  "./data/lideres_patio.js?v=" + BUILD,
  "./data/master_driver.js?v=" + BUILD,
  "./data/adm5x2.js?v=" + BUILD
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
  if (new URL(event.request.url).origin !== self.location.origin) return; // deixa passar direto (Firebase, fontes, etc.)
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then(response => response || caches.match("./index.html"))
    )
  );
});
