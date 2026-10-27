/*
 * Живая проверка модуля АК-Сервера: настоящее приложение в браузере → ядро-заглушка (server/tests/ak_core.py, подписывает
 * запросы, как ядро) → «День» в режиме модуля (python -m server.run с AK_*). Запуск: node tools/test-ak.js (PYTHON= — свой python)
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net'); const crypto = require('crypto');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const results = [];
const ok = (cond, name, info = '') => { results.push(!!cond); console.log(`${cond ? '✔' : '✗'} ${name}${info ? ' — ' + info : ''}`); };
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const [port, corePort] = [await freePort(), await freePort()];
  const secret = crypto.randomBytes(32).toString('hex');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'den-ak-'));
  const BOSS = crypto.randomUUID(), IVAN = crypto.randomUUID(), OLGA = crypto.randomUUID();
  const employees = { [BOSS]: { id: BOSS, name: 'Шамиль', email: 'boss@firma.ru' }, [IVAN]: { id: IVAN, name: 'Иван Монтажник', email: 'ivan@firma.ru' },
    [OLGA]: { id: OLGA, name: 'Ольга' } };
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DEN_') && !k.startsWith('AK_'))),
    AK_MODULE_ID: 'crm', AK_MODULE_SECRET: secret, AK_HOST: '127.0.0.1', AK_PORT: String(port), AK_BASE_PATH: '/m/crm',
    AK_CORE_URL: `http://127.0.0.1:${corePort}`, AK_DATA_DIR: data, AK_LOG_DIR: data };
  let log = '';
  const module = spawn(PY, ['-m', 'server.run'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const core = spawn(PY, ['server/tests/ak_core.py', String(corePort), String(port), secret, 'crm', JSON.stringify(employees)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  [module, core].forEach(p => { p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d); });
  const base = `http://127.0.0.1:${corePort}/m/crm/`;
  const as = (user, roles) => ({ 'X-Test-User': user, 'X-Test-Roles': roles, 'X-Test-Name': encodeURIComponent(employees[user]?.name || '') });
  const api = async (user, roles, p) => { const r = await fetch(base + p, { headers: as(user, roles) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  let browser;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + 'api/health', { headers: as(BOSS, 'owner') })).ok) break; } catch {} await wait(150); }
    browser = await chromium.launch(); const errors = []; const outside = [];
    const device = async (name, user, roles, viewport) => {
      const context = await browser.newContext(viewport ? { viewport } : {});
      await context.addCookies([{ name: 'ak_core_test', value: encodeURIComponent(`${user}|${roles}`), url: base }]); // как вход в ядро
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
      page.on('request', r => { const u = new URL(r.url()); if (u.port === String(corePort) && !u.pathname.startsWith('/m/crm/')) outside.push(u.pathname); });
      page.on('response', r => { if (r.status() >= 400 && !(r.status() === 409 && page.expect409)) errors.push(`${name}: ${r.status()} ${new URL(r.url()).pathname}`); });
      await page.goto(base); await page.waitForTimeout(1500); return { page, context };
    };
    // 1. Владелец открывает модуль: входа нет, человек — из ядра
    const { page: boss, context: bossContext } = await device('владелец', BOSS, 'owner');
    const who = await boss.evaluate(() => ({ ak: window.DaySync.isAk(), user: window.DaySync.user(), dialog: document.querySelector('#syncDialog').open,
      akClass: document.documentElement.classList.contains('ak-mode'), button: !!document.querySelector('#ak-button') }));
    ok(who.ak && who.user.id === BOSS && who.user.email === `${BOSS}@ak` && !who.dialog, 'Вход через ядро: окна входа нет, человек — сотрудник ядра', JSON.stringify(who.user));
    ok(who.akClass && who.button, 'Режим модуля включён, кнопка «АК» ядра вставлена в страницу');
    await boss.evaluate(() => { openSyncDialog(); });
    const ui = await boss.evaluate(() => ({ form: $('#syncAuthForm').hidden, logout: $('#syncLogout').hidden, password: $('#syncPasswordForm').hidden, title: $('#syncStateTitle').textContent }));
    ok(ui.form && ui.logout && ui.password, 'Нет полей email/пароль, «Сменить пользователя» и смены пароля', ui.title);
    await boss.evaluate(() => $('#syncDialog').close());
    // 2. Личная задача уходит на сервер под UUID сотрудника
    await boss.evaluate(async () => { tasks.push({ id: 'ak-task-1', title: 'Задача в АК', date: toKey(new Date()), updatedAt: new Date().toISOString() }); save(); await performSync(false); });
    await boss.waitForTimeout(800);
    ok((await api(BOSS, 'owner', 'api/data/tasks/heads')).body?.some(h => h.id === 'ak-task-1'), 'Личная задача синхронизирована через ядро');
    // 3. Поручение: исполнитель выбирается из сотрудников ядра
    await boss.evaluate(() => { openDialog(null, 'shared'); });
    await boss.waitForTimeout(600);
    const picks = await boss.locator('#taskDialog .ak-pick button').allInnerTexts();
    ok(picks.some(t => t.includes('Иван Монтажник')) && picks.some(t => t.includes('Ольга')) && !picks.some(t => t.includes('Шамиль')), 'В поручении — кнопки сотрудников ядра (без себя)', picks.join(', '));
    await boss.locator('#taskDialog .ak-pick button', { hasText: 'Иван' }).click();
    await boss.fill('#taskTitle', 'Смонтировать АПС');
    ok((await boss.inputValue('#sharedEmails')) === `${IVAN}@ak`, 'Кнопка дописала ключ сотрудника');
    await boss.click('#taskDialog button[type=submit]'); await boss.waitForTimeout(1500);
    const shared = (await api(IVAN, 'courier', 'api/shared')).body || [];
    ok(shared.some(t => t.payload?.title === 'Смонтировать АПС' && t.invited_emails.includes(`${IVAN}@ak`)), 'Монтажник получил приглашение в поручение');
    // 4. Монтажник с телефона: свои роли, левый нижний угол свободен
    const { page: ivan } = await device('монтажник', IVAN, 'courier', { width: 390, height: 800 });
    ok(await ivan.evaluate(() => window.DaySync.crmRole()) === 'worker', 'Роль courier — монтажник CRM');
    const corner = await ivan.evaluate(() => { const el = document.elementFromPoint(24, innerHeight - 24); return el?.closest('button,a,input') ? el.outerHTML.slice(0, 80) : ''; });
    ok(corner === '', 'Левый нижний угол на телефоне свободен для кнопки «АК»', corner);
    // 5. В том же браузере вошёл другой сотрудник: данные прежнего не уходят под его именем
    boss.expect409 = true;
    await bossContext.addCookies([{ name: 'ak_core_test', value: encodeURIComponent(`${OLGA}|viewer`), url: base }]);
    await boss.evaluate(async () => { tasks.push({ id: 'boss-secret', title: 'Личное владельца', date: toKey(new Date()), updatedAt: new Date().toISOString() }); save(); await performSync(false); });
    await boss.waitForTimeout(2000);
    const switched = await boss.evaluate(() => ({ id: window.DaySync.user()?.id, tasks: tasks.map(t => t.id) }));
    const olga = (await api(OLGA, 'viewer', 'api/data/tasks/heads')).body || [];
    ok(switched.id === OLGA && !switched.tasks.includes('boss-secret') && !olga.some(h => h.id === 'boss-secret'), 'Смена сотрудника: приложение переключилось, личное владельца не ушло новому', JSON.stringify(switched));
    const kept = await boss.evaluate(id => (localStorage.getItem(`day-planner-tasks-v2:${id}`) || '').includes('boss-secret'), BOSS);
    ok(kept, 'Правка владельца не потерялась: лежит на устройстве в его данных до его входа');
    // 6. Две вкладки: во второй открылся другой сотрудник — первая сама переключается и не шлёт данные прежнего
    await bossContext.addCookies([{ name: 'ak_core_test', value: encodeURIComponent(`${IVAN}|courier`), url: base }]);
    const tab2 = await bossContext.newPage(); tab2.on('pageerror', e => errors.push(`вкладка 2: ${e.message}`));
    await boss.evaluate(() => { tasks.push({ id: 'olga-note', title: 'Заметка Ольги', date: toKey(new Date()), updatedAt: new Date().toISOString() }); localStorage.setItem(taskStorageKey(), JSON.stringify(tasks)); });
    await tab2.goto(base); await tab2.waitForTimeout(1500); await boss.waitForTimeout(500);
    const tab1 = await boss.evaluate(() => ({ id: window.DaySync.user()?.id, loaded: accountLoadedFor, tasks: tasks.map(t => t.id) }));
    await boss.evaluate(() => performSync(false)); await boss.waitForTimeout(1000);
    const ivanRows = (await api(IVAN, 'courier', 'api/data/tasks/heads')).body || [];
    ok(tab1.id === IVAN && tab1.loaded === IVAN && !tab1.tasks.includes('olga-note') && !ivanRows.some(h => h.id === 'olga-note'), 'Две вкладки: первая переключилась на нового сотрудника, данные прежнего ему не ушли', JSON.stringify(tab1));
    const label = await tab2.evaluate(id => personLabel(`${id}@ak`), BOSS);
    ok(label === 'Шамиль', 'На экране — имя сотрудника из ядра, а не его ключ', label);
    ok(outside.length === 0, 'Все запросы приложения — под /m/crm/', outside.slice(0, 5).join(', '));
    ok(errors.length === 0, 'Нет ошибок JavaScript и неожиданных ошибок сервера', errors.slice(0, 5).join(' | '));
    ok(!/Traceback/.test(log), 'В журнале модуля нет сбоев', log.slice(-500));
  } catch (error) { ok(false, 'Проверка оборвалась', error.stack); }
  finally { if (browser) await browser.close(); module.kill(); core.kill(); }
  const passed = results.filter(Boolean).length;
  console.log(`\nИТОГ: ${passed}/${results.length}${passed === results.length ? ' ✔' : ''}`);
  process.exit(passed === results.length ? 0 : 1);
})();
