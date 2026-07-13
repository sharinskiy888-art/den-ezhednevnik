(function () {
  const config = window.SUPABASE_CONFIG;
  const SESSION_KEY = 'day-sync-session-v1';

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
  async function sync(localTasks, deletedIds = []) {
    const sessionUser = user(); if (!sessionUser) throw new Error('Сначала войдите в облако');
    if (deletedIds.length) await removeRemote(deletedIds);
    const remoteRows = await request('/rest/v1/planner_tasks?select=id,payload,updated_at', { method: 'GET' });
    const merged = new Map();
    localTasks.forEach(task => merged.set(task.id, task));
    (remoteRows || []).forEach(row => {
      const remoteTask = { ...row.payload, id: row.id, updatedAt: row.payload.updatedAt || row.updated_at };
      const localTask = merged.get(row.id);
      if (!localTask || new Date(remoteTask.updatedAt || 0) > new Date(localTask.updatedAt || 0)) merged.set(row.id, remoteTask);
    });
    const result = [...merged.values()];
    if (result.length) {
      const rows = result.map(task => ({ user_id: sessionUser.id, id: task.id, payload: task, updated_at: task.updatedAt || new Date(0).toISOString() }));
      await request('/rest/v1/planner_tasks?on_conflict=user_id,id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
    }
    return result;
  }
  window.DaySync = { getSession, user, signUp, signIn, signOut, sync };
})();
