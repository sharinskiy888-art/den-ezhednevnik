const CACHE='day-planner-v110';
const ASSETS=['./?v=110','index.html?v=110','styles.css?v=110','assets/ak-buttons.css?v=110','sync-config.js?v=110','sync.js?v=110','i18n-en.js?v=110','app.js?v=110','crm.js?v=110','version.js?v=110','version.json?v=110','manifest.webmanifest','assets/icon.svg','assets/manrope-cyrillic-wght-normal.woff2','assets/manrope-latin-wght-normal.woff2','assets/icon-192.png','assets/icon-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  // Данные с сервера (/api/…) и чужие адреса не кэшируются: иначе при сбое сети показались бы старые чужие ответы.
  if(url.origin!==self.location.origin||url.pathname.includes('/api/'))return;
  if(event.request.mode==='navigate'){
    const cachedPage=()=>caches.match(event.request).then(cached=>cached||caches.match('./?v=110'));
    // Кэшируется только настоящая страница. Сервер выключен, а VPS или туннель ответил 502/404 — открываем сохранённое приложение
    // и не затираем его страницей ошибки. Переход на вход ядра (redirect) отдаём как есть и не кэшируем.
    event.respondWith(fetch(event.request).then(response=>{
      if(response.ok&&!response.redirected){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));return response;}
      if(response.type==='opaqueredirect'||response.redirected||response.status===401||response.status===403)return response; // вход в ядро — его дело
      return cachedPage().then(cached=>cached||response);
    }).catch(cachedPage));
    return;
  }
  event.respondWith(fetch(event.request).then(response=>{if(response.ok&&!response.redirected){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));return response;}return caches.match(event.request).then(cached=>cached||response);}).catch(()=>caches.match(event.request)));
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
