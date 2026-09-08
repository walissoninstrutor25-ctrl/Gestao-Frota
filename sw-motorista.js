const CACHE = 'lots-motorista-v1';
self.addEventListener('install', (e)=>{ self.skipWaiting(); });
self.addEventListener('activate', (e)=>{ self.clients.claim(); });
self.addEventListener('message', (e)=>{ if(e.data==='SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', (e)=>{
  // sempre busca da rede primeiro (dados de frota mudam o tempo todo) — cache é só um fallback offline básico
  e.respondWith(
    fetch(e.request).catch(()=> caches.match(e.request))
  );
});
