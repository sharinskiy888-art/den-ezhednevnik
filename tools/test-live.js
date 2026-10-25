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
    DEN_ADMIN_EMAIL: 'admin@den.test', DEN_ADMIN_PASSWORD: 'admin-pass-1', DEN_PUBLIC_URL: base, DEN_MIGRATION: '1' };
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
    // Прежнее облако Supabase — заглушка по настоящему адресу из sync-config.js: поручение с фото, задачи и операции только «в облаке».
    const sb = { calls: [], tid: '33333333-3333-4333-8333-333333333333', file: '44444444-4444-4444-8444-444444444444.jpg' };
    const OLD_STAMP = '2026-10-18T10:00:00.000Z';
    const supabaseMock = async route => {
      const req = route.request(); const u = new URL(req.url()); const auth = req.headers().authorization || '';
      sb.calls.push(`${req.method()} ${u.pathname}${u.search} ${auth}`);
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
      if (u.pathname === '/auth/v1/token') return String(JSON.parse(req.postData() || '{}').refresh_token).startsWith('sb-refresh-') ? json({ access_token: 'sb-access-2', refresh_token: 'sb-refresh-2', expires_in: 3600 }) : json({ msg: 'bad' }, 400);
      if (auth !== 'Bearer sb-access-2') return json({ message: 'JWT expired' }, 401); // старый токен истёк — приложение должно обновить вход
      const mine = (u.searchParams.get('user_id') || u.searchParams.get('owner_id')) === `eq.${OLD_ID}`;
      if (u.pathname === '/rest/v1/planner_tasks') return json(!mine ? [] : [
        { id: 'cloud-only-1', payload: { id: 'cloud-only-1', title: 'Только в прежнем облаке', date: '2026-10-24', updatedAt: OLD_STAMP }, updated_at: OLD_STAMP },
        { id: 'old-task-1', payload: { id: 'old-task-1', title: 'Старая версия из облака', date: '2026-10-25', updatedAt: '2026-10-01T10:00:00.000Z' }, updated_at: '2026-10-01T10:00:00.000Z' }]);
      if (u.pathname === '/rest/v1/planner_expenses') return json(!mine ? [] : [
        { id: 'cloud-exp-1', payload: { id: 'cloud-exp-1', kind: 'income', title: 'Аванс', amount: 19.995, category: 'other', occurredAt: OLD_STAMP, updatedAt: OLD_STAMP }, updated_at: OLD_STAMP }]);
      if (u.pathname === '/rest/v1/shared_tasks') return json(!mine ? [] : [{ id: sb.tid, invited_emails: ['montazhnik@den.test'], accepted_emails: ['montazhnik@den.test'], updated_at: OLD_STAMP,
        payload: { title: 'Поручение из Supabase', date: '2026-10-24', status: 'work', completed: false, subtasks: [{ title: 'Щит', done: true, doneBy: 'montazhnik@den.test' }],
          reports: [{ id: 'r1', email: 'montazhnik@den.test', text: 'Фото щита', photo: `shared/${sb.tid}/${sb.file}`, at: OLD_STAMP }], activity: [],
          ownerId: OLD_ID, ownerEmail: 'shamil@den.test', invitedEmails: ['montazhnik@den.test'], acceptedEmails: ['montazhnik@den.test'], updatedAt: OLD_STAMP } }]);
      if (u.pathname === `/storage/v1/object/authenticated/attachments/shared/${sb.tid}/${sb.file}`) return route.fulfill({ status: 200, contentType: 'image/jpeg', headers, body: Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]) });
      return json({ message: 'not found' }, 404);
    };
    const device = async (name, init) => {
      const context = await browser.newContext();
      await context.route('https://axpglqvvevwttpnmuvam.supabase.co/**', supabaseMock);
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
      page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 400 && !(r.status() === 401 && u.pathname === '/api/auth/login') && !(r.status() === 403 && expect403) && !(r.status() === 401 && u.hostname.endsWith('supabase.co'))) errors.push(`${name}: ${r.status()} ${u.pathname}`); });
      if (init) await page.addInitScript(init);
      await page.goto(base + '/'); await page.waitForTimeout(1200); return page;
    };
    const signIn = async (page, email, password) => {
      await page.evaluate(() => document.querySelector('#syncDialog').open || document.querySelector('#syncDialog').showModal());
      await page.fill('#syncEmail', email); await page.fill('#syncPassword', password);
      await page.click('#syncAuthForm button[type=submit]'); await page.waitForTimeout(2500);
    };
    // 1. Телефон с данными времён Supabase
    const d1 = await device('телефон', `localStorage.setItem('day-sync-session-v1', JSON.stringify({ access_token: 'eyJhbGciOi.old.sig', refresh_token: 'sb-refresh-1', expires_at: 9999999999, user: { id: '${OLD_ID}', email: 'shamil@den.test' } }));
      localStorage.setItem('day-planner-tasks-v2:${OLD_ID}', JSON.stringify([{ id: 'old-task-1', title: 'Задача с телефона до переезда', date: '2026-10-25', updatedAt: '2026-10-20T10:00:00.000Z' }]));`);
    const moved = await d1.evaluate(() => [localStorage.getItem('day-sync-session-v1'), document.querySelector('#syncDialog').open, document.querySelector('#syncEmail').value]);
    ok(moved[0] === null && moved[1] && moved[2] === 'shamil@den.test', 'Старый вход Supabase сброшен: окно входа открыто, email подставлен');
    await signIn(d1, 'shamil@den.test', 'pass-shamil-1');
    ok(/Синхронизировано/.test(await d1.locator('#syncStateTitle').innerText()), 'Вход на свой сервер и синхронизация');
    const token = await d1.evaluate(() => JSON.parse(localStorage.getItem('day-sync-session-v1')).access_token);
    ok((await api('GET', '/api/data/tasks/heads', null, token)).body.some(h => h.id === 'old-task-1'), 'Задача, созданная до переезда, сама загрузилась на сервер');
    // Этап 5: перенос из прежнего облака и сверка
    for (let i = 0; i < 40 && await d1.evaluate(() => localStorage.getItem('day-cloud-old-v1')); i++) await d1.waitForTimeout(250);
    const heads1 = (await api('GET', '/api/data/tasks?ids=cloud-only-1,old-task-1', null, token)).body;
    ok(heads1.length === 2 && heads1.find(r => r.id === 'old-task-1').payload.title === 'Задача с телефона до переезда', 'Запись, которая была только в прежнем облаке, перенесена; более новая версия с телефона не затёрта старой из облака');
    ok((await api('GET', '/api/data/expenses?ids=cloud-exp-1', null, token)).body[0]?.payload.amount === 19.995, 'Операция из прежнего облака перенесена');
    const imported = (await api('GET', `/api/shared/${sb.tid}`, null, token)).body;
    ok(imported.owner_id === OLD_ID && imported.invited_emails.includes('montazhnik@den.test') && !imported.accepted_emails.length && !('ownerId' in imported.payload) && !('invitedEmails' in imported.payload),
      'Поручение организатора перенесено, исполнитель приглашён заново (принять за него сервер не может), служебные поля убраны', JSON.stringify(imported).slice(0, 160));
    const file = await fetch(`${base}/api/files/shared/${sb.tid}/${sb.file}`, { headers: { Authorization: `Bearer ${token}` } });
    ok(file.status === 200 && (await file.arrayBuffer()).byteLength === 6, 'Фото отчёта перенесено с прежним именем (ссылка в отчёте работает)');
    ok(sb.calls.some(c => c.includes('/auth/v1/token')) && sb.calls.some(c => c.includes(`owner_id=eq.${OLD_ID}`) && c.endsWith('sb-access-2')), 'Истёкший вход прежнего облака обновлён; запрошены только свои поручения');
    const rec = (await api('GET', '/api/admin/reconcile', null, admin)).body.find(r => r.email === 'shamil@den.test');
    const sbNote = rec?.devices[0]?.report.supabase || {};
    ok(rec?.status === 'совпадает' && rec.server.incomeKop === '2000' && sbNote.sharedImported === 1 && sbNote.files === 1 && sbNote.oldTasks === 2 && sbNote.oldExpenses === 1,
      'Сверка: числа устройства и сервера совпали (19,995 ₽ = 2000 коп.), итог переноса виден администратору', JSON.stringify(rec).slice(0, 220));
    ok(await d1.evaluate(() => localStorage.getItem('day-cloud-old-v1')) === null, 'После переноса прежний вход Supabase стёрт с телефона');
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
    // Человек заведён на новом сервере с новым id: данные телефона под прежним id подхватываются, PIN — нет (его задают заново)
    const VERA_OLD = '55555555-5555-4555-8555-555555555555';
    await api('POST', '/api/admin/users', { email: 'vera@den.test', password: 'pass-vera-123' }, admin);
    const d4 = await device('телефон Веры', `localStorage.setItem('day-sync-session-v1', JSON.stringify({ access_token: 'eyJhbGciOi.vera.sig', refresh_token: 'sb-refresh-vera', expires_at: 9999999999, user: { id: '${VERA_OLD}', email: 'vera@den.test' } }));
      if (!localStorage.getItem('day-planner-tasks-v2:${VERA_OLD}')) { localStorage.setItem('day-planner-tasks-v2:${VERA_OLD}', JSON.stringify([{ id: 'vera-task-1', title: 'Задача Веры', date: '2026-10-25', updatedAt: '2026-10-20T10:00:00.000Z' }]));
      localStorage.setItem('day-planner-pin-v1:${VERA_OLD}', 'old-hash'); }`);
    await signIn(d4, 'vera@den.test', 'pass-vera-123');
    const vera = await d4.evaluate(() => ({ id: window.DaySync.user()?.id, tasks: tasks.map(t => t.id), pin: localStorage.getItem(`day-planner-pin-v1:${window.DaySync.user()?.id}`) }));
    const veraToken = await d4.evaluate(() => JSON.parse(localStorage.getItem('day-sync-session-v1')).access_token);
    ok(vera.id !== VERA_OLD && vera.tasks.includes('vera-task-1') && vera.pin === null && (await api('GET', '/api/data/tasks/heads', null, veraToken)).body.some(h => h.id === 'vera-task-1'),
      'Новый id на сервере: задачи телефона подхвачены и загружены, старый PIN не перенесён', JSON.stringify(vera));
    // 3. Новый монтажник: неверный пароль, регистрация по приглашению, смена пароля
    const d3 = await device('монтажник'); await signIn(d3, 'shamil@den.test', 'wrong-pass-1');
    ok(/Неверный email или пароль/.test(await d3.locator('#syncStateText').innerText()), 'Неверный пароль — понятное сообщение');
    await d3.fill('#syncEmail', 'montazhnik@den.test'); await d3.fill('#syncPassword', 'pass-mont-123'); await d3.fill('#syncInvite', invite);
    await d3.click('#syncSignUp'); await d3.waitForTimeout(2500);
    ok(await d3.evaluate(() => window.DaySync.user()?.email) === 'montazhnik@den.test', 'Регистрация по коду приглашения из окна входа');
    await d3.evaluate(async () => { await loadSharedTasks(false); });
    ok(await d3.evaluate(id => sharedInvites().some(t => t.id === id && t.status === 'work' && t.reports?.[0]?.text === 'Фото щита'), sb.tid), 'Монтажник после регистрации видит перенесённое поручение с прежним отчётом — приглашением «Принять»');
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
    // 5. CRM: Шамиль — руководитель, монтажник видит только свою заявку. Всё через окна приложения.
    const users = (await api('GET', '/api/admin/users', null, admin)).body;
    const uid = email => users.find(u => u.email === email).id;
    await api('PUT', `/api/admin/users/${uid('shamil@den.test')}/crm`, { role: 'manager' }, admin);
    await api('PUT', `/api/admin/users/${uid('montazhnik@den.test')}/crm`, { role: 'worker' }, admin);
    await d1.evaluate(async () => { await window.DayCrm.sync(); });
    ok(await d1.locator('#tabCrm').isVisible(), 'Руководителю видна вкладка «Клиенты»');
    await d1.click('#tabCrm'); await d1.waitForTimeout(400); await d1.click('#crmAdd'); await d1.waitForTimeout(200);
    await d1.fill('#crmCardForm [name=name]', 'ООО Ромашка'); await d1.fill('#crmCardForm [name=inn]', '7701234567'); await d1.fill('#crmCardForm [name=phone]', '+7 900 111-22-33');
    await d1.click('#crmCardSave'); await d1.waitForTimeout(300);
    await d1.click('[data-crm-tab=clients]'); await d1.click('#crmList [data-crm-open=clients]'); await d1.waitForTimeout(200);
    await d1.click('#crmCardForm [data-crm-new=objects]'); await d1.fill('#crmCardForm [name=address]', 'ул. Ленина, 7'); await d1.check('#crmCardForm input[value="АПС"]');
    await d1.click('#crmCardSave'); await d1.waitForTimeout(300);
    await d1.click('#crmCardForm [data-crm-open=objects]'); await d1.waitForTimeout(200); await d1.click('#crmCardForm [data-crm-new=orders]');
    await d1.fill('#crmCardForm [name=sum]', '150000,50'); await d1.fill('#crmCardForm [name=assignees]', 'montazhnik@den.test'); await d1.fill('#crmCardForm [name=due]', '2026-11-03');
    await d1.click('#crmCardForm [data-crm-stage=work]'); await d1.click('#crmCardSave'); await d1.waitForTimeout(2500);
    const orders = (await api('GET', '/api/crm/orders', null, token)).body;
    ok(orders.length === 1 && orders[0].payload.sumKop === 15000050 && orders[0].payload.stage === 'work', 'Клиент → объект → заявка созданы через окна; сумма 150 000,50 ₽ = 15 000 050 копеек', JSON.stringify(orders[0]?.payload || {}).slice(0, 160));
    await d1.click('#crmCardForm [data-crm-open=orders]'); await d1.waitForTimeout(200);
    if (process.env.SHOTS) { await d1.screenshot({ path: path.join(process.env.SHOTS, 'crm-order.png') }); await d1.setViewportSize({ width: 390, height: 844 }); await d1.screenshot({ path: path.join(process.env.SHOTS, 'crm-order-phone.png') }); await d1.setViewportSize({ width: 1280, height: 720 }); }
    await d1.click('#crmCardForm [data-crm-new=payments][data-kind=income]');
    await d1.fill('#crmCardForm [name=amount]', '50000'); await d1.click('#crmCardSave'); await d1.waitForTimeout(2000);
    ok((await api('GET', '/api/crm/payments', null, token)).body[0]?.payload.amountKop === 5000000, 'Приход по заявке записан в копейках');
    await d1.evaluate(() => { $('#crmCardDialog').close(); $('#crmDialog').close(); });
    await d3.evaluate(async () => { await window.DayCrm.sync(); await loadSharedTasks(false); });
    const worker = await d3.evaluate(() => ({ tab: !$('#tabCrm').hidden, orders: window.DayCrm.state.data.orders.size, clients: [...window.DayCrm.state.data.clients.values()].map(c => c.phone), pays: window.DayCrm.state.data.payments.size, invite: sharedInvites().some(t => t.id.startsWith('crm-')) }));
    ok(worker.tab && worker.orders === 1 && worker.clients[0] === '+7 900 111-22-33' && worker.pays === 0 && worker.invite, 'Монтажник видит свою заявку, объект и телефон клиента, не видит деньги; заявка пришла ему поручением', JSON.stringify(worker));
    await d3.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()));
    await d3.click('#tabCrm'); await d3.waitForTimeout(300);
    if (process.env.SHOTS) await d3.screenshot({ path: path.join(process.env.SHOTS, 'crm-worker-list.png') });
    await d3.click('#crmList [data-crm-open=orders]'); await d3.waitForTimeout(200);
    ok(!(await d3.locator('#crmCardSave').isVisible()) && await d3.locator('#crmCardForm [name=sum]').evaluate(e => e.readOnly), 'У монтажника карточка только для чтения');
    await d3.evaluate(() => { $('#crmCardDialog').close(); $('#crmDialog').close(); });
    const raced = await d1.evaluate(async () => {
      const running = window.DayCrm.sync(); await new Promise(r => setTimeout(r, 5));
      const before = window.DayCrm.state.syncing;
      await window.DayCrm.saveItemForTest({ id: 'race-1', name: 'Сохранён во время синхронизации' });
      await running; for (let i = 0; i < 50 && window.DayCrm.state.syncing; i++) await new Promise(r => setTimeout(r, 100));
      return { before, local: window.DayCrm.state.data.clients.has('race-1') };
    });
    const onServer = (await api('GET', '/api/crm/clients?ids=race-1', null, token)).body.length === 1;
    ok(raced.local && onServer, 'Клиент, сохранённый во время синхронизации, не теряется (и на устройстве, и на сервере)', JSON.stringify({ ...raced, onServer }));
    // Скорость: 10 000 клиентов и 10 000 объектов на устройстве
    const speed = await d1.evaluate(async () => {
      const crm = window.DayCrm; const now = new Date().toISOString();
      for (let i = 0; i < 10000; i++) { crm.state.data.clients.set(`c${i}`, { id: `c${i}`, name: `Клиент ${i} ${['Альфа', 'Бета', 'Гамма'][i % 3]}`, inn: String(7700000000 + i), phone: `+7 900 ${String(i).padStart(7, '0')}`, updatedAt: now });
        crm.state.data.objects.set(`o${i}`, { id: `o${i}`, clientId: `c${i}`, address: `ул. Тестовая, ${i}`, systems: ['АПС'], updatedAt: now }); }
      crm.state.index.clients = null; crm.state.index.objects = null;
      const t0 = performance.now(); crm.search('clients', 'x'); const indexMs = performance.now() - t0;
      const times = []; for (const q of ['7700009', 'гамма 99', '+7 900 0001234', 'нет такого']) { const t = performance.now(); crm.search('clients', q); times.push(performance.now() - t); }
      const t1 = performance.now(); crm.search('objects', 'тестовая 9999'); const objMs = performance.now() - t1;
      $('#tabCrm').click(); await new Promise(r => setTimeout(r, 300)); document.querySelector('[data-crm-tab=clients]').click();
      const t2 = performance.now(); const input = $('#crmSearch'); input.value = '7700005'; input.dispatchEvent(new Event('input')); const typeMs = performance.now() - t2;
      const t3 = performance.now(); document.querySelector('#crmList [data-crm-open]').click(); const cardMs = performance.now() - t3;
      $('#crmCardDialog').close(); $('#crmDialog').close();
      return { indexMs, search: Math.max(...times), objMs, typeMs, cardMs };
    });
    ok(speed.search < 100 && speed.objMs < 100 && speed.typeMs < 100 && speed.cardMs < 100, 'Скорость на 10 000 записей: поиск, ввод в строку поиска и открытие карточки — быстрее 100 мс',
      `поиск ${speed.search.toFixed(1)} мс, по объектам ${speed.objMs.toFixed(1)} мс, ввод+список ${speed.typeMs.toFixed(1)} мс, карточка ${speed.cardMs.toFixed(1)} мс (первая сборка указателя ${speed.indexMs.toFixed(0)} мс)`);
    ok(errors.length === 0, 'Нет ошибок JavaScript и неожиданных ошибок сервера', errors.slice(0, 5).join(' | '));
    ok(!/Traceback/.test(log), 'В журнале сервера нет сбоев');
  } catch (error) { ok(false, 'Проверка оборвалась', error.message); }
  finally { if (browser) await browser.close(); server.kill(); }
  const passed = results.filter(Boolean).length;
  console.log(`\nИТОГ: ${passed}/${results.length}${passed === results.length ? ' ✔' : ''}`);
  process.exit(passed === results.length ? 0 : 1);
})();
