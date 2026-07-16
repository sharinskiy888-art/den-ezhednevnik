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
      throw new Error(message);
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
    const redirect = `${location.origin}${location.pathname}?recovery=1`;
    return request(`/auth/v1/recover?redirect_to=${encodeURIComponent(redirect)}`, { method: 'POST', body: JSON.stringify({ email }) }, false);
  }
  async function consumeRecoveryFromUrl() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (params.get('type') !== 'recovery' || !params.get('access_token')) return false;
    const session = { access_token: params.get('access_token'), refresh_token: params.get('refresh_token') || '', token_type: params.get('token_type') || 'bearer', expires_at: Math.floor(Date.now() / 1000) + Number(params.get('expires_in') || 3600), user: null };
    setSession(session); const account = await request('/auth/v1/user'); session.user = account; setSession(session);
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
  window.DaySync = { getSession, user, signUp, signIn, signOut, resetPassword, consumeRecoveryFromUrl, updatePassword, sync };
})();
