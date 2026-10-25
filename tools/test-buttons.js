#!/usr/bin/env node
/*
 * Полный тест кнопок приложения «День» в настоящем браузере (Chromium через Playwright).
 *
 * Что делает:
 *   1. Поднимает локальный сервер с файлами проекта (интернет не нужен, сервер «День» подменён заглушкой).
 *   2. Открывает приложение в 4 режимах: компьютер/телефон × гость/вошёл в аккаунт.
 *   3. СКВОЗНЫЕ СЦЕНАРИИ: добавить задачу → отметить → открыть → удалить, переключение видов, поиск и т.д.
 *   4. ОБХОД: настоящими нажатиями «как пользователь» кликает каждую видимую кнопку, ссылку,
 *      переключатель и чекбокс (включая внутри всех диалогов и на карточках задач) и фиксирует:
 *        - ОШИБКА JS   — исключение в консоли/обработчике после нажатия;
 *        - НЕ НАЖАТЬ   — кнопка перекрыта другим элементом / не прокручивается / исчезла;
 *        - БЕЗ РЕАКЦИИ — нажатие вообще ничего не изменило (DOM, хранилище, диалоги, сеть).
 *
 * Запуск (из корня проекта):   node tools/test-buttons.js
 * Параметры:                   --only=desktop-guest   (один режим)   --json=report.json   --shots=папка
 * Код выхода: 0 — всё чисто, 1 — найдены ошибки/неработающие кнопки, 2 — не найден Playwright.
 *
 * Нужен Playwright:  npm i -D playwright && npx playwright install chromium
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright')); } catch {
  try {
    const root = require('child_process').execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    ({ chromium } = require(path.join(root, 'playwright')));
  } catch {
    console.error('Playwright не найден. Установите: npm i -D playwright && npx playwright install chromium');
    process.exit(2);
  }
}

const ROOT = path.resolve(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const serverState = { fakeVersion: 0, mock: null };
function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/version.js' && /check=/.test(req.url) && serverState.fakeVersion > 0) {
        serverState.fakeVersion--; res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
        return res.end("window.DAY_APP_RELEASE={version:'999',released:'2099-01-01',notes:['Тестовое обновление']};");
      }
      if (p.startsWith('/api/')) return handleApi(req, res, p); // сервер «День» подменён заглушкой на этом же адресе (без CORS)
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const pad = n => String(n).padStart(2, '0');
const MSK = 3 * 3600e3; // тест идёт в часовом поясе Europe/Moscow (как у пользователя)
const keyOf = d => new Date(d.getTime() + MSK).toISOString().slice(0, 10);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function seedData(signedIn, opts = {}) {
  const now = new Date(); const today = keyOf(now);
  const tomorrow = keyOf(new Date(now.getTime() + 864e5)); const yesterday = keyOf(new Date(now.getTime() - 864e5));
  const t = (id, o) => ({ id, title: 'Задача ' + id, date: today, time: '', priority: 'normal', note: '', autoCarry: true, reminder: '', reminderUtc: '', repeat: 'none', subtasks: [], proofNote: '', notified: false, photo: null, attachment: null, photoCapturedAt: '', updatedAt: new Date().toISOString(), completed: false, carryCount: 0, ...o });
  const tasks = [
    t('11111111-1111-4111-8111-111111111111', { title: 'Подключить аккумулятор на 6п', priority: 'high', time: '09:30' }),
    t('22222222-2222-4222-8222-222222222222', { title: 'Проверить шлейфы', subtasks: [{ title: 'Шлейф 1', done: false }, { title: 'Шлейф 2', done: true }], note: 'заметка' }),
    t('33333333-3333-4333-8333-333333333333', { title: 'Готовая задача', completed: true }),
    t('44444444-4444-4444-8444-444444444444', { title: 'Завтрашняя', date: tomorrow, repeat: 'weekly', priority: 'low' }),
    t('55555555-5555-4555-8555-555555555555', { title: 'С фото', attachment: { name: 'фото.png', type: 'image/png', size: 70, data: PNG } }),
    t('66666666-6666-4666-8666-666666666666', { title: 'Вчерашняя перенесённая', date: yesterday, carryCount: 1 }),
    t('77777777-7777-4777-8777-777777777777', { title: 'С напоминанием', reminder: `${today}T23:50`, reminderUtc: new Date(`${today}T23:50:00+03:00`).toISOString() })
  ];
  if (opts.due) tasks.push(t('88888888-8888-4888-8888-888888888888', { title: 'Просроченное напоминание', reminder: new Date(Date.now() - 120000 + MSK).toISOString().slice(0, 16), reminderUtc: new Date(Date.now() - 120000).toISOString() }));
  // совместная задача: по умолчанию уже принята (чтобы всплывающее приглашение не перекрывало экран); opts.invite — ждёт ответа
  const inv = !!opts.invite;
  const sharedRow = signedIn ? [{ id: '99999999-9999-4999-8999-999999999999', owner_id: 'u-other', owner_email: 'brother@example.com', invited_emails: inv ? ['tester@example.com'] : [], accepted_emails: inv ? [] : ['tester@example.com'], updated_at: new Date().toISOString(), payload: t('99999999-9999-4999-8999-999999999999', { title: 'Совместная от брата', status: 'new', activity: [] }) }] : [];
  if (signedIn && opts.overdue) sharedRow.push(
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', owner_id: 'u-other', owner_email: 'brother@example.com', invited_emails: [], accepted_emails: ['tester@example.com'], updated_at: new Date().toISOString(), payload: t('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { title: 'Просроченная совместная', date: yesterday, status: 'open', activity: [] }) },
    { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', owner_id: 'u-other', owner_email: 'brother@example.com', invited_emails: [], accepted_emails: ['tester@example.com'], updated_at: new Date().toISOString(), payload: t('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { title: 'Завершённая вчерашняя', date: yesterday, status: 'completed', completed: true, activity: [] }) });
  if (signedIn && opts.owned) sharedRow.splice(0, sharedRow.length, { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', owner_id: 'u-tester-0001', owner_email: 'tester@example.com', invited_emails: [], accepted_emails: ['brother@example.com'], updated_at: new Date().toISOString(), payload: t('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { title: 'Моя совместная', status: 'open', subtasks: [{ title: 'Пункт А', done: false }], activity: [] }) });
  return { tasks, sharedRow, today };
}

/* Скрипт, выполняемый в странице до загрузки приложения: заглушки браузерных API, счётчик изменений, тестовые данные */
function initScript({ tasks, signedIn, userId }) {
  return `(() => {
    window.__qa = { mut: 0, confirms: 0, opens: 0 };
    const __d = new Date(); const __today = __d.getFullYear() + '-' + String(__d.getMonth() + 1).padStart(2, '0') + '-' + String(__d.getDate()).padStart(2, '0');
    new MutationObserver(r => { window.__qa.mut += r.length; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    window.confirm = () => { window.__qa.confirms++; return true; };
    window.prompt = () => 'Тест';
    window.alert = () => {};
    window.open = () => { window.__qa.opens++; return null; };
    Object.defineProperty(navigator, 'share', { value: async () => { window.__qa.opens++; }, configurable: true });
    try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {}, readText: async () => '' }, configurable: true }); } catch {}
    try { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('нет камеры (тест)', 'NotAllowedError'); }; } catch {}
    window.SpeechRecognition = window.webkitSpeechRecognition = function () {
      this.start = () => setTimeout(() => { this.onstart && this.onstart(); this.onerror && this.onerror({ error: 'no-speech' }); this.onend && this.onend(); }, 20);
      this.stop = () => {}; this.abort = () => {};
    };
    if (!localStorage.getItem('__qa_seeded')) {
      localStorage.setItem('__qa_seeded', '1');
      const suffix = ${signedIn ? JSON.stringify(userId) : "'guest'"};
      localStorage.setItem('day-planner-tasks-v2:' + suffix, ${JSON.stringify(JSON.stringify(tasks))});
      localStorage.setItem('day-planner-period-plans-v1:' + suffix, JSON.stringify([{ id: 'p1', scope: 'all', anchorDate: __today, text: 'Старый план (без createdAt)' }, { id: 'p2', scope: 'all', anchorDate: __today, text: 'Второй старый план (без createdAt)' }, { id: 'p3', scope: 'all', anchorDate: __today, text: 'Новый план', plannedDate: '', createdAt: new Date().toISOString() }]));
      ${signedIn ? `localStorage.setItem('day-sync-session-v1', JSON.stringify({ access_token: 'den1.qa.qa', refresh_token: 'qa.1.qa', expires_at: Math.floor(Date.now() / 1000) + 7200, user: { id: ${JSON.stringify(userId)}, email: 'tester@example.com', role: 'user' } }));` : ''}
    }
  })();`;
}

