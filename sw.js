const CACHE='day-planner-v28';
const ASSETS=['./?v=28','index.html?v=28','styles.css?v=28','sync-config.js?v=28','sync.js?v=28','app-part1.js?v=28','app-part2.js?v=28','app-part3.js?v=28','manifest.webmanifest','assets/icon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r;}).catch(()=>e.request.mode==='navigate'?caches.match('./?v=28'):Response.error())));});
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(windows=>{for(const client of windows){if('focus' in client)return client.focus();}if(clients.openWindow)return clients.openWindow('./');}));});
