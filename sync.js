(function () {
  const config = window.SUPABASE_CONFIG;
  const SESSION_KEY = 'day-sync-session-v1';
  const STATE_ID = '00000000-0000-4000-8000-000000000001';

  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
  }
  function setSession(session) {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  }
  async function request(path, options = {}, useAuth = true) {
    let session = getSession();
    if (useAuth && session?.expires_at && session.expires_at * 1000 < Date.now() + 60000 && session.refresh_token) session = await refresh(session.refresh_token);
    const headers = { apikey: config.anonKey, 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (useAuth && session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    const response = await fetch(`${config.url}${path}`, { ...options, headers });
    if (!response.ok) {
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
    const result = await request('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ email, password }) }, false);
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
    if (error) throw new Error(error.replace(/\+/g, ' '));
    const type = hash.get('type') || query.get('type'); const accessToken = hash.get('access_token') || query.get('access_token');
    const recoveryIntent = type === 'recovery' || query.get('recovery') === '1' || !!accessToken;
    if (!recoveryIntent) return false;
    if (!accessToken) throw new Error('Ссылка не содержит кода восстановления. Запросите новое письмо.');
    const session = { access_token: accessToken, refresh_token: hash.get('refresh_token') || query.get('refresh_token') || '', token_type: hash.get('token_type') || query.get('token_type') || 'bearer', expires_at: Math.floor(Date.now() / 1000) + Number(hash.get('expires_in') || query.get('expires_in') || 3600), user: null };
    setSession(session);
    history.replaceState(null, '', `${location.pathname}?recovery=1`); return true;
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
  async function removeRemote(ids) {
    for (const id of ids) await request(`/rest/v1/planner_tasks?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }
  async function sync(localTasks, deletedIds = [], localState = null) {
    const sessionUser = user(); if (!sessionUser) throw new Error('Сначала войдите в облако');
    if (deletedIds.length) await removeRemote(deletedIds);
    const remoteRows = await request('/rest/v1/planner_tasks?select=id,payload,updated_at', { method: 'GET' });
    const merged = new Map();
    localTasks.forEach(task => merged.set(task.id, task));
    let remoteState = null;
    (remoteRows || []).forEach(row => {
      if (row.id === STATE_ID || row.payload?.__type === 'app_state') { remoteState = row.payload; return; }
      const remoteTask = { ...row.payload, id: row.id, updatedAt: row.payload.updatedAt || row.updated_at };
      const localTask = merged.get(row.id);
      if (!localTask || new Date(remoteTask.updatedAt || 0) > new Date(localTask.updatedAt || 0)) merged.set(row.id, remoteTask);
    });
    const result = [...merged.values()];
    const localUpdated = new Date(localState?.updatedAt || 0); const remoteUpdated = new Date(remoteState?.updatedAt || 0);
    const appState = remoteState && remoteUpdated > localUpdated ? remoteState : localState ? { __type: 'app_state', ...localState } : remoteState;
    if (result.length || appState) {
      const rows = result.map(task => ({ user_id: sessionUser.id, id: task.id, payload: task, updated_at: task.updatedAt || new Date(0).toISOString() }));
      if (appState) rows.push({ user_id: sessionUser.id, id: STATE_ID, payload: appState, updated_at: appState.updatedAt || new Date(0).toISOString() });
      await request('/rest/v1/planner_tasks?on_conflict=user_id,id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
    }
    return { tasks: result, appState };
  }
  function sharedTaskFromRow(row) {
    return {
      ...(row.payload || {}),
      id: row.id,
      ownerId: row.owner_id,
      ownerEmail: row.owner_email,
      invitedEmails: (row.invited_emails || []).map(email => String(email).trim().toLocaleLowerCase()),
      acceptedEmails: (row.accepted_emails || []).map(email => String(email).trim().toLocaleLowerCase()),
      updatedAt: row.payload?.updatedAt || row.updated_at
    };
  }
  async function loadSharedTasks() {
    if (!user()) return [];
    const rows = await request('/rest/v1/shared_tasks?select=id,owner_id,owner_email,invited_emails,accepted_emails,payload,updated_at&order=updated_at.desc', { method: 'GET' });
    return (rows || []).map(sharedTaskFromRow);
  }
  async function saveSharedTask(task) {
    const sessionUser = user(); if (!sessionUser) throw new Error('Сначала войдите в облако');
    const ownerId = task.ownerId || sessionUser.id;
    const ownerEmail = (task.ownerEmail || sessionUser.email || '').toLocaleLowerCase();
    const invitedEmails = [...new Set((task.invitedEmails || []).map(email => String(email).trim().toLocaleLowerCase()).filter(Boolean))];
    const acceptedEmails = [...new Set((task.acceptedEmails || []).map(email => String(email).trim().toLocaleLowerCase()).filter(Boolean))];
    const { id, ownerId: _ownerId, ownerEmail: _ownerEmail, invitedEmails: _invited, acceptedEmails: _accepted, ...payload } = task;
    const row = { id, owner_id: ownerId, owner_email: ownerEmail, invited_emails: invitedEmails, accepted_emails: acceptedEmails, payload, updated_at: task.updatedAt || new Date().toISOString() };
    await request('/rest/v1/shared_tasks?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
    return { ...task, ownerId, ownerEmail, invitedEmails, acceptedEmails };
  }
  async function deleteSharedTask(id) {
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
  window.DaySync = { getSession, user, signUp, signIn, signOut, resetPassword, verifyRecoveryCode, consumeRecoveryFromUrl, updatePassword, sync, loadSharedTasks, saveSharedTask, deleteSharedTask, answerSharedInvite, touchPresence, loadSharedPresence, savePushSubscription, deletePushSubscription, deleteAccount };
})();
