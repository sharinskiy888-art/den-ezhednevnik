/*
 * Раздел «Клиенты» (CRM): клиенты → объекты → заявки и договоры ТО, деньги по заявкам в копейках, справочник.
 * Данные лежат на устройстве (IndexedDB), поэтому поиск и карточки открываются сразу, без ожидания сервера.
 * Руководитель меняет всё, монтажник видит только назначенные заявки (работа по ним — через поручение).
 */
(function () {
  const KINDS = ['clients', 'objects', 'orders', 'contracts', 'payments', 'dict'];
  const STAGES = { new: ['Новая', 'New'], kp: ['КП', 'Quote'], work: ['В работе', 'In progress'], done: ['Сдано', 'Delivered'], paid: ['Оплачено', 'Paid'] };
  const DEFAULT_DICT = { id: 'dict', workTypes: ['Монтаж', 'Ремонт', 'ТО', 'Проект'], systems: ['АПС', 'СОУЭ', 'Видеонаблюдение', 'Электрика'] };
  const LIST_LIMIT = 200;
  const state = { role: '', userId: '', data: {}, tomb: {}, index: {}, edits: {}, tab: 'orders', query: '', card: null, syncing: false, again: false };
  KINDS.forEach(kind => { state.data[kind] = new Map(); state.tomb[kind] = {}; state.edits[kind] = new Map(); });
  const MAX_KOP = 1e15; const TEXT_MAX = 2000;
  const collator = new Intl.Collator('ru');

  // --- Хранение на устройстве: IndexedDB (localStorage мал для 10 000 карточек) ---
  let dbPromise = null;
  function idb() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const open = indexedDB.open('day-crm', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    }).catch(() => null);
    return dbPromise;
  }
  async function idbGet(key) {
    const db = await idb(); if (!db) return null;
    return new Promise(resolve => { const r = db.transaction('kv').objectStore('kv').get(key); r.onsuccess = () => resolve(r.result ?? null); r.onerror = () => resolve(null); });
  }
  async function idbSet(key, value) {
    const db = await idb(); if (!db) return;
    await new Promise(resolve => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(value, key); t.oncomplete = resolve; t.onerror = resolve; });
  }
  const storeKey = kind => `${state.userId}:${kind}`;
  async function loadLocal(userId) {
    state.userId = userId;
    for (const kind of KINDS) {
      const saved = await idbGet(storeKey(kind)) || {};
      state.data[kind] = new Map((saved.items || []).map(item => [item.id, item])); state.tomb[kind] = saved.tomb || {}; state.index[kind] = null;
    }
    state.role = (await idbGet(`${userId}:role`)) || '';
  }
  async function saveLocal(kind) {
    state.index[kind] = null;
    await idbSet(storeKey(kind), { items: [...state.data[kind].values()], tomb: state.tomb[kind] });
  }

  // --- Деньги: только копейки целым числом ---
  function parseRub(text) {
    const clean = String(text ?? '').replace(/[\s ₽]/g, '').replace(',', '.');
    if (!clean) return 0;
    if (!/^\d+(\.\d{0,2})?$/.test(clean)) return null;
    const [rub, kop = ''] = clean.split('.');
    const value = Number(rub) * 100 + Number((kop + '00').slice(0, 2));
    return value > MAX_KOP ? null : value;
  }
  const formatRub = kop => { const a = Math.abs(kop || 0); return `${kop < 0 ? '−' : ''}${Math.trunc(a / 100).toLocaleString('ru-RU')},${String(a % 100).padStart(2, '0')} ₽`; };
  const kopInput = kop => kop ? `${Math.trunc(kop / 100)},${String(kop % 100).padStart(2, '0')}` : '';

  // --- Поиск: строка для поиска по каждой карточке собирается один раз и обновляется при изменении ---
  const get = (kind, id) => state.data[kind].get(id);
  const dict = () => ({ ...DEFAULT_DICT, ...(get('dict', 'dict') || {}) });
  const objectLabel = o => o ? (o.address || L('Объект без адреса', 'Object without address')) : L('Объект удалён', 'Object deleted');
  const clientOf = o => o && get('clients', o.clientId);
  // Телефон ищется по цифрам: «+7 900 123-45-67», «89001234567» и «900 123 45 67» — один номер.
  function phoneKey(value) { const digits = String(value || '').replace(/\D/g, ''); return digits.length === 11 && /^[78]/.test(digits) ? digits.slice(1) : digits; }
  function searchText(kind, item) {
    const o = kind === 'orders' || kind === 'contracts' ? get('objects', item.objectId) : kind === 'objects' ? item : null;
    const c = kind === 'clients' ? item : clientOf(o);
    return [item.name, item.inn, item.phone, item.email, item.contact, item.note, item.type, item.equipment, ...(item.systems || []), ...(item.assignees || []),
      o?.address, c?.name, c?.inn, c?.phone, phoneKey(item.phone), phoneKey(c?.phone), kind === 'orders' ? STAGES[item.stage || 'new']?.[0] : ''].filter(Boolean).join(' ').toLocaleLowerCase();
  }
  function index(kind) {
    if (!state.index[kind]) state.index[kind] = [...state.data[kind].values()].map(item => [searchText(kind, item), item]);
    return state.index[kind];
  }
  function search(kind, query) {
    const asPhone = String(query || '').replace(/[\s()+-]/g, '');
    const words = /^\d{4,}$/.test(asPhone) ? [phoneKey(asPhone)] : String(query || '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const rows = index(kind);
    return words.length ? rows.filter(([text]) => words.every(word => text.includes(word))).map(([, item]) => item) : rows.map(([, item]) => item);
  }

  // --- Синхронизация ---
  // «Известные версии» лежат в localStorage, сами данные — в IndexedDB. Если данных нет (сменилась роль,
  // браузер очистил базу), версии забываются, чтобы всё скачалось заново, а не только изменённое.
  function forgetVersions(kind) { try { localStorage.removeItem(`day-sync-meta-v1:crm:${kind}:${state.userId}`); } catch {} }
  async function sync() {
    const me = window.DaySync?.user(); if (!me) { state.role = ''; refreshTab(); return; } // вышли из аккаунта — раздела «Клиенты» не видно
    if (state.syncing) { state.again = true; return; } // правка во время обмена — ещё один круг после него
    state.syncing = true; state.again = false;
    const failed = [];
    try {
      if (state.userId !== me.id) await loadLocal(me.id);
      const role = await window.DaySync.crmRole();
      if (role !== state.role) { KINDS.forEach(forgetVersions); if (!role) await wipe(); }
      state.role = role; await idbSet(`${me.id}:role`, role); refreshTab();
      if (!role) return;
      for (const kind of KINDS) {
        try {
          if (!state.data[kind].size && !Object.keys(state.tomb[kind]).length) forgetVersions(kind);
          state.edits[kind].clear();
          if (role === 'manager') {
            const result = await window.DaySync.sync(`crm:${kind}`, [...state.data[kind].values()], state.tomb[kind], null);
            const next = new Map((result.tasks || []).map(item => [item.id, item])); const tomb = result.tombstones || {};
            state.edits[kind].forEach((item, id) => { if (item) { next.set(id, item); delete tomb[id]; } else { next.delete(id); tomb[id] = state.tomb[kind][id]; } });
            state.data[kind] = next; state.tomb[kind] = tomb;
          } else state.data[kind] = new Map((await window.DaySync.mirrorCrm(kind, [...state.data[kind].values()])).map(item => [item.id, item]));
          await saveLocal(kind);
        } catch (error) { if (error.sessionExpired) throw error; failed.push(error.message); } // один раздел с ошибкой не останавливает остальные
      }
      KINDS.forEach(kind => { state.index[kind] = null; });
      if ($('#crmDialog').open) renderList();
      if (failed.length && $('#crmDialog').open) toast(`${L('Не всё сохранилось на сервере', 'Not everything was saved')}: ${failed[0]}`);
    } catch (error) { if ($('#crmDialog').open) toast(error.message || L('Не удалось обновить «Клиенты»', 'Could not update Clients')); }
    finally { state.syncing = false; if (state.again) sync(); }
  }
  // Данные восстановлены из копии: карточки на устройстве забываются и скачиваются заново (иначе вернулись бы на сервер).
  async function forget(userId) {
    for (const kind of KINDS) {
      await idbSet(`${userId}:${kind}`, { items: [], tomb: {} });
      try { localStorage.removeItem(`day-sync-meta-v1:crm:${kind}:${userId}`); } catch {}
      if (state.userId === userId) { state.data[kind] = new Map(); state.tomb[kind] = {}; state.index[kind] = null; }
    }
  }
  async function wipe() { for (const kind of KINDS) { state.data[kind] = new Map(); state.tomb[kind] = {}; await saveLocal(kind); } } // доступ закрыли — телефоны клиентов не остаются на устройстве
  async function saveItem(kind, item) {
    const now = new Date().toISOString(); const saved = { ...item, updatedAt: now };
    state.data[kind].set(saved.id, saved); if (state.syncing) state.edits[kind].set(saved.id, saved); await saveLocal(kind);
    if (kind === 'objects' || kind === 'clients') { state.index.orders = null; state.index.contracts = null; state.index.objects = null; }
    sync();
    return saved;
  }
  async function removeItem(kind, id) {
    state.data[kind].delete(id); state.tomb[kind][id] = new Date().toISOString(); if (state.syncing) state.edits[kind].set(id, null); await saveLocal(kind); sync();
  }
  function refreshTab() {
    const tab = $('#tabCrm'); if (tab) tab.hidden = !state.role;
  }

  // --- Список ---
  const canEdit = () => state.role === 'manager';
  function rowHtml(kind, item) {
    if (kind === 'clients') return `<b>${escapeHtml(item.name)}</b><small>${escapeHtml([item.inn && `ИНН ${item.inn}`, item.phone].filter(Boolean).join(' · '))}</small>`;
    if (kind === 'objects') return `<b>${escapeHtml(objectLabel(item))}</b><small>${escapeHtml([clientOf(item)?.name, (item.systems || []).join(', ')].filter(Boolean).join(' · '))}</small>`;
    const o = get('objects', item.objectId);
    if (kind === 'orders') return `<b>${escapeHtml(item.type || L('Заявка', 'Order'))}: ${escapeHtml(objectLabel(o))}</b><small><span class="crm-stage crm-stage-${escapeHtml(item.stage || 'new')}">${L(...(STAGES[item.stage] || STAGES.new))}</span> ${escapeHtml([item.due && formatShortDate(item.due), item.sumKop ? formatRub(item.sumKop) : ''].filter(Boolean).join(' · '))}</small>`;
    return `<b>${escapeHtml(item.type || 'ТО')}: ${escapeHtml(objectLabel(o))}</b><small>${escapeHtml([item.active === false ? L('остановлен', 'paused') : `${L('следующее', 'next')} ${item.nextDate ? formatShortDate(item.nextDate) : '—'}`, `${L('раз в', 'every')} ${item.periodMonths || 1} ${L('мес.', 'mo.')}`, item.priceKop ? formatRub(item.priceKop) : ''].filter(Boolean).join(' · '))}</small>`;
  }
  const sorters = {
    orders: (a, b) => (a.stage === 'paid') - (b.stage === 'paid') || String(a.due || '9').localeCompare(String(b.due || '9')),
    clients: (a, b) => collator.compare(String(a.name || ''), String(b.name || '')),
    objects: (a, b) => collator.compare(String(a.address || ''), String(b.address || '')),
    contracts: (a, b) => String(a.nextDate || '9').localeCompare(String(b.nextDate || '9'))
  };
  function renderList() {
    const kind = state.tab; const list = $('#crmList');
    $$('[data-crm-tab]').forEach(button => button.classList.toggle('active', button.dataset.crmTab === kind));
    $$('[data-crm-tab="contracts"],[data-crm-tab="dict"]').forEach(button => { button.hidden = !canEdit(); });
    $('#crmAdd').hidden = !canEdit(); // заявка и объект заводятся из карточки клиента
    if (kind === 'dict') { list.innerHTML = ''; openCard('dict', dict()); state.tab = 'orders'; return renderList(); }
    const found = search(kind, state.query).sort(sorters[kind]);
    $('#crmCount').textContent = `${L('Найдено', 'Found')}: ${found.length}${found.length > LIST_LIMIT ? ` · ${L('показаны первые', 'showing first')} ${LIST_LIMIT}` : ''}`;
    list.innerHTML = found.slice(0, LIST_LIMIT).map(item => `<button type="button" class="crm-row nav" data-crm-open="${kind}" data-id="${escapeHtml(item.id)}">${rowHtml(kind, item)}</button>`).join('')
      || `<p class="crm-empty">${state.query ? L('Ничего не найдено', 'Nothing found') : kind === 'orders' && !canEdit() ? L('Вам пока не назначено заявок', 'No orders assigned to you yet') : L('Пока пусто', 'Nothing here yet')}</p>`;
    $$('#crmList [data-crm-open]').forEach(button => button.addEventListener('click', () => openCard(button.dataset.crmOpen, get(button.dataset.crmOpen, button.dataset.id))));
  }
  async function open() {
    const me = window.DaySync?.user(); if (!me) { openSyncDialog(); return; }
    if (state.userId !== me.id) await loadLocal(me.id);
    state.query = ''; $('#crmSearch').value = ''; renderList(); $('#crmDialog').showModal(); sync();
  }

  // --- Карточка ---
  const field = (name, label, value = '', type = 'text', extra = '') => `<label><span>${label}</span><input name="${name}" type="${type}" value="${escapeHtml(String(value ?? ''))}" ${canEdit() ? '' : 'readonly'} ${/maxlength/.test(extra) ? '' : `maxlength="${TEXT_MAX}"`} ${extra}></label>`;
  const area = (name, label, value = '') => `<label><span>${label}</span><textarea name="${name}" rows="3" maxlength="${TEXT_MAX}" ${canEdit() ? '' : 'readonly'}>${escapeHtml(String(value ?? ''))}</textarea></label>`;
  const select = (name, label, options, value) => `<label><span>${label}</span><select name="${name}" ${canEdit() ? '' : 'disabled'}>${options.map(([v, text]) => `<option value="${escapeHtml(v)}" ${v === value ? 'selected' : ''}>${escapeHtml(text)}</option>`).join('')}</select></label>`;
  const emails = text => [...new Set(String(text || '').split(/[\s,;]+/).map(e => e.trim().toLocaleLowerCase()).filter(e => e.includes('@')))];
  const children = (kind, key, id) => [...state.data[kind].values()].filter(item => item[key] === id);
  const linkList = (kind, items, empty) => items.length ? items.sort(sorters[kind] || (() => 0)).map(item => `<button type="button" class="crm-row nav" data-crm-open="${kind}" data-id="${escapeHtml(item.id)}">${kind === 'payments' ? paymentRow(item) : rowHtml(kind, item)}</button>`).join('') : `<p class="crm-empty">${empty}</p>`;
  const paymentRow = p => `<b>${p.kind === 'income' ? '＋' : '−'} ${formatRub(p.amountKop)}</b><small>${escapeHtml([p.date && formatShortDate(p.date), p.note].filter(Boolean).join(' · '))}</small>`;
  const TITLES = { clients: ['Клиент', 'Client'], objects: ['Объект', 'Object'], orders: ['Заявка', 'Order'], contracts: ['Договор ТО', 'Maintenance contract'], payments: ['Оплата или расход', 'Payment or cost'], dict: ['Справочник', 'Reference lists'] };

  function cardBody(kind, item) {
    const d = dict();
    if (kind === 'clients') return field('name', L('Название или ФИО', 'Name'), item.name, 'text', 'required maxlength="300"') + field('inn', L('ИНН', 'Tax ID'), item.inn, 'text', 'inputmode="numeric" maxlength="12"')
      + field('phone', L('Телефон', 'Phone'), item.phone, 'tel') + field('email', 'Email', item.email, 'email') + field('contact', L('Контактное лицо', 'Contact person'), item.contact) + area('note', L('Заметки', 'Notes'), item.note)
      + (item.__new ? '' : `<h4 class="sv-section">${L('Объекты', 'Objects')}</h4>${linkList('objects', children('objects', 'clientId', item.id), L('Объектов нет', 'No objects'))}${canEdit() ? `<button type="button" class="secondary-button gray" data-crm-new="objects">＋ ${L('Объект', 'Object')}</button>` : ''}`);
    if (kind === 'objects') {
      const systems = item.systems || [];
      return `<p class="sv-meta">${L('Клиент', 'Client')}: ${escapeHtml(clientOf(item)?.name || '—')}</p>` + field('address', L('Адрес', 'Address'), item.address, 'text', 'maxlength="500"')
        + `<fieldset class="crm-systems"><legend>${L('Системы', 'Systems')}</legend>${[...new Set([...d.systems, ...systems])].map(s => `<label class="check-label"><input type="checkbox" name="systems" value="${escapeHtml(s)}" ${systems.includes(s) ? 'checked' : ''} ${canEdit() ? '' : 'disabled'}><span>${escapeHtml(s)}</span></label>`).join('')}</fieldset>`
        + area('equipment', L('Оборудование', 'Equipment'), item.equipment) + area('note', L('Заметки', 'Notes'), item.note)
        + `<div class="crm-photos" id="crmPhotos"></div>${canEdit() && !item.__new ? `<label class="secondary-button gray crm-photo-add">📷 ${L('Добавить фото', 'Add photo')}<input type="file" accept="image/*" id="crmPhotoInput" hidden></label>` : ''}`
        + (item.__new ? '' : `<h4 class="sv-section">${L('Заявки', 'Orders')}</h4>${linkList('orders', children('orders', 'objectId', item.id), L('Заявок нет', 'No orders'))}
          ${canEdit() ? `<button type="button" class="secondary-button gray" data-crm-new="orders">＋ ${L('Заявка', 'Order')}</button>` : ''}
          ${canEdit() ? `<h4 class="sv-section">${L('Договоры ТО', 'Maintenance contracts')}</h4>${linkList('contracts', children('contracts', 'objectId', item.id), L('Договоров нет', 'No contracts'))}<button type="button" class="secondary-button gray" data-crm-new="contracts">＋ ${L('Договор ТО', 'Contract')}</button>` : ''}`);
    }
    if (kind === 'orders') {
      const pays = children('payments', 'orderId', item.id); const income = pays.filter(p => p.kind === 'income').reduce((s, p) => s + p.amountKop, 0); const cost = pays.filter(p => p.kind === 'expense').reduce((s, p) => s + p.amountKop, 0);
      const task = typeof sharedTasks !== 'undefined' ? sharedTasks.find(t => t.id === `crm-${item.id}`) : null;
      const o = get('objects', item.objectId); const c = clientOf(o);
      return `<p class="sv-meta">${escapeHtml(objectLabel(o))}${c ? ` · ${escapeHtml(c.name)}${c.phone ? ` · <a href="tel:${escapeHtml(c.phone)}">${escapeHtml(c.phone)}</a>` : ''}` : ''}</p>`
        + select('type', L('Вид работ', 'Work type'), [...new Set([...d.workTypes, item.type].filter(Boolean))].map(t => [t, t]), item.type || d.workTypes[0])
        + `<div class="crm-stages" role="group">${Object.entries(STAGES).map(([key, names]) => `<button type="button" data-crm-stage="${key}" class="tab${(item.stage || 'new') === key ? ' active' : ''}" ${canEdit() ? '' : 'disabled'}>${L(...names)}</button>`).join('')}</div>`
        + field('due', L('Срок', 'Due'), item.due, 'date') + field('sum', L('Сумма, ₽', 'Amount, ₽'), kopInput(item.sumKop), 'text', 'inputmode="decimal"')
        + area('assignees', L('Исполнители (email, по одному в строке)', 'Assignees (email, one per line)'), (item.assignees || []).join('\n')) + area('note', L('Заметки', 'Notes'), item.note)
        + (task ? `<p class="sv-meta">${L('Поручение', 'Assignment')}: ${sharedStatusText(task.status)} · ${L('отчётов', 'reports')}: ${(task.reports || []).length} <button type="button" class="secondary-button gray" data-crm-task="${escapeHtml(task.id)}">${L('Открыть поручение', 'Open assignment')}</button></p>` : '')
        + (canEdit() && !item.__new ? `<h4 class="sv-section">${L('Деньги по заявке', 'Money')}: ${L('приход', 'in')} ${formatRub(income)} · ${L('расход', 'out')} ${formatRub(cost)} · ${L('итого', 'net')} ${formatRub(income - cost)}</h4>${linkList('payments', pays, L('Операций нет', 'No operations'))}<button type="button" class="secondary-button gray" data-crm-new="payments" data-kind="income">＋ ${L('Приход', 'Income')}</button> <button type="button" class="secondary-button gray" data-crm-new="payments" data-kind="expense">− ${L('Расход', 'Cost')}</button>` : '');
    }
    if (kind === 'contracts') return `<p class="sv-meta">${escapeHtml(objectLabel(get('objects', item.objectId)))}</p>`
      + select('type', L('Вид работ', 'Work type'), [...new Set(['ТО', ...d.workTypes, item.type].filter(Boolean))].map(t => [t, t]), item.type || 'ТО')
      + field('periodMonths', L('Раз в сколько месяцев', 'Every N months'), item.periodMonths || 1, 'number', 'min="1" max="24" step="1"') + field('price', L('Цена одного ТО, ₽', 'Price per visit, ₽'), kopInput(item.priceKop), 'text', 'inputmode="decimal"')
      + field('nextDate', L('Следующее ТО', 'Next visit'), item.nextDate || toKey(new Date()), 'date', 'required') + area('assignees', L('Исполнители (email)', 'Assignees (email)'), (item.assignees || []).join('\n'))
      + `<label class="check-label"><input type="checkbox" name="active" ${item.active === false ? '' : 'checked'}><span>${L('Действует: заявки ТО создаются сами за 7 дней', 'Active: maintenance orders are created 7 days ahead')}</span></label>` + area('note', L('Заметки', 'Notes'), item.note);
    if (kind === 'payments') return select('kind', L('Тип', 'Type'), [['income', L('Приход', 'Income')], ['expense', L('Расход', 'Cost')]], item.kind || 'income')
      + field('amount', L('Сумма, ₽', 'Amount, ₽'), kopInput(item.amountKop), 'text', 'inputmode="decimal" required') + field('date', L('Дата', 'Date'), item.date || toKey(new Date()), 'date') + field('note', L('Комментарий', 'Comment'), item.note);
    return area('workTypes', L('Виды работ (по одному в строке)', 'Work types (one per line)'), d.workTypes.join('\n')) + area('systems', L('Системы (по одному в строке)', 'Systems (one per line)'), d.systems.join('\n'));
  }
  function openCard(kind, item, parent = null) {
    if (!item) return;
    state.card = { kind, item: { ...item }, parent };
    $('#crmCardTitle').textContent = L(...TITLES[kind]);
    $('#crmCardForm').innerHTML = cardBody(kind, item);
    $('#crmCardSave').hidden = !canEdit(); $('#crmCardDelete').hidden = !canEdit() || !!item.__new || kind === 'dict';
    $$('#crmCardForm [data-crm-open]').forEach(button => button.addEventListener('click', async () => { if (await keepEdits()) openCard(button.dataset.crmOpen, get(button.dataset.crmOpen, button.dataset.id), state.card); }));
    $$('#crmCardForm [data-crm-new]').forEach(button => button.addEventListener('click', async () => { if (await keepEdits()) newChild(button.dataset.crmNew, button.dataset.kind); }));
    $$('#crmCardForm [data-crm-stage]').forEach(button => button.addEventListener('click', () => { $$('#crmCardForm [data-crm-stage]').forEach(b => b.classList.toggle('active', b === button)); }));
    $$('#crmCardForm [data-crm-task]').forEach(button => button.addEventListener('click', () => { $('#crmCardDialog').close(); $('#crmDialog').close(); openDialog(button.dataset.crmTask, 'shared'); }));
    $('#crmPhotoInput')?.addEventListener('change', event => addPhoto(event.target.files?.[0]));
    window.DayAk?.employeePicker($('#crmCardForm textarea[name="assignees"]')); // АК-Сервер: исполнители — из сотрудников ядра
    renderPhotos(item);
    if (!$('#crmCardDialog').open) $('#crmCardDialog').showModal();
    $('#crmCardDialog .shared-panel').scrollTop = 0; // новая карточка — с начала, а не с места прокрутки прошлой
  }
  // Перед переходом во вложенную карточку несохранённые правки текущей сохраняются, а не теряются.
  async function keepEdits() {
    if (!canEdit() || !state.card || state.card.item.__new) return true;
    let item; try { item = readCard(); } catch (error) { toast(error.message); return false; }
    const before = state.card.item; const changed = Object.keys({ ...item, ...before }).some(key => JSON.stringify(item[key]) !== JSON.stringify(before[key]));
    if (changed) state.card.item = await saveItem(state.card.kind, item);
    return true;
  }
  function closeCard() {
    const parent = state.card?.parent;
    if (parent) openCard(parent.kind, get(parent.kind, parent.item.id) || parent.item, parent.parent); else $('#crmCardDialog').close();
  }
  function newChild(kind, paymentKind) {
    const parent = state.card.item; const id = crypto.randomUUID();
    const base = { objects: { clientId: parent.id, systems: [] }, orders: { objectId: parent.id, stage: 'new', type: dict().workTypes[0], assignees: [] },
      contracts: { objectId: parent.id, periodMonths: 1, active: true, nextDate: toKey(new Date()), type: 'ТО', assignees: [] }, payments: { orderId: parent.id, kind: paymentKind || 'income', date: toKey(new Date()) } }[kind];
    openCard(kind, { id, __new: true, ...base }, state.card);
  }
  async function renderPhotos(item) {
    const box = $('#crmPhotos'); if (!box) return;
    box.innerHTML = '';
    for (const path of item.photos || []) {
      try { const blob = await window.DaySync.loadSharedMedia(path); const img = document.createElement('img'); img.src = URL.createObjectURL(blob); img.alt = ''; box.append(img); } catch {}
    }
  }
  async function addPhoto(file) {
    if (!file) return;
    try {
      const blob = await compressReportPhoto(file); const path = await window.DaySync.uploadCrmPhoto(state.card.item.id, blob);
      const saved = await saveItem('objects', { ...get('objects', state.card.item.id), photos: [...(state.card.item.photos || []), path] });
      state.card.item = saved; renderPhotos(saved); toast(L('Фото добавлено', 'Photo added'));
    } catch (error) { toast(error.message || L('Фото не загрузилось', 'Photo upload failed')); }
  }
  function readCard() {
    const { kind, item } = state.card; const form = $('#crmCardForm'); const val = name => form.elements[name]?.value?.trim() ?? '';
    const out = { ...item }; delete out.__new;
    const money = (name, key) => { const kop = parseRub(val(name)); if (kop === null) throw new Error(L('Сумма: только цифры и копейки через запятую, например 1500,50', 'Amount: digits only, e.g. 1500.50')); out[key] = kop; };
    if (kind === 'clients') { ['name', 'inn', 'phone', 'email', 'contact', 'note'].forEach(n => { out[n] = val(n); }); if (!out.name) throw new Error(L('Укажите название клиента', 'Enter the client name')); if (out.inn && !/^\d{10}(\d{2})?$/.test(out.inn)) throw new Error(L('ИНН — 10 или 12 цифр', 'Tax ID: 10 or 12 digits')); }
    if (kind === 'objects') { ['address', 'equipment', 'note'].forEach(n => { out[n] = val(n); }); out.systems = [...form.querySelectorAll('input[name="systems"]:checked')].map(i => i.value); }
    if (kind === 'orders') { out.type = val('type'); out.due = val('due'); out.note = val('note'); out.assignees = emails(val('assignees')); out.stage = form.querySelector('[data-crm-stage].active')?.dataset.crmStage || 'new'; money('sum', 'sumKop'); }
    if (kind === 'contracts') { out.type = val('type'); out.nextDate = val('nextDate'); out.note = val('note'); out.assignees = emails(val('assignees')); out.active = form.elements.active.checked; out.periodMonths = Math.min(24, Math.max(1, Math.round(Number(val('periodMonths')) || 1))); money('price', 'priceKop'); if (!out.nextDate) throw new Error(L('Укажите дату следующего ТО', 'Enter the next visit date')); }
    if (kind === 'payments') { out.kind = val('kind'); out.date = val('date'); out.note = val('note'); money('amount', 'amountKop'); if (!out.amountKop) throw new Error(L('Укажите сумму больше нуля', 'Enter an amount above zero')); }
    if (kind === 'dict') { const lines = n => [...new Set(val(n).split(/\r?\n/).map(s => s.trim().slice(0, 100)).filter(Boolean))].slice(0, 200); out.workTypes = lines('workTypes'); out.systems = lines('systems'); }
    return out;
  }
  async function saveCard() {
    if (!canEdit() || !state.card) return;
    let item; try { item = readCard(); } catch (error) { toast(error.message); return; }
    const saved = await saveItem(state.card.kind, item); const parent = state.card.parent;
    toast(L('Сохранено', 'Saved'));
    if (parent) openCard(parent.kind, get(parent.kind, parent.item.id) || parent.item, parent.parent); else { $('#crmCardDialog').close(); renderList(); }
    return saved;
  }
  async function deleteCard() {
    if (!canEdit() || !state.card || state.card.item.__new) return;
    const { kind, item, parent } = state.card;
    const linked = kind === 'clients' ? children('objects', 'clientId', item.id).length : kind === 'objects' ? children('orders', 'objectId', item.id).length + children('contracts', 'objectId', item.id).length : kind === 'orders' ? children('payments', 'orderId', item.id).length : 0;
    if (linked) { toast(L('Сначала удалите вложенные записи (объекты, заявки, оплаты)', 'Delete the nested records first')); return; }
    if (!confirm(L('Удалить эту запись?', 'Delete this record?'))) return;
    await removeItem(kind, item.id); toast(L('Удалено', 'Deleted'));
    if (parent) openCard(parent.kind, get(parent.kind, parent.item.id) || parent.item, parent.parent); else { $('#crmCardDialog').close(); renderList(); }
  }
  function newClient() { openCard('clients', { id: crypto.randomUUID(), __new: true, name: '' }); }

  // --- Привязка к разметке ---
  $('#tabCrm').addEventListener('click', open);
  $('#closeCrm').addEventListener('click', () => $('#crmDialog').close());
  $('#closeCrmCard').addEventListener('click', () => $('#crmCardDialog').close());
  $('#crmCardClose').addEventListener('click', closeCard); // «Закрыть» во вложенной карточке возвращает к родительской
  $('#crmCardSave').addEventListener('click', saveCard);
  $('#crmCardDelete').addEventListener('click', deleteCard);
  $('#crmAdd').addEventListener('click', newClient);
  $('#crmSearch').addEventListener('input', event => { state.query = event.target.value; renderList(); });
  $$('[data-crm-tab]').forEach(button => button.addEventListener('click', () => { state.tab = button.dataset.crmTab; renderList(); }));
  $('#crmCardDialog').addEventListener('close', () => { if ($('#crmDialog').open) renderList(); });

  window.DayCrm = { sync, forget, open, search, parseRub, formatRub, state, refreshTab, loadLocal, saveLocal, saveItemForTest: item => saveItem('clients', item) };
  (async () => { const me = window.DaySync?.user(); if (me) { await loadLocal(me.id); refreshTab(); } })();
})();
