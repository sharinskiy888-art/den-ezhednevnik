/*
 * Часть монтажника обновляется сама (ТЗ АК-День, задача О п. 6): телефон открыл …/worker (service worker закэшировал
 * часть) → на сервер поставили новую версию → при следующем открытии та же ссылка показывает новую версию.
 * «Новая версия» — копия экранов с номером +1 во всех файлах (как настоящий выпуск). Запуск: node tools/test-ak-part-update.js
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net'); const crypto = require('crypto');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const FILES = ['index.html', 'app.js', 'crm.js', 'sync.js', 'sync-config.js', 'i18n-en.js', 'styles.css', 'sw.js', 'version.js', 'version.json',
  'manifest.webmanifest', 'manifest-worker.webmanifest', 'install.html', 'qr-iphone.svg'];
const results = [];
const ok = (cond, name, info = '') => { results.push(!!cond); console.log(`${cond ? '✔' : '✗'} ${name}${info ? ' — ' + info : ''}`); };
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const [port, corePort] = [await freePort(), await freePort()];
  const secret = crypto.randomBytes(32).toString('hex');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'den-part-')); const screens = path.join(data, 'screens');
  fs.mkdirSync(screens); FILES.forEach(f => fs.copyFileSync(path.join(ROOT, f), path.join(screens, f))); fs.cpSync(path.join(ROOT, 'assets'), path.join(screens, 'assets'), { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version; const next = String(Number(version) + 1);
  const IVAN = crypto.randomUUID(); const employees = { [IVAN]: { id: IVAN, name: 'Иван Монтажник' } };
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DEN_') && !k.startsWith('AK_'))),
    AK_MODULE_ID: 'crm', AK_MODULE_SECRET: secret, AK_HOST: '127.0.0.1', AK_PORT: String(port), AK_BASE_PATH: '/m/crm',
    AK_CORE_URL: `http://127.0.0.1:${corePort}`, AK_DATA_DIR: path.join(data, 'data'), AK_LOG_DIR: path.join(data, 'data'), DEN_STATIC_DIR: screens };
  let log = '';
  const module = spawn(PY, ['-m', 'server.run'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const core = spawn(PY, ['server/tests/ak_core.py', String(corePort), String(port), secret, 'crm', JSON.stringify(employees)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  [module, core].forEach(p => { p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d); });
  const base = `http://127.0.0.1:${corePort}/m/crm/`;
  let browser;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + 'api/health', { headers: { 'X-Test-User': IVAN, 'X-Test-Roles': 'installer' } })).ok) break; } catch {} await wait(150); }
    browser = await chromium.launch(); const errors = [];
    const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
    await context.addCookies([{ name: 'ak_core_test', value: encodeURIComponent(`${IVAN}|installer`), url: base }]);
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + 'worker'); await page.waitForTimeout(1500);
    await page.evaluate(() => navigator.serviceWorker.ready); await page.waitForTimeout(500);
    const before = await page.evaluate(() => ({ version: APP_VERSION, part: document.documentElement.dataset.part, scope: navigator.serviceWorker.controller ? 'есть' : 'нет' }));
    ok(before.version === version && before.part === 'worker', `Часть монтажника открыта, версия ${version}`, JSON.stringify(before));
    // новый выпуск на сервере: номер +1 во всех файлах, как делает настоящий выпуск
    for (const f of ['index.html', 'app.js', 'sw.js', 'version.js', 'version.json']) {
      const file = path.join(screens, f); let text = fs.readFileSync(file, 'utf8');
      text = text.split(`?v=${version}`).join(`?v=${next}`).replace(`day-planner-v${version}`, `day-planner-v${next}`)
        .replace(`APP_VERSION = '${version}'`, `APP_VERSION = '${next}'`).replace(`version: '${version}'`, `version: '${next}'`).replace(`"version": "${version}"`, `"version": "${next}"`);
      fs.writeFileSync(file, text);
    }
    // следующее открытие той же ссылки (с главного экрана телефона): приложение само находит новую версию и перезагружается
    await page.goto(base + 'worker'); await page.waitForTimeout(1000);
    for (let i = 0; i < 40 && await page.evaluate(() => APP_VERSION).catch(() => '') !== next; i++) await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({ version: APP_VERSION, part: document.documentElement.dataset.part, path: location.pathname }));
    ok(after.version === next && after.part === 'worker' && after.path.endsWith('/worker/'), `Без новой ссылки часть сама обновилась до ${next} и осталась частью монтажника`, JSON.stringify(after));
    const caches = await page.evaluate(async () => { for (let i = 0; i < 20; i++) { const keys = await caches.keys(); if (keys.length === 1) return keys; await new Promise(r => setTimeout(r, 300)); } return caches.keys(); });
    ok(caches.length === 1 && caches[0] === `day-planner-v${next}`, 'Старый кэш удалён, остался только кэш новой версии', caches.join(', '));
    ok(errors.length === 0, 'Нет ошибок JavaScript', errors.slice(0, 3).join(' | '));
  } catch (error) { ok(false, 'Проверка оборвалась', error.stack); }
  finally { if (browser) await browser.close(); module.kill(); core.kill(); }
  if (/Traceback/.test(log)) ok(false, 'В журнале модуля сбой', log.slice(-800));
  const passed = results.filter(Boolean).length;
  console.log(`\nИТОГ: ${passed}/${results.length}${passed === results.length ? ' ✔' : ''}`);
  process.exit(passed === results.length ? 0 : 1);
})();
