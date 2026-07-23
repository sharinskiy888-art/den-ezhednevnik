const CACHE='day-planner-v58';
const ASSETS=['./?v=58','index.html?v=58','styles.css?v=58','sync-config.js?v=58','sync.js?v=58','app.js?v=58','reset.html?v=58','version.js?v=58','version.json?v=58','manifest.webmanifest','assets/icon.svg','assets/icon-192.png','assets/icon-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  if(event.request.mode==='navigate'){
    event.respondWith(fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));return response;}).catch(()=>caches.match(event.request).then(cached=>cached||caches.match('./?v=58'))));
    return;
  }
  event.respondWith(fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));return response;}).catch(()=>caches.match(event.request)));
});
self.addEventListener('push',event=>{
  let payload={};
  try{payload=event.data?.json()||{};}catch{payload={body:event.data?.text()||''};}
  const title=payload.title||'День';
  const options={
    body:payload.body||'У вас есть запланированное дело.',
    icon:'assets/icon-192.png',
    badge:'assets/icon-192.png',
    tag:payload.tag||'day-reminder',
    renotify:payload.renotify!==false,
    requireInteraction:payload.requireInteraction!==false,
    silent:false,
    vibrate:[220,90,220,90,320],
    timestamp:payload.timestamp||Date.now(),
    actions:[{action:'open',title:payload.openLabel||'Открыть'}],
    data:{url:payload.url||(payload.taskId?`./?openTask=${encodeURIComponent(payload.taskId)}`:'./'),taskId:payload.taskId||null}
  };
  event.waitUntil(Promise.all([
    self.registration.showNotification(title,options),
    clients.matchAll({type:'window',includeUncontrolled:true}).then(windows=>Promise.all(windows.map(client=>client.postMessage({type:'DAY_PUSH',title,body:options.body,taskId:options.data.taskId}))))
  ]));
});
self.addEventListener('notificationclick',event=>{event.notification.close();const target=event.notification.data?.url||'./';event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(async windows=>{for(const client of windows){if('navigate' in client)await client.navigate(target);if('focus' in client)return client.focus();}if(clients.openWindow)return clients.openWindow(target);}));});
