// Кнопки по общему файлу АК (assets/ak-buttons.css = «АК-кнопки.css» как есть): каждая видимая кнопка действия на главном
// экране и во всех окнах — объёмная по образцу; меню, вкладки, дни и значки (.nav/.tab/.icon) — свой вид, их размеры
// от файла не меняются; ни одна кнопка не появилась и не пропала из-за файла. Ширины 375, 768, 1366.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'); const net = require('net'); const os = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
let failed = 0;
const ok = (cond, name, info = '') => { console.log(`${cond ? '✔' : '✗'} ${name}${cond ? '' : ' — ' + info}`); if (!cond) failed++; };

(async () => {
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'den-ak-buttons-'));
  const env = { ...process.env, DEN_SECRET: 'ak-buttons-secret-' + 'x'.repeat(40), DEN_DATA_DIR: data, DEN_STATIC_DIR: ROOT,
    DEN_ADMIN_EMAIL: 'admin@den.test', DEN_ADMIN_PASSWORD: 'admin-pass-1', DEN_PUBLIC_URL: base };
  const server = spawn(PY, ['-m', 'uvicorn', 'server.main:app', '--port', String(port)], { cwd: ROOT, env, stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    const sameFile = fs.readFileSync(path.join(ROOT, 'assets', 'ak-buttons.css'), 'utf8').startsWith('/* АК-кнопки.css');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const links = [...html.matchAll(/<link rel="stylesheet" href="([^"?]+)/g)].map(m => m[1]);
    ok(sameFile && links[links.length - 1] === 'assets/ak-buttons.css', 'АК-кнопки.css лежит в программе и подключён последним', JSON.stringify(links));
    for (const [w, h] of [[1366, 768], [768, 1024], [375, 800]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.goto(base + '/'); await page.waitForTimeout(1000);
      await page.evaluate(() => { tasks.push({ id: 'b1', title: 'Проверка кнопок', date: toKey(new Date()), updatedAt: new Date().toISOString(), subtasks: [{ text: 'шаг', done: false }] }); save(); render(); });
      const views = [null, ...(await page.$$eval('dialog', ds => ds.map(d => d.id)))];
      const wrong = [], changed = [];
      for (const id of views) {
        if (id) await page.evaluate(id => document.getElementById(id).showModal(), id);
        await page.waitForTimeout(250); // кнопка меняет тень с переходом 0,07 с — ждём, пока он закончится
        const snap = () => page.evaluate(() => [...document.querySelectorAll('button')].map(b => {
          const r = b.getBoundingClientRect(), cs = getComputedStyle(b);
          const act = !['nav', 'tab', 'icon'].some(c => b.classList.contains(c));
          const raised = cs.backgroundImage.includes('gradient') && cs.borderTopLeftRadius === '12px' && parseFloat(cs.minHeight) >= 44 && cs.boxShadow.includes('0px 4px 0px');
          return { vis: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0, w: Math.round(r.width), h: Math.round(r.height), act, raised, d: (b.id || b.className || b.textContent.trim()).slice(0, 40) };
        }));
        const on = await snap();
        await page.evaluate(() => { document.querySelector('link[href*="ak-buttons"]').disabled = true; });
        await page.waitForTimeout(250);
        const off = await snap();
        await page.evaluate(() => { document.querySelector('link[href*="ak-buttons"]').disabled = false; });
        on.forEach((a, i) => {
          const b = off[i], where = id || 'главный экран';
          if (a.vis && a.act && !a.raised) wrong.push(`${where}: ${a.d}`);
          if (a.vis !== b.vis) changed.push(`${where}: ${a.d} видна ${b.vis}→${a.vis}`);
          else if (a.vis && !a.act && (Math.abs(a.w - b.w) > 2 || Math.abs(a.h - b.h) > 2)) changed.push(`${where}: ${a.d} ${b.w}×${b.h}→${a.w}×${a.h}`);
        });
        if (id) await page.evaluate(id => document.getElementById(id).close(), id);
      }
      ok(!wrong.length, `${w} px: все кнопки действий объёмные по АК-кнопки.css`, wrong.join('; '));
      ok(!changed.length, `${w} px: меню, вкладки и значки не задеты, ни одна кнопка не появилась и не пропала`, changed.join('; '));
      await page.close();
    }
  } catch (e) { ok(false, 'Проверка прошла без сбоев', e.stack); }
  await browser.close(); server.kill();
  console.log(`\nИТОГ: ${failed ? 'ошибок ' + failed : 'все проверки ✔'}`);
  process.exit(failed ? 1 : 0);
})();
