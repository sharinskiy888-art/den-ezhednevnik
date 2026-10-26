(function () {
  // Свой сервер «День» (FastAPI). Пустой url — сервер на том же адресе, что и приложение.
  const config = window.DAY_SERVER || {};
  const API = `${String(config.url || '').replace(/\/+$/, '')}/api`;
  const SESSION_KEY = 'day-sync-session-v1';
  const STATE_ID = '00000000-0000-4000-8000-000000000001';
  const OLD_KEY = 'day-cloud-old-v1';
  // Прежние названия таблиц Supabase остаются в app.js; на сервере они короче. CRM: «crm:clients» → /crm/clients.
  const TABLES = { planner_tasks: '/data/tasks', planner_expenses: '/data/expenses' };
  const tablePath = table => TABLES[table] || (String(table).startsWith('crm:') ? `/crm/${table.slice(4)}` : `/data/${table}`);

  // Вход, выданный другим облаком (Supabase или прежний сервер), здесь недействителен: забываем его и просим
  // войти заново. Локальные задачи не трогаются — они привязаны к id пользователя, а он при переезде сохраняется.
  function getSession() {
    let session = null;
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
    if (session?.access_token && !String(session.access_token).startsWith('den1.')) {
      localStorage.removeItem(SESSION_KEY);
      Object.keys(localStorage).filter(key => key.startsWith('day-sync-meta-v1:')).forEach(key => localStorage.removeItem(key));
      localStorage.setItem('day-cloud-moved', session?.user?.email || '1');
      // Вход Supabase не выбрасываем: им при первом входе на новый сервер забираются поручения и записи из прежнего облака.
      if (session?.user?.id && session.refresh_token && !localStorage.getItem(OLD_KEY)) {
        localStorage.setItem(OLD_KEY, JSON.stringify({ id: session.user.id, email: String(session.user.email || '').toLocaleLowerCase(),
          access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at || 0 }));
      }
      return null;
    }
    return session;
  }
  function setSession(session) {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  }
  // Если вход истёк и обновить его нельзя, не оставляем «мёртвую» сессию: иначе приложение
  // молча перестаёт синхронизироваться, а пользователь продолжает видеть статус «вошёл».
  function expireSession() { setSession(null); }
  function sessionExpiredError(cause) {
    if (cause && !(cause.status === 400 || cause.status === 401)) return cause;
    const error = new Error('Вход истёк. Войдите снова, чтобы синхронизировать задачи.');
    error.sessionExpired = true; error.status = 401; return error;
  }
  // Одно обновление входа на все запросы сразу: синхронизация и присутствие идут параллельно.
  let refreshing = null;
  function refreshOnce(refreshToken) {
    if (!refreshing) refreshing = refresh(refreshToken).finally(() => { refreshing = null; });
    return refreshing;
  }
  async function request(path, options = {}, useAuth = true, retried = false) {
    let session = getSession();
    if (useAuth && session?.expires_at && session.expires_at * 1000 < Date.now() + 60000 && session.refresh_token) {
      try { session = await refreshOnce(session.refresh_token); }
      catch (error) { if (error.status === 400 || error.status === 401) expireSession(); throw error.sessionExpired ? error : sessionExpiredError(error); }
    }
    const headers = { ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
    if (useAuth && session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    const { raw, ...fetchOptions } = options;
    const response = await fetch(`${API}${path}`, { ...fetchOptions, headers, cache: 'no-store' });
    if (!response.ok) {
      if (useAuth && response.status === 401 && session?.access_token) {
        if (!retried && session.refresh_token) {
          // Пока шёл этот запрос, другой уже обновил вход — просто повторяем с новым, старый токен не предъявляем.
          const current = getSession();
          // Пока шёл запрос, вошёл другой человек: запрос с чужими данными не повторяем и его вход не трогаем.
          if (current?.user?.id !== session.user?.id) { const error = new Error('Аккаунт сменился'); error.userChanged = true; throw error; }
          if (current?.access_token && current.access_token !== session.access_token) return request(path, options, useAuth, true);
          try { await refreshOnce(session.refresh_token); } catch (error) { if (error.status === 400 || error.status === 401) expireSession(); throw sessionExpiredError(error); }
          return request(path, options, useAuth, true);
        }
        expireSession(); throw sessionExpiredError();
      }
      let message = `Ошибка сервера: ${response.status}`;
      let code = '';
      try { const body = await response.json(); message = body.message || message; code = body.code || ''; } catch {}
      const error = new Error(message);
      error.status = response.status; error.code = code;
      error.retryAfter = Number(response.headers.get('retry-after') || 0);
      throw error;
    }
    if (raw) return response;
    if (response.status === 204) return null;
    const text = await response.text(); return text ? JSON.parse(text) : null;
  }
  const post = (path, body, useAuth = true) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) }, useAuth);
  // Регистрации «с улицы» нет: нужен код приглашения от администратора.
  async function signUp(email, password, invite) {
    const result = await post('/auth/register', { email, password, invite }, false);
    setSession(result); return result;
  }
  async function signIn(email, password) {
    const result = await post('/auth/login', { email, password }, false);
    setSession(result); return result;
  }
  async function updatePassword(password, oldPassword) {
    const account = await request('/auth/user', { method: 'PUT', body: JSON.stringify({ password, old_password: oldPassword }) });
    const session = getSession(); if (session) { session.user = account; setSession(session); } return account;
  }
  async function refresh(refreshToken) {
    const result = await post('/auth/refresh', { refresh_token: refreshToken }, false);
    setSession(result); return result;
  }
  async function signOut() {
    if (getSession()?.access_token) { try { await request('/auth/logout', { method: 'POST' }); } catch {} }
    setSession(null);
  }
  function user() { return getSession()?.user || null; }
  // Удалённые записи не стираются физически, а хранятся как «надгробия» { __deleted: true, updatedAt }.
  // Надгробие проходит через ту же логику «новее побеждает», что и обычная правка, поэтому
  // устройство со старой копией задачи не может вернуть её обратно на сервер.
  const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
  const isTombstone = payload => !!payload?.__deleted;
  async function pruneRemoteTombstones(table, ids) {
    for (const id of ids) await request(`${tablePath(table)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  // Экономная синхронизация: сначала с сервера берётся лёгкий список «id + время правки» без
  // содержимого, а полностью скачиваются только строки, чьей версии на устройстве ещё нет.
  // На сервер уходят только записи, отличающиеся от последней известной серверной версии.
  const syncMetaKey = (table, userId) => `day-sync-meta-v1:${table}:${userId}`;
  function loadSyncMeta(table, userId) {
    try { const meta = JSON.parse(localStorage.getItem(syncMetaKey(table, userId)) || 'null'); if (meta && typeof meta === 'object') return { known: meta.known || {} }; } catch {}
    return { known: {} };
  }
  function saveSyncMeta(table, userId, meta) {
    try { localStorage.setItem(syncMetaKey(table, userId), JSON.stringify(meta)); } catch {}
  }
  const idsQuery = ids => ids.map(id => encodeURIComponent(String(id))).join(',');
  async function fetchChangedRows(table, known) {
    const base = tablePath(table);
    if (!Object.keys(known).length) return { rows: await request(base, { method: 'GET' }) || [], serverIds: null };
    const heads = await request(`${base}/heads`, { method: 'GET' }) || [];
    const ids = heads.filter(row => known[row.id] !== (row.pu || row.updated_at)).map(row => row.id);
    const rows = [];
    for (let i = 0; i < ids.length; i += 50) rows.push(...(await request(`${base}?ids=${idsQuery(ids.slice(i, i + 50))}`, { method: 'GET' }) || []));
    return { rows, serverIds: new Set(heads.map(row => row.id)) };
  }
  // oldRows — строки из прежнего облака (Supabase): сливаются по тем же правилам «новее побеждает», но серверу ещё не известны.
  async function sync(table, localItems, localTombstones = {}, localState = null, oldRows = []) {
    const sessionUser = user(); if (!sessionUser) throw new Error('Сначала войдите в облако');
    const meta = loadSyncMeta(table, sessionUser.id);
    const known = { ...meta.known };
    const { rows: remoteRows, serverIds } = await fetchChangedRows(table, known);
    // Строку убрали с сервера (истёкшее надгробие) — забываем её версию, чтобы при нужде отправить заново.
    if (serverIds) Object.keys(known).forEach(id => { if (!serverIds.has(id)) delete known[id]; });
    const merged = new Map();
    const tombstones = new Map(Object.entries(localTombstones || {}));
    const newer = (a, b) => new Date(a || 0) > new Date(b || 0);
    localItems.forEach(item => merged.set(item.id, item));
    let remoteState = null;
    const absorb = (row, fromServer) => {
      const updatedAt = row.payload?.updatedAt || row.updated_at;
      if (fromServer) known[row.id] = updatedAt;
      if (row.id === STATE_ID || row.payload?.__type === 'app_state') { if (!remoteState || newer(row.payload?.updatedAt, remoteState.updatedAt)) remoteState = row.payload; return; }
      if (isTombstone(row.payload)) { if (!tombstones.has(row.id) || newer(updatedAt, tombstones.get(row.id))) tombstones.set(row.id, updatedAt); return; }
      const remoteItem = { ...row.payload, id: row.id, updatedAt };
      const localItem = merged.get(row.id);
      if (!localItem || newer(remoteItem.updatedAt, localItem.updatedAt)) merged.set(row.id, remoteItem);
    };
    remoteRows.forEach(row => absorb(row, true));
    (oldRows || []).forEach(row => { if (row?.id && row.payload && typeof row.payload === 'object') absorb(row, false); });
    // Надгробие побеждает, если оно не старше самой записи; если запись правили уже после удаления — она остаётся.
    tombstones.forEach((deletedAt, id) => {
      const item = merged.get(id);
      if (!item) return;
      if (newer(item.updatedAt, deletedAt)) tombstones.delete(id); else merged.delete(id);
    });
    const expired = [];
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    tombstones.forEach((deletedAt, id) => { if (new Date(deletedAt || 0).getTime() < cutoff) { expired.push(id); tombstones.delete(id); } });
    const result = [...merged.values()];
    const localUpdated = new Date(localState?.updatedAt || 0); const remoteUpdated = new Date(remoteState?.updatedAt || 0);
    const appState = remoteState && remoteUpdated > localUpdated ? remoteState : localState ? { __type: 'app_state', ...localState } : remoteState;
    const stamp = value => value || new Date(0).toISOString();
    const rows = [];
    result.forEach(item => { if (known[item.id] !== stamp(item.updatedAt)) rows.push({ user_id: sessionUser.id, id: item.id, payload: item, updated_at: stamp(item.updatedAt) }); });
    tombstones.forEach((deletedAt, id) => { if (known[id] !== deletedAt) rows.push({ user_id: sessionUser.id, id, payload: { id, __deleted: true, updatedAt: deletedAt }, updated_at: deletedAt }); });
    if (appState && known[STATE_ID] !== stamp(appState.updatedAt)) rows.push({ user_id: sessionUser.id, id: STATE_ID, payload: appState, updated_at: stamp(appState.updatedAt) });
    // Пока скачивали изменения, на устройстве вошёл другой человек — его аккаунт данными прежнего не заполняем.
    if (user()?.id !== sessionUser.id) { const error = new Error('Аккаунт сменился'); error.userChanged = true; throw error; }
    if (rows.length) {
      // Частями: тысячи карточек CRM или задач за раз не упираются в предел размера запроса.
      let part = []; let size = 0;
      const send = async () => { if (!part.length) return; await request(tablePath(table), { method: 'POST', body: JSON.stringify(part) }); part.forEach(row => { known[row.id] = row.updated_at; }); part = []; size = 0; };
      for (const row of rows) {
        const bytes = JSON.stringify(row).length;
        if (part.length && (part.length >= 1000 || size + bytes > 8e6)) await send();
        part.push(row); size += bytes;
      }
      await send();
    }
    if (expired.length) { await pruneRemoteTombstones(table, expired); expired.forEach(id => { delete known[id]; }); }
    saveSyncMeta(table, sessionUser.id, { known });
    return { tasks: result, tombstones: Object.fromEntries(tombstones), appState };
  }
  async function syncExpenses(localExpenses, localTombstones = {}, oldRows = []) {
    const { tasks, tombstones } = await sync('planner_expenses', localExpenses, localTombstones, null, oldRows);
    return { expenses: tasks, tombstones };
  }
  function sharedTaskFromRow(row) {
    return {
      ...(row.payload || {}),
      id: row.id,
      ownerId: row.owner_id,
      ownerEmail: row.owner_email,
      invitedEmails: (row.invited_emails || []).map(email => String(email).trim().toLocaleLowerCase()),
      acceptedEmails: (row.accepted_emails || []).map(email => String(email).trim().toLocaleLowerCase()),
      leaveRequests: (row.leave_requests || []).map(email => String(email).trim().toLocaleLowerCase()),
      updatedAt: row.payload?.updatedAt || row.updated_at,
      __rev: row.rev || '',
      __remote: true
    };
  }
  // Старый сервер без раздела поручений отвечает 404 — это «поручений нет», а не сбой.
  const emptyIfMissing = error => { if (error.status === 404) return null; throw error; };
  // Совместные задачи тоже грузятся экономно: лёгкий список «id + время правки + участники», а задача целиком
  // (с фото) скачивается, только если она изменилась с прошлой загрузки.
  let sharedCache = { userId: '', rows: new Map() };
  const sharedHeadKey = row => `${row.updated_at}|${row.pu || ''}|${(row.invited_emails || []).join(',')}|${(row.accepted_emails || []).join(',')}|${(row.leave_requests || []).join(',')}`;
  async function loadSharedTasks() {
    const sessionUser = user(); if (!sessionUser) return [];
    if (sharedCache.userId !== sessionUser.id) sharedCache = { userId: sessionUser.id, rows: new Map() };
    const heads = await request('/shared/heads', { method: 'GET' }).catch(emptyIfMissing) || [];
    const changed = heads.filter(head => sharedCache.rows.get(head.id)?.key !== sharedHeadKey(head)).map(head => head.id);
    for (let i = 0; i < changed.length; i += 50) {
      const rows = await request(`/shared?ids=${idsQuery(changed.slice(i, i + 50))}`, { method: 'GET' }) || [];
      rows.forEach(row => sharedCache.rows.set(row.id, { key: sharedHeadKey({ ...row, pu: row.payload?.updatedAt }), row }));
    }
    const visible = new Set(heads.map(head => head.id));
    [...sharedCache.rows.keys()].forEach(id => { if (!visible.has(id)) sharedCache.rows.delete(id); });
    return heads.map(head => sharedCache.rows.get(head.id)?.row).filter(Boolean).map(row => sharedTaskFromRow(structuredClone(row)));
  }
  // Свежая копия одной задачи прямо перед сохранением: чтобы правка одного участника не затирала чужие.
  async function loadSharedTask(id) {
    if (!user()) return null;
    const row = await request(`/shared/${encodeURIComponent(id)}`, { method: 'GET' }).catch(emptyIfMissing);
    return row ? sharedTaskFromRow(row) : null;
  }
  async function saveSharedTask(task) {
    const sessionUser = user(); if (!sessionUser) throw new Error('Сначала войдите в аккаунт');
    const ownerId = task.ownerId || sessionUser.id;
    const ownerEmail = (task.ownerEmail || sessionUser.email || '').toLocaleLowerCase();
    const invitedEmails = [...new Set((task.invitedEmails || []).map(email => String(email).trim().toLocaleLowerCase()).filter(Boolean))];
    const acceptedEmails = [...new Set((task.acceptedEmails || []).map(email => String(email).trim().toLocaleLowerCase()).filter(Boolean))];
    const { id, ownerId: _ownerId, ownerEmail: _ownerEmail, invitedEmails: _invited, acceptedEmails: _accepted, leaveRequests, __remote, __rev, ...payload } = task;
    const row = { id, owner_id: ownerId, owner_email: ownerEmail, invited_emails: invitedEmails, accepted_emails: acceptedEmails, payload, updated_at: task.updatedAt || new Date().toISOString() };
    sharedCache.rows.delete(id);
    if (__remote) {
      // Организатор присылает строку целиком, исполнитель — только содержимое; что кому можно, решает сервер.
      const { id: _id, ...patch } = ownerId === sessionUser.id ? row : { payload, updated_at: row.updated_at };
      if (__rev) patch.base_rev = __rev; // сервер ответит 409, если строку успели изменить после нашего чтения
      await request(`/shared/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
    } else await post('/shared', row);
    return { ...task, ownerId, ownerEmail, invitedEmails, acceptedEmails, __remote: true };
  }
  async function deleteSharedTask(id) {
    sharedCache.rows.delete(id);
    await request(`/shared/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  async function answerSharedInvite(id, accepted) {
    return post(`/shared/${encodeURIComponent(id)}/answer`, { accept: !!accepted });
  }
  // CRM. Роль: manager — синхронизирует как свои данные (sync), worker — только зеркалит то, что ему видно.
  async function crmRole() {
    if (!user()) return '';
    try { return (await request('/crm/me', { method: 'GET' }))?.role || ''; } catch (error) { if (error.status === 404) return ''; throw error; }
  }
  async function mirrorCrm(kind, cached = []) {
    if (!user()) return [];
    const base = tablePath(`crm:${kind}`); const byId = new Map(cached.map(item => [item.id, item]));
    const heads = await request(`${base}/heads`, { method: 'GET' }) || [];
    const ids = heads.filter(head => byId.get(head.id)?.updatedAt !== (head.pu || head.updated_at)).map(head => head.id);
    for (let i = 0; i < ids.length; i += 200) {
      (await request(`${base}?ids=${idsQuery(ids.slice(i, i + 200))}`, { method: 'GET' }) || []).forEach(row => byId.set(row.id, { ...row.payload, id: row.id, updatedAt: row.payload?.updatedAt || row.updated_at }));
    }
    const visible = new Set(heads.map(head => head.id));
    return [...byId.values()].filter(item => visible.has(item.id) && !isTombstone(item)); // снятое с монтажника пропадает с устройства
  }
  async function uploadCrmPhoto(objectId, blob) {
    return (await request(`/files/crm/${encodeURIComponent(objectId)}?ext=jpg`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob })).path;
  }
  async function requestLeaveShared(id) {
    return post(`/shared/${encodeURIComponent(id)}/leave`, {});
  }
  async function touchPresence(locale = 'ru') {
    if (!user()) return;
    await post('/presence', { locale: locale === 'en' ? 'en' : 'ru' }).catch(emptyIfMissing);
  }
  async function loadSharedPresence() {
    if (!user()) return [];
    return await request('/presence', { method: 'GET' }).catch(emptyIfMissing) || [];
  }
  // Push-уведомления при закрытом приложении отложены до отдельного этапа: подписка не отправляется, но и не ломает работу.
  async function savePushSubscription() { return null; }
  async function deletePushSubscription() {}
  // Фото и голосовые отчётов лежат на сервере в папке задачи, а в задаче — только путь к файлу.
  // Скачиваются они только при просмотре и запоминаются на устройстве, чтобы не тратить трафик повторно.
  const MEDIA_CACHE = 'day-shared-media-v1';
  async function uploadSharedMedia(taskId, blob, extension) {
    const result = await request(`/files/shared/${encodeURIComponent(taskId)}?ext=${encodeURIComponent(extension)}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
    const path = result.path;
    try { const cache = await caches.open(MEDIA_CACHE); await cache.put(`/media/${path}`, new Response(blob, { headers: { 'Content-Type': blob.type } })); } catch {}
    return path;
  }
  async function loadSharedMedia(path) {
    try { const cache = await caches.open(MEDIA_CACHE); const hit = await cache.match(`/media/${path}`); if (hit) return await hit.blob(); } catch {}
    const response = await request(`/files/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'GET', raw: true });
    const blob = await response.blob();
    try { const cache = await caches.open(MEDIA_CACHE); await cache.put(`/media/${path}`, new Response(blob, { headers: { 'Content-Type': blob.type } })); } catch {}
    return blob;
  }
  // Обратная связь уходит на свой сервер (раньше — на сторонний formsubmit.co).
  async function sendFeedback(message) {
    try { await post('/feedback', message, !!getSession()); }
    catch (error) { if (!error.sessionExpired) throw error; await post('/feedback', message, false); } // вход истёк — сообщение всё равно уходит
  }
  // --- Переезд из Supabase (этап 5): один раз, на устройстве, тем же входом, что был в прежнем приложении ---
  const OLD_CLOUD = config.oldSupabase || {};
  function oldCloud() {
    try { const old = JSON.parse(localStorage.getItem(OLD_KEY) || 'null'); return old?.id && OLD_CLOUD.url ? old : null; } catch { return null; }
  }
  function markOldCloud(patch) {
    const old = oldCloud(); if (!old) return null;
    const next = patch === null ? null : { ...old, ...patch };
    if (next) localStorage.setItem(OLD_KEY, JSON.stringify(next)); else localStorage.removeItem(OLD_KEY);
    return next;
  }
  // Перенос только в тот же аккаунт: если на телефоне вошёл другой человек, чужие данные ему не достаются.
  const oldCloudMine = () => { const old = oldCloud(); const me = user(); return old && me && old.email && old.email === String(me.email || '').toLocaleLowerCase() ? old : null; };
  // Каждый запрос к прежнему облаку — не дольше 20 с: зависшее облако не должно держать синхронизацию.
  const oldFetch = (url, options) => fetch(url, { ...options, cache: 'no-store', signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined });
  async function oldRequest(path, options = {}, retried = false) {
    let old = oldCloud(); if (!old) throw Object.assign(new Error('Нет входа прежнего облака'), { fatal: true });
    if (!old.expires_at || old.expires_at * 1000 < Date.now() + 60000 || retried) old = await oldRefreshOnce(old);
    const response = await oldFetch(`${OLD_CLOUD.url}${path}`, { ...options, headers: { apikey: OLD_CLOUD.anonKey, Authorization: `Bearer ${old.access_token}`, ...(options.headers || {}) } });
    if (response.status === 401 && !retried) return oldRequest(path, options, true);
    if (!response.ok) throw Object.assign(new Error(`Прежнее облако: ${response.status}`), { status: response.status });
    return response;
  }
  // Токен Supabase одноразовый: два обновления сразу отозвали бы вход, поэтому обновление одно на всех.
  let oldRefreshing = null;
  function oldRefreshOnce(old) {
    if (!oldRefreshing) oldRefreshing = oldRefresh(old).finally(() => { oldRefreshing = null; });
    return oldRefreshing;
  }
  async function oldRefresh(old) {
    const response = await oldFetch(`${OLD_CLOUD.url}/auth/v1/token?grant_type=refresh_token`, { method: 'POST',
      headers: { apikey: OLD_CLOUD.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: old.refresh_token }) });
    // 400/401 — вход прежнего облака истёк навсегда: повторять бессмысленно.
    if (!response.ok) throw Object.assign(new Error(`Вход прежнего облака не обновился: ${response.status}`), { status: response.status, fatal: response.status === 400 || response.status === 401 });
    const result = await response.json();
    return markOldCloud({ access_token: result.access_token, refresh_token: result.refresh_token, expires_at: result.expires_at || Math.floor(Date.now() / 1000) + (result.expires_in || 3600) });
  }
  async function oldList(query) {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await (await oldRequest(`/rest/v1/${query}&order=id.asc&limit=1000&offset=${offset}`)).json();
      out.push(...page); if (page.length < 1000) return out;
    }
  }
  // Личные задачи, планы и финансы из прежнего облака (на случай, если на этом телефоне чего-то не было).
  async function loadOldPersonal() {
    const old = oldCloudMine(); if (!old) return null;
    const own = `user_id=eq.${encodeURIComponent(old.id)}`;
    return { tasks: await oldList(`planner_tasks?select=id,payload,updated_at&${own}`), expenses: await oldList(`planner_expenses?select=id,payload,updated_at&${own}`) };
  }
  const MEDIA_RE = /^shared\/([A-Za-z0-9_-]{1,100})\/([A-Za-z0-9-]{1,100}\.[a-z0-9]{2,5})$/;
  // Сбой, после которого продолжать нет смысла (вход, сеть, лимит облака): попытка целиком повторится позже.
  const stopsImport = error => error.fatal || error.sessionExpired || !error.status || error.status === 401 || error.status === 402 || error.status === 429 || error.status >= 500;
  // Поручения, где этот человек организатор, и файлы их отчётов (имена прежние). Готовые задачи и файлы запоминаются,
  // чтобы повторная попытка не скачивала их из Supabase снова; задача с постоянной ошибкой пропускается, а не повторяется.
  async function importOldShared() {
    const old = oldCloudMine(); if (!old) return null;
    const rows = await oldList(`shared_tasks?select=id,invited_emails,accepted_emails,payload,updated_at&owner_id=eq.${encodeURIComponent(old.id)}`);
    const progress = { tasks: {}, files: {}, ...(old.sharedProgress || {}) };
    const save = () => markOldCloud({ sharedProgress: progress });
    for (const row of rows) {
      if (progress.tasks[row.id]) continue;
      const { id: _id, ownerId, ownerEmail, invitedEmails, acceptedEmails, leaveRequests, __remote, ...payload } = row.payload || {};
      try {
        const result = await post('/migration/shared', { id: row.id, invited_emails: row.invited_emails || [], accepted_emails: row.accepted_emails || [], payload, updated_at: row.updated_at || payload.updatedAt || new Date().toISOString() });
        progress.tasks[row.id] = result?.imported ? 'imported' : 'skipped';
      } catch (error) {
        if (stopsImport(error)) { save(); throw error; }
        progress.tasks[row.id] = 'failed'; save(); continue;
      }
      const paths = (Array.isArray(payload.reports) ? payload.reports : []).flatMap(report => [report?.photo, report?.voice]).filter(path => typeof path === 'string');
      for (const path of new Set(paths)) {
        if (progress.files[path]) continue;
        const match = MEDIA_RE.exec(path);
        if (!match || match[1] !== row.id) { progress.files[path] = 'failed'; continue; }
        try {
          const blob = await (await oldRequest(`/storage/v1/object/authenticated/attachments/${path}`)).blob();
          await request(`/files/shared/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`, { method: 'PUT', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
          progress.files[path] = 'ok';
        } catch (error) {
          if (error.status === 409) progress.files[path] = 'ok'; // уже лежит на сервере
          else if (stopsImport(error)) { save(); throw error; }
          else progress.files[path] = 'failed';
        }
        save();
      }
      save();
    }
    const count = (list, value) => Object.values(list).filter(v => v === value).length;
    return { found: rows.length, imported: count(progress.tasks, 'imported'), skipped: count(progress.tasks, 'skipped'), failed: count(progress.tasks, 'failed'),
      files: count(progress.files, 'ok'), filesFailed: count(progress.files, 'failed') };
  }
  // Копейки — по десятичной записи числа, а не умножением (19.995 * 100 в JS даёт 1999.4999…). Так же считает сервер.
  function toKop(value) {
    const n = Number(value); if (!Number.isFinite(n)) return 0n;
    if (Math.abs(n) >= 1e21) return BigInt(n) * 100n;
    const text = String(Math.abs(n));
    if (/e/i.test(text)) return 0n; // меньше 0,000001 ₽
    const [whole, frac = ''] = text.split('.');
    let kop = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
    if ((frac[2] || '0') >= '5') kop += 1n;
    return n < 0 ? -kop : kop;
  }
  async function reportCounts(counts, supabase, device, label) {
    return post('/migration/report', { device, label, counts, ...(supabase ? { supabase } : {}) });
  }
  window.DaySync = { oldCloud, oldCloudMine, markOldCloud, loadOldPersonal, importOldShared, toKop, reportCounts, uploadSharedMedia, loadSharedMedia, getSession, user, signUp, signIn, signOut, updatePassword, sync, syncExpenses, loadSharedTasks, loadSharedTask, saveSharedTask, deleteSharedTask, answerSharedInvite, requestLeaveShared, crmRole, mirrorCrm, uploadCrmPhoto, touchPresence, loadSharedPresence, savePushSubscription, deletePushSubscription, sendFeedback };
})();
