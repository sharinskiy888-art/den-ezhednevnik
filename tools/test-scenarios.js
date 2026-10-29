/*
 * Живые сценарии модуля АК глазами людей: несколько сотрудников ядра, поручение от начала до конца через кнопки
 * (принять, статус, подзадача, отчёт с фото и голосом, «Напомнить», проверка, завершение, «Попросить выйти» / «Отпустить»),
 * новый сотрудник ядра, и телефон, когда компьютер с АК-Сервером выключен (нет связи, 502, 404, страница входа ядра).
 * Запуск: node tools/test-scenarios.js   (PYTHON= — свой python)
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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const [port, corePort] = [await freePort(), await freePort()];
  const secret = crypto.randomBytes(32).toString('hex');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'den-sc-'));
  const BOSS = crypto.randomUUID(), IVAN = crypto.randomUUID(), OLGA = crypto.randomUUID(), PETR = crypto.randomUUID();
  const employees = { [BOSS]: { id: BOSS, name: 'Шамиль', email: 'boss@firma.ru' }, [IVAN]: { id: IVAN, name: 'Иван Монтажник', email: 'ivan@firma.ru' },
    [OLGA]: { id: OLGA, name: 'Ольга' } };
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DEN_') && !k.startsWith('AK_'))),
    AK_MODULE_ID: 'crm', AK_MODULE_SECRET: secret, AK_HOST: '127.0.0.1', AK_PORT: String(port), AK_BASE_PATH: '/m/crm',
    AK_CORE_URL: `http://127.0.0.1:${corePort}`, AK_DATA_DIR: data, AK_LOG_DIR: data };
  // Прежняя установка «Дня» на этом компьютере: в ней был petr@old.ru, которого ядро не знает (его email нет в АК-Сервере)
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'den-sc-old-'));
  const oldEnv = { ...env, DEN_DATA_DIR: legacy, DEN_SECRET: 's'.repeat(40), DEN_ENV_FILE: path.join(legacy, 'нет.env'), DEN_NEW_PASSWORD: 'old-pass-123' };
  for (const key of Object.keys(oldEnv)) if (key.startsWith('AK_')) delete oldEnv[key];
  require('child_process').execFileSync(PY, ['-m', 'server.admin', 'add', 'petr@old.ru', '-'], { cwd: ROOT, env: oldEnv, stdio: 'ignore' });
  require('child_process').execFileSync(PY, ['-c', `import sqlite3, sys, json; c = sqlite3.connect(sys.argv[1]); uid = c.execute('select id from users').fetchone()[0]
c.execute('insert into rows values (?,?,?,?,?,null)', (uid, 'tasks', 'petr-old', json.dumps({'id': 'petr-old', 'title': 'Задача прежнего Петра', 'date': '2026-10-20', 'updatedAt': '2026-10-20T10:00:00.000Z'}), '2026-10-20T10:00:00.000Z')); c.commit()`, path.join(legacy, 'den.db')]);
  env.DEN_LEGACY_DATA = legacy;
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
    browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const errors = [];
    const device = async (name, user, roles, viewport = { width: 390, height: 820 }) => {
      const context = await browser.newContext({ viewport, permissions: ['microphone'] });
      await context.addCookies([{ name: 'ak_core_test', value: encodeURIComponent(`${user}|${roles}`), url: base }]);
      const page = await context.newPage(); page.allow = new Set();
      page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
      page.on('response', r => { if (r.status() >= 400 && !page.allow.has(r.status()) && !page.outage) errors.push(`${name}: ${r.status()} ${new URL(r.url()).pathname}`); });
      page.on('dialog', d => d.accept());
      await page.goto(base); await page.waitForTimeout(1500); return { page, context };
    };
    const shared = (page, id) => page.evaluate(id => sharedTasks.find(t => t.id === id) || null, id);
    const refresh = page => page.evaluate(async () => { await loadSharedTasks(false); render(); });

    // 1. Три сотрудника ядра открывают «День»: никто не регистрируется, у каждого свой человек
    const { page: boss } = await device('Шамиль', BOSS, 'owner', { width: 1366, height: 768 });
    const { page: ivan, context: ivanCtx } = await device('Иван', IVAN, 'courier');
    const { page: olga } = await device('Ольга', OLGA, 'cashier');
    const ids = await Promise.all([boss, ivan, olga].map(p => p.evaluate(() => window.DaySync.user()?.id)));
    ok(ids[0] === BOSS && ids[1] === IVAN && ids[2] === OLGA, 'Три сотрудника вошли через ядро, у каждого свой человек');

    // 2. Шамиль создаёт поручение кнопками: исполнители — Иван и Ольга, подзадачи
    await boss.evaluate(() => openDialog(null, 'shared')); await boss.waitForTimeout(800);
    await boss.locator('#taskDialog .ak-pick button', { hasText: 'Иван' }).click();
    await boss.locator('#taskDialog .ak-pick button', { hasText: 'Ольга' }).click();
    await boss.fill('#taskTitle', 'Монтаж АПС на объекте');
    await boss.fill('#taskSubtasks', 'Проложить кабель\nПоставить датчики');
    await boss.click('#taskDialog button[type=submit]'); await boss.waitForTimeout(1500);
    const tid = await boss.evaluate(() => sharedTasks.find(t => t.title === 'Монтаж АПС на объекте')?.id);
    const created = tid && await shared(boss, tid);
    ok(created && created.invitedEmails.includes(`${IVAN}@ak`) && created.invitedEmails.includes(`${OLGA}@ak`) && created.subtasks.length === 2, 'Поручение создано: два исполнителя, две подзадачи', JSON.stringify(created?.invitedEmails));

    // 3. Иван: окно приглашения по центру → «Принять»
    await refresh(ivan); await ivan.evaluate(() => renderSharedInvitePrompt()); await ivan.waitForTimeout(500);
    const prompt = await ivan.evaluate(() => { const box = document.querySelector('#sharedInvitePrompt, .shared-invite-prompt, [data-invite-prompt]'); return box && !box.hidden ? box.textContent : ''; });
    ok(prompt.includes('Монтаж АПС'), 'У Ивана всплыло приглашение', prompt.slice(0, 80));
    await ivan.evaluate(id => acceptSharedInvite(id), tid); await ivan.waitForTimeout(800);
    ok((await shared(ivan, tid))?.acceptedEmails.includes(`${IVAN}@ak`), 'Иван принял поручение');
    await olga.evaluate(async id => { await loadSharedTasks(false); await acceptSharedInvite(id); }, tid);

    // 4. Иван ставит «В работе», отмечает подзадачу, шлёт отчёт: текст + фото + голос (кнопками)
    await ivan.evaluate(id => openDialog(id, 'shared'), tid); await ivan.waitForTimeout(800);
    await ivan.locator('#sharedView [data-status="open"]').click(); await ivan.waitForTimeout(800);
    await ivan.locator('#sharedView [data-shared-subtask]').first().click(); await ivan.waitForTimeout(800);
    await ivan.fill('#reportText', 'Кабель проложен');
    await ivan.setInputFiles('#reportPhotoInput', { name: 'shchit.png', mimeType: 'image/png', buffer: PNG }); await ivan.waitForTimeout(800);
    await ivan.click('#reportVoiceButton'); await ivan.waitForTimeout(1500); await ivan.click('#reportVoiceButton'); await ivan.waitForTimeout(800);
    const pending = await ivan.evaluate(() => ({ photo: !!pendingReport.photo, voice: !!pendingReport.voice }));
    await ivan.click('#reportSend'); await ivan.waitForTimeout(2000);
    const afterReport = await shared(ivan, tid);
    const report = afterReport?.reports?.[0] || {};
    ok(pending.photo && pending.voice && report.text === 'Кабель проложен' && report.photo && report.voice, 'Отчёт ушёл: текст, фото и голосовое', JSON.stringify({ pending, report }));
    ok(afterReport?.status === 'open' && afterReport.subtasks[0].done && afterReport.subtasks[0].doneBy === `${IVAN}@ak`, 'Статус «В работе» и подзадача отмечены Иваном');

    // 5. Шамиль видит отчёт, открывает фото и слушает голос
    await refresh(boss); await boss.evaluate(id => openDialog(id, 'shared'), tid); await boss.waitForTimeout(800);
    const who = await boss.locator('#sharedReportList .report-item strong').first().textContent();
    await boss.locator('[data-report-photo]').first().click(); await boss.locator('[data-report-voice]').first().click(); await boss.waitForTimeout(1500);
    const media = await boss.evaluate(() => ({ img: !!document.querySelector('#sharedReportList img.report-photo'), audio: !!document.querySelector('#sharedReportList audio') }));
    ok(who.includes('Иван') && media.img && media.audio, 'Шамиль видит отчёт Ивана (по имени), фото открылось, голос играет', JSON.stringify({ who, media }));

    // 6. «Напомнить исполнителю» → у Ивана окно напоминания
    await boss.locator('#sharedView [data-nudge-shared]').click(); await boss.waitForTimeout(1200);
    await refresh(ivan); await ivan.evaluate(() => { $('#taskDialog').close(); renderSharedInvitePrompt(); }); await ivan.waitForTimeout(500);
    const nudge = await ivan.evaluate(() => pendingNudges().map(t => t.title));
    ok(nudge.includes('Монтаж АПС на объекте'), 'Кнопка «Напомнить»: у Ивана всплыло напоминание', JSON.stringify(nudge));

    // 7. Иван — «Готово, на проверке»; Ольга просит выйти, Шамиль отпускает; Шамиль завершает
    await ivan.evaluate(id => setSharedStatus(id, 'review'), tid); await ivan.waitForTimeout(800);
    await olga.evaluate(async id => { await loadSharedTasks(false); await requestLeaveShared(id); }, tid); await olga.waitForTimeout(500);
    await refresh(boss); await boss.evaluate(id => { $('#taskDialog').close(); openDialog(id, 'shared'); }, tid); await boss.waitForTimeout(800);
    const release = boss.locator('#sharedView [data-release-shared]');
    const asked = await release.count(); if (asked) { await release.first().click(); await boss.waitForTimeout(1000); }
    await refresh(olga); const olgaHas = !!(await shared(olga, tid));
    ok(asked === 1 && !olgaHas, 'Ольга попросила выйти, Шамиль нажал «Отпустить» — у Ольги поручение пропало');
    ok((await shared(boss, tid))?.status === 'review', 'Шамиль видит «Готово, на проверке»');
    await boss.locator('#sharedView [data-status="completed"]').click(); await boss.waitForTimeout(1000);
    await refresh(ivan);
    ok((await shared(ivan, tid))?.status === 'completed', 'Шамиль завершил — у Ивана «Принято и завершено»');

    // 8. Новый сотрудник: завели в АК-Сервере → он открыл «День» → Шамиль может дать ему поручение
    core.stdin; // ядро-заглушка читает сотрудников при запуске: нового добавляем как вход (так он появляется в базе «Дня»)
    employees[PETR] = { id: PETR, name: 'Пётр Новый' };
    const first = await api(PETR, 'courier', 'api/ak/me');
    await boss.evaluate(async () => { akEmployeesCache = await window.DaySync.akEmployees(); });
    const people = await boss.evaluate(() => akEmployeesCache.map(p => p.key));
    ok(first.status === 200 && people.includes(`${PETR}@ak`), 'Новый сотрудник после первого входа виден Шамилю в списке исполнителей', JSON.stringify(first.body));

    // 8б. Прежний «Дня» человек без пары: владелец в «Аккаунт» выбирает, кто это (Ольга), и нажимает «Связать»
    await boss.evaluate(() => openSyncDialog()); await boss.waitForTimeout(1200);
    const row = boss.locator('#akLegacyList .ak-legacy-row', { hasText: 'petr@old.ru' });
    const rowShown = await row.count();
    if (rowShown) { await row.locator('select').selectOption(OLGA); await row.locator('button').click(); await boss.waitForTimeout(1200); }
    const boxHidden = await boss.evaluate(() => $('#akLegacyBox').hidden);
    await boss.evaluate(() => $('#syncDialog').close());
    await olga.evaluate(() => performSync(false)); await olga.waitForTimeout(800);
    const olgaOld = await olga.evaluate(() => tasks.some(t => t.id === 'petr-old'));
    const ivanBox = await ivan.evaluate(async () => { openSyncDialog(); await new Promise(r => setTimeout(r, 800)); const hidden = $('#akLegacyBox').hidden; $('#syncDialog').close(); return hidden; });
    ok(rowShown === 1 && boxHidden && olgaOld && ivanBox, 'Прежний человек без пары: владелец связал его с Ольгой — её задачи на месте; у монтажника этого блока нет', JSON.stringify({ rowShown, boxHidden, olgaOld, ivanBox }));

    // 8в. Перенос с прежнего сайта (Supabase) вручную: файл «Сохранить копию» с телефона → «Загрузить копию» в модуле
    const backup = { app: 'den-ezhednevnik', version: '98', exportedAt: new Date().toISOString(), deletedIds: {}, deletedExpenseIds: {}, periodPlans: [], financeLimits: {}, profile: {},
      tasks: [{ id: 'site-task', title: 'Задача с сайта', date: '2026-10-28', updatedAt: '2026-10-28T09:00:00.000Z' }],
      expenses: [{ id: 'site-exp', kind: 'expense', title: 'Кабель', amount: 1250.5, category: 'other', occurredAt: '2026-10-28T09:00:00.000Z', updatedAt: '2026-10-28T09:00:00.000Z' }] };
    await olga.setInputFiles('#importBackupInput', { name: 'den-backup-2026-10-28.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await olga.waitForTimeout(1500); await olga.evaluate(() => performSync(false)); await olga.waitForTimeout(1000);
    const onServer = { tasks: ((await api(OLGA, 'cashier', 'api/data/tasks/heads')).body || []).map(h => h.id), exp: ((await api(OLGA, 'cashier', 'api/data/expenses/heads')).body || []).map(h => h.id) };
    ok(onServer.tasks.includes('site-task') && onServer.exp.includes('site-exp'), 'Копия с прежнего сайта загружена в модуль: задача и расход дошли до сервера', JSON.stringify(onServer));

    // 9. Компьютер с АК-Сервером выключен: телефон Ивана
    await ivan.evaluate(async () => { tasks.push({ id: 'before-off', title: 'Записано при связи', date: toKey(new Date()), updatedAt: new Date().toISOString() }); save(); await performSync(false); });
    await ivan.waitForTimeout(500);
    const outage = async (label, handler) => {
      ivan.outage = true;
      await ivanCtx.route(`http://127.0.0.1:${corePort}/**`, handler);
      let opened = false; let who = '';
      try { await ivan.reload({ timeout: 15000 }); await ivan.waitForTimeout(2500); opened = await ivan.evaluate(() => typeof tasks !== 'undefined' && tasks.some(t => t.id === 'before-off')); who = await ivan.evaluate(() => window.DaySync?.user()?.id || ''); } catch (e) { who = e.message.slice(0, 80); }
      const id = `off-${label}`;
      if (opened) await ivan.evaluate(async id => { tasks.push({ id, title: id, date: toKey(new Date()), updatedAt: new Date().toISOString() }); save(); try { await performSync(false); } catch {} }, id);
      await ivan.waitForTimeout(500);
      const kept = opened && await ivan.evaluate(id => (localStorage.getItem(taskStorageKey()) || '').includes(id), id);
      if (opened) {
        await ivan.waitForTimeout(1000);
        const seen = await ivan.evaluate(() => sharedTasks.map(t => t.title));
        const said = await ivan.evaluate(async () => { const id = sharedTasks[0]?.id; if (!id) return ''; $('#toastText').textContent = ''; await setSharedStatus(id, 'question'); return $('#toastText').textContent; });
        ok(seen.includes('Монтаж АПС на объекте') && /недоступен|Нет связи/.test(said), `Сервер выключен (${label}): поручения видны, при попытке изменить — понятное сообщение`, JSON.stringify({ seen, said }));
      }
      ok(opened && who === IVAN && kept, `Сервер выключен (${label}): «День» открылся с задачами, Иван не «вышел», новая задача сохранилась на телефоне`, `opened=${opened} who=${who}`);
      await ivanCtx.unroute(`http://127.0.0.1:${corePort}/**`); ivan.outage = false;
      await ivan.goto(base); await ivan.waitForTimeout(2000); await ivan.evaluate(() => performSync(false)); await ivan.waitForTimeout(800);
      const server = ((await api(IVAN, 'courier', 'api/data/tasks/heads')).body || []).map(h => h.id);
      ok(server.includes(id), `Сервер включили (${label}): задача, записанная без связи, дошла до сервера`);
    };
    await outage('нет связи', route => route.abort('connectionrefused'));
    await outage('502 от VPS', route => route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }));
    await outage('404 от туннеля', route => route.fulfill({ status: 404, contentType: 'text/html', body: '<html><body>404 page not found</body></html>' }));
    // Вход в ядро истёк (компьютер включён): ядро уводит на свою страницу входа — её и показываем, после входа всё на месте
    ivan.outage = true;
    await ivanCtx.route(`http://127.0.0.1:${corePort}/**`, route => route.request().url().includes('/login') ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html><body>Вход в АК-Сервер</body></html>' }) : route.fulfill({ status: 302, headers: { location: `http://127.0.0.1:${corePort}/login` } }));
    await ivan.reload(); await ivan.waitForTimeout(1500);
    const loginText = (await ivan.textContent('body')) + ' ' + ivan.url(); const loginShown = loginText.includes('Вход в АК-Сервер');
    await ivanCtx.unroute(`http://127.0.0.1:${corePort}/**`); ivan.outage = false;
    await ivan.goto(base); await ivan.waitForTimeout(2000);
    const back = await ivan.evaluate(() => ({ who: window.DaySync.user()?.id, has: tasks.some(t => t.id === 'off-нет связи') }));
    ok(loginShown && back.who === IVAN && back.has, 'Вход в ядро истёк: показана страница входа ядра, после входа «День» и задачи на месте', JSON.stringify(back) + (loginShown ? '' : loginText.slice(0, 200)));
    const cached = await ivan.evaluate(async () => { const keys = await caches.keys(); for (const k of keys) { const c = await caches.open(k); for (const r of await c.keys()) { const t = await (await c.match(r)).text(); if (/Bad Gateway|page not found|Вход в АК-Сервер/.test(t)) return r.url; } } return ''; });
    ok(!cached, 'Страница ошибки или входа не попала в кэш вместо приложения', cached);

    ok(errors.length === 0, 'Нет ошибок JavaScript и неожиданных ошибок сервера', errors.slice(0, 6).join(' | '));
    ok(!/Traceback/.test(log), 'В журнале модуля нет сбоев', log.slice(-400));
  } catch (error) { ok(false, 'Проверка оборвалась', error.stack); }
  finally { if (browser) await browser.close(); module.kill(); core.kill(); }
  const passed = results.filter(Boolean).length;
  console.log(`\nИТОГ: ${passed}/${results.length}${passed === results.length ? ' ✔' : ''}`);
  process.exit(passed === results.length ? 0 : 1);
})();
