const CACHE_NAME='gv2vpd-pwa-shell-v8';
const OFFLINE_ASSETS=['/manifest.webmanifest','/icons/gv2vpd-192.svg','/icons/gv2vpd-512.svg','/icons/gv2vpd.svg','/offline.html'];
const APP_SHELL_ASSETS=['/','/style.css','/app.js','/chart-safety.js','/chart-plan-cache.js','/pwa-register.js'];
const APP_SHELL_PATHS=new Set(APP_SHELL_ASSETS);

function isWorkstationHtml(response){
 if(!response||!response.ok||!String(response.headers?.get?.('content-type')||'').toLowerCase().includes('text/html'))return Promise.resolve(false);
 return response.clone().text().then(html=>/<title>\s*GV2VPD\s*\|\s*Live Trading Workstation/i.test(html)&&/id=["']feedState["']/.test(html)).catch(()=>false);
}

async function isValidShellResponse(path,response){
 if(!response||!response.ok)return false;
 const contentType=String(response.headers?.get?.('content-type')||'').toLowerCase();
 if(path==='/'||path.endsWith('.html'))return isWorkstationHtml(response);
 return !contentType.includes('text/html');
}

self.addEventListener('install',event=>{
 event.waitUntil((async()=>{
  const cache=await caches.open(CACHE_NAME);
  await Promise.all([...OFFLINE_ASSETS,...APP_SHELL_ASSETS].map(async path=>{
   try{
    const response=await fetch(path,{cache:'reload',credentials:'same-origin'});
    if(path==='/'||APP_SHELL_PATHS.has(path)){
     if(await isValidShellResponse(path,response))await cache.put(path,response.clone());
    }else if(response.ok){
     await cache.put(path,response.clone());
    }
   }catch{}
  }));
  await self.skipWaiting();
 })());
});

self.addEventListener('activate',event=>{
 event.waitUntil((async()=>{
  const keys=await caches.keys();
  const current=await caches.open(CACHE_NAME);
  for(const key of keys.filter(name=>name.startsWith('gv2vpd-pwa-')&&name!==CACHE_NAME)){
   const previous=await caches.open(key);
   for(const path of [...OFFLINE_ASSETS,...APP_SHELL_ASSETS]){
    if(await current.match(path))continue;
    const response=await previous.match(path);
    if(response)await current.put(path,response);
   }
   await caches.delete(key);
  }
  await self.clients.claim();
 })());
});

self.addEventListener('fetch',event=>{
 const request=event.request;
 if(request.method!=='GET')return;
 const url=new URL(request.url);
 if(url.origin!==self.location.origin)return;
 if(url.pathname.startsWith('/api/'))return;

 if(request.mode==='navigate'){
  const cachedPromise=caches.open(CACHE_NAME).then(cache=>cache.match('/'));
  const refreshPromise=fetch(request).then(async response=>{
   if(await isWorkstationHtml(response)){
    const cache=await caches.open(CACHE_NAME);
    await cache.put('/',response.clone());
    return response;
   }
   const cached=await cachedPromise;
   if(cached)return cached;
   if(!response.ok)return (await caches.match('/offline.html'))||response;
   return response;
  }).catch(async()=>{
   return (await cachedPromise)||(await caches.match('/offline.html'))||new Response('NO LIVE DATA · NO TRADE',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  });
  event.respondWith(cachedPromise.then(cached=>cached||refreshPromise));
  event.waitUntil(refreshPromise.then(()=>undefined).catch(()=>undefined));
  return;
 }

 if(APP_SHELL_PATHS.has(url.pathname)){
  const cachedPromise=caches.open(CACHE_NAME).then(cache=>cache.match(request));
  const refreshPromise=fetch(request).then(async response=>{
   if(await isValidShellResponse(url.pathname,response)){
    const cache=await caches.open(CACHE_NAME);
    await cache.put(request,response.clone());
    return response;
   }
   return (await cachedPromise)||response;
  }).catch(async()=>{
   return (await cachedPromise)||new Response('APP ASSET UNAVAILABLE',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  });
  event.respondWith(cachedPromise.then(cached=>cached||refreshPromise));
  event.waitUntil(refreshPromise.then(()=>undefined).catch(()=>undefined));
  return;
 }

 if(OFFLINE_ASSETS.includes(url.pathname)){
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{
   if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));}
   return response;
  })));
 }
});
