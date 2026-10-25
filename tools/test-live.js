/*
 * Живая проверка: настоящий sync.js + настоящий сервер «День» (server/) в браузере, три «устройства».
 * Запуск: node tools/test-live.js   (нужны Python с server/requirements.txt и Playwright; PYTHON= — свой python)
 * Проверяет то, что заглушка в test-buttons.js проверить не может: что приложение и сервер понимают друг друга.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const results = [];
const ok = (cond, name, info = '') => { results.push(!!cond); console.log(`${cond ? '✔' : '✗'} ${name}${info ? ' — ' + info : ''}`); };
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'den-live-'));
  const env = { ...process.env, DEN_SECRET: 'live-test-secret-' + 'x'.repeat(40), DEN_DATA_DIR: data, DEN_STATIC_DIR: ROOT,
    DEN_ADMIN_EMAIL: 'admin@den.test', DEN_ADMIN_PASSWORD: 'admin-pass-1', DEN_PUBLIC_URL: base };
  const server = spawn(PY, ['-m', 'uvicorn', 'server.main:app', '--port', String(port)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
  const api = async (method, p, body, token) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null }; };
  let browser; let expect403 = false;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
    const admin = (await api('POST', '/api/auth/login', { email: 'admin@den.test', password: 'admin-pass-1' })).body.access_token;
    const OLD_ID = '11111111-1111-4111-8111-111111111111';
    ok((await api('POST', '/api/admin/users', { email: 'shamil@den.test', password: 'pass-shamil-1', id: OLD_ID }, admin)).status === 201, 'Админ переносит пользователя с прежним id');
    const invite = (await api('POST', '/api/admin/invites', { email: 'montazhnik@den.test' }, admin)).body.invite;

    browser = await chromium.launch(); const errors = [];
    const device = async (name, init) => {
      const page = await (await browser.newContext()).newPage();
      page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
      page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 400 && !(r.status() === 401 && u.pathname === '/api/auth/login') && !(r.status() === 403 && expect403)) errors.push(`${name}: ${r.status()} ${u.pathname}`); });
      if (init) await page.addInitScript(init);
      await page.goto(base + '/'); await page.waitForTimeout(1200); return page;
    };
    const signIn = async (page, email, password) => {
      await page.evaluate(() => document.querySelector('#syncDialog').open || document.querySelector('#syncDialog').showModal());
      await page.fill('#syncEmail', email); await page.fill('#syncPassword', password);
      await page.click('#syncAuthForm button[type=submit]'); await page.waitForTimeout(2500);
    };
    // 1. Телефон с данными времён Supabase
    const d1 = await device('телефон', `localStorage.setItem('day-sync-session-v1', JSON.stringify({ access_token: 'eyJhbGciOi.old.sig', refresh_token: 'x', expires_at: 9999999999, user: { id: '${OLD_ID}', email: 'shamil@den.test' } }));
      localStorage.setItem('day-planner-tasks-v2:${OLD_ID}', JSON.stringify([{ id: 'old-task-1', title: 'Задача с телефона до переезда', date: '2026-10-25', updatedAt: '2026-10-20T10:00:00.000Z' }]));`);
    const moved = await d1.evaluate(() => [localStorage.getItem('day-sync-session-v1'), document.querySelector('#syncDialog').open, document.querySelector('#syncEmail').value]);
    ok(moved[0] === null && moved[1] && moved[2] === 'shamil@den.test', 'Старый вход Supabase сброшен: окно входа открыто, email подставлен');
    await signIn(d1, 'shamil@den.test', 'pass-shamil-1');
    ok(/Синхронизировано/.test(await d1.locator('#syncStateTitle').innerText()), 'Вход на свой сервер и синхронизация');
    const token = await d1.evaluate(() => JSON.parse(localStorage.getItem('day-sync-session-v1')).access_token);
    ok((await api('GET', '/api/data/tasks/heads', null, token)).body.some(h => h.id === 'old-task-1'), 'Задача, созданная до переезда, сама загрузилась на сервер');
    await d1.evaluate(async () => { tasks.push(normalizeTask({ id: 'live-new-1', title: 'Новая задача', date: toKey(new Date()), updatedAt: new Date().toISOString() })); profile = { ...profile, name: 'Шамиль' }; touchAppState(); save(); await performSync(false); });
    // 2. Компьютер: чистый браузер
    const d2 = await device('компьютер'); await signIn(d2, 'shamil@den.test', 'pass-shamil-1');
    const ids2 = await d2.evaluate(() => tasks.map(t => t.id));
    ok(ids2.includes('old-task-1') && ids2.includes('live-new-1'), 'Второе устройство получило задачи первого', ids2.join(','));
    ok(await d2.evaluate(() => profile.name) === 'Шамиль', 'Профиль (состояние приложения) дошёл до второго устройства');
    await d2.evaluate(async () => { markDeleted(deletedIds, deletedStorageKey(), 'live-new-1'); tasks = tasks.filter(t => t.id !== 'live-new-1'); save(); await performSync(false); });
    await d1.evaluate(async () => { await performSync(false); });
    const ids1 = await d1.evaluate(() => tasks.map(t => t.id));
    ok(!ids1.includes('live-new-1') && ids1.includes('old-task-1'), 'Удаление дошло до первого устройства (надгробие), задача не воскресла');
    await d1.evaluate(async () => { expenses.push(normalizeExpense({ id: 'exp-live-1', kind: 'expense', title: 'Кабель', amount: 1234.56, category: 'other', occurredAt: new Date().toISOString(), updatedAt: new Date().toISOString() })); saveExpenses(); await performSync(false); });
    await d2.evaluate(async () => { await performSync(false); });
    ok(await d2.evaluate(() => expenses.find(e => e.id === 'exp-live-1')?.amount) === 1234.56, 'Расход дошёл до второго устройства с той же суммой');
    // Пустой ответ сервера не стирает данные устройства
    await api('DELETE', '/api/data/tasks/old-task-1', null, token);
    await d1.evaluate(async () => { localStorage.removeItem(`day-sync-meta-v1:planner_tasks:${window.DaySync.user().id}`); await performSync(false); });
    ok((await d1.evaluate(() => tasks.map(t => t.id))).includes('old-task-1'), 'Пустой ответ сервера не стёр задачу на устройстве — она загрузилась снова');
    await d1.evaluate(async () => { await window.DaySync.sendFeedback({ text: 'Живая проверка', email: 'shamil@den.test' }); });
    ok((await api('GET', '/api/admin/feedback', null, admin)).body.some(f => f.text === 'Живая проверка'), 'Обратная связь дошла до сервера');
    // 3. Новый монтажник: неверный пароль, регистрация по приглашению, смена пароля
    const d3 = await device('монтажник'); await signIn(d3, 'shamil@den.test', 'wrong-pass-1');
    ok(/Неверный email или пароль/.test(await d3.locator('#syncStateText').innerText()), 'Неверный пароль — понятное сообщение');
    await d3.fill('#syncEmail', 'montazhnik@den.test'); await d3.fill('#syncPassword', 'pass-mont-123'); await d3.fill('#syncInvite', invite);
    await d3.click('#syncSignUp'); await d3.waitForTimeout(2500);
    ok(await d3.evaluate(() => window.DaySync.user()?.email) === 'montazhnik@den.test', 'Регистрация по коду приглашения из окна входа');
    await d3.evaluate(() => document.querySelector('#syncDialog').open || document.querySelector('#syncDialog').showModal());
    await d3.fill('#syncOldPassword', 'pass-mont-123'); await d3.fill('#syncChangeNewPassword', 'pass-mont-456'); await d3.click('#syncPasswordForm button[type=submit]'); await d3.waitForTimeout(1500);
    ok((await api('POST', '/api/auth/login', { email: 'montazhnik@den.test', password: 'pass-mont-456' })).status === 200, 'Смена пароля в окне «Аккаунт» работает');
    // 4. Поручение: Шамиль (организатор, телефон) → монтажник. Всё через функции самого приложения.
    const SID = '22222222-2222-4222-8222-222222222222';
    await d1.evaluate(async id => { await window.DaySync.saveSharedTask({ id, title: 'Монтаж АПС на Ленина', date: toKey(new Date()), note: 'ключи у охраны', status: 'new', completed: false,
      subtasks: [{ title: 'Кабель', done: false }, { title: 'Датчики', done: false }], reports: [], activity: [{ type: 'created', email: 'shamil@den.test', at: new Date().toISOString() }],
      invitedEmails: ['montazhnik@den.test'], acceptedEmails: [], updatedAt: new Date().toISOString() }); }, SID);
    await d3.evaluate(async () => { await loadSharedTasks(false); });
    ok(await d3.evaluate(id => sharedInvites().some(t => t.id === id), SID), 'Монтажник видит приглашение в поручение');
    await d3.evaluate(async id => { await acceptSharedInvite(id); await toggleSharedSubtask(id, 0); await setSharedStatus(id, 'question'); }, SID);
    const photoPath = await d3.evaluate(async id => {
      openDialog(id, 'shared'); const c = document.createElement('canvas'); c.width = c.height = 8;
      pendingReport.photo = await new Promise(r => c.toBlob(r, 'image/jpeg')); $('#reportText').value = 'Кабель проложен';
      await sendSharedReport(); closeDialog(); return sharedTasks.find(t => t.id === id).reports.at(-1)?.photo || '';
    }, SID);
    await d3.evaluate(async id => { await setSharedTaskCompleted(id, true); }, SID);
    const row = (await api('GET', `/api/shared/${SID}`, null, token)).body;
    ok(row.accepted_emails.includes('montazhnik@den.test') && row.payload.subtasks[0].done && row.payload.reports.length === 1 && row.payload.status === 'review',
      'Исполнитель принял, отметил подзадачу, отправил отчёт с фото; галочка «готово» → «на проверке»', `статус ${row.payload.status}, отчётов ${row.payload.reports.length}`);
    expect403 = true;
    const forbidden = await d3.evaluate(async id => { const t = await freshSharedTask(id); t.title = 'Подмена'; try { await window.DaySync.saveSharedTask(t); return 'сохранилось'; } catch (e) { return `${e.status} ${sharedErrorText(e)}`; } }, SID);
    expect403 = false;
    ok(/^403 /.test(forbidden) && (await api('GET', `/api/shared/${SID}`, null, token)).body.payload.title === 'Монтаж АПС на Ленина', 'Исполнитель не может поменять текст задачи — понятный отказ', forbidden);
    const owner = await d1.evaluate(async (args) => { await loadSharedTasks(false); const t = sharedTasks.find(x => x.id === args.id); const blob = await window.DaySync.loadSharedMedia(args.photo); return { status: t?.status, report: t?.reports?.[0]?.text, size: blob.size }; }, { id: SID, photo: photoPath });
    ok(owner.status === 'review' && owner.report === 'Кабель проложен' && owner.size > 0, 'Организатор видит статус, отчёт и само фото', JSON.stringify(owner));
    await d3.evaluate(async () => { await window.DaySync.touchPresence('ru'); });
    ok((await d1.evaluate(async () => window.DaySync.loadSharedPresence())).some(p => p.email === 'montazhnik@den.test'), 'Организатор видит, что монтажник в сети');
    await d3.evaluate(async id => { openDialog(id, 'shared'); document.querySelector(`[data-leave-shared="${id}"]`).click(); await new Promise(r => setTimeout(r, 1200)); closeDialog(); }, SID);
    ok((await api('GET', `/api/shared/${SID}`, null, token)).body.leave_requests.includes('montazhnik@den.test'), 'Кнопка «Попросить выйти» — просьба дошла до организатора');
    await d1.evaluate(async id => { await loadSharedTasks(false); openDialog(id, 'shared'); document.querySelector(`[data-release-shared="${id}"]`).click(); await new Promise(r => setTimeout(r, 1200)); closeDialog(); }, SID);
    await d3.evaluate(async () => { await loadSharedTasks(false); });
    ok(!(await d3.evaluate(id => sharedTasks.some(t => t.id === id), SID)), 'Организатор нажал «Отпустить» — у монтажника задача пропала');
    await d1.evaluate(async id => { await setSharedStatus(id, 'completed'); }, SID);
    ok((await api('GET', `/api/shared/${SID}`, null, token)).body.payload.status === 'completed', 'Организатор завершает задачу');
    await d1.evaluate(async id => { await window.DaySync.deleteSharedTask(id); }, SID);
    ok(!fs.existsSync(path.join(data, 'files', 'shared', SID)), 'Удаление поручения убрало и его файлы');
    ok(errors.length === 0, 'Нет ошибок JavaScript и неожиданных ошибок сервера', errors.slice(0, 5).join(' | '));
    ok(!/Traceback/.test(log), 'В журнале сервера нет сбоев');
  } catch (error) { ok(false, 'Проверка оборвалась', error.message); }
  finally { if (browser) await browser.close(); server.kill(); }
  const passed = results.filter(Boolean).length;
  console.log(`\nИТОГ: ${passed}/${results.length}${passed === results.length ? ' ✔' : ''}`);
  process.exit(passed === results.length ? 0 : 1);
})();