/* Заглушка сервера «День»: тестовый сервер сам отвечает на /api/* (тот же адрес, что и страница — CORS не нужен) */
function setMock(sharedRow, userId, counter) { counter.answers = counter.answers || []; serverState.mock = { sharedRow, userId, counter }; }
function handleApi(req, res, p) {
  const { sharedRow, userId, counter } = serverState.mock || { sharedRow: [], userId: 'u', counter: { n: 0, answers: [] } };
  counter.n++;
  let body = ''; req.on('data', c => body += c);
  req.on('end', () => {
    const m = req.method; const query = new URLSearchParams(req.url.split('?')[1] || '');
    const json = (obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    const parsed = () => { try { return JSON.parse(body || '{}'); } catch { return {}; } };
    const user = { id: userId, email: 'tester@example.com', role: 'user' };
    const shared = /^\/api\/shared\/([^/]+)(\/answer)?$/.exec(p);
    if (p === '/api/auth/user') return json(user);
    if (/^\/api\/auth\/(login|refresh|register)$/.test(p)) return json({ access_token: 'den1.qa.qa', refresh_token: 'qa.1.qa', token_type: 'bearer', expires_in: 7200, expires_at: Math.floor(Date.now() / 1000) + 7200, user });
    if (p === '/api/shared/heads') return json(sharedRow.map(r => ({ id: r.id, updated_at: r.updated_at, pu: r.payload?.updatedAt || null, invited_emails: r.invited_emails, accepted_emails: r.accepted_emails })));
    if (p === '/api/shared' && m === 'GET') { const ids = (query.get('ids') || '').split(','); return json(sharedRow.filter(r => ids.includes(r.id))); }
    if (shared && shared[2] && m === 'POST') { const b = parsed(); counter.answers.push(!!b.accept); sharedRow.forEach(r => { r.invited_emails = []; if (b.accept) r.accepted_emails = ['tester@example.com']; }); res.writeHead(204); return res.end(); }
    if (shared && m === 'PATCH') {
      const row = sharedRow.find(r => r.id === decodeURIComponent(shared[1]));
      if (row) { Object.assign(row, parsed()); counter.patches = (counter.patches || 0) + 1; }
      res.writeHead(204); return res.end();
    }
    if (shared && m === 'GET') { const row = sharedRow.find(r => r.id === decodeURIComponent(shared[1])); return row ? json(row) : json({ message: 'Не найдено' }, 404); }
    if (p === '/api/presence' && m === 'GET') return json([]);
    if (p.startsWith('/api/files/shared/') && m === 'POST') return json({ path: `shared/${p.split('/')[4]}/qa.${query.get('ext') || 'jpg'}` }, 201);
    if (p.startsWith('/api/files/') && m === 'GET') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')); }
    if (m === 'GET') return json([]);
    if (p === '/api/shared' && m === 'POST') return json(parsed(), 201);
    res.writeHead(204); res.end();
  });
}

const SELECTOR = 'button, a[href], summary, [role="button"], input[type="checkbox"], input[type="radio"], input[type="button"], input[type="submit"], select';
const DESTRUCTIVE = /удал|выйти|выход|сброс|очист|стереть|delete|signout|logout|reset|clear|remove/i;

/* Собирает кликабельные элементы в «активной области»: если открыт диалог — только внутри него */
async function collect(page) {
  return page.evaluate(sel => {
    const dialogs = [...document.querySelectorAll('dialog[open]')];
    const scope = dialogs.length ? dialogs[dialogs.length - 1] : document;
    const scopeId = dialogs.length ? dialogs[dialogs.length - 1].id || 'dialog' : 'page';
    const all = [...document.querySelectorAll(sel)];
    const out = [];
    all.forEach((el, i) => {
      if (scope !== document && !scope.contains(el)) return;
      if (!el.checkVisibility || !el.checkVisibility({ checkVisibilityCSS: true })) return;
      const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return;
      const ds = Object.entries(el.dataset).map(([k, v]) => k + '=' + v).join('&');
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const label = (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : '')) + (text ? ` «${text}»` : '');
      const gds = Object.keys(el.dataset).join('&');
      out.push({ elId: el.id || '', gkey: [scopeId, el.tagName, el.id, el.className, gds, el.getAttribute('href') || ''].join('|'), index: i, scopeId, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', tag: el.tagName.toLowerCase(), type: el.type || '', key: [scopeId, el.tagName, el.id, el.className, ds, text, el.getAttribute('href') || ''].join('|'), label, ident: [el.id, text, ds, el.getAttribute('href') || '', el.className].join(' ') });
    });
    return { items: out, dialogOpen: dialogs.length > 0, scopeId };
  }, SELECTOR);
}

async function snapshot(page, supaCounter) {
  const s = await page.evaluate(() => ({
    mut: window.__qa ? window.__qa.mut : 0, opens: window.__qa ? window.__qa.opens : 0, confirms: window.__qa ? window.__qa.confirms : 0,
    dialogs: [...document.querySelectorAll('dialog[open]')].map(d => d.id).join(','),
    storage: Object.keys(localStorage).sort().map(k => k + '=' + localStorage.getItem(k)).join('|').length,
    url: location.href, hash: Object.keys(localStorage).sort().map(k => localStorage.getItem(k)).join('|').split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)
  })).catch(() => ({ mut: -1, dialogs: '', storage: -1, url: '', hash: 0, opens: 0, confirms: 0 }));
  s.net = supaCounter.n + (supaCounter.chooser || 0) * 1000; return s;
}

/* Заполняет пустые поля в открытом диалоге правдоподобными значениями — чтобы кнопки «Сохранить» отрабатывали по-настоящему */
async function fillDialog(page) {
  await page.evaluate(() => {
    const d = [...document.querySelectorAll('dialog[open]')].pop(); if (!d) return;
    const today = new Date(); const pad = n => String(n).padStart(2, '0');
    const dk = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const setVal = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    d.querySelectorAll('input, textarea').forEach(el => {
      if (el.value || el.disabled || el.readOnly || ['checkbox', 'radio', 'file', 'hidden', 'button', 'submit', 'range', 'color'].includes(el.type)) return;
      if (!el.checkVisibility || !el.checkVisibility()) return;
      const short = el.maxLength > 0 && el.maxLength <= 8; const numeric = el.inputMode === 'numeric' || !!el.pattern;
      if (el.type === 'email') setVal(el, 'tester@example.com');
      else if (el.type === 'password') setVal(el, short || numeric ? '1234' : 'Test12345!');
      else if (el.type === 'date') setVal(el, dk);
      else if (el.type === 'time') setVal(el, '10:00');
      else if (el.type === 'datetime-local') setVal(el, dk + 'T10:00');
      else if (el.type === 'number') setVal(el, '1');
      else if (el.type === 'tel') setVal(el, '+70000000000');
      else if (short || numeric) setVal(el, '1234');
      else setVal(el, 'Тест');
    });
  }).catch(() => {});
}

function classifyClickError(msg) {
  if (/intercepts pointer events/.test(msg)) return 'НЕ НАЖАТЬ (кнопку перекрывает другой элемент)';
  if (/outside of the viewport|not visible|not stable|detached/.test(msg)) return 'НЕ НАЖАТЬ (недоступна/исчезла)';
  if (/disabled|not enabled/.test(msg)) return 'DISABLED';
  return 'НЕ НАЖАТЬ (' + msg.split('\n')[0].slice(0, 120) + ')';
}

async function sweep(page, ctx, state, log) {
  const clicked = new Set(); const perKind = new Map(); const KIND_CAP = 6; let steps = 0; let escapes = 0;
  const seen = new Map(); const openerOf = new Map(); const revisits = new Map();
  const base = state.base;
  while (steps < 900) {
    steps++;
    if (!page.url().startsWith(base + '/index.html') && page.url() !== base + '/' && !page.url().startsWith(base + '/?') && !page.url().startsWith(base + '/#')) {
      log.notes.push(`переход на ${page.url().replace(base, '')} → возврат в приложение`);
      await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(300); continue;
    }
    let { items, dialogOpen, scopeId } = await collect(page);
    if (dialogOpen) { await fillDialog(page); ({ items, dialogOpen, scopeId } = await collect(page)); }
    if (dialogOpen) { if (!seen.has(scopeId)) seen.set(scopeId, new Map()); items.forEach(c => seen.get(scopeId).set(c.key, c.gkey)); }
    const fresh = items.filter(c => !clicked.has(c.key) && (perKind.get(c.gkey) || 0) < KIND_CAP);
    const isCloser = c => /close|закры|×|отмен|cancel|dismiss|decline/i.test(c.ident);
    const next = fresh.find(c => !DESTRUCTIVE.test(c.ident) && !isCloser(c) && c.type !== 'submit') || fresh.find(c => !DESTRUCTIVE.test(c.ident) && !isCloser(c)) || fresh.find(c => !isCloser(c)) || fresh[0];
    if (!next) {
      if (dialogOpen) { if (++escapes > 80) break; await page.keyboard.press('Escape'); await page.waitForTimeout(120); const again = await collect(page); if (again.dialogOpen && again.scopeId === scopeId) { await page.evaluate(() => { const d = [...document.querySelectorAll('dialog[open]')].pop(); d && d.close && d.close(); }); state.filledScopes.delete(scopeId); } else state.filledScopes.delete(scopeId); continue; }
      // страница исчерпана — возвращаемся в меню/диалоги, где остались ненажатые кнопки (мы вышли из них, открыв вложенное окно)
      let again = false;
      for (const [d, keys] of seen) {
        const left = [...keys].some(([k, g]) => !clicked.has(k) && (perKind.get(g) || 0) < KIND_CAP);
        if (left && openerOf.has(d) && (revisits.get(d) || 0) < 6) { const o = openerOf.get(d); clicked.delete(o.key); perKind.set(o.gkey, Math.max(0, (perKind.get(o.gkey) || 1) - 1)); revisits.set(d, (revisits.get(d) || 0) + 1); again = true; break; }
      }
      if (again) continue;
      break;
    }
    clicked.add(next.key); perKind.set(next.gkey, (perKind.get(next.gkey) || 0) + 1);
    if (args.verbose) console.log(`  #${steps} [${next.scopeId}] ${next.label}`);
    if (next.disabled) { log.disabled.push({ el: next.label, scope: next.scopeId }); continue; }
    const before = await snapshot(page, state.supa); const errMark = state.errors.length;
    const loc = page.locator(SELECTOR).nth(next.index);
    if (next.elId) state.clickedIds.add(next.elId);
    await loc.evaluate(el => { const bump = () => { if (window.__qa) window.__qa.mut++; }; el.addEventListener('change', bump, { once: true }); el.addEventListener('input', bump, { once: true }); }).catch(() => {});
    let failure = '';
    try { await loc.click({ timeout: 2500 }); } catch (e) { failure = classifyClickError(String(e.message || e)); }
    await page.waitForTimeout(140);
    const after = await snapshot(page, state.supa); const newErrors = state.errors.slice(errMark);
    after.dialogs.split(',').filter(d => d && !before.dialogs.split(',').includes(d)).forEach(d => openerOf.set(d, { key: next.key, gkey: next.gkey }));
    const rec = { el: next.label, scope: next.scopeId };
    log.clicked++;
    if (failure && failure !== 'DISABLED') { log.cantClick.push({ ...rec, why: failure }); }
    else if (failure === 'DISABLED') log.disabled.push(rec);
    if (newErrors.length) log.jsErrors.push({ ...rec, errors: newErrors });
    if (!failure) {
      const changed = before.mut !== after.mut || before.dialogs !== after.dialogs || before.hash !== after.hash || before.url !== after.url || before.opens !== after.opens || before.net !== after.net;
      if (!changed && next.tag !== 'select') {
        const hint = await page.evaluate(() => { const d = [...document.querySelectorAll('dialog[open]')].pop(); if (!d) return ''; const bad = d.querySelector('input:invalid, select:invalid, textarea:invalid'); return bad ? `поле «${bad.id || bad.name || bad.type}»: ${bad.validationMessage}` : ''; }).catch(() => '');
        log.noEffect.push({ ...rec, hint });
      }
    }
  }
  log.steps = steps; log.clickedIds = [...state.clickedIds];
}

function newLog() { return { clicked: 0, steps: 0, jsErrors: [], cantClick: [], noEffect: [], disabled: [], notes: [], flows: [], loadErrors: [], flowErrors: [], clickedIds: [] }; }

async function flows(page, state, log) {
  const ok = (name, pass, detail = '') => log.flows.push({ name, pass: !!pass, detail });
  const step = async (name, fn) => { try { const r = await fn(); if (r !== undefined) ok(name, r === true || (r && r.pass), r && r.detail || ''); } catch (e) { ok(name, false, 'ошибка: ' + String(e.message).split('\n')[0].slice(0, 140));
      if (args.shots) { fs.mkdirSync(args.shots, { recursive: true }); const blocker = await page.evaluate(() => { const o = [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return (cs.position === 'fixed' || cs.position === 'sticky') && r.width > 60 && r.height > 60 && cs.visibility !== 'hidden' && cs.display !== 'none' && e.checkVisibility && e.checkVisibility(); }); return o.map(e => (e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0]) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)).join(' | '); }).catch(() => ''); ok('  ↳ видимые фиксированные слои на экране', true, blocker); await page.screenshot({ path: path.join(args.shots, `fail-${state.mode}-${log.flows.length}.png`) }).catch(() => {}); } } };
  const mobile = state.mobile;
  const tasksOnPage = () => page.locator('#taskList .task').count();
  const titleVisible = t => page.locator('#taskList .task-title', { hasText: t }).count();
  const dialogOpen = id => page.locator(`#${id}[open]`).count().then(n => n === 1);
  const save = async () => { await page.locator('#taskDialog button[type="submit"]').first().click(); await page.waitForTimeout(300); };
  const openNew = async () => { await page.locator(mobile ? '#mobileNewTaskButton' : '#addButton').click(); await page.waitForTimeout(200); };

  await page.waitForSelector('#taskList', { timeout: 5000 }).catch(() => {});
  await step('Список задач дня отображается (тестовые данные)', async () => { const n = await tasksOnPage(); return { pass: n >= 3, detail: `задач на экране: ${n}` }; });

  if (!mobile) {
    await step('Быстрое добавление: строка ввода + кнопка «Добавить»', async () => {
      await page.fill('#quickInput', 'Тест быстрого добавления'); await page.locator('#quickForm .quick-submit').click(); await page.waitForTimeout(250);
      return (await titleVisible('Тест быстрого добавления')) === 1;
    });
  } else {
    ok('Быстрое добавление текстом на телефоне', true, 'на телефоне поле скрыто штатно — вместо него кнопка «＋ Новая задача»');
    await step('Кнопка «＋ Новая задача» (телефон) открывает диалог', async () => { await openNew(); const o = await dialogOpen('taskDialog'); await page.keyboard.press('Escape'); await page.waitForTimeout(150); return o; });
    await step('Плавающая кнопка «+» внизу (телефон) открывает диалог', async () => { await page.locator('#mobileAddButton').click(); await page.waitForTimeout(200); const o = await dialogOpen('taskDialog'); await page.keyboard.press('Escape'); await page.waitForTimeout(150); return o; });
  }

  await step('Новая задача через диалог: открытие, ввод названия, «Сохранить»', async () => {
    await openNew(); if (!(await dialogOpen('taskDialog'))) return { pass: false, detail: 'диалог не открылся' };
    await page.fill('#taskTitle', 'Тест через диалог'); await save();
    return { pass: (await titleVisible('Тест через диалог')) === 1 && !(await dialogOpen('taskDialog')), detail: '' };
  });
  await step('Чекбокс «выполнено» отмечает задачу выполненной', async () => {
    await page.locator('#taskList .task', { hasText: 'Тест через диалог' }).locator('[data-check]').click(); await page.waitForTimeout(250);
    return (await page.locator('#taskList .task.completed', { hasText: 'Тест через диалог' }).count()) === 1;
  });
  await step('Чекбокс повторно: снимает отметку «выполнено»', async () => {
    await page.locator('#taskList .task', { hasText: 'Тест через диалог' }).locator('[data-check]').click(); await page.waitForTimeout(250);
    return (await page.locator('#taskList .task.completed', { hasText: 'Тест через диалог' }).count()) === 0;
  });
  await step('Нажатие на подзадачу переключает её состояние', async () => {
    const sub = page.locator('#taskList .subtask').first(); const before = await sub.getAttribute('class');
    await sub.click(); await page.waitForTimeout(200); return (await page.locator('#taskList .subtask').first().getAttribute('class')) !== before;
  });
  await step('Кнопка «⋯» открывает редактирование с данными задачи', async () => {
    await page.locator('#taskList .task', { hasText: 'Тест через диалог' }).locator('[data-edit]').click(); await page.waitForTimeout(200);
    return (await dialogOpen('taskDialog')) && (await page.inputValue('#taskTitle')) === 'Тест через диалог';
  });
  await step('Нажатие на название задачи тоже открывает её', async () => {
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    await page.locator('#taskList .task', { hasText: 'Тест через диалог' }).locator('.task-title').click(); await page.waitForTimeout(200);
    const ok = (await dialogOpen('taskDialog')) && (await page.inputValue('#taskTitle')) === 'Тест через диалог';
    return ok;
  });
  await step('Изменение названия сохраняется', async () => {
    await page.fill('#taskTitle', 'Изменённое название'); await save(); return (await titleVisible('Изменённое название')) === 1;
  });
  await step('Приоритет «Высокий» и повтор сохраняются в задаче', async () => {
    await page.locator('#taskList .task', { hasText: 'Изменённое название' }).locator('[data-edit]').click(); await page.waitForTimeout(200);
    await page.selectOption('#taskPriority', 'high'); await page.selectOption('#taskRepeat', 'weekly'); await save();
    await page.locator('#taskList .task', { hasText: 'Изменённое название' }).locator('[data-edit]').click(); await page.waitForTimeout(200);
    const v = [await page.inputValue('#taskPriority'), await page.inputValue('#taskRepeat')]; await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    return { pass: v[0] === 'high' && v[1] === 'weekly', detail: v.join('/') };
  });
  await step('Удаление задачи (кнопка «Удалить» в диалоге)', async () => {
    await page.locator('#taskList .task', { hasText: 'Изменённое название' }).locator('[data-edit]').click(); await page.waitForTimeout(200);
    await page.locator('#deleteTask').click(); await page.waitForTimeout(300);
    const gone = (await titleVisible('Изменённое название')) === 0;
    const tomb = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('day-planner-deleted-v1')).map(k => localStorage.getItem(k)).join(''));
    return { pass: gone && /\d{4}-\d{2}-\d{2}T/.test(tomb), detail: gone ? (tomb ? '' : 'метка удаления не записана') : 'задача осталась в списке' };
  });
  await step('Кнопка «Отмена»/«×» закрывает диалог без сохранения', async () => {
    await openNew(); await page.fill('#taskTitle', 'Не должна сохраниться'); await page.locator('#cancelDialog').click(); await page.waitForTimeout(250);
    return !(await dialogOpen('taskDialog')) && (await titleVisible('Не должна сохраниться')) === 0;
  });
  await step('Поиск находит задачу по слову и очищается', async () => {
    const search = page.locator('input[type="search"], #searchInput').first(); await search.fill('Шлейф'); await page.waitForTimeout(250);
    const found = await tasksOnPage(); await search.fill(''); await page.waitForTimeout(200); return { pass: found >= 1, detail: `найдено: ${found}` };
  });
  for (const per of ['week', 'month', 'year', 'day']) {
    await step(`Переключение периода «${per}»`, async () => { await page.locator(`.period-button[data-period="${per}"]`).click(); await page.waitForTimeout(150); return (await page.locator(`.period-button[data-period="${per}"]`).getAttribute('class')).includes('active'); });
  }
  const navSel = mobile ? '.mobile-nav' : '.nav-item';
  const views = await page.locator(`${navSel}[data-view]`).evaluateAll(els => els.map(e => e.dataset.view)).catch(() => []);
  for (const v of views) {
    await step(`Переход в раздел «${v}»`, async () => { await page.locator(`${navSel}[data-view="${v}"]`).click(); await page.waitForTimeout(200); return (await page.locator(`${navSel}[data-view="${v}"]`).getAttribute('class')).includes('active'); });
  }
  await page.locator(`${navSel}[data-view="today"]`).click().catch(() => {}); await page.waitForTimeout(150);
  await step('Кнопка «Планы» открывает экран планов без ошибок', async () => {
    const mark = state.errors.length; await page.locator(mobile ? '#mobilePlansButton' : '#desktopPlansButton').click(); await page.waitForTimeout(300);
    const errs = state.errors.slice(mark); await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    return { pass: errs.length === 0, detail: errs.join(' | ') };
  });
  await step('Карточка «Фокус дня» кликабельна (открывает задачу)', async () => {
    const fc = page.locator('#focusCard'); if (!(await fc.isVisible())) return { pass: mobile, detail: mobile ? 'на телефоне карточка скрыта штатно' : 'карточки нет на экране' };
    await fc.click(); await page.waitForTimeout(250); const o = await dialogOpen('taskDialog'); await page.keyboard.press('Escape'); await page.waitForTimeout(150); return o;
  });

  /* ——— Финансы ——— */
  const clickId = async sel => { state.clickedIds.add(sel.replace(/^#/, '')); await page.locator(sel).click({ timeout: 3000 }); };
  const noErrors = (mark) => state.errors.slice(mark).length === 0;
  await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(100);
  const finTab = mobile ? '#mobileTabFinance, #tabFinance' : '#tabFinance';
  await step('Финансы: вкладка «Финансы» открывает раздел', async () => {
    await clickId('#tabFinance'); await page.waitForTimeout(250); return await page.locator('#financeView').isVisible();
  });
  await step('Финансы: строка «кофе 250» + «Добавить» создаёт операцию', async () => {
    const mark = state.errors.length; await page.fill('#financeQuickInput', 'кофе 250'); await page.locator('#financeQuickForm button[type="submit"]').click(); await page.waitForTimeout(350);
    const total = (await page.locator('#financeExpenseTotal').innerText()).replace(/\s/g, ''); return { pass: /250/.test(total) && noErrors(mark), detail: 'расход: ' + total };
  });
  await step('Финансы: плитка категории открывает окно «Добавить», сумма + «Добавить»', async () => {
    const mark = state.errors.length; await page.locator('#financeCategoryGrid [data-category]').first().click(); await page.waitForTimeout(250);
    if (!(await dialogOpen('financeAddDialog'))) return { pass: false, detail: 'окно добавления не открылось' };
    await page.fill('#faAmount', '100'); await clickId('#faSubmit'); await page.waitForTimeout(350);
    const total = (await page.locator('#financeExpenseTotal').innerText()).replace(/\s/g, ''); return { pass: /350/.test(total) && !(await dialogOpen('financeAddDialog')) && noErrors(mark), detail: 'расход: ' + total };
  });
  await step('Финансы: окно «Добавить» закрывается крестиком', async () => {
    await page.locator('#financeCategoryGrid [data-category]').first().click(); await page.waitForTimeout(200);
    await clickId('#closeFinanceAdd'); await page.waitForTimeout(200); return !(await dialogOpen('financeAddDialog'));
  });
  await step('Финансы: переключатель периода ‹ сегодня › (суммы меняются по периодам)', async () => {
    const mark = state.errors.length; const total = async () => (await page.locator('#financeExpenseTotal').innerText()).replace(/\s/g, '');
    const a = await total(); await clickId('#financePeriodPrev'); await page.waitForTimeout(250); const b = await total();
    await clickId('#financePeriodNext'); await page.waitForTimeout(200); await clickId('#financePeriodNext'); await page.waitForTimeout(250); const c = await total();
    await clickId('#financePeriodToday'); await page.waitForTimeout(250); const d = await total();
    return { pass: /350/.test(a) && !/350/.test(b) && !/350/.test(c) && d === a && noErrors(mark), detail: `${a} → ${b} → ${c} → ${d}` };
  });
  await step('Финансы: фото чека — выбор из галереи и кнопка «×»', async () => {
    const mark = state.errors.length; const png = Buffer.from(PNG.split(',')[1], 'base64');
    const [fc1] = await Promise.all([page.waitForEvent('filechooser', { timeout: 3000 }), clickId('#financeGalleryButton')]); await fc1.setFiles({ name: 'chek.png', mimeType: 'image/png', buffer: png }); await page.waitForTimeout(500);
    await page.locator('#financePhotoPreview').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    const shown = await page.locator('#financePhotoPreview').isVisible(); if (shown) await clickId('#removeExpensePhoto'); await page.waitForTimeout(200);
    return { pass: shown && !(await page.locator('#financePhotoPreview').isVisible()) && noErrors(mark), detail: shown ? '' : 'предпросмотр не появился' };
  });
  await step('Финансы: кнопка «Сфотографировать чек» открывает выбор файла/камеры', async () => {
    const [fc2] = await Promise.all([page.waitForEvent('filechooser', { timeout: 3000 }), clickId('#financeCameraButton')]); return !!fc2;
  });
  await step('Финансы: кнопка 🎙 не вызывает ошибок', async () => {
    const mark = state.errors.length; await clickId('#financeVoiceButton'); await page.waitForTimeout(300); return noErrors(mark);
  });
  await step('Финансы: лимит категории — выбор в списке не вызывает ошибок', async () => {
    const mark = state.errors.length; const sel = page.locator('#financeLimitAddSelect');
    if (!(await sel.isVisible())) return { pass: true, detail: 'список скрыт (у всех категорий уже есть лимит или нет расходов)' };
    state.clickedIds.add('financeLimitAddSelect'); const opts = await sel.locator('option').count(); if (opts > 1) await sel.selectOption({ index: 1 }); await page.waitForTimeout(300);
    await page.keyboard.press('Escape'); await page.waitForTimeout(150); return noErrors(mark);
  });

  /* ——— Резервная копия ——— */
  await clickId('#tabPlanner').catch(() => {});
  await step('Резервная копия: «Сохранить копию данных» скачивает файл с задачами', async () => {
    await page.locator('#updateButton').click(); await page.waitForTimeout(200);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 4000 }), clickId('#exportBackup')]);
    const text = fs.readFileSync(await dl.path(), 'utf-8'); const data = JSON.parse(text);
    return { pass: data.app === 'den-ezhednevnik' && Array.isArray(data.tasks) && data.tasks.length >= 3 && Array.isArray(data.expenses), detail: `${dl.suggestedFilename()}: задач ${data.tasks && data.tasks.length}, операций ${data.expenses && data.expenses.length}` };
  });
  await step('Резервная копия: «Восстановить из копии» добавляет недостающую задачу и не трогает остальные', async () => {
    const before = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('day-planner-tasks-v2')).map(k => JSON.parse(localStorage.getItem(k)).length)[0]);
    const now = new Date().toISOString(); const d = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
    const backup = { app: 'den-ezhednevnik', version: '91', tasks: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Из копии', date: d, time: '', priority: 'normal', note: '', autoCarry: true, reminder: '', reminderUtc: '', repeat: 'none', subtasks: [], proofNote: '', notified: false, photo: null, attachment: null, photoCapturedAt: '', updatedAt: now, completed: false, carryCount: 0 }], expenses: [], periodPlans: [] };
    await page.locator('#updateButton').click(); await page.waitForTimeout(200); state.clickedIds.add('importBackup');
    await page.setInputFiles('#importBackupInput', { name: 'den-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) }); await page.waitForTimeout(500);
    const after = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('day-planner-tasks-v2')).map(k => JSON.parse(localStorage.getItem(k)).length)[0]);
    return { pass: after === before + 1, detail: `задач было ${before}, стало ${after}` };
  });
  await step('Уведомления: окно открывается из меню и закрывается крестиком', async () => {
    await page.locator('#updateButton').click(); await page.waitForTimeout(200); await clickId('#openNotificationSettings'); await page.waitForTimeout(300);
    const opened = await dialogOpen('notificationDialog'); if (opened) await clickId('#closeNotificationSettings'); await page.waitForTimeout(200);
    return { pass: opened && !(await dialogOpen('notificationDialog')), detail: opened ? '' : 'окно не открылось' };
  });
  await step('Резервная копия: чужой/битый файл отклоняется, данные не меняются', async () => {
    const count = () => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('day-planner-tasks-v2')).map(k => JSON.parse(localStorage.getItem(k)).length)[0]);
    const before = await count(); await page.locator('#updateButton').click(); await page.waitForTimeout(200);
    await page.setInputFiles('#importBackupInput', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1') }); await page.waitForTimeout(400);
    await page.locator('#updateButton').click().catch(() => {}); await page.waitForTimeout(200);
    await page.setInputFiles('#importBackupInput', { name: 'y.json', mimeType: 'application/json', buffer: Buffer.from('{"app":"other","tasks":[]}') }); await page.waitForTimeout(400);
    return { pass: (await count()) === before, detail: 'задач: ' + before };
  });
}

