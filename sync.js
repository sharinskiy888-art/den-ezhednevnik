(function () {
  const config = window.SUPABASE_CONFIG;
  const SESSION_KEY = 'day-sync-session-v1';
  const STATE_ID = '00000000-0000-4000-8000-000000000001';

  // Вход, выданный другим облаком (после переезда на новый проект Supabase), здесь недействителен:
  // забываем его и просим войти заново. Локальные задачи при этом не трогаются — они привязаны к id
  // пользователя, а он при переезде сохраняется.
  function tokenIssuer(token = '') {
    try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).iss || ''; } catch { return ''; }
  }
  function getSession() {
    let session = null;
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
    const issuer = tokenIssuer(session?.access_token);
    if (issuer && config.url && !issuer.startsWith(config.url)) {
      localStorage.removeItem(SESSION_KEY);
      Object.keys(localStorage).filter(key => key.startsWith('day-sync-meta-v1:')).forEach(key => localStorage.removeItem(key));
      localStorage.setItem('day-cloud-moved', session?.user?.email || '1');
      return null;
    }
    return session;
  }
  function setSession(session) {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  }
  // Если вход в облако истёк и обновить его нельзя, не оставляем «мёртвую» сессию: иначе приложение
  // молча перестаёт синхронизироваться, а пользователь продолжает видеть статус «вошёл».
  function expireSession() { setSession(null); }
  function sessionExpiredError(cause) {
    if (cause && !(cause.status === 400 || cause.status === 401)) return cause;
    const error = new Error('Вход в облако истёк. Войдите снова, чтобы синхронизировать задачи.');
    error.sessionExpired = true; error.status = 401; return error;
  }
  async function request(path, options = {}, useAuth = true, retried = false) {
    let session = getSession();
    if (useAuth && session?.expires_at && session.expires_at * 1000 < Date.now() + 60000 && session.refresh_token) {
      try { session = await refresh(session.refresh_token); }
      catch (error) { if (error.status === 400 || error.status === 401) expireSession(); throw error.sessionExpired ? error : sessionExpiredError(error); }
    }
    const headers = { apikey: config.anonKey, 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (useAuth && session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    const response = await fetch(`${config.url}${path}`, { ...options, headers });
    if (!response.ok) {
      if (useAuth && response.status === 401 && session?.access_token) {
        if (!retried && session.refresh_token) {
          try { await refresh(session.refresh_token); } catch (error) { if (error.status === 400 || error.status === 401) expireSession(); throw sessionExpiredError(error); }
          return request(path, options, useAuth, true);
        }
        expireSession(); throw sessionExpiredError();
      }
      let message = `Ошибка облака: ${response.status}`;
      try { const body = await response.json(); message = body.msg || body.message || body.error_description || message; } catch {}
      const error = new Error(message);
      error.status = response.status;
      error.retryAfter = Number(response.headers.get('retry-after') || 0);
      throw error;
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') return null;
    const text = await response.text(); return text ? JSON.parse(text) : null;
  }
  async function signUp(email, password) {
    const redirect = new URL('./', location.href).href;
    const result = await request(`/auth/v1/signup?redirect_to=${encodeURIComponent(redirect)}`, { method: 'POST', body: JSON.stringify({ email, password }) }, false);
    if (result.access_token) setSession(result);
    return result;
  }
  async function signIn(email, password) {
    const result = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) }, false);
    setSession(result); return result;
  }
  async function resetPassword(email) {
    const redirect = new URL('reset.html', location.href).href;
    return request(`/auth/v1/recover?redirect_to=${encodeURIComponent(redirect)}`, { method: 'POST', body: JSON.stringify({ email }) }, false);
  }
  async function verifyRecoveryCode(email, token) {
    const result = await request('/auth/v1/verify', { method: 'POST', body: JSON.stringify({ email, token, type: 'recovery' }) }, false);
    if (!result?.access_token) throw new Error('Код не подтверждён. Запросите новый код и попробуйте ещё раз.');
    setSession(result); return result;
  }
  async function consumeRecoveryFromUrl() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, '')); const query = new URLSearchParams(location.search);
    const error = hash.get('error_description') || query.get('error_description') || hash.get('error') || query.get('error');
    const type = hash.get('type') || query.get('type'); const accessToken = hash.get('access_token') || query.get('access_token');
    const recoveryIntent = type === 'recovery' || query.get('recovery') === '1';
    const signupIntent = type === 'signup' && !!accessToken;
    if (!error && !recoveryIntent && !signupIntent) return false;
    // A home-screen shortcut can permanently re-launch at the exact URL it was created from —
    // including one-time tokens in the hash/query. If we already tried (and failed on) this
    // exact link, don't attempt it again or nag the user every single time the app opens.
    const signature = `${hash.toString()}|${query.toString()}`;
    const HANDLED_KEY = 'day-auth-link-handled';
    if (localStorage.getItem(HANDLED_KEY) === signature) return false;
    try {
      if (error) throw new Error(error.replace(/\+/g, ' '));
      if (signupIntent) {
        const session = { access_token: accessToken, refresh_token: hash.get('refresh_token') || query.get('refresh_token') || '', token_type: hash.get('token_type') || query.get('token_type') || 'bearer', expires_at: Math.floor(Date.now() / 1000) + Number(hash.get('expires_in') || query.get('expires_in') || 3600), user: null };
        const account = await request('/auth/v1/user', { headers: { Authorization: `Bearer ${accessToken}` } }, false);
        session.user = account; setSession(session);
        return 'signup';
      }
      if (!accessToken) throw new Error('Ссылка не содержит кода восстановления. Запросите новое письмо.');
      const session = { access_token: accessToken, refresh_token: hash.get('refresh_token') || query.get('refresh_token') || '', token_type: hash.get('token_type') || query.get('token_type') || 'bearer', expires_at: Math.floor(Date.now() / 1000) + Number(hash.get('expires_in') || query.get('expires_in') || 3600), user: null };
      setSession(session);
      history.replaceState(null, '', `${location.pathname}?recovery=1`);
      return 'recovery';
    } catch (err) {
      localStorage.setItem(HANDLED_KEY, signature); throw err;
    } finally {
      // Always clear one-time auth params from the URL — success or failure — so a stale/expired
      // link saved as a home-screen shortcut can't keep re-triggering (and re-failing) on every launch.
      if (location.pathname && !location.search.includes('recovery=1')) history.replaceState(null, '', location.pathname);
    }
  }
  async function updatePassword(password) {
    const account = await request('/auth/v1/user', { method: 'PUT', body: JSON.stringify({ password }) });
    const session = getSession(); if (session) { session.user = account; setSession(session); } return account;
  }
  async function refresh(refreshToken) {
    const result = await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }) }, false);
    setSession(result); return result;
  }
  async function signOut() {
    if (getSession()?.access_token) { try { await request('/auth/v1/logout', { method: 'POST' }); } catch {} }
    setSession(null);
  }
  function user() { return getSession()?.user || null; }
  // Удалённые записи не стираются физически, а хранятся как «надгробия» { __deleted: true, updatedAt }.
  // Надгробие проходит через ту же логику «новее побеждает», что и обычная правка, поэтому
  // устройство со старой копией задачи не может вернуть её обратно в облако.
  const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
  const isTombstone = payload => !!payload?.__deleted;
  async function pruneRemoteTombstones(table, ids) {
    for (const id of ids) await request(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }
  // Экономная синхронизация: сначала с сервера берётся лёгкий список «id + время правки» без
  // содержимого, а полностью скачиваются только строки, чьей версии на устройстве ещё нет.
  // На сервер уходят только записи, отличающиеся от последней известной серверной версии.
  // Раньше каждые 15 секунд все задачи (с фото) скачивались целиком — это исчерпало лимит трафика Supabase.
  const syncMetaKey = (table, userId) => `day-sync-meta-v1:${table}:${userId}`;
  function loadSyncMeta(table, userId) {
    try { const meta = JSON.parse(localStorage.getItem(syncMetaKey(table, userId)) || 'null'); if (meta && typeof meta === 'object') return { known: meta.known || {} }; } catch {}
    return { known: {} };
  }
  function saveSyncMeta(table, userId, meta) {
    try { localStorage.setItem(syncMetaKey(table, userId), JSON.stringify(meta)); } catch {}
  }
  async function fetchChangedRows(table, known) {
    const full = `/rest/v1/${table}?select=id,payload,updated_at`;
    if (!Object.keys(known).length) return { rows: await request(full, { method: 'GET' }) || [], serverIds: null };
    const heads = await request(`/rest/v1/${table}?select=id,updated_at,pu:payload->>updatedAt`, { method: 'GET' }) || [];
    const ids = heads.filter(row => known[row.id] !== (row.pu || row.updated_at)).map(row => row.id);
    const rows = [];
    for (let i = 0; i < ids.length; i += 50) {
      const list = ids.slice(i, i + 50).map(id => `"${String(id).replace(/"/g, '')}"`).join(',');
      rows.push(...(await request(`${full}&id=in.(${encodeURIComponent(list)})`, { method: 'GET' }) || []));
    }
    return { rows, serverIds: new Set(heads.map(row => row.id)) };
  }
  async function sync(table, localItems, localTombstones = {}, localState = null) {
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
    remoteRows.forEach(row => {
      const updatedAt = row.payload?.updatedAt || row.updated_at;
      known[row.id] = updatedAt;
      if (row.id === STATE_ID || row.payload?.__type === 'app_state') { remoteState = row.payload; return; }
      if (isTombstone(row.payload)) { if (!tombstones.has(row.id) || newer(updatedAt, tombstones.get(row.id))) tombstones.set(row.id, updatedAt); return; }
      const remoteItem = { ...row.payload, id: row.id, updatedAt };
      const localItem = merged.get(row.id);
      if (!localItem || newer(remoteItem.updatedAt, localItem.updatedAt)) merged.set(row.id, remoteItem);
    });
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
    if (rows.length) {
      await request(`/rest/v1/${table}?on_conflict=user_id,id`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
      rows.forEach(row => { known[row.id] = row.updated_at; });
    }
    if (expired.length) { await pruneRemoteTombstones(table, expired); expired.forEach(id => { delete known[id]; }); }
    saveSyncMeta(table, sessionUser.id, { known });
    return { tasks: result, tombstones: Object.fromEntries(tombstones), appState };
  }
  async function syncExpenses(localExpenses, localTombstones = {}) {
    const { tasks, tombstones } = await sync('planner_expenses', localExpenses, localTombstones, null);
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
      updatedAt: row.payload?.updatedAt || row.updated_at,
      __remote: true
    };
  }
  // Совместные задачи тоже грузятся экономно: каждые 2 минуты берётся лёгкий список «id + время правки +
  // участники», а задача целиком (с фото) скачивается, только если она изменилась с прошлой загрузки.
  const SHARED_COLUMNS = 'id,owner_id,owner_email,invited_emails,accepted_emails,payload,updated_at';
  let sharedCache = { userId: '', rows: new Map() };
  const sharedHeadKey = row => `${row.updated_at}|${row.pu || ''}|${(row.invited_emails || []).join(',')}|${(row.accepted_emails || []).join(',')}`;
  async function loadSharedTasks() {
    const sessionUser = user(); if (!sessionUser) return [];
    if (sharedCache.userId !== sessionUser.id) sharedCache = { userId: sessionUser.id, rows: new Map() };
    const heads = await request('/rest/v1/shared_tasks?select=id,updated_at,invited_emails,accepted_emails,pu:payload->>updatedAt&order=updated_at.desc', { method: 'GET' }) || [];
    const changed = heads.filter(head => sharedCache.rows.get(head.id)?.key !== sharedHeadKey(head)).map(head => head.id);
    for (let i = 0; i < changed.length; i += 50) {
      const list = changed.slice(i, i + 50).map(id => `"${String(id).replace(/"/g, '')}"`).join(',');
      const rows = await request(`/rest/v1/shared_tasks?select=${SHARED_COLUMNS}&id=in.(${encodeURIComponent(list)})`, { method: 'GET' }) || [];
      rows.forEach(row => sharedCache.rows.set(row.id, { key: sharedHeadKey({ ...row, pu: row.payload?.updatedAt }), row }));
    }
    const visible = new Set(heads.map(head => head.id));
    [...sharedCache.rows.keys()].forEach(id => { if (!visible.has(id)) sharedCache.rows.delete(id); });
    return heads.map(head => sharedCache.rows.get(head.id)?.row).filter(Boolean).map(row => sharedTaskFromRow(structuredClone(row)));
  }
  // Свежая копия одной задачи прямо перед сохранением: чтобы правка одного участника не затирала чужие.
  async function loadSharedTask(id) {
    if (!user()) return null;
    const rows = await request(`/rest/v1/shared_tasks?id=eq.${encodeURIComponent(id)}&select=id,owner_id,owner_email,invited_emails,accepted_emails,payload,updated_at`, { method: 'GET' });
    return rows?.[0] ? sharedTaskFromRow(rows[0]) : null;
  }
  async function saveSharedTask(task) {
    const sessionUser = user(); if (!sessionUser) throw new Error('Сначала войдите в облако');
    const ownerId = task.ownerId || sessionUser.id;
    const ownerEmail = (task.ownerEmail || sessionUser.email || '').toLocaleLowerCase();
    const invitedEmails = [...new Set((task.invitedEmails || []).map(email => String(email).trim().toLocaleLowerCase()).filter(Boolean))];
    const acceptedEmails = [...new Set((task.acceptedEmails || []).map(email => String(email).trim().toLocaleLowerCase()).filter(Boolean))];
    const { id, ownerId: _ownerId, ownerEmail: _ownerEmail, invitedEmails: _invited, acceptedEmails: _accepted, __remote, ...payload } = task;
    const row = { id, owner_id: ownerId, owner_email: ownerEmail, invited_emails: invitedEmails, accepted_emails: acceptedEmails, payload, updated_at: task.updatedAt || new Date().toISOString() };
    if (__remote) {
      const isOwner = ownerId === sessionUser.id;
      const patch = isOwner ? { ...row } : { payload, updated_at: row.updated_at };
      sharedCache.rows.delete(id);
      delete patch.id;
      await request(`/rest/v1/shared_tasks?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    } else {
      sharedCache.rows.delete(id);
      await request('/rest/v1/shared_tasks?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
    }
    return { ...task, ownerId, ownerEmail, invitedEmails, acceptedEmails, __remote: true };
  }
  async function deleteSharedTask(id) {
    sharedCache.rows.delete(id);
    await request(`/rest/v1/shared_tasks?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }
  async function answerSharedInvite(id, accepted) {
    const result = await request('/rest/v1/rpc/answer_shared_invite', { method: 'POST', body: JSON.stringify({ task_id: id, accept_invite: !!accepted }) });
    return Array.isArray(result) ? result[0] : result;
  }
  async function touchPresence(locale = 'ru') {
    if (!user()) return;
    await request('/rest/v1/rpc/touch_presence', {
      method: 'POST',
      body: JSON.stringify({ account_locale: locale === 'en' ? 'en' : 'ru' })
    });
  }
  async function loadSharedPresence() {
    if (!user()) return [];
    return await request('/rest/v1/rpc/get_shared_presence', { method: 'POST', body: '{}' }) || [];
  }
  async function savePushSubscription(subscription, locale = 'ru', settings = {}) {
    const sessionUser = user();
    if (!sessionUser || !subscription?.endpoint) throw new Error('Authentication required');
    const json = subscription.toJSON ? subscription.toJSON() : subscription;
    const row = {
      endpoint: json.endpoint,
      user_id: sessionUser.id,
      p256dh: json.keys?.p256dh || '',
      auth: json.keys?.auth || '',
      locale: locale === 'en' ? 'en' : 'ru',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow',
      notification_settings: {
        exact: settings.exact !== false,
        daily: settings.daily !== false,
        dailyTime: settings.dailyTime || '09:00',
        overdue: settings.overdue !== false
      },
      updated_at: new Date().toISOString()
    };
    await request('/rest/v1/push_subscriptions?on_conflict=endpoint', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row)
    });
    return row;
  }
  async function deletePushSubscription(endpoint) {
    if (!endpoint) return;
    await request(`/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    });
  }
  async function deleteAccount() {
    await request('/rest/v1/rpc/delete_own_account', { method: 'POST', body: '{}' });
    setSession(null);
  }
  window.DaySync = { getSession, user, signUp, signIn, signOut, resetPassword, verifyRecoveryCode, consumeRecoveryFromUrl, updatePassword, sync, syncExpenses, loadSharedTasks, loadSharedTask, saveSharedTask, deleteSharedTask, answerSharedInvite, touchPresence, loadSharedPresence, savePushSubscription, deletePushSubscription, deleteAccount };
})();
