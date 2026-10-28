/*
 * Проверка на разных устройствах со своим сервером «День»: iPhone, Android, планшет, ноутбук, большой монитор.
 * 1) Вид: на каждом экране нет прокрутки вбок и кнопок за краем, каждое окно (<dialog>) целиком на экране.
 * 2) Синхронизация между устройствами одного человека и между людьми: задачи, планы, финансы, удаление,
 *    одновременные правки, работа без сети, поручение с фото, CRM, PIN, два человека на одном устройстве,
 *    запуск приложения без сети.
 * Запуск: node tools/test-devices.js   (PYTHON= — свой python; SHOTS=папка — снимки экранов)
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net');
const { chromium, devices } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const results = [];
const ok = (cond, name, info = '') => { results.push(!!cond); console.log(`${cond ? '✔' : '✗'} ${name}${info ? ' — ' + info : ''}`); };
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = ms => new Promise(r => setTimeout(r, ms));
const strip = d => { const { defaultBrowserType, ...rest } = d; return rest; }; // браузер — Chromium, вид и касания — как у устройства
const PROFILES = {
  'iPhone 13': strip(devices['iPhone 13']), 'iPhone SE': strip(devices['iPhone SE']), 'Android (Pixel 7)': strip(devices['Pixel 7']),
  'Планшет (iPad Mini)': strip(devices['iPad Mini']), 'Ноутбук 1366×768': { viewport: { width: 1366, height: 768 } }, 'Монитор 1920×1080': { viewport: { width: 1920, height: 1080 } },
};

(async () => {
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'den-devices-'));
  const env = { ...process.env, DEN_SECRET: 'devices-test-secret-' + 'x'.repeat(40), DEN_DATA_DIR: data, DEN_STATIC_DIR: ROOT,
    DEN_ADMIN_EMAIL: 'admin@den.test', DEN_ADMIN_PASSWORD: 'admin-pass-1', DEN_PUBLIC_URL: base, DEN_LOGIN_LIMIT: '1000' };
  const server = spawn(PY, ['-m', 'uvicorn', 'server.main:app', '--port', String(port)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
  const api = async (method, p, body, token) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null }; };
  let browser; const errors = [];
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await wait(150); }
    const admin = (await api('POST', '/api/auth/login', { email: 'admin@den.test', password: 'admin-pass-1' })).body.access_token;
    for (const email of ['shamil@den.test', 'ivan@den.test', 'vera@den.test']) await api('POST', '/api/admin/users', { email, password: 'pass-12345' }, admin);
    browser = await chromium.launch();
    const open = async (name, profile) => {
      const context = await browser.newContext({ ...profile, serviceWorkers: 'allow' });
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
      page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 400 && !page.allow?.(r.status(), u.pathname)) errors.push(`${name}: ${r.status()} ${u.pathname}`); });
      await page.goto(base + '/'); await page.waitForTimeout(800); return { page, context };
    };
    const signIn = async (page, email) => {
      await page.evaluate(() => document.querySelector('#syncDialog').open || openSyncDialog());
      await page.fill('#syncEmail', email); await page.fill('#syncPassword', 'pass-12345');
      await page.click('#syncAuthForm button[type=submit]');
      for (let i = 0; i < 40 && !(await page.evaluate(() => !!window.DaySync.user())); i++) await page.waitForTimeout(150);
      await page.waitForTimeout(800); await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()));
    };
    const sync = page => page.evaluate(async () => { await performSync(false); await loadSharedTasks(false); });

    // ---------- 1. Вид на каждом устройстве ----------
    const layout = async page => page.evaluate(async () => {
      const problems = []; const vw = innerWidth, vh = innerHeight;
      const check = where => {
        if (document.documentElement.scrollWidth > vw + 1) problems.push(`${where}: прокрутка вбок ${document.documentElement.scrollWidth}>${vw}`);
        document.querySelectorAll('button, a, input, select, textarea').forEach(el => {
          const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
          if (!r.width || !r.height || s.visibility === 'hidden' || el.closest('dialog:not([open])') || el.closest('[hidden]')) return;
          if (r.right > vw + 1 || r.left < -1) problems.push(`${where}: «${(el.textContent || el.id || el.name || el.tagName).trim().slice(0, 20)}» за краем экрана`);
        });
      };
      const views = [...document.querySelectorAll('[data-view]')].filter(b => b.offsetParent).map(b => b.dataset.view).filter((v, i, a) => a.indexOf(v) === i && v !== 'settings');
      for (const tab of ['#tabPlanner', '#tabFinance']) {
        document.querySelector(tab)?.click(); await new Promise(r => setTimeout(r, 120)); check(tab);
      }
      document.querySelector('#tabPlanner')?.click();
      for (const view of views) { document.querySelector(`[data-view="${view}"]`)?.click(); await new Promise(r => setTimeout(r, 80)); check(`вид ${view}`);
        for (const b of [...document.querySelectorAll('.period-switch button')].filter(x => x.offsetParent)) { b.click(); await new Promise(r => setTimeout(r, 60)); check(`вид ${view}/${b.textContent.trim()}`); } }
      const dialogs = [];
      for (const d of document.querySelectorAll('dialog')) {
        if (d.id === 'pinDialog') continue;
        try { d.showModal(); } catch { continue; }
        await new Promise(r => setTimeout(r, 60));
        const panel = d.getBoundingClientRect();
        if (panel.left < -1 || panel.right > vw + 1 || panel.top < -1 || panel.bottom > vh + 1) problems.push(`окно ${d.id} выходит за экран (${Math.round(panel.left)},${Math.round(panel.top)},${Math.round(panel.right)},${Math.round(panel.bottom)} при ${vw}×${vh})`);
        if (vw <= 600 && panel.width < vw - 2 && !['reminderDialog', 'updateDialog', 'pinDialog'].includes(d.id)) problems.push(`окно ${d.id} на телефоне не во всю ширину (${Math.round(panel.width)} из ${vw})`);
        // «Планы» (reminderDialog) на компьютере — у правого верхнего угла по замыслу (CLAUDE.md)
        if (vw > 900 && d.id !== 'reminderDialog' && Math.abs((panel.left + panel.right) / 2 - vw / 2) > 2) problems.push(`окно ${d.id} не по центру`);
        dialogs.push(d.id); d.close();
      }
      document.querySelector('[data-view="today"]')?.click();
      return { problems, views, dialogs: dialogs.length };
    });
    for (const [name, profile] of Object.entries(PROFILES)) {
      const { page, context } = await open(name, profile);
      await signIn(page, 'vera@den.test');
      const r = await layout(page);
      ok(r.problems.length === 0, `${name}: экраны и ${r.dialogs} окон — без прокрутки вбок, ничего за краем, окна на месте`, r.problems.slice(0, 4).join(' | '));
      if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `device-${name.replace(/[^\wА-я]+/g, '_')}.png`) });
      await context.close();
    }

    // ---------- 2. Синхронизация: телефон, ноутбук, монитор у Шамиля; телефон у Ивана ----------
    const { page: phone, context: phoneCtx } = await open('iPhone Шамиля', PROFILES['iPhone 13']);
    const { page: laptop } = await open('ноутбук Шамиля', PROFILES['Ноутбук 1366×768']);
    const { page: desk } = await open('монитор Шамиля', PROFILES['Монитор 1920×1080']);
    const { page: ivan } = await open('Android Ивана', PROFILES['Android (Pixel 7)']);
    for (const p of [phone, laptop, desk]) await signIn(p, 'shamil@den.test');
    await signIn(ivan, 'ivan@den.test');
    // задача через окно приложения на телефоне
    await phone.evaluate(() => openDialog()); await phone.fill('#taskTitle', 'Купить кабель КПСнг'); await phone.click('#taskDialog button[type=submit]');
    await phone.waitForTimeout(1500); await sync(laptop); await sync(desk);
    ok(await laptop.evaluate(() => tasks.some(t => t.title === 'Купить кабель КПСнг')) && await desk.evaluate(() => tasks.some(t => t.title === 'Купить кабель КПСнг')), 'Задача с телефона появилась на ноутбуке и мониторе');
    // одновременные правки: побеждает более поздняя
    const tid = await phone.evaluate(() => tasks.find(t => t.title === 'Купить кабель КПСнг').id);
    await laptop.evaluate(id => { const t = tasks.find(x => x.id === id); t.note = 'с ноутбука'; t.updatedAt = new Date(Date.now() - 1000).toISOString(); save(); }, tid);
    await desk.evaluate(id => { const t = tasks.find(x => x.id === id); t.note = 'с монитора (позже)'; t.updatedAt = new Date().toISOString(); save(); }, tid);
    await sync(laptop); await sync(desk); await sync(laptop); await sync(phone);
    const notes = await Promise.all([phone, laptop, desk].map(p => p.evaluate(id => tasks.find(x => x.id === id)?.note, tid)));
    ok(notes.every(n => n === 'с монитора (позже)'), 'Одновременные правки: на всех трёх устройствах более поздняя', notes.join(' / '));
    // без сети: правки на телефоне, потом сеть появилась
    await phoneCtx.setOffline(true);
    await phone.evaluate(() => { tasks.push(normalizeTask ? normalizeTask({ id: 'offline-1', title: 'Записал без сети', date: toKey(new Date()), updatedAt: new Date().toISOString() }) : { id: 'offline-1', title: 'Записал без сети', date: toKey(new Date()), updatedAt: new Date().toISOString() });
      expenses.push(normalizeExpense({ id: 'offline-exp', kind: 'expense', title: 'Бензин', amount: 2500.4, category: 'other', occurredAt: new Date().toISOString(), updatedAt: new Date().toISOString() })); save(); saveExpenses(); });
    await phone.evaluate(() => performSync(false)).catch(() => {});
    await phone.reload(); await phone.waitForTimeout(1500); // приложение открывается без сети (из service worker), данные на месте
    const offline = await phone.evaluate(() => ({ shown: document.body.innerText.includes('Записал без сети') || tasks.some(t => t.id === 'offline-1'), user: !!window.DaySync.user() }));
    ok(offline.shown && offline.user, 'Без сети: приложение открывается после перезагрузки, записанное без сети на месте', JSON.stringify(offline));
    await phoneCtx.setOffline(false); await phone.evaluate(() => window.dispatchEvent(new Event('online'))); await phone.waitForTimeout(1500); await sync(phone);
    await sync(desk);
    ok(await desk.evaluate(() => tasks.some(t => t.id === 'offline-1') && expenses.find(e => e.id === 'offline-exp')?.amount === 2500.4), 'Сеть вернулась — задача и расход, записанные без сети, дошли до монитора (сумма та же: 2500,40 ₽)');
    // удаление на ноутбуке — пропадает везде и не воскресает
    await sync(laptop);
    await laptop.evaluate(id => { markDeleted(deletedIds, deletedStorageKey(), id); tasks = tasks.filter(t => t.id !== id); save(); }, tid);
    await sync(laptop); await sync(phone); await sync(desk); await sync(phone);
    const gone = await Promise.all([phone, laptop, desk].map(p => p.evaluate(id => !tasks.some(t => t.id === id), tid)));
    ok(gone.every(Boolean), 'Удаление на ноутбуке: задача пропала на всех устройствах и не вернулась', gone.join(','));
    // планы и профиль (общее состояние)
    await desk.evaluate(() => { periodPlans.push({ id: 'plan-dev-1', scope: 'all', anchorDate: toKey(new Date()), text: 'План с монитора', plannedDate: '', createdAt: new Date().toISOString() }); savePeriodPlans(); });
    await sync(desk); await sync(phone);
    ok(await phone.evaluate(() => periodPlans.some(p => p.id === 'plan-dev-1')), 'План, добавленный на мониторе, есть на телефоне');
    // финансы: итог одинаков на всех устройствах
    const totals = await Promise.all([phone, laptop, desk].map(async p => { await sync(p); return p.evaluate(() => expenses.filter(e => !e.deleted).reduce((s, e) => s + Math.round(e.amount * 100) * (e.kind === 'income' ? 1 : -1), 0)); }));
    ok(new Set(totals).size === 1, 'Финансы: итог в копейках совпадает на трёх устройствах', totals.join(' / '));
    // поручение: телефон Шамиля → Android Ивана, отчёт с фото → видно на мониторе
    await phone.evaluate(() => openDialog(null, 'shared')); await phone.fill('#taskTitle', 'Монтаж АПС, ул. Мира 5'); await phone.fill('#sharedEmails', 'ivan@den.test');
    await phone.click('#taskDialog button[type=submit]'); await phone.waitForTimeout(1800);
    await sync(ivan);
    const sid = await ivan.evaluate(() => sharedInvites().find(t => t.title === 'Монтаж АПС, ул. Мира 5')?.id);
    ok(!!sid, 'Иван получил поручение на Android');
    if (sid) {
      await ivan.evaluate(async id => { await acceptSharedInvite(id); await setSharedStatus(id, 'work');
        openDialog(id, 'shared'); const c = document.createElement('canvas'); c.width = c.height = 16; pendingReport.photo = await new Promise(r => c.toBlob(r, 'image/jpeg'));
        $('#reportText').value = 'Датчики стоят'; await sendSharedReport(); closeDialog(); }, sid);
      await sync(desk);
      const seen = await desk.evaluate(async id => { const t = sharedTasks.find(x => x.id === id); const photo = t?.reports?.at(-1)?.photo; const blob = photo ? await window.DaySync.loadSharedMedia(photo) : null; return { status: t?.status, text: t?.reports?.at(-1)?.text, size: blob?.size || 0 }; }, sid);
      ok(seen.status === 'work' && seen.text === 'Датчики стоят' && seen.size > 0, 'Монитор Шамиля: статус «В работе», отчёт и фото Ивана', JSON.stringify(seen));
    }
    // CRM: монитор → Android Ивана
    const users = (await api('GET', '/api/admin/users', null, admin)).body; const uid = e => users.find(u => u.email === e).id;
    await api('PUT', `/api/admin/users/${uid('shamil@den.test')}/crm`, { role: 'manager' }, admin); await api('PUT', `/api/admin/users/${uid('ivan@den.test')}/crm`, { role: 'worker' }, admin);
    await desk.evaluate(async () => { await window.DayCrm.sync();
      const now = new Date().toISOString(); await window.DayCrm.saveItemForTest({ id: 'cl-dev', name: 'ООО Север', phone: '+7 911 000-00-00', updatedAt: now }); });
    await desk.evaluate(async () => { const s = window.DayCrm.state; const now = new Date().toISOString();
      s.data.objects.set('ob-dev', { id: 'ob-dev', clientId: 'cl-dev', address: 'пр. Мира, 5', systems: ['АПС'], updatedAt: now }); s.edits.objects.set('ob-dev', s.data.objects.get('ob-dev'));
      s.data.orders.set('or-dev', { id: 'or-dev', objectId: 'ob-dev', stage: 'work', assignees: ['ivan@den.test'], sumKop: 9900000, updatedAt: now }); s.edits.orders.set('or-dev', s.data.orders.get('or-dev'));
      await window.DayCrm.saveLocal('objects'); await window.DayCrm.saveLocal('orders');
      for (let i = 0; i < 50 && s.syncing; i++) await new Promise(r => setTimeout(r, 100)); // идёт синхронизация после сохранения клиента
      await window.DayCrm.sync(); for (let i = 0; i < 50 && s.syncing; i++) await new Promise(r => setTimeout(r, 100)); });
    const shamilToken = await desk.evaluate(() => JSON.parse(localStorage.getItem('day-sync-session-v1')).access_token);
    ok((await api('GET', '/api/crm/orders?ids=or-dev', null, shamilToken)).body?.length === 1, 'CRM: заявка с монитора на сервере');
    await ivan.evaluate(async () => { await window.DayCrm.sync(); });
    const crm = await ivan.evaluate(() => ({ orders: [...window.DayCrm.state.data.orders.keys()], money: window.DayCrm.state.data.payments.size, sum: window.DayCrm.state.data.orders.get('or-dev')?.sumKop }));
    ok(crm.orders.includes('or-dev'), 'CRM: заявка с монитора у монтажника на телефоне', JSON.stringify(crm));
    // PIN на телефоне
    await phone.evaluate(async () => { openSyncDialog(); $('#pinSetupInput').value = '1234'; await savePin(); });
    await phone.evaluate(() => { localStorage.removeItem(pinUnlockedAtStorageKey()); }); await phone.reload(); await phone.waitForTimeout(1500);
    const locked = await phone.evaluate(() => $('#pinDialog').open);
    for (let i = 0; i < 5; i++) { await phone.fill('#pinUnlockInput', '0000'); await phone.click('#pinUnlockForm button[type=submit]'); await phone.waitForTimeout(150); }
    await phone.fill('#pinUnlockInput', '1234'); await phone.click('#pinUnlockForm button[type=submit]'); await phone.waitForTimeout(300);
    const paused = await phone.evaluate(() => $('#pinDialog').open && /Подождите|паузу/.test($('#pinError').textContent));
    await phone.evaluate(() => localStorage.removeItem('day-planner-pin-fails-v1'));
    await phone.fill('#pinUnlockInput', '1234'); await phone.click('#pinUnlockForm button[type=submit]'); await phone.waitForTimeout(500);
    ok(locked && paused && !(await phone.evaluate(() => $('#pinDialog').open)), 'PIN: после перезагрузки замок; 5 неверных — пауза даже для верного; верный PIN открывает', JSON.stringify({ locked, paused }));
    // два человека на одном ноутбуке: данные не смешиваются
    await laptop.evaluate(async () => { await handleSyncLogout(); });
    await signIn(laptop, 'vera@den.test');
    const mixed = await laptop.evaluate(() => ({ user: window.DaySync.user().email, tasks: tasks.map(t => t.title), shared: sharedTasks.length, crm: !$('#tabCrm').hidden }));
    ok(mixed.user === 'vera@den.test' && !mixed.tasks.some(t => /без сети|кабель/i.test(t)) && mixed.shared === 0 && !mixed.crm, 'Вера вошла на ноутбуке Шамиля после выхода — его задачи, поручения и «Клиенты» не видны', JSON.stringify(mixed));
    await laptop.evaluate(async () => { await handleSyncLogout(); }); await signIn(laptop, 'shamil@den.test'); await sync(laptop);
    ok(await laptop.evaluate(() => tasks.some(t => t.id === 'offline-1') && periodPlans.some(p => p.id === 'plan-dev-1')), 'Шамиль снова вошёл на ноутбуке — его задачи и планы на месте');
    ok(errors.length === 0, 'Нет ошибок JavaScript и неожиданных ошибок сервера', errors.slice(0, 6).join(' | '));
    ok(!/Traceback/.test(log), 'В журнале сервера нет сбоев', log.slice(-400));
  } catch (error) { ok(false, 'Проверка оборвалась', error.stack); }
  finally { if (browser) await browser.close(); server.kill(); }
  const passed = results.filter(Boolean).length;
  console.log(`\nИТОГ: ${passed}/${results.length}${passed === results.length ? ' ✔' : ''}`);
  process.exit(passed === results.length ? 0 : 1);
})();