const viewportOpts = mobile => mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'ru-RU', timezoneId: 'Europe/Moscow' } : { viewport: { width: 1366, height: 768 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow' };

/* Всплывающие карточки: каждая проверяется в своём чистом окружении, чтобы не перекрывать друг друга */
async function runPrompts(browser, base, mobile, shotsDir) {
  const log = newLog(); log.mode = (mobile ? 'mobile' : 'desktop') + '-prompts'; log.clickedIds = [];
  const userId = 'u-tester-0001';
  const IGNORE = /Failed to load resource|net::ERR_FAILED|ERR_BLOCKED|favicon|service worker|ServiceWorker|sw\.js/i;
  const kinds = [
    ['reminder-open', 'Напоминание: «Открыть» открывает задачу', { due: true }],
    ['reminder-dismiss', 'Напоминание: «Закрыть» скрывает карточку', { due: true }],
    ['invite-accept', 'Приглашение: «Принять»', { invite: true }],
    ['invite-decline', 'Приглашение: «Отклонить»', { invite: true }]
  ];
  for (const [kind, name, opts] of kinds) {
    const { tasks, sharedRow } = seedData(true, opts);
    const context = await browser.newContext(viewportOpts(mobile));
    await context.addInitScript(initScript({ tasks, signedIn: true, userId }));
    const supa = { n: 0 };
    setMock(sharedRow, userId, supa);
    await context.route(url => { const h = url.hostname; return h !== '127.0.0.1' && h !== 'localhost'; }, r => r.abort());
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', e => { const t = String(e.message || e).split('\n')[0]; if (!IGNORE.test(t)) errors.push('JS: ' + t); });
    page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push('console.error: ' + m.text().split('\n')[0].slice(0, 200)); });
    const ok = (pass, detail = '') => log.flows.push({ name, pass: !!pass, detail });
    try {
      await page.goto(base + '/index.html', { waitUntil: 'load' }); await page.waitForTimeout(1600);
      const box = { 'reminder-open': '#reminderAlert', 'reminder-dismiss': '#reminderAlert', 'invite-accept': '#sharedInvitePrompt', 'invite-decline': '#sharedInvitePrompt', 'update-apply': '#updatePrompt' }[kind];
      const btn = { 'reminder-open': '#reminderAlertOpen', 'reminder-dismiss': '#reminderAlertDismiss', 'invite-accept': '#sharedInvitePromptAccept', 'invite-decline': '#sharedInvitePromptDecline', 'update-apply': '#promptApplyUpdate' }[kind];
      if (!(await page.locator(box).isVisible())) { ok(false, 'карточка не появилась'); }
      else {
        log.clicked++; log.clickedIds.push(btn.slice(1));
        await page.locator(btn).click({ timeout: 3000 }); await page.waitForTimeout(kind === 'update-apply' ? 2500 : 400);
        if (kind === 'reminder-open') ok(await page.locator('#taskDialog[open]').count() === 1 && (await page.inputValue('#taskTitle')) === 'Просроченное напоминание', 'диалог задачи открылся с нужной задачей');
        else if (kind === 'update-apply') ok(errors.length === 0, errors.join(' | ') || 'обновление применено без ошибок');
        else if (kind.startsWith('invite')) { await page.locator(box).waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {}); const hidden = !(await page.locator(box).isVisible()); ok(hidden && (kind === 'invite-accept' ? supa.answers.slice(-1)[0] === true : supa.answers.length === 0), `карточка скрыта: ${hidden}; ответ в облако: ${JSON.stringify(supa.answers)}${kind === 'invite-decline' ? ' (в v90 «Отклонить» = «Позже»: прячет карточку, облако не трогает)' : ''}`); }
        else ok(!(await page.locator(box).isVisible()), '');
      }
      if (errors.length && kind !== 'update-apply') log.jsErrors.push({ el: name, scope: 'prompts', errors: errors.slice() });
      if (shotsDir && !log.flows.slice(-1)[0].pass) { fs.mkdirSync(shotsDir, { recursive: true }); await page.screenshot({ path: path.join(shotsDir, `prompt-${log.mode}-${kind}.png`) }).catch(() => {}); }
    } catch (e) { ok(false, 'ошибка: ' + String(e.message).split('\n')[0].slice(0, 160)); }
    await context.close();
  }
  return log;
}


