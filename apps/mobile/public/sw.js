const cacheName='vcp-mobile-shell-v1';
self.addEventListener('install',event=>{event.waitUntil(caches.open(cacheName).then(c=>c.addAll(['/mobile/','/mobile/manifest.webmanifest','/mobile/icon.svg'])).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==cacheName).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/mobile/api/'))return;
 const shell=url.pathname==='/mobile/'||url.pathname==='/mobile/manifest.webmanifest'||url.pathname==='/mobile/icon.svg'||url.pathname.startsWith('/mobile/assets/');
 if(!shell)return;
 event.respondWith(fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();caches.open(cacheName).then(c=>c.put(event.request,copy));}return response;}).catch(()=>caches.match(event.request)));
});
