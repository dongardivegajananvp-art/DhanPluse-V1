const CACHE_NAME='gv2vpd-pwa-shell-v5';
const OFFLINE_ASSETS=['/manifest.webmanifest','/icons/gv2vpd.svg','/offline.html'];
const NETWORK_FIRST_ASSETS=['/style.css','/app.js','/chart-safety.js'];

self.addEventListener('install',event=>{
 event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(OFFLINE_ASSETS)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
 event.waitUntil(caches.keys()
  .then(keys=>Promise.all(keys.filter(key=>key.startsWith('gv2vpd-pwa-')&&key!==CACHE_NAME).map(key=>caches.delete(key))))
  .then(()=>self.clients.claim()));
});

self.addEventListener('fetch',event=>{
 const request=event.request;
 if(request.method!=='GET')return;
 const url=new URL(request.url);
 if(url.origin!==self.location.origin)return;
 if(url.pathname.startsWith('/api/'))return;

 if(request.mode==='navigate'){
  event.respondWith(fetch(request).then(response=>{
   if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put('/',copy));}
   return response;
  }).catch(async()=> (await caches.match('/offline.html')) || new Response('NO LIVE DATA · NO TRADE',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}})));
  return;
 }

 if(NETWORK_FIRST_ASSETS.includes(url.pathname)){
  event.respondWith(fetch(request).then(response=>{
   if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));}
   return response;
  }).catch(async()=> (await caches.match(request)) || new Response('APP ASSET UNAVAILABLE',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}})));
  return;
 }

 if(OFFLINE_ASSETS.includes(url.pathname)){
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{
   if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));}
   return response;
  })));
 }
});