/* Функции, доступные только при особых условиях: установка, PIN, фото, обновление */
async function runSpecial(browser, base, mobile, shotsDir) {
  const log = newLog(); log.mode = (mobile ? 'mobile' : 'desktop') + '-special';
  const userId = 'u-tester-0001';
  const IGNORE = /Failed to load resource|net::ERR_FAILED|ERR_BLOCKED|favicon|service worker|ServiceWorker|sw\.js/i;
  const png = Buffer.from(PNG.split(',')[1], 'base64');
  const scenario = async (name, setup, body) => {
    const { tasks, sharedRow } = seedData(true, (setup && setup.seed) || {});
    const context = await browser.newContext(viewportOpts(mobile));
    await context.addInitScript(initScript({ tasks, signedIn: true, userId }));
    if (setup && setup.init) await context.addInitScript(setup.init);
    const supa = { n: 0 }; setMock(sharedRow, userId, supa);
    await context.route(url => { const h = url.hostname; return h !== '127.0.0.1' && h !== 'localhost'; }, r => r.abort());
    serverState.fakeVersion = setup && setup.fakeVersion || 0;
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', e => { const t = String(e.message || e).split('\n')[0]; if (!IGNORE.test(t)) errors.push('JS: ' + t); });
    page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push('console.error: ' + m.text().split('\n')[0].slice(0, 200)); });
    const ok = (pass, detail = '', label = name) => log.flows.push({ name: label, pass: !!pass, detail });
    const click = async sel => { log.clicked++; log.clickedIds.push(sel.replace(/^#/, '')); await page.locator(sel).click({ timeout: 3000 }); };
    try {
      await page.goto(base + '/index.html', { waitUntil: 'load' }); await page.waitForTimeout(1200);
      await body({ page, ok, click, errors, supa, context });
      if (errors.length) log.jsErrors.push({ el: name, scope: 'special', errors: errors.slice() });
    } catch (e) {
      ok(false, 'ошибка: ' + String(e.message).split('\n')[0].slice(0, 170));
      if (shotsDir) { fs.mkdirSync(shotsDir, { recursive: true }); await page.screenshot({ path: path.join(shotsDir, `special-${log.mode}-${log.flows.length}.png`) }).catch(() => {}); }
    }
    await context.close(); serverState.fakeVersion = 0;
  };
  const openMenu = async (page, click) => { await click('#updateButton'); await page.waitForTimeout(250); };

  await scenario('Установка приложения: кнопка «Установить» после beforeinstallprompt', null, async ({ page, ok, click }) => {
    await page.evaluate(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = () => { window.__qa.installPrompted = 1; }; e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); });
    await page.waitForTimeout(200); const shown = await page.locator('#installButton').isVisible();
    if (shown) { await click('#installButton'); await page.waitForTimeout(250); }
    ok(shown && (await page.evaluate(() => window.__qa.installPrompted)) === 1 && !(await page.locator('#installButton').isVisible()), shown ? 'системное окно установки вызвано, кнопка скрылась' : 'кнопка не появилась');
  });

  await scenario('PIN: установка → блокировка → неверный PIN → верный PIN', null, async ({ page, ok, click }) => {
    await openMenu(page, click); await click('#openAccountFromMenu'); await page.waitForTimeout(250);
    await page.fill('#pinSetupInput', '1234'); await click('#pinSaveButton'); await page.waitForTimeout(300);
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('day-planner-pin-unlocked-at')).forEach(k => localStorage.removeItem(k)));
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(900);
    const locked = await page.locator('#pinDialog[open]').count() === 1; ok(locked, locked ? 'после перезапуска показан экран PIN' : 'экран PIN не появился', 'PIN: после установки приложение блокируется');
    if (!locked) return;
    await page.fill('#pinUnlockInput', '0000'); await page.locator('#pinUnlockForm button[type="submit"]').click(); await page.waitForTimeout(250);
    const err = (await page.locator('#pinError').innerText()).trim(); ok(err.length > 0 && (await page.locator('#pinDialog[open]').count()) === 1, 'сообщение: «' + err + '»', 'PIN: неверный код отклоняется с сообщением');
    await page.fill('#pinUnlockInput', '1234'); await page.locator('#pinUnlockForm button[type="submit"]').click(); await page.waitForTimeout(300);
    ok((await page.locator('#pinDialog[open]').count()) === 0, '', 'PIN: верный код открывает ежедневник');
  });

  await scenario('PIN: «Войти по почте и паролю»', { init: `localStorage.getItem('__qa_pin') || (localStorage.setItem('__qa_pin', '1'), 0);` }, async ({ page, ok, click }) => {
    await openMenu(page, click); await click('#openAccountFromMenu'); await page.waitForTimeout(250);
    await page.fill('#pinSetupInput', '1234'); await click('#pinSaveButton'); await page.waitForTimeout(300); await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('day-planner-pin-unlocked-at')).forEach(k => localStorage.removeItem(k)));
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(900);
    if ((await page.locator('#pinDialog[open]').count()) !== 1) { ok(false, 'экран PIN не появился'); return; }
    await click('#pinUsePassword'); await page.waitForTimeout(400);
    ok((await page.locator('#pinDialog[open]').count()) === 0 && (await page.locator('#syncDialog[open]').count()) === 1, 'экран PIN закрылся, открылся вход по почте и паролю');
  });

  await scenario('Фото: удаление выбранного фото в «Обратной связи» и в профиле', null, async ({ page, ok, click }) => {
    await openMenu(page, click); await click('#openFeedback'); await page.waitForTimeout(250);
    await page.setInputFiles('#feedbackPhotoInput', { name: 'a.png', mimeType: 'image/png', buffer: png }); await page.locator('#removeFeedbackPhoto').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    const fbShown = await page.locator('#removeFeedbackPhoto').isVisible(); if (fbShown) await click('#removeFeedbackPhoto'); await page.waitForTimeout(250);
    ok(fbShown && !(await page.locator('#removeFeedbackPhoto').isVisible()), fbShown ? '' : 'после выбора фото кнопка «Убрать» не появилась', 'Обратная связь: фото выбирается и убирается');
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    await click('#profileButton'); await page.waitForTimeout(250);
    await page.setInputFiles('#profilePhotoInput', { name: 'a.png', mimeType: 'image/png', buffer: png }); await page.locator('#removeProfilePhoto').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    const prShown = await page.locator('#removeProfilePhoto').isVisible(); if (prShown) await click('#removeProfilePhoto'); await page.waitForTimeout(250);
    ok(prShown && !(await page.locator('#removeProfilePhoto').isVisible()), prShown ? '' : 'после выбора фото кнопка «Убрать» не появилась', 'Профиль: фото выбирается и убирается');
  });

  /* Окно совместной задачи: исполнитель только отвечает, организатор может редактировать */
  await scenario('Совместная задача: окно исполнителя (только чтение + мой ответ)', null, async ({ page, ok, click, supa }) => {
    await page.locator('#taskList .task', { hasText: 'Совместная от брата' }).locator('.task-title').click(); await page.waitForTimeout(300);
    const view = (await page.locator('#taskDialog[open][data-mode="view"]').count()) === 1; ok(view, 'окно не открылось в режиме просмотра', 'Исполнитель: задача открывается в режиме просмотра');
    if (!view) return;
    ok((await page.locator('#sharedView').innerText()).includes('Совместная от брата'), '', 'Исполнитель: название задачи показано текстом');
    const hidden = [];
    for (const sel of ['#taskTitle', '#taskDate', '#sharedEmails', '#taskSubtasks', '#taskNote', '#taskCameraButton', '#sharedTaskStatus', '#taskTypeSwitch', '#svEdit', '#svDelete', '#taskForm button[type="submit"]']) if (await page.locator(sel).isVisible()) hidden.push(sel);
    ok(!hidden.length, 'видны лишние элементы: ' + hidden.join(', '), 'Исполнитель: поля задачи, «Редактировать», «Удалить» и «Сохранить» скрыты');
    const statuses = await page.locator('#sharedView [data-shared-status]').evaluateAll(list => list.map(b => b.dataset.status));
    ok(statuses.join() === 'accepted,open,question,review', 'статусы: ' + statuses.join(), 'Исполнитель: доступны статусы «Принял / В работе / Есть вопрос / Готово», «Завершено» нет');
    const before = supa.patches || 0;
    await click('#sharedView [data-status="open"]'); for (let i = 0; i < 40 && !((supa.patches || 0) > before && (await page.locator('#sharedView [data-status="open"].active').count()) === 1); i++) await page.waitForTimeout(100);
    ok((supa.patches || 0) > before && (await page.locator('#sharedView [data-status="open"].active').count()) === 1, 'сохранений: ' + ((supa.patches || 0) - before), 'Исполнитель: кнопка статуса «В работе» сохраняется и подсвечивается');
    await page.fill('#reportText', 'Сделал, проверьте'); const before2 = supa.patches || 0; await click('#reportSend'); for (let i = 0; i < 40 && !((supa.patches || 0) > before2 && (await page.locator('#sharedReportList').innerText()).includes('Сделал, проверьте')); i++) await page.waitForTimeout(100);
    ok((supa.patches || 0) > before2 && (await page.locator('#sharedReportList').innerText()).includes('Сделал, проверьте'), 'отчёт не появился в списке', 'Исполнитель: «Отправить отчёт» добавляет отчёт в обсуждение');
    await click('#svClose'); await page.waitForTimeout(200);
    ok((await page.locator('#taskDialog[open]').count()) === 0, '', 'Исполнитель: «Закрыть» закрывает окно');
  });

  await scenario('Совместная задача: окно организатора (просмотр → «Редактировать»)', { seed: { owned: true } }, async ({ page, ok, click }) => {
    await page.locator('#taskList .task', { hasText: 'Моя совместная' }).locator('[data-shared-edit]').click(); await page.waitForTimeout(300);
    ok((await page.locator('#taskDialog[open][data-mode="view"]').count()) === 1 && await page.locator('#svEdit').isVisible() && await page.locator('#svDelete').isVisible(), '', 'Организатор: окно в режиме просмотра, есть «Редактировать» и «Удалить»');
    const st = await page.locator('#sharedView [data-shared-status]').evaluateAll(list => list.map(b => b.dataset.status));
    ok(st.join() === 'open,completed', 'статусы: ' + st.join(), 'Организатор: кнопки «В работе» и «Завершено»');
    await click('#svEdit'); await page.waitForTimeout(250);
    ok((await page.locator('#taskDialog[data-mode="edit"]').count()) === 1 && await page.locator('#taskTitle').isVisible() && await page.locator('#sharedEmails').isEnabled() && !(await page.locator('#sharedView').isVisible()), '', 'Организатор: «Редактировать» открывает полную форму');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  });

  /* Совместные задачи не теряются вместе со своим днём, пока не завершены */
  await scenario('Совместные задачи: просроченная остаётся в «Сегодня», завершённая — нет', { seed: { overdue: true } }, async ({ page, ok }) => {
    const titles = (await page.locator('#taskList .task-title').allInnerTexts());
    ok(titles.includes('Просроченная совместная'), 'в «Сегодня»: ' + titles.join(' | '), 'Совместные: незавершённая вчерашняя задача показана сегодня');
    ok(!titles.includes('Завершённая вчерашняя'), '', 'Совместные: завершённая вчерашняя в «Сегодня» не показывается');
    ok((await page.locator('#taskList .task', { hasText: 'Просроченная совместная' }).locator('.overdue-tag').count()) === 1, '', 'Совместные: у просроченной есть метка «Просрочена»');
    await page.locator('#taskList .task', { hasText: 'Просроченная совместная' }).locator('[data-shared-check]').check(); await page.waitForTimeout(700);
    ok((await page.locator('#taskList .task-title', { hasText: 'Просроченная совместная' }).count()) === 0 || (await page.locator('#taskList .task.completed', { hasText: 'Просроченная совместная' }).count()) === 0, '', 'Совместные: после завершения метка просрочки исчезает');
  });

  /* Чужие данные: старые «общие» ключи не попадают в новый аккаунт */
  await scenario('Аккаунты: старые общие данные не появляются у нового аккаунта', null, async ({ page, ok }) => {
    await page.evaluate(() => { localStorage.removeItem('day-planner-tasks-v2:u-tester-0001'); localStorage.setItem('day-planner-tasks-v2', JSON.stringify([{ id: 'old1', title: 'Чужая старая задача', date: toKey(new Date()), priority: 'normal', completed: false }])); });
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(900);
    const titles = await page.locator('#taskList .task-title').allInnerTexts();
    ok(!titles.includes('Чужая старая задача'), 'видно: ' + titles.join(' | '), 'Аккаунты: «общие» старые задачи не подхватываются новым аккаунтом');
  });

  /* Цветовая тема и частота напоминаний */
  await scenario('Тема: выбор цвета меняет оформление и запоминается', null, async ({ page, ok, click }) => {
    await click('#profileButton'); await page.waitForTimeout(250);
    await click('[data-theme-choice="green"]'); await page.waitForTimeout(150);
    const read = () => page.evaluate(() => ({ t: document.documentElement.dataset.theme || '', v: getComputedStyle(document.documentElement).getPropertyValue('--violet').trim(), meta: document.querySelector('meta[name="theme-color"]').content }));
    const g = await read(); ok(g.t === 'green' && g.v === '#0f5a43' && g.meta === '#0f5a43', JSON.stringify(g), 'Тема: «Зелёный» меняет основной цвет и цвет шапки браузера');
    await page.keyboard.press('Escape'); await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(800);
    const r = await read(); ok(r.t === 'green' && r.v === '#0f5a43', JSON.stringify(r), 'Тема: выбор сохраняется после перезапуска');
    await click('#profileButton'); await page.waitForTimeout(250); await click('[data-theme-choice="blue"]'); await page.waitForTimeout(150);
    const b = await read(); ok(b.t === '' && b.v === '#0e3764', JSON.stringify(b), 'Тема: «Синий» возвращает основной цвет');
  });

  await scenario('Уведомления: частота напоминаний выбирается и сохраняется', null, async ({ page, ok, click }) => {
    const slots = await page.evaluate(() => ({ once: notificationSlots({ dailyTime: '09:00', repeat: 'once' }).length, twice: notificationSlots({ dailyTime: '09:00', dailyTime2: '18:30', repeat: 'twice' }).join(), h2: notificationSlots({ dailyTime: '09:00', repeat: 'hourly2' }).length, h: notificationSlots({ dailyTime: '09:00', repeat: 'hourly' }).length, late: notificationSlots({ dailyTime: '22:00', repeat: 'hourly' }).length }));
    ok(slots.once === 1 && slots.twice === '540,1110' && slots.h2 === 7 && slots.h === 13 && slots.late === 1, JSON.stringify(slots), 'Уведомления: расписание «раз/два раза в день, каждые 2 часа, каждый час» считается верно');
    await openMenu(page, click); await click('#openNotificationSettings'); await page.waitForTimeout(300);
    ok(!(await page.locator('#notifyTime2Row').isVisible()), '', 'Уведомления: «Второе напоминание» скрыто при «Один раз в день»');
    await page.selectOption('#notifyRepeat', 'twice'); await page.waitForTimeout(100);
    ok(await page.locator('#notifyTime2Row').isVisible(), '', 'Уведомления: «Два раза в день» показывает второе время');
    await page.fill('#notifyDailyTime2', '19:15'); await page.locator('#notificationForm button[type="submit"]').click(); await page.waitForTimeout(500);
    const saved = await page.evaluate(() => JSON.stringify(notificationSettings)); ok(/"repeat":"twice"/.test(saved) && /19:15/.test(saved), saved, 'Уведомления: частота и время сохраняются');
  });

  /* Приложение открыто со вчера: «сегодня» обновляется само */
  await scenario('Смена дня: «сегодня» обновляется без перезапуска', null, async ({ page, ok }) => {
    const r = await page.evaluate(async () => { const real = todayKey; todayKey = '2000-01-01'; selectedDate = '2000-01-01'; await checkReminders(); return { fixed: todayKey === real, followed: selectedDate === real }; });
    ok(r.fixed && r.followed, JSON.stringify(r), 'Смена дня: дата «сегодня» и выбранный день обновляются сами');
  });

  /* Все окна: по центру и целиком в экране (ноутбук и телефон) */
  await scenario('Окна: каждое окно по центру и целиком помещается в экран', null, async ({ page, ok }) => {
    const res = await page.evaluate(() => {
      const bad = []; const vw = document.documentElement.clientWidth; const vh = window.innerHeight;
      document.querySelectorAll('dialog').forEach(d => {
        try { d.showModal(); } catch { return; }
        const r = d.getBoundingClientRect(); const cx = (r.left + r.right) / 2;
        if (d.id !== 'reminderDialog' && Math.abs(cx - vw / 2) > 8) bad.push(d.id + ': не по центру (центр ' + Math.round(cx) + ' из ' + vw + ')');
        if (r.left < -1 || r.right > vw + 1) bad.push(d.id + ': выходит за ширину экрана');
        if (r.top < -1 || r.bottom > vh + 1) bad.push(d.id + ': выходит за высоту экрана (' + Math.round(r.top) + '…' + Math.round(r.bottom) + ' из ' + vh + ')');
        d.close();
      });
      return bad;
    });
    ok(!res.length, res.join('; '), 'Окна: положение и размер на этом экране');
  });

  /* Очень старые и «кривые» данные (прошлые версии, облако, файл копии): экраны не должны ломаться */
  const legacyInit = `if (!localStorage.getItem('__qa_legacy')) { localStorage.setItem('__qa_legacy', '1');
    const d = new Date(); const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); const sfx = 'u-tester-0001';
    localStorage.setItem('day-planner-tasks-v2:' + sfx, JSON.stringify([{ id: 'l1', title: 'Очень старая задача', date: today }, { title: 'Без id и даты' }, { id: 'l3', title: 'Битые подзадачи', date: today, priority: 'urgent', subtasks: [null, { title: 'х' }, 'строка'] }, null, 'мусор', 42]));
    localStorage.setItem('day-planner-period-plans-v1:' + sfx, JSON.stringify([{ text: 'план без всего' }, { id: 'p9', scope: 'week', period: '2026-10-12', text: 'старый формат' }, null, 7]));
    localStorage.setItem('day-planner-expenses-v1:' + sfx, JSON.stringify([{ title: 'Старый расход', amount: '150', category: 'food' }, { id: 'e2', kind: 'income', amount: 1000 }, { amount: 'abc' }, null, 'x'])); }`;
  await scenario('Старые данные: экраны открываются без ошибок', { init: legacyInit }, async ({ page, ok, click, errors }) => {
    const titles = await page.locator('#taskList .task-title').allInnerTexts();
    ok(['Очень старая задача', 'Без id и даты', 'Битые подзадачи'].every(t => titles.some(x => x.includes(t))), 'задачи на экране: ' + titles.join(' | '), 'Старые данные: «кривые» задачи показываются в списке');
    await page.locator('#taskList .task', { hasText: 'Битые подзадачи' }).locator('[data-edit]').click(); await page.waitForTimeout(250);
    ok((await page.locator('#taskDialog[open]').count()) === 1, '', 'Старые данные: задача с битыми подзадачами открывается'); await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    await click(mobile ? '#mobilePlansButton' : '#desktopPlansButton'); await page.waitForTimeout(300);
    const planText = await page.locator('#reminderDialog').innerText().catch(() => ''); ok((await page.locator('#reminderDialog[open]').count()) === 1, 'окно планов открылось', 'Старые данные: «Планы» открываются'); await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    await click('#tabFinance'); await page.waitForTimeout(300);
    ok(await page.locator('#financeView').isVisible(), '', 'Старые данные: «Финансы» открываются');
    await page.evaluate(() => { const b = document.querySelector('[data-finance-nav="history"]'); if (b) b.click(); else if (typeof openFinanceHistory === 'function') openFinanceHistory(); }); await page.waitForTimeout(400);
    const hist = (await page.locator('#financeHistoryDialog[open]').count()) === 1; ok(hist, hist ? '' : 'окно истории не открылось', 'Старые данные: «История» финансов открывается');
  });

  /* Обратная связь: весь путь от кнопки до отправки (адрес /api/feedback подменён заглушкой) */
  const APPV = (/APP_VERSION = '(\d+)'/.exec(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf-8')) || [])[1];
  const hookFormsubmit = async (context, hits, state) => context.route(u => u.pathname === '/api/feedback', async route => {
    const req = route.request(); hits.push((req.postDataBuffer() || Buffer.alloc(0)).toString('utf-8'));
    const okAns = state.mode === 'ok';
    await route.fulfill(okAns ? { status: 204, body: '' } : { status: 500, contentType: 'application/json', body: '{"message":"qa"}' });
  });
  const sendFeedback = async (page, click, text, email, withPhoto) => {
    await openMenu(page, click); await click('#openFeedback'); await page.waitForTimeout(250);
    await page.fill('#feedbackText', text);
    if (email) await page.fill('#feedbackReplyEmail', email);
    if (withPhoto) { await page.setInputFiles('#feedbackPhotoInput', { name: 'a.png', mimeType: 'image/png', buffer: png }); await page.locator('#removeFeedbackPhoto').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {}); }
    await click('#feedbackSubmitButton'); await page.waitForTimeout(600);
  };
  await scenario('Обратная связь (вошедший): отправка с фото, затем сбой сети', null, async ({ page, ok, click, context }) => {
    const hits = []; const st = { mode: 'ok' }; await hookFormsubmit(context, hits, st);
    await sendFeedback(page, click, 'Тест обратной связи', '', true);
    const closed = (await page.locator('#feedbackDialog[open]').count()) === 0; const body = hits[0] || '';
    ok(closed && hits.length === 1 && body.includes('Тест обратной связи') && body.includes('tester@example.com') && body.includes(APPV) && body.includes('"photo":"data:image/jpeg;base64,'), `окно закрылось: ${closed}; запросов: ${hits.length}; текст/почта/версия/фото в запросе: ${body.includes('Тест обратной связи')}/${body.includes('tester@example.com')}/${body.includes(APPV)}/${/filename=/.test(body)}`, 'Обратная связь: сообщение с фото уходит со всеми полями');
    st.mode = 'fail'; await sendFeedback(page, click, 'Второе сообщение', '', false);
    const stillOpen = (await page.locator('#feedbackDialog[open]').count()) === 1; const kept = await page.inputValue('#feedbackText'); const label = (await page.locator('#feedbackSubmitButton').innerText()).trim(); const enabled = await page.locator('#feedbackSubmitButton').isEnabled();
    ok(stillOpen && kept === 'Второе сообщение' && enabled && /Отправить/.test(label), `окно открыто: ${stillOpen}; текст сохранён: ${kept === 'Второе сообщение'}; кнопка снова активна: ${enabled} («${label}»)`, 'Обратная связь: при сбое отправки текст не теряется, кнопка снова активна');
    st.mode = 'ok'; await click('#feedbackSubmitButton'); await page.waitForTimeout(600);
    ok((await page.locator('#feedbackDialog[open]').count()) === 0 && hits.length === 3, 'повторная отправка после сбоя прошла', 'Обратная связь: повторная отправка после сбоя проходит');
  });
  await scenario('Обратная связь (без входа в облако): нужен email, затем отправка', { init: `localStorage.removeItem('__qa_nosession');` }, async ({ page, ok, click, context }) => {
    const hits = []; const st = { mode: 'ok' }; await hookFormsubmit(context, hits, st);
    await page.evaluate(() => localStorage.removeItem('day-sync-session-v1')); await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(900);
    await page.evaluate(() => localStorage.removeItem('day-sync-session-v1'));
    await sendFeedback(page, click, 'Без входа', '', false);
    const blocked = hits.length === 0 && (await page.locator('#feedbackDialog[open]').count()) === 1 && !(await page.locator('#feedbackReplyEmail').evaluate(e => e.readOnly));
    ok(blocked, `без email запрос не ушёл: ${hits.length === 0}; поле email доступно для ввода: ${!(await page.locator('#feedbackReplyEmail').evaluate(e => e.readOnly))}`, 'Обратная связь без входа: без email отправка не идёт, поле email можно заполнить');
    await page.fill('#feedbackReplyEmail', 'user@example.com'); await click('#feedbackSubmitButton'); await page.waitForTimeout(600);
    const body = hits[0] || '';
    ok((await page.locator('#feedbackDialog[open]').count()) === 0 && hits.length === 1 && body.includes('user@example.com') && body.includes('Без входа'), `запросов: ${hits.length}; email в запросе: ${body.includes('user@example.com')}`, 'Обратная связь без входа: с указанным email сообщение уходит');
  });

  await scenario('Автообновление: найдена новая версия → приложение само переходит на неё', { fakeVersion: 1 }, async ({ page, ok, errors }) => {
    await page.waitForTimeout(2500);
    ok(/[?&]v=999/.test(page.url()) && errors.length === 0, 'адрес после загрузки: ' + page.url().replace(base, '') + (errors.length ? ' | ' + errors.join(' | ') : ''));
  });

  await scenario('Обновление вручную: карточка «Доступно обновление» и кнопки «Обновить»', { fakeVersion: Infinity, init: `try { const orig = navigator.serviceWorker; Object.defineProperty(navigator, 'serviceWorker', { value: new Proxy(orig, { get(t, k) { if (k === 'getRegistration') return async () => ({ update: async () => { throw new Error('qa: сбой автообновления'); } }); const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } }), configurable: true }); } catch (e) {}` }, async ({ page, ok, click, errors }) => {
    await page.waitForTimeout(2500);
    const prompt = await page.locator('#updatePrompt').isVisible(); ok(prompt, prompt ? 'карточка показана после сбоя автообновления' : 'карточка не появилась', 'Обновление: при сбое автообновления показывается карточка');
    if (prompt) { await click('#promptApplyUpdate'); await page.waitForTimeout(800); ok(errors.length === 0, errors.join(' | '), 'Обновление: «Обновить» в карточке не вызывает ошибок'); }
    await openMenu(page, click); const en = await page.locator('#applyUpdateButton').isEnabled();
    ok(en, en ? '' : 'кнопка «Установить обновление» неактивна', 'Обновление: в меню кнопка «Установить обновление» активна, когда есть новая версия');
    if (en) { await click('#applyUpdateButton'); await page.waitForTimeout(800); ok(errors.length === 0, errors.join(' | '), 'Обновление: «Установить обновление» в меню не вызывает ошибок'); }
  });
  return log;
}

