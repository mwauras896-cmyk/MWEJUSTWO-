self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(clients.claim()));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.pathname.startsWith('/api'))return;e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open('m1').then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request)))});