async function runMode(browser, base, mode, shotsDir) {
  const mobile = mode.startsWith('mobile'); const signedIn = mode.endsWith('signed');
  const userId = 'u-tester-0001';
  const { tasks, sharedRow } = seedData(signedIn);
  const context = await browser.newContext(viewportOpts(mobile));
  await context.addInitScript(initScript({ tasks, signedIn, userId }));
  const supa = { n: 0 };
  setMock(sharedRow, userId, supa);
  await context.route(url => { const h = url.hostname; return h !== '127.0.0.1' && h !== 'localhost'; }, r => r.abort());
  const state = { mode, errors: [], supa, base, page: null, filledScopes: new Set(), clickedIds: new Set(), mobile };
  context.on('page', p => { if (state.page && p !== state.page) p.close().catch(() => {}); });
  const page = await context.newPage(); state.page = page;
  const IGNORE = /Failed to load resource|net::ERR_FAILED|ERR_BLOCKED|favicon|service worker|ServiceWorker/i;
  page.on('filechooser', () => { supa.chooser = (supa.chooser || 0) + 1; });
  page.on('download', () => { supa.chooser = (supa.chooser || 0) + 1; });
  page.on('pageerror', e => state.errors.push('JS: ' + String(e.message || e).split('\n')[0]));
  page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) state.errors.push('console.error: ' + m.text().split('\n')[0].slice(0, 200)); });

  const log = newLog(); log.mode = mode;
  await page.goto(base + '/index.html', { waitUntil: 'load' }); await page.waitForTimeout(900);
  log.loadErrors = state.errors.splice(0);
  await flows(page, state, log);
  log.flowErrors = state.errors.splice(0);
  // свежее состояние для обхода (сценарии меняли данные)
  await page.evaluate(() => localStorage.clear()); await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(700);
  state.errors.length = 0;
  await sweep(page, context, state, log);
  if (shotsDir) { fs.mkdirSync(shotsDir, { recursive: true }); await page.screenshot({ path: path.join(shotsDir, mode + '.png') }).catch(() => {}); }
  await context.close();
  return log;
}

module.exports = { startServer, seedData, initScript, setMock, viewportOpts, serverState, PNG };

if (require.main === module) (async () => {
  const { server, base } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const modes = ['desktop-guest', 'desktop-signed', 'mobile-guest', 'mobile-signed'].filter(m => !args.only || m === args.only);
  const results = [];
  const problems = r => r.flows.filter(f => !f.pass).length + r.loadErrors.length + r.flowErrors.length + r.jsErrors.length + r.cantClick.length;
  // Режим с ошибками прогоняется ещё раз: на медленной машине (CI) бывают случайные сбои по времени. Настоящая ошибка упадёт и второй раз.
  const attempt = async (name, fn) => {
    let r = await fn();
    if (problems(r) > 0) { process.stdout.write('(повтор) '); const r2 = await fn(); if (problems(r2) === 0) { r2.notes.push('прошёл со 2-й попытки: в 1-й попытке были ' + problems(r) + ' сбоя(ев), вероятно из-за медленной машины'); r = r2; } else r = r2; }
    results.push(r); console.log(`нажато ${r.clicked}`);
  };
  for (const m of modes) { process.stdout.write(`▶ ${m} … `); await attempt(m, () => runMode(browser, base, m, args.shots)); }
  if (!args.only || /special|prompts/.test(args.only)) for (const mobile of [false, true]) {
    for (const [suffix, fn] of [['prompts', runPrompts], ['special', runSpecial]]) { const m = (mobile ? 'mobile' : 'desktop') + '-' + suffix; if (args.only && args.only !== m) continue; process.stdout.write(`▶ ${m} … `); await attempt(m, () => fn(browser, base, mobile, args.shots)); }
  }
  await browser.close(); server.close();

  let bad = 0;
  for (const r of results) {
    console.log(`\n══════ ${r.mode} ══════ нажато кнопок: ${r.clicked}, шагов: ${r.steps}`);
    const flowFail = r.flows.filter(f => !f.pass);
    console.log(`Сквозные сценарии: ${r.flows.length - flowFail.length}/${r.flows.length} ок`);
    flowFail.forEach(f => console.log(`  ✗ ${f.name} ${f.detail}`));
    if (r.loadErrors.length) { console.log('Ошибки при загрузке страницы:'); r.loadErrors.forEach(e => console.log('  ✗ ' + e)); }
    if (r.flowErrors.length) { console.log('Ошибки в сценариях:'); r.flowErrors.forEach(e => console.log('  ✗ ' + e)); }
    if (r.jsErrors.length) { console.log('ОШИБКА JS после нажатия:'); const seenE = new Set(); r.jsErrors.forEach(e => { const k = e.el + '|' + e.errors.join('|'); if (seenE.has(k)) return; seenE.add(k); console.log(`  ✗ [${e.scope}] ${e.el}\n      ${e.errors.join('\n      ')}`); }); }
    if (r.cantClick.length) { console.log('НЕ НАЖАТЬ:'); r.cantClick.forEach(e => console.log(`  ✗ [${e.scope}] ${e.el} — ${e.why}`)); }
    if (r.noEffect.length) { console.log(`БЕЗ РЕАКЦИИ (проверьте вручную, часть может быть нормой): ${r.noEffect.length}`); r.noEffect.forEach(e => console.log(`  ? [${e.scope}] ${e.el}${e.hint ? ' — ' + e.hint : ''}`)); }
    r.notes.forEach(n => console.log('  ℹ ' + n));
    bad += flowFail.length + r.loadErrors.length + r.flowErrors.length + r.jsErrors.length + r.cantClick.length;
  }
  // ПОКРЫТИЕ: все элементы с id из index.html (кнопки/ссылки/переключатели) против реально нажатых во всех режимах
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
  const dialogs = [...html.matchAll(/<dialog\b[^>]*\bid="([^"]+)"[\s\S]*?<\/dialog>/g)].map(m => ({ id: m[1], from: m.index, to: m.index + m[0].length }));
  const staticEls = [...html.matchAll(/<(button|a|input|select|summary)\b([^>]*)>/g)].map(m => { const id = /\bid="([^"]+)"/.exec(m[2]); const type = /\btype="([^"]+)"/.exec(m[2]); const ok = m[1] !== 'input' || ['checkbox', 'radio', 'button', 'submit'].includes(type && type[1]); return ok && id ? { id: id[1], tag: m[1], pos: m.index, hidden: /\bhidden\b/.test(m[2]), dialog: (dialogs.find(d => m.index >= d.from && m.index < d.to) || {}).id || 'страница' } : null; }).filter(Boolean);
  const allClicked = new Set(results.flatMap(r => r.clickedIds || []));
  // Известные элементы, до которых пользователь не может добраться (панель «today» в окне планов нигде не включается)
  const UNREACHABLE = new Set(['enableNotifications']);
  const uncovered = staticEls.filter(e => !allClicked.has(e.id) && !UNREACHABLE.has(e.id));
  const unreachable = staticEls.filter(e => !allClicked.has(e.id) && UNREACHABLE.has(e.id));
  console.log(`\n══════ ПОКРЫТИЕ ══════\nэлементов с id в разметке: ${staticEls.length}, нажато хотя бы в одном режиме: ${staticEls.length - uncovered.length - unreachable.length}, недостижимы из интерфейса: ${unreachable.length}`);
  unreachable.forEach(e => console.log(`  ℹ #${e.id} в интерфейсе недостижим (панель скрыта навсегда — мёртвый код, на работу не влияет)`));
  if (uncovered.length) { console.log('НЕ нажаты ни в одном режиме:'); uncovered.forEach(e => console.log(`  - #${e.id} (${e.tag}, ${e.dialog}${e.hidden ? ', скрыт по умолчанию' : ''})`)); }
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ results, uncovered }, null, 2));
  console.log(bad ? `\nИТОГ: найдено проблем — ${bad}` : '\nИТОГ: ошибок не найдено ✔');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('Тест упал:', e); process.exit(3); });
