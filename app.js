const STORAGE_KEY = 'day-planner-tasks-v2';
const LEGACY_KEY = 'day-planner-tasks-v1';
const DELETED_KEY = 'day-planner-deleted-v1';
const PROFILE_KEY = 'day-planner-profile-v1';
const PLAN_KEY = 'day-planner-period-plans-v1';
const STATE_UPDATED_KEY = 'day-planner-state-updated-v1';
const PIN_KEY = 'day-planner-pin-v1';
const PIN_UNLOCKED_AT_KEY = 'day-planner-pin-unlocked-at-v1';
const PIN_RELOCK_MS = 30 * 60 * 1000;
const NOTIFICATION_KEY = 'day-planner-notifications-v1';
const APP_VERSION = '60';
const UPDATE_SEEN_KEY = 'day-planner-update-seen-v1';
const UPDATE_APPLIED_KEY = 'day-planner-update-applied-v1';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const pad = (n) => String(n).padStart(2, '0');
const toKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const fromKey = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
const todayKey = toKey(new Date());

const migrateExistingAccount = !!window.DaySync?.user();
const accountSuffix = () => window.DaySync?.user()?.id || 'guest';
const taskStorageKey = () => `${STORAGE_KEY}:${accountSuffix()}`;
const deletedStorageKey = () => `${DELETED_KEY}:${accountSuffix()}`;
const profileStorageKey = () => `${PROFILE_KEY}:${accountSuffix()}`;
const planStorageKey = () => `${PLAN_KEY}:${accountSuffix()}`;
const stateUpdatedStorageKey = () => `${STATE_UPDATED_KEY}:${accountSuffix()}`;
const pinStorageKey = () => `${PIN_KEY}:${accountSuffix()}`;
const pinUnlockedAtStorageKey = () => `${PIN_UNLOCKED_AT_KEY}:${accountSuffix()}`;
const notificationStorageKey = () => `${NOTIFICATION_KEY}:${accountSuffix()}`;

let tasks = loadTasks();
let selectedDate = todayKey;
let searchQuery = '';
let currentView = 'today';
let currentPeriod = 'day';
let installPrompt = null;
let pendingPhoto = null;
let pendingAttachment = null;
let deletedIds = loadDeletedIds();
let suppressSync = false;
let syncTimer = null;
let syncInFlight = false;
let activeRecognition = null;
let activeVoiceButton = null;
let profile = loadProfile();
let pendingProfilePhoto = profile.photo || '';
let periodPlans = loadPeriodPlans();
let appStateUpdatedAt = localStorage.getItem(stateUpdatedStorageKey()) || new Date(0).toISOString();
let currentPlanningView = 'week';
let planningAnchorDate = selectedDate;
let feedbackPhoto = null;
let pushSubscriptionActive = false;
let pushSubscriptionRegisteredAt = 0;
let pendingNotificationTaskId = '';
const defaultNotificationSettings = { exact: true, daily: true, dailyTime: '09:00', overdue: true };
function loadNotificationSettings() { try { return { ...defaultNotificationSettings, ...JSON.parse(localStorage.getItem(notificationStorageKey()) || '{}') }; } catch { return { ...defaultNotificationSettings }; } }
let notificationSettings = loadNotificationSettings();
let pinUnlocked = false;
let appHiddenAt = 0;
let latestAppVersion = APP_VERSION;
let latestUpdateNotes = ['Центр обновлений и ручная установка новой версии.'];
let updateInProgress = false;
let focusIndex = 0;
let focusTaskIds = [];
let focusRotateTimer = null;
let signUpBusy = false;
let signUpCooldownUntil = 0;
let sharedTasks = [];
let sharedPresence = new Map();
let currentSharedTab = 'tasks';
let sharedLoading = false;
let activeSharedInviteId = '';
let sharedPresenceBusy = false;

function loadTasks() {
  try {
    let current = localStorage.getItem(taskStorageKey());
    if (!current && migrateExistingAccount && window.DaySync?.user()) {
      current = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_KEY);
      if (current) localStorage.setItem(taskStorageKey(), current);
      localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(LEGACY_KEY);
    }
    const legacy = accountSuffix() === 'guest' ? localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_KEY) : null;
    const parsed = JSON.parse(current || legacy || 'null');
    if (Array.isArray(parsed)) return parsed.map(t => ({ autoCarry: false, reminder: '', notified: false, photo: null, attachment: null, photoCapturedAt: '', proofNote: '', repeat: 'none', subtasks: [], carryCount: 0, updatedAt: new Date(0).toISOString(), ...t }));
    return seedTasks();
  } catch { return seedTasks(); }
}

function loadDeletedIds() {
  try { return JSON.parse(localStorage.getItem(deletedStorageKey()) || '[]'); } catch { return []; }
}
function loadProfile() {
  try { return { name: '', photo: '', ...JSON.parse(localStorage.getItem(profileStorageKey()) || '{}') }; }
  catch { return { name: '', photo: '' }; }
}
function loadPeriodPlans() {
  try {
    const value = JSON.parse(localStorage.getItem(planStorageKey()) || '[]');
    if (!Array.isArray(value)) return [];
    return value.map(plan => {
      if (plan.plannedDate) return { ...plan, scope: 'all', anchorDate: plan.plannedDate };
      let anchorDate = plan.anchorDate;
      if (!anchorDate && plan.scope === 'week') anchorDate = plan.period;
      if (!anchorDate && plan.scope === 'month') anchorDate = `${plan.period}-01`;
      if (!anchorDate && plan.scope === 'year') anchorDate = `${plan.period}-01-01`;
      return { ...plan, scope: 'all', anchorDate: anchorDate || todayKey };
    });
  }
  catch { return []; }
}
function touchAppState() {
  appStateUpdatedAt = new Date().toISOString(); localStorage.setItem(stateUpdatedStorageKey(), appStateUpdatedAt); queueCloudSync();
}
function savePeriodPlans() {
  try { localStorage.setItem(planStorageKey(), JSON.stringify(periodPlans)); touchAppState(); return true; }
  catch { toast('Не удалось сохранить планы'); return false; }
}
function saveProfile() {
  try { localStorage.setItem(profileStorageKey(), JSON.stringify(profile)); touchAppState(); return true; }
  catch { toast('Не удалось сохранить фотографию. Выберите снимок меньшего размера'); return false; }
}
function profileDisplayName() {
  const emailName = window.DaySync?.user()?.email?.split('@')[0] || '';
  const value = (profile.name || emailName).trim(); return value ? value.charAt(0).toLocaleUpperCase('ru') + value.slice(1) : '';
}
function greetingText() {
  const hour = new Date().getHours(); return hour < 6 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';
}
function taskWord(count) { const n = Math.abs(count) % 100; const n1 = n % 10; return n > 10 && n < 20 ? 'задач' : n1 === 1 ? 'задача' : n1 > 1 && n1 < 5 ? 'задачи' : 'задач'; }

function switchAccountData() {
  tasks = loadTasks(); deletedIds = loadDeletedIds(); profile = loadProfile(); pendingProfilePhoto = profile.photo || ''; periodPlans = loadPeriodPlans(); appStateUpdatedAt = localStorage.getItem(stateUpdatedStorageKey()) || new Date(0).toISOString(); sharedTasks = []; runAutoCarry(); render(); refreshSyncUi(); renderProfile(); loadSharedTasks(false);
}

function seedTasks() {
  return [];
}

function save() {
  try { localStorage.setItem(taskStorageKey(), JSON.stringify(tasks)); if (!suppressSync) queueCloudSync(); return true; }
  catch { toast('Не хватает памяти. Удалите несколько больших вложений.'); return false; }
}

function runAutoCarry() {
  let changed = false;
  tasks.forEach(task => {
    if (!task.completed && task.autoCarry && task.date < todayKey) {
      task.carriedFrom = task.carriedFrom || task.date;
      const missedDays = Math.max(1, Math.round((fromKey(todayKey) - fromKey(task.date)) / 86400000));
      task.carryCount = (task.carryCount || 0) + missedDays;
      task.date = todayKey;
      task.updatedAt = new Date().toISOString();
      changed = true;
    }
  });
  if (changed) save();
}

function formatLong(key) { return fromKey(key).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }); }
function formatHeaderDate(key) { const text = fromKey(key).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); return text.charAt(0).toLocaleUpperCase('ru') + text.slice(1); }
function escapeHtml(value = '') { const d = document.createElement('div'); d.textContent = value; return d.innerHTML; }
const REPEAT_LABELS = { daily: 'Каждый день', weekdays: 'По будням', weekly: 'Каждую неделю', monthly: 'Каждый месяц' };
const FIXED_HOLIDAYS = { '01-01': 'Новый год', '01-02': 'Новогодние каникулы', '01-03': 'Новогодние каникулы', '01-04': 'Новогодние каникулы', '01-05': 'Новогодние каникулы', '01-06': 'Новогодние каникулы', '01-07': 'Рождество Христово', '01-08': 'Новогодние каникулы', '02-23': 'День защитника Отечества', '03-08': 'Международный женский день', '05-01': 'Праздник Весны и Труда', '05-09': 'День Победы', '06-12': 'День России', '11-04': 'День народного единства' };
const OFFICIAL_HOLIDAYS_2026 = (() => {
  const result = {}; const addRange = (start, end, name) => { const d = fromKey(start); const last = fromKey(end); while (d <= last) { result[toKey(d)] = name; d.setDate(d.getDate() + 1); } };
  addRange('2026-01-01', '2026-01-11', 'Новогодние каникулы'); addRange('2026-02-21', '2026-02-23', 'Праздничные выходные'); addRange('2026-03-07', '2026-03-09', 'Праздничные выходные'); addRange('2026-05-01', '2026-05-03', 'Праздник Весны и Труда'); addRange('2026-05-09', '2026-05-11', 'День Победы'); addRange('2026-06-12', '2026-06-14', 'День России'); result['2026-11-04'] = 'День народного единства'; result['2026-12-31'] = 'Официальный выходной'; return result;
})();
function holidayName(key) { return OFFICIAL_HOLIDAYS_2026[key] || FIXED_HOLIDAYS[key.slice(5)] || ''; }
function formatShortDate(key) { return fromKey(key).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }); }
function weekBounds(key) {
  const date = fromKey(key); const start = new Date(date); start.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  const end = new Date(start); end.setDate(start.getDate() + 6); return [toKey(start), toKey(end)];
}
function formatWeekRange(key) {
  const [startKey, endKey] = weekBounds(key); const start = fromKey(startKey); const end = fromKey(endKey);
  if (start.getMonth() === end.getMonth()) {
    const month = end.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }).replace(/^\d+\s*/, '');
    return `${start.getDate()}–${end.getDate()} ${month}`;
  }
  return `${start.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} — ${end.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`;
}
function periodBounds() {
  const d = fromKey(selectedDate);
  if (currentPeriod === 'day') return [selectedDate, selectedDate];
  if (currentPeriod === 'week') return weekBounds(selectedDate);
  if (currentPeriod === 'month') return [toKey(new Date(d.getFullYear(), d.getMonth(), 1)), toKey(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
  return [`${d.getFullYear()}-01-01`, `${d.getFullYear()}-12-31`];
}

function renderPeriod() {
  const strip = $('#weekStrip'); const overview = $('#calendarOverview');
  $$('.period-button').forEach(b => b.classList.toggle('active', b.dataset.period === currentPeriod));
  if (currentPeriod === 'day' || currentPeriod === 'week') {
    strip.hidden = false; overview.hidden = true; renderWeek();
  } else {
    strip.hidden = true; overview.hidden = false;
    if (currentPeriod === 'month') renderMonth(); else renderYear();
  }
}

function renderWeek() {
  const base = fromKey(selectedDate); const monday = new Date(base); monday.setDate(base.getDate() - ((base.getDay() + 6) % 7));
  const names = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  $('#weekStrip').innerHTML = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday); d.setDate(monday.getDate() + i); const key = toKey(d);
    const dayTasks = tasks.filter(t => t.date === key && !t.completed); const importantCount = dayTasks.filter(t => t.priority === 'high').length;
    const priorityText = importantCount ? `, важных задач: ${importantCount}` : ''; const holiday = holidayName(key); const weekend = [0, 6].includes(d.getDay());
    return `<button class="day-button ${key === selectedDate ? 'selected' : ''} ${dayTasks.length ? 'has-tasks' : ''} ${importantCount ? 'has-high-priority' : ''} ${weekend ? 'weekend' : ''} ${holiday ? 'holiday' : ''}" data-date="${key}" aria-label="${formatLong(key)}${holiday ? `, ${holiday}` : ''}${priorityText}" title="${holiday}"><em ${importantCount ? '' : 'hidden'} aria-hidden="true">!</em><span>${names[i]}</span><b>${d.getDate()}</b><i></i></button>`;
  }).join('');
  $$('.day-button').forEach(b => b.addEventListener('click', () => { selectedDate = b.dataset.date; if (currentPeriod === 'day') render(); else { renderPeriod(); renderStats(); } }));
}

function renderMonth() {
  const anchor = fromKey(selectedDate); const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(first); start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const heads = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(x => `<div class="month-grid-head">${x}</div>`).join('');
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start); d.setDate(start.getDate() + i); const key = toKey(d); const count = tasks.filter(t => t.date === key && !t.completed).length; const holiday = holidayName(key); const weekend = [0, 6].includes(d.getDay());
    return `<button class="month-day ${d.getMonth() !== anchor.getMonth() ? 'outside' : ''} ${key === selectedDate ? 'selected' : ''} ${weekend ? 'weekend' : ''} ${holiday ? 'holiday' : ''}" data-month-date="${key}" title="${holiday}" aria-label="${formatLong(key)}${holiday ? `, ${holiday}` : ''}"><b>${d.getDate()}</b>${holiday ? '<em>праздник</em>' : count ? `<small>${count} дел</small>` : ''}</button>`;
  }).join('');
  $('#calendarOverview').innerHTML = `<div class="month-grid">${heads}${days}</div>`;
  $$('[data-month-date]').forEach(b => b.addEventListener('click', () => { selectedDate = b.dataset.monthDate; currentPeriod = 'day'; render(); }));
}

function renderYear() {
  const year = fromKey(selectedDate).getFullYear();
  $('#calendarOverview').innerHTML = `<div class="year-grid">${Array.from({ length: 12 }, (_, month) => {
    const count = tasks.filter(t => { const d = fromKey(t.date); return d.getFullYear() === year && d.getMonth() === month && !t.completed; }).length;
    const name = new Date(year, month, 1).toLocaleDateString('ru-RU', { month: 'long' });
    return `<button class="year-month" data-month="${month}"><strong>${name[0].toUpperCase() + name.slice(1)}</strong><span><b>${count}</b> активных дел</span></button>`;
  }).join('')}</div>`;
  $$('[data-month]').forEach(b => b.addEventListener('click', () => { selectedDate = toKey(new Date(year, Number(b.dataset.month), 1)); currentPeriod = 'month'; render(); }));
}

function visibleTasks() {
  let result; const [start, end] = periodBounds();
  if (searchQuery) result = tasks;
  else if (currentView === 'upcoming') result = tasks.filter(t => t.date >= todayKey && !t.completed);
  else if (currentView === 'completed') result = tasks.filter(t => t.completed);
  else result = tasks.filter(t => t.date >= start && t.date <= end);
  if (searchQuery) result = result.filter(t => `${t.title} ${t.note || ''} ${t.proofNote || ''} ${t.attachment?.name || ''} ${(t.subtasks || []).map(s => s.title).join(' ')}`.toLocaleLowerCase('ru').includes(searchQuery));
  const priorityOrder = { high: 0, normal: 1, low: 2 };
  return result.sort((a, b) => {
    if (searchQuery) return (b.date + (b.time || '99:99')).localeCompare(a.date + (a.time || '99:99'));
    const completedLast = currentView === 'today' && currentPeriod === 'day' ? Number(a.completed) - Number(b.completed) : 0;
    return completedLast || (a.date + (a.time || '99:99')).localeCompare(b.date + (b.time || '99:99')) || (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1);
  });
}

function renderTasks() {
  const list = visibleTasks();
  $('#taskList').innerHTML = list.map(t => {
    const subDone = (t.subtasks || []).filter(s => s.done).length;
    const carryLabel = t.carryCount ? `Переносилась ${t.carryCount} ${t.carryCount === 1 ? 'день' : t.carryCount < 5 ? 'дня' : 'дней'}` : 'Автоперенос';
    return `<article class="task priority-${t.priority || 'normal'} ${t.completed ? 'completed' : ''}" data-task-id="${t.id}">
    <input class="check" type="checkbox" data-check="${t.id}" ${t.completed ? 'checked' : ''} aria-label="Отметить задачу ${escapeHtml(t.title)} выполненной">
    <div class="task-main"><div class="task-title">${escapeHtml(t.title)}</div><div class="task-meta">
      <span>${currentPeriod !== 'day' || currentView !== 'today' ? formatShortDate(t.date) + ' · ' : ''}${t.time || 'В течение дня'}</span>
      ${t.autoCarry ? `<span class="tag carry">↻ ${carryLabel}</span>` : ''}${t.photo ? '<span class="photo-chip">📷 фотоотчёт</span>' : ''}
      ${t.repeat && t.repeat !== 'none' ? `<span class="tag repeat">⟳ ${REPEAT_LABELS[t.repeat]}</span>` : ''}
      ${(t.subtasks || []).length ? `<span class="tag checklist">☑ ${subDone}/${t.subtasks.length}</span>` : ''}
      ${t.attachment || t.photo ? '<span class="tag">📎 вложение</span>' : ''}
      ${t.priority === 'high' ? '<span class="priority-label high">Важно</span>' : t.priority === 'low' ? '<span class="priority-label low">Можно позже</span>' : ''}
    </div>${(t.subtasks || []).length ? `<div class="subtask-list">${t.subtasks.map((s, i) => `<button type="button" class="subtask ${s.done ? 'done' : ''}" data-subtask="${t.id}" data-sub-index="${i}"><i>${s.done ? '✓' : ''}</i>${escapeHtml(s.title)}</button>`).join('')}</div>` : ''}</div><button class="more-button" data-edit="${t.id}" aria-label="Редактировать ${escapeHtml(t.title)}">•••</button></article>`;
  }).join('');
  $('#emptyState').hidden = list.length > 0;
  $('#emptyStateTitle').textContent = searchQuery ? 'Ничего не найдено' : 'На этот день задач нет';
  $('#emptyStateText').textContent = searchQuery ? 'Проверьте написание или введите другое слово. Поиск выполняется по всему архиву.' : 'Оставьте время для себя или добавьте новое дело.';
  $('#emptyAddButton').hidden = !!searchQuery;
  $$('[data-check]').forEach(el => el.addEventListener('change', () => toggleTask(el.dataset.check)));
  $$('[data-edit]').forEach(el => el.addEventListener('click', () => openDialog(el.dataset.edit)));
  $$('[data-subtask]').forEach(el => el.addEventListener('click', () => toggleSubtask(el.dataset.subtask, Number(el.dataset.subIndex))));
  enableTaskGestures();
}

function renderStats() {
  const day = tasks.filter(t => t.date === selectedDate); const done = day.filter(t => t.completed).length; const planned = day.length - done;
  const percent = day.length ? Math.round(done / day.length * 100) : 0;
  $('#doneCount').textContent = done; $('#plannedCount').textContent = planned; $('#progressPercent').textContent = `${percent}%`;
  $('#progressRing').style.setProperty('--p', percent); $('#progressCaption').textContent = percent === 100 ? 'Отличный день!' : percent > 0 ? 'Так держать' : 'Начните с малого';
  renderFocusCard(day);
  const periodList = visibleTasks(); const periodDone = periodList.filter(t => t.completed).length;
  $('#taskSummary').textContent = periodList.length ? `${periodDone} из ${periodList.length} выполнено` : 'Пока всё свободно';
}

function renderFocusCard(day) {
  const urgent = day.filter(t => !t.completed && t.priority === 'high');
  const ids = urgent.map(t => t.id).join(',');
  const listChanged = ids !== focusTaskIds.join(',');
  focusTaskIds = urgent.map(t => t.id);
  if (listChanged) {
    if (focusIndex >= urgent.length) focusIndex = 0;
    clearInterval(focusRotateTimer);
    if (urgent.length > 1) focusRotateTimer = setInterval(() => { focusIndex = (focusIndex + 1) % focusTaskIds.length; paintFocusCard(); }, 5000);
  }
  paintFocusCard(urgent, day);
}
function paintFocusCard(urgentParam, dayParam) {
  const day = dayParam || tasks.filter(t => t.date === selectedDate);
  const urgent = urgentParam || day.filter(t => !t.completed && t.priority === 'high');
  const card = $('#focusCard');
  card.classList.add('focus-fade'); setTimeout(() => card.classList.remove('focus-fade'), 320);
  if (urgent.length) {
    if (focusIndex >= urgent.length) focusIndex = 0;
    const focus = urgent[focusIndex];
    $('#focusTitle').textContent = focus.title;
    $('#focusMeta').textContent = focus.time ? `В ${focus.time}` : focus.autoCarry ? 'Переносится до выполнения' : 'В удобное время';
    $('#focusIllustration').textContent = urgent.length > 1 ? `${focusIndex + 1}/${urgent.length}` : '★';
    card.dataset.focusTask = focus.id; card.classList.toggle('has-task', true);
  } else {
    const hasOpen = day.some(t => !t.completed);
    $('#focusTitle').textContent = hasOpen ? 'Срочных дел нет' : 'Все дела завершены';
    $('#focusMeta').textContent = hasOpen ? 'Важные задачи не отмечены — остальные дела ждут своей очереди' : 'Можно спокойно отдохнуть';
    $('#focusIllustration').textContent = hasOpen ? '—' : '✓';
    delete card.dataset.focusTask; card.classList.toggle('has-task', false);
  }
}

function renderHeader() {
  const d = fromKey(selectedDate); const [start, end] = periodBounds();
  const periodLabel = currentPeriod === 'day' ? formatLong(selectedDate) : currentPeriod === 'week' ? `${fromKey(start).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} — ${fromKey(end).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}` : currentPeriod === 'month' ? d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }) : String(d.getFullYear());
  $('#weekOverviewLabel').textContent = formatWeekRange(selectedDate);
  $('#weekOverviewButton').hidden = currentView !== 'today' || currentPeriod !== 'day';
  $('#dateEyebrow').textContent = periodLabel;
  if (searchQuery) { $('#pageTitle').textContent = 'Поиск по ежедневнику'; $('#pageSubtitle').textContent = 'Ищем в активных, выполненных и архивных задачах.'; $('#listTitle').textContent = `Результаты поиска: ${visibleTasks().length}`; }
  else if (currentView === 'upcoming') { $('#pageTitle').textContent = 'Предстоящие дела'; $('#pageSubtitle').textContent = 'Всё важное — в одном списке.'; $('#listTitle').textContent = 'Ближайшие задачи'; }
  else if (currentView === 'completed') { $('#pageTitle').textContent = 'Выполнено'; $('#pageSubtitle').textContent = 'Приятно видеть результат.'; $('#listTitle').textContent = 'Готовые задачи'; }
  else {
    const titles = { day: 'План на день', week: 'План на неделю', month: 'План на месяц', year: 'План на год' };
    const name = profileDisplayName(); const openCount = tasks.filter(t => t.date === selectedDate && !t.completed).length;
    $('#pageTitle').textContent = currentPeriod === 'day' ? `${greetingText()}${name ? `, ${name}` : ''}!` : titles[currentPeriod];
    $('#pageSubtitle').textContent = currentPeriod === 'day' ? `${formatHeaderDate(selectedDate)} · осталось ${openCount} ${taskWord(openCount)}` : 'Незавершённые дела не потеряются.';
    $('#listTitle').textContent = currentPeriod === 'day' ? (selectedDate === todayKey ? 'Задачи на сегодня' : `Задачи на ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`) : `Задачи: ${periodLabel}`;
  }
}

function renderProfile() {
  const name = profileDisplayName(); const initial = (name || 'Я').charAt(0).toLocaleUpperCase('ru');
  if (!$('#profileInitial')) $('#profileButton').innerHTML = '<span id="profileInitial">Я</span><img id="profileAvatarImage" alt="" hidden>';
  $('#profileInitial').textContent = initial; const previewInitial = $('#profilePreviewInitial'); if (previewInitial) previewInitial.textContent = initial;
  const avatar = $('#profileAvatarImage'); avatar.hidden = !profile.photo; if (profile.photo) avatar.src = profile.photo; else avatar.removeAttribute('src');
  $('#profileInitial').hidden = !!profile.photo;
  const preview = $('#profilePreviewImage'); if (preview) { preview.hidden = !pendingProfilePhoto; if (pendingProfilePhoto) preview.src = pendingProfilePhoto; else preview.removeAttribute('src'); }
  if (previewInitial) previewInitial.hidden = !!pendingProfilePhoto; const remove = $('#removeProfilePhoto'); if (remove) remove.hidden = !pendingProfilePhoto;
  $('#profileButton').title = name ? `Профиль: ${name}` : 'Настроить личный профиль';
}
function renderConnectionState() {
  const avatar = $('#profileButton'); if (!avatar) return;
  const online = navigator.onLine;
  avatar.classList.toggle('connection-online', online);
  avatar.classList.toggle('connection-offline', !online);
  avatar.setAttribute('aria-label', `Открыть профиль — ${online ? 'в сети' : 'нет соединения'}`);
}
function openProfile() {
  pendingProfilePhoto = profile.photo || ''; $('#profileName').value = profile.name || '';
  renderProfile(); $('#profileDialog').showModal();
}
function prepareProfilePhoto(file) {
  if (!file?.type?.startsWith('image/')) { toast('Выберите фотографию'); return; }
  const image = new Image(); const url = URL.createObjectURL(file);
  image.onload = () => {
    const size = 512; const scale = Math.max(size / image.width, size / image.height); const width = size / scale; const height = size / scale;
    const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
    canvas.getContext('2d').drawImage(image, (image.width - width) / 2, (image.height - height) / 2, width, height, 0, 0, size, size);
    pendingProfilePhoto = canvas.toDataURL('image/jpeg', .78); URL.revokeObjectURL(url); renderProfile();
  };
  image.onerror = () => { URL.revokeObjectURL(url); toast('Не удалось прочитать фотографию'); }; image.src = url;
}
function saveProfileForm(event) {
  event.preventDefault(); profile = { name: $('#profileName').value.trim(), photo: pendingProfilePhoto };
  if (!saveProfile()) return; renderProfile(); renderHeader(); $('#profileDialog').close(); toast('Профиль сохранён');
}

function render() { renderHeader(); renderPeriod(); renderTasks(); renderStats(); renderMiniTasks(); }
function syncNav() { $$('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === currentView)); }
function nextRepeatDate(task) {
  const date = fromKey(task.date);
  if (task.repeat === 'daily') date.setDate(date.getDate() + 1);
  else if (task.repeat === 'weekdays') { do { date.setDate(date.getDate() + 1); } while ([0, 6].includes(date.getDay())); }
  else if (task.repeat === 'weekly') date.setDate(date.getDate() + 7);
  else if (task.repeat === 'monthly') date.setMonth(date.getMonth() + 1);
  return toKey(date);
}
function createNextRepeat(task) {
  if (!task.repeat || task.repeat === 'none') return null;
  const nextDate = nextRepeatDate(task);
  const source = task.recurrenceSource || task.id;
  if (tasks.some(t => t.recurrenceSource === source && t.date === nextDate)) return null;
  const clone = { ...task, id: crypto.randomUUID(), date: nextDate, completed: false, notified: false, carriedFrom: '', carryCount: 0, recurrenceSource: source, subtasks: (task.subtasks || []).map(s => ({ title: s.title, done: false })), photo: null, attachment: null, photoCapturedAt: '', proofNote: '', updatedAt: new Date().toISOString() };
  if (task.reminder) { const old = new Date(task.reminder); const base = fromKey(task.date); const next = fromKey(nextDate); old.setDate(old.getDate() + Math.round((next - base) / 86400000)); clone.reminder = `${toKey(old)}T${pad(old.getHours())}:${pad(old.getMinutes())}`; }
  tasks.push(clone);
  return clone.id;
}
function toggleTask(id) {
  const task = tasks.find(t => t.id === id); if (!task) return;
  const wasCompleted = task.completed; task.completed = !task.completed; task.updatedAt = new Date().toISOString();
  const createdRepeatId = task.completed ? createNextRepeat(task) : null;
  save(); render();
  toast(task.completed ? 'Задача выполнена' : 'Задача возвращена', task.completed ? 'Отменить' : '', () => { task.completed = wasCompleted; if (createdRepeatId) tasks = tasks.filter(t => t.id !== createdRepeatId); task.updatedAt = new Date().toISOString(); save(); render(); });
}
function toggleSubtask(id, index) {
  const task = tasks.find(t => t.id === id); if (!task?.subtasks?.[index]) return;
  task.subtasks[index].done = !task.subtasks[index].done; task.updatedAt = new Date().toISOString(); save(); render();
}
function enableTaskGestures() {
  $$('.task').forEach(row => {
    let startX = 0; let startY = 0;
    row.addEventListener('touchstart', e => { startX = e.touches[0].clientX; startY = e.touches[0].clientY; }, { passive: true });
    row.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - startX; const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      if (dx > 0) toggleTask(row.dataset.taskId); else openDialog(row.dataset.taskId);
    }, { passive: true });
  });
}

function parseQuickTask(text) {
  let title = text.trim(); let date = selectedDate < todayKey ? todayKey : selectedDate; let time = '';
  const base = fromKey(todayKey);
  if (/\bпослезавтра\b/i.test(title)) { base.setDate(base.getDate() + 2); date = toKey(base); title = title.replace(/\bпослезавтра\b/ig, ''); }
  else if (/\bзавтра\b/i.test(title)) { base.setDate(base.getDate() + 1); date = toKey(base); title = title.replace(/\bзавтра\b/ig, ''); }
  else if (/\bсегодня\b/i.test(title)) { date = todayKey; title = title.replace(/\bсегодня\b/ig, ''); }
  const months = { января: 0, февраля: 1, марта: 2, апреля: 3, мая: 4, июня: 5, июля: 6, августа: 7, сентября: 8, октября: 9, ноября: 10, декабря: 11 };
  const dateMatch = title.match(/(?:\bна|\bдо)?\s*(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4}))?/i);
  if (dateMatch) {
    let year = Number(dateMatch[3]) || base.getFullYear(); const month = months[dateMatch[2].toLocaleLowerCase('ru')];
    if (!dateMatch[3] && new Date(year, month, Number(dateMatch[1])) < fromKey(todayKey)) year += 1;
    date = toKey(new Date(year, month, Number(dateMatch[1]))); title = title.replace(dateMatch[0], '');
  }
  const timeMatch = title.match(/(?:\bв\s*)?([01]?\d|2[0-3])(?::|\.)([0-5]\d)\b|\bв\s+([01]?\d|2[0-3])\s*(?:час(?:а|ов)?)?\b/i);
  if (timeMatch) { time = `${pad(Number(timeMatch[1] || timeMatch[3]))}:${timeMatch[2] || '00'}`; title = title.replace(timeMatch[0], ''); }
  return { title: title.replace(/\s{2,}/g, ' ').replace(/^[,.;\s]+|[,.;\s]+$/g, '') || text.trim(), date, time };
}
function addQuickTask(title) {
  const lines = title.split(/\r?\n/).map(line => line.trim().replace(/^[-•\d.)\s]+/, '')).filter(Boolean); if (!lines.length) return;
  lines.forEach(clean => { const parsed = parseQuickTask(clean); tasks.push({ id: crypto.randomUUID(), ...parsed, priority: 'normal', note: '', completed: false, autoCarry: true, reminder: '', notified: false, photo: null, attachment: null, photoCapturedAt: '', proofNote: '', repeat: 'none', subtasks: [], carryCount: 0, updatedAt: new Date().toISOString() }); });
  save(); $('#quickInput').value = ''; render(); toast(lines.length > 1 ? `Добавлено дел: ${lines.length}` : 'Дело добавлено с автопереносом');
}

function setTaskType(type = 'personal', locked = false) {
  const shared = type === 'shared';
  $('#taskSource').value = shared ? 'shared' : 'personal';
  $('#sharedTaskFields').hidden = !shared;
  $$('[data-task-type]').forEach(button => { button.classList.toggle('active', button.dataset.taskType === type); button.disabled = locked; });
}
function openDialog(id = null, source = 'personal') {
  const task = source === 'shared' ? sharedTasks.find(t => t.id === id) : tasks.find(t => t.id === id); $('#taskForm').reset(); pendingPhoto = task?.photo || null;
  pendingAttachment = task?.attachment || (task?.photo ? { name: 'Фотоотчёт.jpg', type: 'image/jpeg', data: task.photo, size: 0 } : null);
  $('#taskId').value = task?.id || ''; $('#dialogTitle').textContent = task ? 'Редактировать задачу' : 'Новая задача';
  setTaskType(source, !!task);
  $('#sharedEmails').value = source === 'shared' ? [...(task?.acceptedEmails || []), ...(task?.invitedEmails || [])].filter(email => email !== task?.ownerEmail).join('\n') : '';
  $('#sharedTaskStatus').value = task?.status || 'open';
  const ownsSharedTask = source !== 'shared' || !task || task.ownerId === window.DaySync?.user()?.id;
  $('#sharedEmails').disabled = !ownsSharedTask;
  renderSharedTaskPresence(task);
  $('#taskTitle').value = task?.title || ''; $('#taskDate').value = task?.date || selectedDate; $('#taskTime').value = task?.time || '';
  $('#taskTimeMode').value = task?.time ? 'exact' : 'anytime'; updateTimeMode();
  $('#taskPriority').value = task?.priority || 'normal'; $('#taskNote').value = task?.note || '';
  $('#taskAutoCarry').checked = task?.autoCarry || false; $('#taskReminder').value = task?.reminder || ''; $('#taskRepeat').value = task?.repeat || 'none';
  $('#taskSubtasks').value = (task?.subtasks || []).map(s => s.title).join('\n'); $('#taskProofNote').value = task?.proofNote || ''; $('#deleteTask').hidden = !task || (source === 'shared' && task.ownerId !== window.DaySync?.user()?.id);
  renderPhotoPreview(); $('#taskDialog').showModal(); setTimeout(() => $('#taskTitle').focus(), 50);
}
function closeDialog() { $('#taskDialog').close(); }
function updateTimeMode() {
  const exact = $('#taskTimeMode').value === 'exact';
  $('#taskTime').hidden = !exact; $('#taskTime').required = exact;
  if (!exact) $('#taskTime').value = '';
}
async function handleSubmit(event) {
  event.preventDefault(); const id = $('#taskId').value;
  const source = $('#taskSource').value; const existing = source === 'shared' ? sharedTasks.find(t => t.id === id) : tasks.find(t => t.id === id); const previousSubtasks = existing?.subtasks || [];
  const subtasks = $('#taskSubtasks').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean).map(title => ({ title, done: previousSubtasks.find(s => s.title === title)?.done || false, doneBy: previousSubtasks.find(s => s.title === title)?.doneBy || '', doneAt: previousSubtasks.find(s => s.title === title)?.doneAt || '' }));
  const attachmentChanged = pendingAttachment?.data !== existing?.attachment?.data && pendingAttachment?.data !== existing?.photo;
  const reminder = $('#taskReminder').value;
  const data = { title: $('#taskTitle').value.trim(), date: $('#taskDate').value, time: $('#taskTimeMode').value === 'exact' ? $('#taskTime').value : '', priority: $('#taskPriority').value, note: $('#taskNote').value.trim(), autoCarry: $('#taskAutoCarry').checked, reminder, reminderUtc: reminder ? new Date(reminder).toISOString() : '', repeat: $('#taskRepeat').value, subtasks, proofNote: $('#taskProofNote').value.trim(), notified: false, photo: pendingPhoto, attachment: pendingAttachment, photoCapturedAt: pendingAttachment && attachmentChanged ? new Date().toISOString() : existing?.photoCapturedAt || '', updatedAt: new Date().toISOString() };
  if (!data.title) return;
  if (source === 'shared') {
    const account = window.DaySync?.user();
    if (!account) { closeDialog(); toast('Сначала войдите в аккаунт'); openSyncDialog(); return; }
    const requestedEmails = parseSharedEmails($('#sharedEmails').value).filter(email => email !== account.email?.toLocaleLowerCase());
    if (!existing && !requestedEmails.length) { toast('Укажите почту хотя бы одного участника'); return; }
    const isOwner = !existing || existing.ownerId === account.id;
    const accepted = isOwner ? (existing?.acceptedEmails || []).filter(email => requestedEmails.includes(email)) : (existing?.acceptedEmails || []);
    const invited = isOwner ? requestedEmails.filter(email => !accepted.includes(email)) : (existing?.invitedEmails || []);
    const sharedTask = {
      ...(existing || {}),
      id: existing?.id || crypto.randomUUID(),
      ...data,
      ownerId: existing?.ownerId || account.id,
      ownerEmail: existing?.ownerEmail || account.email?.toLocaleLowerCase(),
      invitedEmails: invited,
      acceptedEmails: accepted,
      status: $('#sharedTaskStatus').value,
      completed: $('#sharedTaskStatus').value === 'completed',
      activity: [...(existing?.activity || []), { type: existing ? 'updated' : 'created', email: account.email, at: data.updatedAt }].slice(-30)
    };
    try {
      await window.DaySync.saveSharedTask(sharedTask);
      selectedDate = data.date; closeDialog(); await loadSharedTasks(false); renderSharedDialog();
      toast(existing ? 'Совместная задача обновлена' : 'Приглашения отправлены в ежедневник');
    } catch (error) { toast(sharedErrorText(error)); }
    return;
  }
  if (id) Object.assign(existing, data);
  else tasks.push({ id: crypto.randomUUID(), ...data, completed: false, carryCount: 0 });
  if (!save()) return; selectedDate = data.date; closeDialog(); render(); toast(id ? 'Изменения сохранены' : 'Задача добавлена');
}
async function deleteCurrent() {
  const id = $('#taskId').value; if (!id) return;
  if ($('#taskSource').value === 'shared') {
    const task = sharedTasks.find(item => item.id === id);
    if (task?.ownerId !== window.DaySync?.user()?.id) { toast('Удалить общую задачу может только организатор'); return; }
    try { await window.DaySync.deleteSharedTask(id); closeDialog(); await loadSharedTasks(false); renderSharedDialog(); toast('Совместная задача удалена'); } catch (error) { toast(sharedErrorText(error)); }
    return;
  }
  tasks = tasks.filter(t => t.id !== id); if (!deletedIds.includes(id)) deletedIds.push(id); localStorage.setItem(deletedStorageKey(), JSON.stringify(deletedIds)); save(); closeDialog(); render(); toast('Задача удалена');
}

async function prepareAttachment(file) {
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) { toast('Файл слишком большой. Максимальный размер — 4 МБ'); return; }
  if (file.type?.startsWith('image/')) {
    const url = URL.createObjectURL(file); const image = new Image();
    image.onload = () => {
      const max = 1280; const scale = Math.min(1, max / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height); const data = canvas.toDataURL('image/jpeg', .76);
      pendingPhoto = data; pendingAttachment = { name: file.name || 'Фото.jpg', type: 'image/jpeg', data, size: file.size };
      URL.revokeObjectURL(url); renderPhotoPreview(); toast('Фотография прикреплена');
    };
    image.onerror = () => { URL.revokeObjectURL(url); toast('Не удалось прочитать фотографию'); };
    image.src = url; return;
  }
  const reader = new FileReader();
  reader.onload = () => { pendingPhoto = null; pendingAttachment = { name: file.name || 'Документ', type: file.type || 'application/octet-stream', data: reader.result, size: file.size }; renderPhotoPreview(); toast('Документ прикреплён'); };
  reader.onerror = () => toast('Не удалось прочитать документ'); reader.readAsDataURL(file);
}
function renderPhotoPreview() {
  const attachment = pendingAttachment || (pendingPhoto ? { name: 'Фотоотчёт.jpg', type: 'image/jpeg', data: pendingPhoto, size: 0 } : null);
  $('#photoPreview').hidden = !attachment;
  const imagePreview = $('#photoPreviewImage'); const fileIcon = $('#attachmentFileIcon');
  if (attachment) {
    const isImage = attachment.type?.startsWith('image/'); imagePreview.hidden = !isImage; fileIcon.hidden = isImage;
    if (isImage) imagePreview.src = attachment.data; else imagePreview.removeAttribute('src');
    $('#attachmentName').textContent = attachment.name || (isImage ? 'Фотография' : 'Документ');
    const task = tasks.find(t => t.id === $('#taskId').value); const size = attachment.size ? ` · ${Math.max(1, Math.round(attachment.size / 1024))} КБ` : '';
    $('#photoMeta').textContent = (task?.photoCapturedAt ? `Добавлено ${new Date(task.photoCapturedAt).toLocaleString('ru-RU')}` : 'Новое вложение') + size;
    $('#attachmentOpen').href = attachment.data; $('#attachmentOpen').download = attachment.name || 'Вложение';
  } else {
    imagePreview.hidden = true; fileIcon.hidden = true; imagePreview.removeAttribute('src'); $('#attachmentName').textContent = ''; $('#photoMeta').textContent = ''; $('#attachmentOpen').removeAttribute('href');
  }
}

function resetVoiceButton() {
  activeRecognition = null;
  const button = activeVoiceButton || $('#voiceButton'); activeVoiceButton = null;
  if (!button) return; button.classList.remove('listening'); button.textContent = '🎙'; button.title = 'Голосовой ввод';
}
function voiceFallback(targetId, message) {
  const target = $('#' + targetId); setTimeout(() => { target?.focus(); toast(message || 'Нажмите микрофон на клавиатуре и продиктуйте текст'); }, 120);
}
function applyVoiceText(targetId, text, parseTask) {
  const target = $('#' + targetId); if (!target) return;
  if (parseTask) {
    const parsed = parseQuickTask(text); target.value = parsed.title; $('#taskDate').value = parsed.date;
    $('#taskTimeMode').value = parsed.time ? 'exact' : 'anytime'; updateTimeMode(); if (parsed.time) $('#taskTime').value = parsed.time;
  } else if (targetId === 'taskSubtasks') target.value = [target.value.trim(), text].filter(Boolean).join('\n');
  else target.value = [target.value.trim(), text].filter(Boolean).join(target.value.trim() ? ' ' : '');
  target.focus();
}
async function startVoiceForField(targetId, buttonId, options = {}) {
  if (activeRecognition) return;
  if (options.openTask) { openDialog(); $('#dialogTitle').textContent = 'Новая задача голосом'; $('#taskAutoCarry').checked = true; }
  const target = $('#' + targetId); if (!target) { toast('Поле для голосового ввода не найдено'); return; } target.focus();
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { voiceFallback(targetId, 'Нажмите микрофон на клавиатуре телефона и продиктуйте текст'); return; }
  if (!isSecureContext) { toast('Микрофон работает только в установленном приложении или через HTTPS'); return; }
  try {
    const recognition = new Recognition(); activeRecognition = recognition; activeVoiceButton = $('#' + buttonId);
    recognition.lang = 'ru-RU'; recognition.interimResults = false; recognition.continuous = false; recognition.maxAlternatives = 1;
    activeVoiceButton?.classList.add('listening'); if (activeVoiceButton) { activeVoiceButton.textContent = '●'; activeVoiceButton.title = 'Слушаю…'; }
    recognition.onstart = () => toast(options.prompt || 'Слушаю… Говорите');
    recognition.onresult = e => {
      const text = [...e.results].map(result => result[0].transcript).join(' ').trim();
      if (text) { applyVoiceText(targetId, text, !!options.parseTask); toast(options.success || 'Текст добавлен'); }
      else toast('Речь не распознана. Попробуйте ещё раз');
    };
    recognition.onerror = e => {
      const messages = { 'not-allowed': 'Разрешите доступ к микрофону в настройках браузера', 'service-not-allowed': 'Браузер запретил службу распознавания речи', 'audio-capture': 'Микрофон не найден или занят другим приложением', 'no-speech': 'Речь не услышана. Нажмите микрофон и повторите', network: 'Нет связи со службой распознавания речи' };
      toast(messages[e.error] || 'Не удалось распознать речь. Попробуйте ещё раз');
    };
    recognition.onend = () => { if (activeRecognition === recognition) resetVoiceButton(); }; recognition.start();
  } catch (error) {
    resetVoiceButton(); if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') toast('Разрешите приложению доступ к микрофону'); else toast('Не удалось включить микрофон');
  }
}
function startVoiceInput() { return startVoiceForField('taskTitle', 'voiceButton', { openTask: true, parseTask: true, prompt: 'Слушаю… Назовите задачу, дату и время', success: 'Задача распознана. Проверьте и сохраните' }); }
function stopVoiceInput() {
  if (!activeRecognition) return;
  try { activeRecognition.stop(); } catch {}
}
function bindHoldToTalk(buttonId, starter) {
  const button = $('#' + buttonId); if (!button) return;
  let holding = false;
  const start = event => {
    if (event.type === 'keydown' && ![' ', 'Enter'].includes(event.key)) return;
    if (event.type === 'keydown' && event.repeat) return;
    event.preventDefault(); holding = true;
    if (event.pointerId != null) { try { button.setPointerCapture(event.pointerId); } catch {} }
    starter();
  };
  const stop = event => {
    if (!holding) return;
    if (event.type === 'keyup' && ![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault(); holding = false; stopVoiceInput();
  };
  button.addEventListener('pointerdown', start);
  button.addEventListener('pointerup', stop);
  button.addEventListener('pointercancel', stop);
  button.addEventListener('lostpointercapture', stop);
  button.addEventListener('keydown', start);
  button.addEventListener('keyup', stop);
  button.addEventListener('contextmenu', event => event.preventDefault());
  button.title = 'Удерживайте, пока говорите';
}

function renderMiniTasks() {
  const today = tasks.filter(t => t.date === todayKey && !t.completed).sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  $('#miniTaskList').innerHTML = today.length ? today.map(t => `<label class="mini-task"><input class="check" type="checkbox" data-mini-check="${t.id}"><div><strong>${escapeHtml(t.title)}</strong><small>${t.time || 'В течение дня'}${t.reminder ? ' · 🔔 ' + new Date(t.reminder).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''}</small></div></label>`).join('') : '<div class="empty-state"><div class="empty-icon">✓</div><h3>На сегодня всё</h3></div>';
  $$('[data-mini-check]').forEach(el => el.addEventListener('change', () => toggleTask(el.dataset.miniCheck)));
  $('#enableNotifications').hidden = !('Notification' in window) || Notification.permission === 'granted';
}

function periodKeyForPlanDate(view, dateKey) {
  if (view === 'week') return weekBounds(dateKey)[0];
  if (view === 'month') return dateKey.slice(0, 7);
  return dateKey.slice(0, 4);
}
function planningPeriodKey(view = currentPlanningView, anchor = planningAnchorDate) { return periodKeyForPlanDate(view, anchor); }
function planningPeriodLabel(view = currentPlanningView) {
  const d = fromKey(planningAnchorDate);
  if (view === 'week') return formatWeekRange(planningAnchorDate);
  if (view === 'month') return d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  return `${d.getFullYear()} год`;
}
function movePlanningPeriod(direction) {
  const d = fromKey(planningAnchorDate);
  if (currentPlanningView === 'week') d.setDate(d.getDate() + direction * 7);
  else if (currentPlanningView === 'month') d.setMonth(d.getMonth() + direction);
  else if (currentPlanningView === 'year') d.setFullYear(d.getFullYear() + direction);
  planningAnchorDate = toKey(d); $('#planDate').value = ''; renderPlanningDialog();
}
function renderPlanningDialog() {
  $$('.planning-tab').forEach(button => button.classList.toggle('active', button.dataset.planningView === currentPlanningView));
  const today = currentPlanningView === 'today'; $('#todayPlanningPanel').hidden = !today; $('#longPlanningPanel').hidden = today;
  if (today) { renderMiniTasks(); return; }
  const names = { week: 'Планы на неделю', month: 'Планы на месяц', year: 'Планы на год' };
  $('#planPeriodTitle').textContent = names[currentPlanningView]; $('#planPeriodLabel').textContent = planningPeriodLabel();
  $('#planDate').removeAttribute('min'); $('#planDate').removeAttribute('max');
  const key = planningPeriodKey();
  const list = periodPlans.filter(plan => periodKeyForPlanDate(currentPlanningView, plan.plannedDate || plan.anchorDate || todayKey) === key).sort((a, b) => (a.plannedDate || a.anchorDate || '9999-12-31').localeCompare(b.plannedDate || b.anchorDate || '9999-12-31') || a.createdAt.localeCompare(b.createdAt));
  $('#periodPlanList').innerHTML = list.length ? list.map(plan => `<article class="period-plan"><span>•</span><div class="period-plan-content"><p>${escapeHtml(plan.text)}</p>${plan.plannedDate ? `<time datetime="${plan.plannedDate}">До ${fromKey(plan.plannedDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</time>` : '<time>Без точной даты · этот период</time>'}</div><button type="button" data-delete-plan="${plan.id}" aria-label="Удалить план">×</button></article>`).join('') : '<div class="plan-empty">На этот период планов пока нет. Добавьте первый пункт или перейдите стрелками к другому периоду.</div>';
  $$('[data-delete-plan]').forEach(button => button.addEventListener('click', () => { periodPlans = periodPlans.filter(plan => plan.id !== button.dataset.deletePlan); savePeriodPlans(); renderPlanningDialog(); }));
}
function addPeriodPlans(event) {
  event.preventDefault(); if (!event.currentTarget.reportValidity()) return; const items = $('#planInput').value.split(/\n+/).map(text => text.trim()).filter(Boolean); if (!items.length) return;
  const plannedDate = $('#planDate').value || ''; const targetDate = plannedDate || planningAnchorDate; items.forEach(text => periodPlans.push({ id: crypto.randomUUID(), scope: 'all', anchorDate: targetDate, text, plannedDate, createdAt: new Date().toISOString() }));
  if (!savePeriodPlans()) return; if (plannedDate) planningAnchorDate = plannedDate; $('#planInput').value = ''; $('#planDate').value = ''; renderPlanningDialog(); $('#planInput').focus(); toast(items.length === 1 ? 'План добавлен — можно записать следующий' : `Добавлено планов: ${items.length}`);
}

function urlBase64ToUint8Array(value = '') {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64); return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
}
async function ensurePushSubscription(forceSave = false) {
  if (!window.DaySync?.user() || !window.DaySync?.savePushSubscription || !('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'granted') {
    pushSubscriptionActive = false; return false;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const publicKey = window.SUPABASE_CONFIG?.vapidPublicKey;
      if (!publicKey) throw new Error('Push key is missing');
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      forceSave = true;
    }
    if (forceSave || Date.now() - pushSubscriptionRegisteredAt > 10 * 60 * 1000) {
      await window.DaySync.savePushSubscription(subscription, document.documentElement.lang || 'ru', notificationSettings);
      pushSubscriptionRegisteredAt = Date.now();
    }
    pushSubscriptionActive = true; return true;
  } catch {
    pushSubscriptionActive = false; return false;
  }
}
function showReminderAlert(taskId, title, text) {
  pendingNotificationTaskId = taskId || '';
  $('#reminderAlertTitle').textContent = title || 'Пора выполнить задачу';
  $('#reminderAlertText').textContent = text || '';
  $('#reminderAlert').hidden = false;
}
function hideReminderAlert() { $('#reminderAlert').hidden = true; pendingNotificationTaskId = ''; }
function openNotificationTask(taskId = pendingNotificationTaskId) {
  hideReminderAlert(); if (!taskId) return;
  const personal = tasks.find(task => task.id === taskId);
  const shared = sharedTasks.find(task => task.id === taskId);
  if (personal) { selectedDate = personal.date; render(); openDialog(taskId, 'personal'); }
  else if (shared) { selectedDate = shared.date; openDialog(taskId, 'shared'); }
  else toast('Задача уже выполнена или удалена');
}
async function enableNotifications() {
  if (!('Notification' in window)) { toast('Уведомления не поддерживаются'); return; }
  const permission = await Notification.requestPermission(); renderMiniTasks(); renderNotificationSettings();
  if (permission === 'granted') {
    const pushReady = await ensurePushSubscription(true);
    toast(pushReady ? 'Фоновые уведомления включены' : 'Уведомления включены. Для фоновых напоминаний войдите в аккаунт');
    await showAppNotification('День — уведомления включены', { body: 'Напоминания будут приходить на это устройство.', tag: 'notification-enabled', requireInteraction: true });
  }
  else toast('Уведомления не разрешены. Разрешите их в настройках устройства.');
}
async function showAppNotification(title, options = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const taskId = options.data?.taskId || '';
  const payload = { icon: 'assets/icon-192.png', badge: 'assets/icon-192.png', requireInteraction: true, silent: false, vibrate: [220, 90, 220, 90, 320], data: { url: taskId ? `./?openTask=${encodeURIComponent(taskId)}` : './', ...(options.data || {}) }, ...options };
  try { const registration = await navigator.serviceWorker?.ready; if (registration) await registration.showNotification(title, payload); else new Notification(title, payload); return true; } catch { return false; }
}
function notificationStampKey(type) { return `day-notification-${type}:${accountSuffix()}:${todayKey}`; }
function updateAppBadge() {
  const count = tasks.filter(task => !task.completed && task.date <= todayKey).length;
  if (navigator.setAppBadge) { if (count) navigator.setAppBadge(count).catch(() => {}); else navigator.clearAppBadge?.().catch(() => {}); }
}
async function checkReminders() {
  const now = new Date(); updateAppBadge();
  const due = tasks.filter(t => !t.completed && t.reminder && !t.notified && new Date(t.reminder) <= now);
  for (const task of due) {
    task.notified = true;
    task.updatedAt = new Date().toISOString();
    if (notificationSettings.exact) {
      showReminderAlert(task.id, 'Пора выполнить задачу', task.title);
      await showAppNotification('День — пора выполнить задачу', { body: task.title, tag: `task-${task.id}`, data: { taskId: task.id } });
    }
  }
  if (due.length) { save(); if (notificationSettings.exact && $('#reminderDialog').open === false) toast(`Напоминание: ${due[0].title}`); }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const minutesNow = now.getHours() * 60 + now.getMinutes(); const [dailyHour, dailyMinute] = notificationSettings.dailyTime.split(':').map(Number); const dailyAt = dailyHour * 60 + dailyMinute;
  const todayTasks = tasks.filter(task => !task.completed && task.date === todayKey).sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  if (notificationSettings.daily && todayTasks.length && minutesNow >= dailyAt && !localStorage.getItem(notificationStampKey('daily'))) {
    const preview = todayTasks.slice(0, 3).map(task => task.title).join(' · '); await showAppNotification(`Сегодня дел: ${todayTasks.length}`, { body: preview, tag: `daily-${todayKey}` }); localStorage.setItem(notificationStampKey('daily'), '1');
  }
  const overdue = tasks.filter(task => !task.completed && task.date < todayKey);
  if (notificationSettings.overdue && overdue.length && !localStorage.getItem(notificationStampKey('overdue'))) {
    await showAppNotification(`Остались незавершённые дела: ${overdue.length}`, { body: overdue.slice(0, 3).map(task => task.title).join(' · '), tag: `overdue-${todayKey}` }); localStorage.setItem(notificationStampKey('overdue'), '1');
  }
}

function renderNotificationSettings() {
  notificationSettings = loadNotificationSettings(); $('#notifyExact').checked = notificationSettings.exact; $('#notifyDaily').checked = notificationSettings.daily; $('#notifyDailyTime').value = notificationSettings.dailyTime; $('#notifyOverdue').checked = notificationSettings.overdue;
  const state = $('#notificationPermissionState'); const supported = 'Notification' in window; const permission = supported ? Notification.permission : 'unsupported';
  state.className = `permission-state ${permission === 'granted' ? 'allowed' : permission === 'denied' ? 'blocked' : ''}`;
  state.textContent = permission === 'granted' ? (pushSubscriptionActive ? '✓ Фоновые push-уведомления подключены на этом устройстве.' : '✓ Системные уведомления разрешены. Войдите в аккаунт для работы при закрытом приложении.') : permission === 'denied' ? 'Уведомления заблокированы. Разрешите их в настройках браузера или телефона.' : supported ? 'Сначала разрешите приложению показывать уведомления.' : 'Это устройство или браузер не поддерживает системные уведомления.';
}
async function openNotificationDialog() { $('#updateDialog').close(); renderNotificationSettings(); $('#notificationDialog').showModal(); if ('Notification' in window && Notification.permission === 'default') await enableNotifications(); }
async function saveNotificationSettings(event) { event.preventDefault(); notificationSettings = { exact: $('#notifyExact').checked, daily: $('#notifyDaily').checked, dailyTime: $('#notifyDailyTime').value || '09:00', overdue: $('#notifyOverdue').checked }; localStorage.setItem(notificationStorageKey(), JSON.stringify(notificationSettings)); await ensurePushSubscription(true); $('#notificationDialog').close(); checkReminders(); toast('Настройки уведомлений сохранены на этом устройстве'); }
async function testNotification() { if (!('Notification' in window) || Notification.permission !== 'granted') { await enableNotifications(); return; } const shown = await showAppNotification('Проверка — День', { body: 'Уведомления работают правильно.', tag: 'notification-test' }); toast(shown ? 'Проверочное уведомление отправлено' : 'Не удалось показать уведомление'); }

function resetFeedbackForm() { $('#feedbackForm').reset(); const accountEmail = window.DaySync?.user()?.email || ''; $('#feedbackReplyEmail').value = accountEmail; feedbackPhoto = null; $('#feedbackFile').hidden = true; $('#feedbackFileName').textContent = ''; }
async function chooseFeedbackPhoto(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Выберите фотографию или изображение'); return; }
  if (file.size > 10 * 1024 * 1024) { toast('Фото слишком большое. Максимум 10 МБ'); return; }
  const url = URL.createObjectURL(file); const image = new Image();
  try {
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
    const max = 1600; const scale = Math.min(1, max / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .78));
    if (!blob) throw new Error('Не удалось подготовить фото');
    const baseName = (file.name || 'Фото проблемы').replace(/\.[^.]+$/, '');
    feedbackPhoto = new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
    $('#feedbackFileName').textContent = `${feedbackPhoto.name} · ${Math.max(1, Math.round(blob.size / 1024))} КБ`;
    $('#feedbackFile').hidden = false; toast('Фото подготовлено к отправке');
  } catch { toast('Не удалось прочитать фотографию'); }
  finally { URL.revokeObjectURL(url); }
}
function feedbackMessage(text, replyEmail) { const accountEmail = window.DaySync?.user()?.email || 'не выполнен вход'; return `Обратная связь по приложению «День»\nВерсия: ${APP_VERSION}\nАккаунт: ${accountEmail}\nEmail для ответа: ${replyEmail}\nУстройство: ${navigator.userAgent}\n\n${text}`; }
async function submitFeedback(event) {
  event.preventDefault();
  const accountEmail = window.DaySync?.user()?.email || '';
  if (!accountEmail) { $('#feedbackDialog').close(); toast('Сначала войдите в свой аккаунт'); openSyncDialog(); return; }
  const textValue = $('#feedbackText').value.trim();
  if (!textValue) return;
  const button = $('#feedbackSubmitButton');
  button.disabled = true; button.textContent = 'Отправляем…';
  try {
    const data = new FormData();
    data.append('email', accountEmail);
    data.append('Отправитель', accountEmail);
    data.append('Версия приложения', APP_VERSION);
    data.append('Текст обращения', textValue);
    data.append('_subject', `Обратная связь — День, версия ${APP_VERSION}`);
    data.append('_template', 'table');
    data.append('_captcha', 'false');
    if (feedbackPhoto) data.append('attachment', feedbackPhoto, feedbackPhoto.name || 'photo.jpg');
    const response = await fetch('https://formsubmit.co/ajax/75397e76b5b257f37da54b02fc3f7c85', { method: 'POST', headers: { Accept: 'application/json' }, body: data });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success === false) throw new Error(result.message || 'Ошибка отправки');
    $('#feedbackDialog').close(); resetFeedbackForm(); toast(`Сообщение отправлено. Ответ придёт на ${accountEmail}`);
  } catch {
    toast('Не удалось отправить. Проверьте интернет и попробуйте ещё раз.');
  } finally {
    button.disabled = false; button.textContent = 'Отправить разработчику';
  }
}

function movePeriod(direction) {
  const d = fromKey(selectedDate);
  if (currentPeriod === 'day') d.setDate(d.getDate() + direction);
  else if (currentPeriod === 'week') d.setDate(d.getDate() + direction * 7);
  else if (currentPeriod === 'month') d.setMonth(d.getMonth() + direction);
  else d.setFullYear(d.getFullYear() + direction);
  selectedDate = toKey(d); render();
}
function toast(message, actionLabel = '', action = null) {
  const el = $('#toast'); const button = $('#toastAction'); $('#toastText').textContent = message;
  button.hidden = !actionLabel; button.textContent = actionLabel; button.onclick = action ? () => { action(); el.classList.remove('show'); } : null;
  el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), actionLabel ? 5000 : 2400);
}

function setSyncStatus(status, title, text) {
  $('#syncStateTitle').textContent = title; $('#syncStateText').textContent = text;
}
function refreshSyncUi() {
  const user = window.DaySync?.user();
  $('#syncAuthForm').hidden = !!user; $('#syncConnected').hidden = !user; $('#syncRecoveryCodeForm').hidden = true; $('#syncResetForm').hidden = true;
  $('#pinRemoveButton').hidden = !user || !localStorage.getItem(pinStorageKey());
  const avatar = $('#profileButton');
  if (user) {
    setSyncStatus('connected', 'Личный аккаунт подключён', user.email || 'Облачная синхронизация активна');
    $('#accountEntryButton').classList.add('connected'); $('#accountEntryText').textContent = 'Аккаунт ✓'; $('#accountEntryButton').title = user.email || 'Личный аккаунт'; avatar.title = user.email || 'Личный аккаунт';
  }
  else {
    setSyncStatus('', 'Не подключено', 'Каждый человек входит со своей почтой и видит только свои задачи.');
    $('#accountEntryButton').classList.remove('connected'); $('#accountEntryText').textContent = 'Войти'; $('#accountEntryButton').title = 'Войти или зарегистрироваться'; avatar.title = 'Личный профиль';
  }
}
function preparePinField(input) {
  input.value = input.value.replace(/\D/g, '').slice(0, 4);
}
function openSyncDialog() {
  if ($('#profileDialog').open) $('#profileDialog').close();
  refreshSyncUi(); $('#pinSetupInput').value = ''; $('#syncDialog').showModal();
  setTimeout(() => { if (!$('#syncConnected').hidden) $('#pinSetupInput').focus(); }, 50);
}
function queueCloudSync() {
  if (!window.DaySync?.user()) return;
  clearTimeout(syncTimer); syncTimer = setTimeout(() => performSync(false), 900);
}
async function performSync(showMessage = true) {
  if (!window.DaySync?.user()) { if (showMessage) toast('Сначала войдите в облако'); return; }
  if (syncInFlight) return;
  syncInFlight = true;
  setSyncStatus('syncing', 'Синхронизация…', 'Обмениваемся изменениями с облаком');
  try {
    const result = await window.DaySync.sync(tasks, deletedIds, { profile, periodPlans, updatedAt: appStateUpdatedAt });
    tasks = result.tasks || []; deletedIds = []; localStorage.setItem(deletedStorageKey(), '[]');
    const remoteState = result.appState;
    if (remoteState && new Date(remoteState.updatedAt || 0) > new Date(appStateUpdatedAt || 0)) {
      profile = { name: '', photo: '', ...(remoteState.profile || {}) };
      periodPlans = Array.isArray(remoteState.periodPlans) ? remoteState.periodPlans : [];
      pendingProfilePhoto = profile.photo || '';
      appStateUpdatedAt = remoteState.updatedAt;
      localStorage.setItem(profileStorageKey(), JSON.stringify(profile));
      localStorage.setItem(planStorageKey(), JSON.stringify(periodPlans));
      localStorage.setItem(stateUpdatedStorageKey(), appStateUpdatedAt);
    }
    suppressSync = true; save(); suppressSync = false; render(); renderProfile(); await loadSharedTasks(false); await refreshSharedPresence(); await ensurePushSubscription(false);
    if ($('#sharedDialog')?.open) renderSharedDialog();
    setSyncStatus('connected', 'Синхронизировано', `Задач в облаке: ${tasks.length}`);
    if (showMessage) toast('Данные синхронизированы');
  } catch (error) {
    suppressSync = false; setSyncStatus('error', 'Ошибка синхронизации', error.message); if (showMessage) toast(error.message);
  } finally { syncInFlight = false; }
}
async function handleSyncLogin(event) {
  event.preventDefault(); const email = $('#syncEmail').value.trim(); const password = $('#syncPassword').value;
  setSyncStatus('syncing', 'Выполняется вход…', email);
  try {
    await window.DaySync.signIn(email, password); markPinUnlocked(); $('#syncPassword').value = ''; switchAccountData(); await performSync();
    if ($('#syncDialog').open) $('#syncDialog').close();
    renderSharedInvitePrompt();
  }
  catch (error) { setSyncStatus('error', 'Не удалось войти', error.message); }
}
async function handleSyncSignUp() {
  const form = $('#syncAuthForm'); if (!form.reportValidity()) return;
  const button = $('#syncSignUp');
  const waitSeconds = Math.ceil((signUpCooldownUntil - Date.now()) / 1000);
  if (signUpBusy || waitSeconds > 0) {
    setSyncStatus('', 'Запрос уже отправлен', `Подождите ${Math.max(1, waitSeconds)} сек. и проверьте письмо. Повторно нажимать регистрацию не нужно.`);
    return;
  }
  const email = $('#syncEmail').value.trim(); const password = $('#syncPassword').value;
  signUpBusy = true; button.disabled = true; button.textContent = 'Отправляем…';
  setSyncStatus('syncing', 'Создаём аккаунт…', email);
  try {
    const result = await window.DaySync.signUp(email, password); $('#syncPassword').value = '';
    signUpCooldownUntil = Date.now() + 35000;
    if (result.access_token) {
      markPinUnlocked(); switchAccountData(); await performSync();
      if ($('#syncDialog').open) $('#syncDialog').close();
      renderSharedInvitePrompt();
    }
    else setSyncStatus('connected', 'Регистрация создана', 'Проверьте почту и откройте самое новое письмо подтверждения. После подтверждения нажмите «Войти».');
  } catch (error) {
    const limited = error.status === 429 || /35 seconds|security purposes|rate limit/i.test(error.message);
    const exists = /already registered|already exists|user_already_exists/i.test(error.message);
    if (limited) {
      signUpCooldownUntil = Date.now() + Math.max(35000, (error.retryAfter || 0) * 1000);
      setSyncStatus('', 'Запрос уже отправлен', 'Сервер получил регистрацию. Подождите 35 секунд, проверьте почту и не нажимайте кнопку несколько раз подряд.');
    } else if (exists) setSyncStatus('', 'Email уже зарегистрирован', 'Нажмите «Войти» или воспользуйтесь восстановлением пароля.');
    else setSyncStatus('error', 'Не удалось зарегистрироваться', error.message);
  } finally {
    signUpBusy = false;
    const restoreButton = () => {
      const remaining = Math.ceil((signUpCooldownUntil - Date.now()) / 1000);
      if (remaining > 0) {
        button.disabled = true; button.textContent = `Подождите ${remaining} с`;
        setTimeout(restoreButton, 1000);
      } else { button.disabled = false; button.textContent = 'Регистрация'; }
    };
    restoreButton();
  }
}
async function handleForgotPassword() {
  const email = $('#syncEmail').value.trim();
  if (!email || !$('#syncEmail').checkValidity()) { $('#syncEmail').reportValidity(); return; }
  await sendRecoveryCode(email);
}
async function sendRecoveryCode(email) {
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) { setSyncStatus('error', 'Введите email', 'Укажите почту, на которую зарегистрирован ежедневник.'); return; }
  setSyncStatus('syncing', 'Отправляем письмо…', email);
  try {
    await window.DaySync.resetPassword(email); localStorage.setItem('day-password-recovery-email', email);
    $('#syncRecoveryEmail').value = email; $('#syncAuthForm').hidden = true; $('#syncConnected').hidden = true; $('#syncResetForm').hidden = true; $('#syncRecoveryCodeForm').hidden = false;
    setSyncStatus('', 'Письмо отправлено', 'Откройте только самое новое письмо. Нажмите в нём Reset password; старые письма уже недействительны.');
    toast('Новое письмо восстановления отправлено');
  }
  catch (error) { setSyncStatus('error', 'Не удалось отправить письмо', error.message); }
}
async function handleVerifyRecoveryCode(event) {
  event.preventDefault(); const email = $('#syncRecoveryEmail').value.trim(); const token = $('#syncRecoveryCode').value.trim().replace(/\s/g, '');
  setSyncStatus('syncing', 'Проверяем код…', email);
  try {
    await window.DaySync.verifyRecoveryCode(email, token); $('#syncRecoveryCode').value = ''; $('#syncRecoveryCodeForm').hidden = true; $('#syncResetForm').hidden = false;
    setSyncStatus('connected', 'Код подтверждён', 'Теперь придумайте новый пароль. Старый пароль не нужен.'); setTimeout(() => $('#syncNewPassword').focus(), 50);
  } catch (error) { setSyncStatus('error', 'Код не подошёл', 'Введите код из самого нового письма или отправьте новый код.'); }
}
function showLoginForm() {
  $('#syncRecoveryCodeForm').hidden = true; $('#syncResetForm').hidden = true; $('#syncConnected').hidden = true; $('#syncAuthForm').hidden = false;
  const email = $('#syncRecoveryEmail').value.trim(); if (email) $('#syncEmail').value = email;
  setSyncStatus('', 'Вход в аккаунт', 'Введите email и пароль или запросите код восстановления.');
}
async function handleResetPassword(event) {
  event.preventDefault(); const password = $('#syncNewPassword').value; const confirm = $('#syncNewPasswordConfirm').value;
  if (password !== confirm) { setSyncStatus('error', 'Пароли не совпадают', 'Введите одинаковый пароль в двух полях.'); return; }
  try {
    await window.DaySync.updatePassword(password); markPinUnlocked(); history.replaceState(null, '', location.pathname);
    $('#syncNewPassword').value = ''; $('#syncNewPasswordConfirm').value = ''; localStorage.removeItem('day-password-recovery-email'); switchAccountData(); await performSync(false); toast('Новый пароль сохранён');
  } catch (error) { setSyncStatus('error', 'Не удалось сменить пароль', error.message); }
}
async function hashPin(pin) {
  const bytes = new TextEncoder().encode(`${accountSuffix()}:${pin}`); const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
function markPinUnlocked() { pinUnlocked = true; localStorage.setItem(pinUnlockedAtStorageKey(), String(Date.now())); }
function pinUnlockStillValid() { const unlockedAt = Number(localStorage.getItem(pinUnlockedAtStorageKey()) || 0); return unlockedAt > 0 && Date.now() - unlockedAt < PIN_RELOCK_MS; }
async function savePin() {
  const pin = $('#pinSetupInput').value.trim(); if (!/^\d{4}$/.test(pin)) { toast('Введите ровно четыре цифры'); return; }
  localStorage.setItem(pinStorageKey(), await hashPin(pin)); $('#pinSetupInput').value = ''; markPinUnlocked(); refreshSyncUi(); if ($('#syncDialog').open) { $('#syncDialog').close(); await new Promise(resolve => setTimeout(resolve, 80)); } toast('PIN установлен. Повторный запрос — не раньше чем через 30 минут.');
}
function removePin() { localStorage.removeItem(pinStorageKey()); localStorage.removeItem(pinUnlockedAtStorageKey()); $('#pinSetupInput').value = ''; pinUnlocked = true; refreshSyncUi(); toast('PIN удалён'); }
async function maybeLockApp() {
  if (!window.DaySync?.user() || !localStorage.getItem(pinStorageKey()) || $('#pinDialog').open) return;
  if (pinUnlocked || pinUnlockStillValid()) { pinUnlocked = true; return; }
  $('#pinUnlockInput').value = ''; $('#pinError').textContent = ''; $('#pinDialog').showModal(); setTimeout(() => $('#pinUnlockInput').focus(), 50);
}
async function unlockWithPin(event) {
  event.preventDefault(); const entered = await hashPin($('#pinUnlockInput').value);
  if (entered !== localStorage.getItem(pinStorageKey())) { $('#pinError').textContent = 'Неверный PIN. Попробуйте ещё раз.'; $('#pinUnlockInput').select(); return; }
  markPinUnlocked(); $('#pinDialog').close(); performSync(false);
}
async function useAccountPassword() {
  $('#pinDialog').close(); save(); await window.DaySync.signOut(); pinUnlocked = false; switchAccountData(); $('#syncDialog').showModal();
}
async function handleSyncLogout() { save(); await window.DaySync.signOut(); pinUnlocked = false; switchAccountData(); toast('Вы вышли. Личные задачи этого аккаунта скрыты.'); }

function compareAppVersions(left, right) {
  const a = String(left).split('.').map(Number); const b = String(right).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) { const difference = (a[i] || 0) - (b[i] || 0); if (difference) return difference; }
  return 0;
}
function refreshUpdateIndicator() {
  const available = compareAppVersions(latestAppVersion, APP_VERSION) > 0;
  $('#updateBadge').hidden = !available;
  $('#updateButton').setAttribute('aria-label', available ? 'Обновления — доступна новая версия' : 'Обновления');
}
function showUpdatePromptIfNeeded() {
  const available = compareAppVersions(latestAppVersion, APP_VERSION) > 0;
  if (!available) { $('#updatePrompt').hidden = true; return; }
  $('#updatePromptTitle').textContent = 'Доступно обновление';
  $('#updatePromptText').textContent = `Версия ${latestAppVersion} готова к установке`;
  $('#promptApplyUpdate').hidden = false;
  $('#updatePrompt').hidden = false;
  clearTimeout(showUpdatePromptIfNeeded.timer);
  showUpdatePromptIfNeeded.timer = setTimeout(() => { $('#updatePrompt').hidden = true; }, 10000);
}
function showUpdatedNoticeIfNeeded() {
  const applied = localStorage.getItem(UPDATE_APPLIED_KEY);
  if (applied !== APP_VERSION) return;
  localStorage.removeItem(UPDATE_APPLIED_KEY);
  $('#updatePromptTitle').textContent = 'Приложение обновлено';
  $('#updatePromptText').textContent = `Установлена версия ${APP_VERSION}`;
  $('#promptApplyUpdate').hidden = true;
  $('#updatePrompt').hidden = false;
  setTimeout(() => { if ($('#promptApplyUpdate').hidden) $('#updatePrompt').hidden = true; }, 3200);
}
function renderUpdateCenter() {
  const available = compareAppVersions(latestAppVersion, APP_VERSION) > 0;
  $('#latestVersionLabel').textContent = latestAppVersion;
  $('#updateStatusTitle').textContent = available ? 'Доступно новое обновление' : 'Установлена последняя версия';
  $('#updateStatusText').textContent = available ? `Версия ${latestAppVersion} готова к установке` : 'Новых обновлений нет';
  $('#updateNotes').innerHTML = latestUpdateNotes.map(note => `<li>${escapeHtml(note)}</li>`).join('');
  $('#applyUpdateButton').hidden = !available;
  $('#applyUpdateButton').disabled = !available;
  $('#applyUpdateButton').textContent = 'Установить обновление';
}
async function checkForAppUpdate(showFeedback = false, autoInstall = false) {
  try {
    await new Promise((resolve, reject) => {
      $('#appVersionCheck')?.remove(); const script = document.createElement('script'); script.id = 'appVersionCheck'; script.src = `version.js?check=${Date.now()}`; script.onload = resolve; script.onerror = () => reject(new Error('Не удалось проверить версию')); document.head.append(script);
    });
    const release = window.DAY_APP_RELEASE || {}; latestAppVersion = String(release.version || APP_VERSION); latestUpdateNotes = Array.isArray(release.notes) && release.notes.length ? release.notes : latestUpdateNotes;
    refreshUpdateIndicator(); renderUpdateCenter();
    const available = compareAppVersions(latestAppVersion, APP_VERSION) > 0;
    if (autoInstall && available) { await applyAppUpdate(true); return; }
    if (showFeedback) toast(compareAppVersions(latestAppVersion, APP_VERSION) > 0 ? `Доступна версия ${latestAppVersion}` : 'Установлена последняя версия');
  } catch { if (showFeedback) toast('Не удалось проверить обновление. Проверьте интернет.'); }
}
async function applyAppUpdate(automatic = false) {
  if (updateInProgress) return;
  updateInProgress = true;
  const button = $('#applyUpdateButton'); button.disabled = true; button.textContent = automatic ? 'Обновляем автоматически…' : 'Обновляем…';
  localStorage.setItem(UPDATE_SEEN_KEY, latestAppVersion); refreshUpdateIndicator();
  try {
    localStorage.setItem(UPDATE_APPLIED_KEY, latestAppVersion);
    const registration = await navigator.serviceWorker?.getRegistration(); if (registration) await registration.update();
    const url = new URL('./', location.href); url.searchParams.set('v', latestAppVersion); url.searchParams.set('updated', Date.now()); location.replace(url.href);
  } catch {
    updateInProgress = false; localStorage.removeItem(UPDATE_APPLIED_KEY); button.disabled = false; button.textContent = 'Повторить обновление';
    showUpdatePromptIfNeeded(); toast('Автообновление не завершилось. Нажмите «Обновить» в меню.');
  }
}
async function applyPromptedUpdate() {
  $('#updatePrompt').hidden = true;
  const available = compareAppVersions(latestAppVersion, APP_VERSION) > 0;
  localStorage.setItem(UPDATE_SEEN_KEY, latestAppVersion);
  refreshUpdateIndicator();
  if (available) { await applyAppUpdate(); return; }
  toast('Приложение обновлено');
}

function parseSharedEmails(value = '') {
  return [...new Set(value.split(/[\s,;]+/).map(email => email.trim().toLocaleLowerCase()).filter(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
}
function sharedErrorText(error) {
  const message = error?.message || '';
  if (/shared_tasks|answer_shared_invite|404|schema cache/i.test(message)) return 'Раздел совместных задач ещё настраивается. Обновите приложение через минуту';
  if (/row-level|policy|403/i.test(message)) return 'Нет доступа к этой совместной задаче';
  return message || 'Не удалось синхронизировать совместные задачи';
}
function currentAccountEmail() { return (window.DaySync?.user()?.email || '').toLocaleLowerCase(); }
function sharedInvites() {
  const email = currentAccountEmail();
  return sharedTasks.filter(task => (task.invitedEmails || []).includes(email) && !(task.acceptedEmails || []).includes(email));
}
function acceptedSharedTasks() {
  const account = window.DaySync?.user(); const email = currentAccountEmail();
  return sharedTasks.filter(task => task.ownerId === account?.id || (task.acceptedEmails || []).includes(email));
}
function sharedMembers(task) {
  const entries = [
    { email: task.ownerEmail, role: 'Организатор', state: 'accepted' },
    ...(task.acceptedEmails || []).map(email => ({ email, role: 'Участник', state: 'accepted' })),
    ...(task.invitedEmails || []).map(email => ({ email, role: 'Приглашён', state: 'invited' }))
  ];
  return [...new Map(entries.filter(item => item.email).map(item => [item.email, item])).values()];
}
function isMemberOnline(email = '') {
  const normalizedEmail = email.toLocaleLowerCase();
  if (normalizedEmail && normalizedEmail === currentAccountEmail() && navigator.onLine && document.visibilityState === 'visible') return true;
  const lastSeen = sharedPresence.get(normalizedEmail);
  return !!lastSeen && Date.now() - new Date(lastSeen).getTime() < 90 * 1000;
}
function renderSharedTaskPresence(task) {
  const container = $('#sharedTaskPresence'); if (!container) return;
  if (!task) { container.hidden = true; container.innerHTML = ''; return; }
  const members = sharedMembers(task);
  container.innerHTML = members.map(member => {
    const online = isMemberOnline(member.email);
    return `<span class="presence-person ${online ? 'online' : 'offline'}"><i class="presence-dot"></i>${escapeHtml(member.email === currentAccountEmail() ? 'Вы' : member.email.split('@')[0])} · ${online ? 'в сети' : 'не в сети'}</span>`;
  }).join('');
  container.hidden = !members.length;
}
async function refreshSharedPresence() {
  if (sharedPresenceBusy) return;
  if (!window.DaySync?.user() || !window.DaySync?.touchPresence || !window.DaySync?.loadSharedPresence) {
    sharedPresence = new Map(); return;
  }
  sharedPresenceBusy = true;
  try {
    await window.DaySync.touchPresence(document.documentElement.lang || 'ru');
    const rows = await window.DaySync.loadSharedPresence();
    sharedPresence = new Map((rows || []).map(row => [String(row.email || '').toLocaleLowerCase(), row.last_seen]));
    sharedPresence.set(currentAccountEmail(), new Date().toISOString());
    if ($('#sharedDialog')?.open) renderSharedDialog();
    const openedSharedTaskId = $('#taskSource')?.value === 'shared' ? $('#taskId')?.value : '';
    if ($('#taskDialog')?.open && openedSharedTaskId) renderSharedTaskPresence(sharedTasks.find(task => task.id === openedSharedTaskId));
  } catch {
    if (currentAccountEmail() && navigator.onLine && document.visibilityState === 'visible') sharedPresence.set(currentAccountEmail(), new Date().toISOString());
  } finally {
    sharedPresenceBusy = false;
  }
}
function memberInitial(email = '') { return (email.split('@')[0] || '?').charAt(0).toLocaleUpperCase('ru'); }
function sharedProgress(task) {
  const subtasks = task.subtasks || [];
  if (subtasks.length) return Math.round(subtasks.filter(item => item.done).length / subtasks.length * 100);
  return task.status === 'completed' ? 100 : task.status === 'review' ? 75 : 0;
}
function renderSharedBadges() {
  const count = sharedInvites().length;
  ['#desktopSharedBadge', '#mobileSharedBadge'].forEach(selector => { const badge = $(selector); if (!badge) return; badge.hidden = !count; badge.textContent = count > 9 ? '9+' : count; });
  const inviteCount = $('#sharedInviteCount'); if (inviteCount) { inviteCount.hidden = !count; inviteCount.textContent = count; }
}
function sharedInviteShortDescription(task) {
  const note = String(task.note || task.proofNote || '').trim();
  if (note) return note.length > 120 ? `${note.slice(0, 117)}…` : note;
  const subtasks = (task.subtasks || []).map(item => item.title).filter(Boolean);
  if (subtasks.length) return `Подзадачи: ${subtasks.slice(0, 2).join(', ')}${subtasks.length > 2 ? ` и ещё ${subtasks.length - 2}` : ''}`;
  return `${formatShortDate(task.date)} · ${task.time || 'без точного времени'}`;
}
function renderSharedInvitePrompt() {
  const prompt = $('#sharedInvitePrompt');
  if (!prompt) return;
  const task = sharedInvites()[0];
  if (!window.DaySync?.user() || !task) { prompt.hidden = true; activeSharedInviteId = ''; return; }
  activeSharedInviteId = task.id;
  $('#sharedInvitePromptTitle').textContent = task.title || 'Новая совместная задача';
  $('#sharedInvitePromptDescription').textContent = sharedInviteShortDescription(task);
  $('#sharedInvitePromptOwner').textContent = `Приглашает: ${task.ownerEmail || 'организатор'}`;
  $('#sharedInvitePromptAccept').disabled = false; $('#sharedInvitePromptDecline').disabled = false;
  prompt.hidden = false;
}
async function answerSharedInvitePrompt(accepted) {
  if (!activeSharedInviteId) return;
  const acceptButton = $('#sharedInvitePromptAccept'); const declineButton = $('#sharedInvitePromptDecline');
  acceptButton.disabled = true; declineButton.disabled = true;
  try {
    await window.DaySync.answerSharedInvite(activeSharedInviteId, accepted);
    await loadSharedTasks(false);
    if ($('#sharedDialog')?.open) renderSharedDialog();
    toast(accepted ? 'Совместная задача принята' : 'Приглашение отклонено');
  } catch (error) { acceptButton.disabled = false; declineButton.disabled = false; toast(sharedErrorText(error)); }
}
async function loadSharedTasks(showErrors = false) {
  if (!window.DaySync?.user() || !window.DaySync?.loadSharedTasks || sharedLoading) { renderSharedBadges(); return sharedTasks; }
  sharedLoading = true;
  try {
    const previousInvites = new Map(sharedInvites().map(task => [task.id, task.inviteReminderAt || '']));
    sharedTasks = await window.DaySync.loadSharedTasks();
    const newInvites = sharedInvites().filter(task => !previousInvites.has(task.id) || previousInvites.get(task.id) !== (task.inviteReminderAt || ''));
    renderSharedBadges();
    renderSharedInvitePrompt();
    if (newInvites.length && Notification.permission === 'granted') showAppNotification('Новое приглашение', { body: newInvites[0].title, tag: `shared-${newInvites[0].id}` });
  } catch (error) { if (showErrors) toast(sharedErrorText(error)); }
  finally { sharedLoading = false; }
  return sharedTasks;
}
function renderSharedSummary() {
  const active = acceptedSharedTasks(); const done = active.filter(task => task.status === 'completed').length;
  const percent = active.length ? Math.round(done / active.length * 100) : 0;
  $('#sharedSummary').innerHTML = `<div class="shared-overall-ring" style="--p:${percent}"><span>${percent}%</span></div><div><strong>${done} из ${active.length} совместных задач завершено</strong><small>${sharedInvites().length ? `Ожидают ответа приглашения: ${sharedInvites().length}` : 'Все новые приглашения обработаны'} · изменения видны участникам автоматически</small></div>`;
}
function sharedStatusLabel(task) {
  return task.status === 'completed' ? '<span class="done">✓ Завершено</span>' : task.status === 'review' ? '<span class="review">◷ На проверке</span>' : '<span>В работе</span>';
}
function renderSharedTaskCard(task) {
  const members = sharedMembers(task); const progress = sharedProgress(task);
  const canRepeatInvite = task.ownerId === window.DaySync?.user()?.id && (task.invitedEmails || []).length > 0;
  return `<article class="shared-task-card">
    <button type="button" class="shared-card-open" data-open-shared="${task.id}"><div><h3>${escapeHtml(task.title)}</h3><p>${formatShortDate(task.date)} · ${task.time || 'В течение дня'} · прогресс ${progress}%</p>
    <div class="shared-card-tags">${sharedStatusLabel(task)}<span>☑ ${(task.subtasks || []).filter(item => item.done).length}/${(task.subtasks || []).length}</span>${task.ownerId === window.DaySync?.user()?.id ? '<span>Вы организатор</span>' : `<span>Организатор: ${escapeHtml(task.ownerEmail || '')}</span>`}</div></div>
    <div class="shared-avatar-stack">${members.slice(0, 4).map(member => { const online = isMemberOnline(member.email); return `<span class="shared-avatar ${online ? 'online' : 'offline'}" title="${escapeHtml(member.email)} — ${online ? 'в сети' : 'не в сети'}">${memberInitial(member.email)}</span>`; }).join('')}</div></button>
    ${(task.subtasks || []).length ? `<div class="shared-subtasks">${task.subtasks.map((item, index) => `<button type="button" class="${item.done ? 'done' : ''}" data-shared-subtask="${task.id}" data-shared-index="${index}"><i>${item.done ? '✓' : ''}</i><span>${escapeHtml(item.title)}</span>${item.doneBy ? `<small>${escapeHtml(item.doneBy.split('@')[0])}</small>` : ''}</button>`).join('')}</div>` : ''}
    ${canRepeatInvite ? `<button type="button" class="repeat-shared-invite" data-repeat-shared-invite="${task.id}">↻ Повторить приглашение</button>` : ''}
  </article>`;
}
function renderSharedPeople() {
  const accountTasks = acceptedSharedTasks(); const people = new Map();
  accountTasks.forEach(task => sharedMembers(task).filter(member => member.state === 'accepted').forEach(member => {
    const item = people.get(member.email) || { email: member.email, roles: new Set(), tasks: 0, completed: 0, contributions: 0 };
    item.roles.add(member.role); item.tasks += 1; if (task.status === 'completed') item.completed += 1;
    item.contributions += (task.subtasks || []).filter(subtask => subtask.doneBy === member.email).length; people.set(member.email, item);
  }));
  if (!people.size) return '<div class="shared-empty"><strong>Участников пока нет</strong>Создайте совместную задачу и пригласите человека по почте.</div>';
  return [...people.values()].map(person => {
    const percent = person.tasks ? Math.round(person.completed / person.tasks * 100) : 0;
    const online = isMemberOnline(person.email);
    return `<article class="member-card"><div class="member-ring" style="--p:${percent}"><span>${percent}%</span></div><div><strong>${escapeHtml(person.email === currentAccountEmail() ? 'Вы' : person.email.split('@')[0])}</strong><small><span class="presence-person ${online ? 'online' : 'offline'}"><i class="presence-dot"></i>${online ? 'В сети' : 'Не в сети'}</span>${person.tasks} задач · выполнено ${person.completed} · отмечено подзадач ${person.contributions}</small></div><span class="member-role">${person.roles.has('Организатор') ? 'Организатор' : 'Участник'}</span></article>`;
  }).join('');
}
function renderSharedInvites() {
  const invites = sharedInvites();
  if (!invites.length) return '<div class="shared-empty"><strong>Новых приглашений нет</strong>Когда вас пригласят по почте аккаунта, задача появится здесь.</div>';
  return invites.map(task => `<article class="invite-card"><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.ownerEmail)} · ${formatShortDate(task.date)} · ${task.time || 'без времени'}</small><div class="invite-actions"><button type="button" class="invite-accept" data-answer-invite="${task.id}" data-accept="1">Принять</button><button type="button" class="invite-decline" data-answer-invite="${task.id}" data-accept="0">Отклонить</button></div></article>`).join('');
}
function bindSharedContentActions() {
  $$('[data-open-shared]').forEach(button => button.addEventListener('click', () => { $('#sharedDialog').close(); openDialog(button.dataset.openShared, 'shared'); }));
  $$('[data-shared-subtask]').forEach(button => button.addEventListener('click', () => toggleSharedSubtask(button.dataset.sharedSubtask, Number(button.dataset.sharedIndex))));
  $$('[data-answer-invite]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await window.DaySync.answerSharedInvite(button.dataset.answerInvite, button.dataset.accept === '1'); await loadSharedTasks(false); renderSharedDialog(); toast(button.dataset.accept === '1' ? 'Приглашение принято' : 'Приглашение отклонено'); }
    catch (error) { button.disabled = false; toast(sharedErrorText(error)); }
  }));
  $$('[data-repeat-shared-invite]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await repeatSharedInvite(button.dataset.repeatSharedInvite);
      button.textContent = '✓ Приглашение повторено';
      setTimeout(() => { if (button.isConnected) { button.disabled = false; button.textContent = '↻ Повторить приглашение'; } }, 1800);
    } catch (error) {
      button.disabled = false;
      toast(sharedErrorText(error));
    }
  }));
}
function renderSharedDialog() {
  if (!$('#sharedDialog')) return;
  renderSharedBadges(); renderSharedSummary();
  $$('[data-shared-tab]').forEach(button => button.classList.toggle('active', button.dataset.sharedTab === currentSharedTab));
  if (currentSharedTab === 'people') $('#sharedContent').innerHTML = renderSharedPeople();
  else if (currentSharedTab === 'invites') $('#sharedContent').innerHTML = renderSharedInvites();
  else {
    const list = acceptedSharedTasks();
    $('#sharedContent').innerHTML = list.length ? list.sort((a, b) => (a.date + (a.time || '99:99')).localeCompare(b.date + (b.time || '99:99'))).map(renderSharedTaskCard).join('') : '<div class="shared-empty"><strong>Совместных задач пока нет</strong>Добавьте первую задачу и пригласите участника.</div>';
  }
  bindSharedContentActions();
}
async function openSharedDialog() {
  if (!window.DaySync?.user()) { toast('Сначала войдите в аккаунт'); openSyncDialog(); return; }
  currentSharedTab = sharedInvites().length ? 'invites' : 'tasks'; renderSharedDialog(); $('#sharedDialog').showModal();
  await loadSharedTasks(true); renderSharedDialog();
}
async function toggleSharedSubtask(taskId, index) {
  const task = sharedTasks.find(item => item.id === taskId); if (!task?.subtasks?.[index]) return;
  const item = task.subtasks[index]; item.done = !item.done; item.doneBy = item.done ? currentAccountEmail() : ''; item.doneAt = item.done ? new Date().toISOString() : '';
  task.updatedAt = new Date().toISOString();
  try { await window.DaySync.saveSharedTask(task); renderSharedDialog(); } catch (error) { item.done = !item.done; toast(sharedErrorText(error)); }
}
async function repeatSharedInvite(taskId) {
  const task = sharedTasks.find(item => item.id === taskId);
  if (!task || task.ownerId !== window.DaySync?.user()?.id) throw new Error('Повторить приглашение может только организатор');
  if (!(task.invitedEmails || []).length) throw new Error('Все приглашения уже обработаны');
  task.inviteReminderAt = new Date().toISOString();
  task.inviteReminderNumber = Number(task.inviteReminderNumber || 0) + 1;
  task.updatedAt = task.inviteReminderAt;
  await window.DaySync.saveSharedTask(task);
  toast('Запрос повторён. Участник увидит приглашение при следующей проверке приложения');
}

$('#quickForm').addEventListener('submit', e => { e.preventDefault(); addQuickTask($('#quickInput').value); });
$('#quickInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addQuickTask(e.currentTarget.value); } });
$('#taskSearch').addEventListener('input', e => { searchQuery = e.currentTarget.value.trim().toLocaleLowerCase('ru'); renderHeader(); renderTasks(); renderStats(); });
$('#weekOverviewButton').addEventListener('click', () => { currentView = 'today'; currentPeriod = 'week'; syncNav(); render(); });
bindHoldToTalk('voiceButton', startVoiceInput);
bindHoldToTalk('voiceTitleButton', () => startVoiceForField('taskTitle', 'voiceTitleButton', { parseTask: true, prompt: 'Слушаю название, дату и время', success: 'Название задачи добавлено' }));
bindHoldToTalk('voiceSubtasksButton', () => startVoiceForField('taskSubtasks', 'voiceSubtasksButton', { prompt: 'Продиктуйте одну подзадачу', success: 'Подзадача добавлена новой строкой' }));
bindHoldToTalk('voiceNoteButton', () => startVoiceForField('taskNote', 'voiceNoteButton', { prompt: 'Продиктуйте заметку', success: 'Заметка добавлена' }));
$('#addButton').addEventListener('click', () => openDialog()); $('#mobileAddButton').addEventListener('click', () => openDialog()); $('#mobileNewTaskButton').addEventListener('click', () => openDialog()); $('#emptyAddButton').addEventListener('click', () => openDialog());
$$('[data-task-type]').forEach(button => button.addEventListener('click', () => setTaskType(button.dataset.taskType)));
$('#closeDialog').addEventListener('click', closeDialog); $('#cancelDialog').addEventListener('click', closeDialog); $('#taskForm').addEventListener('submit', handleSubmit); $('#deleteTask').addEventListener('click', deleteCurrent);
$('#taskCameraButton').addEventListener('click', () => $('#taskCameraInput').click()); $('#taskGalleryButton').addEventListener('click', () => $('#taskGalleryInput').click()); $('#taskDocumentButton').addEventListener('click', () => $('#taskDocumentInput').click());
['taskCameraInput', 'taskGalleryInput', 'taskDocumentInput'].forEach(id => $('#' + id).addEventListener('change', e => { prepareAttachment(e.target.files[0]); e.target.value = ''; }));
$('#removePhoto').addEventListener('click', () => { pendingPhoto = null; pendingAttachment = null; renderPhotoPreview(); });
$('#taskTimeMode').addEventListener('change', updateTimeMode);
$('#updateButton').addEventListener('click', async () => { renderUpdateCenter(); $('#updateDialog').showModal(); await checkForAppUpdate(false); }); $('#closeUpdate').addEventListener('click', () => $('#updateDialog').close()); $('#applyUpdateButton').addEventListener('click', () => applyAppUpdate(false));
$('#promptApplyUpdate').addEventListener('click', applyPromptedUpdate);
$('#focusCard').addEventListener('click', () => { const id = $('#focusCard').dataset.focusTask; if (id) openDialog(id); });
$('#openNotificationSettings').addEventListener('click', openNotificationDialog); $('#closeNotificationSettings').addEventListener('click', () => $('#notificationDialog').close()); $('#notificationForm').addEventListener('submit', saveNotificationSettings); $('#testNotification').addEventListener('click', testNotification);
$('#reminderAlertDismiss').addEventListener('click', hideReminderAlert); $('#reminderAlertOpen').addEventListener('click', () => openNotificationTask());
$('#openFeedback').addEventListener('click', () => { $('#updateDialog').close(); resetFeedbackForm(); $('#feedbackDialog').showModal(); }); $('#closeFeedback').addEventListener('click', () => $('#feedbackDialog').close()); bindHoldToTalk('feedbackVoiceButton', () => startVoiceForField('feedbackText', 'feedbackVoiceButton', { prompt: 'Слушаю описание проблемы', success: 'Текст обратной связи добавлен' })); $('#chooseFeedbackPhoto').addEventListener('click', () => $('#feedbackPhotoInput').click()); $('#feedbackPhotoInput').addEventListener('change', event => { chooseFeedbackPhoto(event.target.files[0]); event.target.value = ''; }); $('#removeFeedbackPhoto').addEventListener('click', () => { feedbackPhoto = null; $('#feedbackFile').hidden = true; $('#feedbackFileName').textContent = ''; }); $('#feedbackForm').addEventListener('submit', submitFeedback);
$('#closeReminders').addEventListener('click', () => $('#reminderDialog').close()); $('#enableNotifications').addEventListener('click', enableNotifications);
function openPlansDialog() { currentPlanningView = 'week'; planningAnchorDate = selectedDate; renderPlanningDialog(); $('#reminderDialog').showModal(); }
$('#mobilePlansButton').addEventListener('click', openPlansDialog);
$('#desktopPlansButton').addEventListener('click', openPlansDialog);
$('#mobileSharedButton').addEventListener('click', openSharedDialog); $('#desktopSharedButton').addEventListener('click', openSharedDialog); $('#closeShared').addEventListener('click', () => $('#sharedDialog').close()); $('#sharedAddButton').addEventListener('click', () => { $('#sharedDialog').close(); openDialog(null, 'shared'); });
$('#sharedInvitePromptAccept').addEventListener('click', () => answerSharedInvitePrompt(true)); $('#sharedInvitePromptDecline').addEventListener('click', () => answerSharedInvitePrompt(false));
$$('[data-shared-tab]').forEach(button => button.addEventListener('click', () => { currentSharedTab = button.dataset.sharedTab; renderSharedDialog(); }));
$$('[data-planning-view]').forEach(button => button.addEventListener('click', () => { currentPlanningView = button.dataset.planningView; renderPlanningDialog(); })); $('#planForm').addEventListener('submit', addPeriodPlans);
$('#planPeriodPrev').addEventListener('click', () => movePlanningPeriod(-1)); $('#planPeriodNext').addEventListener('click', () => movePlanningPeriod(1));
$('#closeSync').addEventListener('click', () => $('#syncDialog').close());
$('#accountEntryButton').addEventListener('click', openSyncDialog);
$('#profileButton').addEventListener('click', openProfile); $('#closeProfile').addEventListener('click', () => $('#profileDialog').close()); $('#profileForm').addEventListener('submit', saveProfileForm);
$('#chooseProfilePhoto').addEventListener('click', () => $('#profilePhotoInput').click()); $('#profileGalleryButton').addEventListener('click', () => $('#profilePhotoInput').click()); $('#profileCameraButton').addEventListener('click', () => $('#profileCameraInput').click());
$('#profilePhotoInput').addEventListener('change', e => { prepareProfilePhoto(e.target.files[0]); e.target.value = ''; }); $('#profileCameraInput').addEventListener('change', e => { prepareProfilePhoto(e.target.files[0]); e.target.value = ''; });
$('#removeProfilePhoto').addEventListener('click', () => { pendingProfilePhoto = ''; $('#profilePhotoInput').value = ''; $('#profileCameraInput').value = ''; renderProfile(); });
$('#syncAuthForm').addEventListener('submit', handleSyncLogin); $('#syncSignUp').addEventListener('click', handleSyncSignUp); $('#syncForgotPassword').addEventListener('click', handleForgotPassword); $('#syncRecoveryCodeForm').addEventListener('submit', handleVerifyRecoveryCode); $('#syncResendRecoveryCode').addEventListener('click', () => sendRecoveryCode($('#syncRecoveryEmail').value.trim())); $('#syncBackToLogin').addEventListener('click', showLoginForm); $('#syncResetForm').addEventListener('submit', handleResetPassword);
$('#syncNow').addEventListener('click', () => performSync()); $('#syncLogout').addEventListener('click', handleSyncLogout); $('#pinSaveButton').addEventListener('click', savePin); $('#pinRemoveButton').addEventListener('click', removePin);
$('#pinUnlockForm').addEventListener('submit', unlockWithPin); $('#pinUsePassword').addEventListener('click', useAccountPassword);
$('#pinSetupInput').addEventListener('input', event => preparePinField(event.target)); $('#pinUnlockInput').addEventListener('input', event => preparePinField(event.target));
$$('[data-period]').forEach(b => b.addEventListener('click', () => { currentPeriod = b.dataset.period; currentView = 'today'; syncNav(); render(); }));
$('#periodPrev').addEventListener('click', () => movePeriod(-1)); $('#periodNext').addEventListener('click', () => movePeriod(1)); $('#periodToday').addEventListener('click', () => { selectedDate = todayKey; render(); });
$$('[data-view]').forEach(b => b.addEventListener('click', () => { if (b.dataset.view === 'settings') { toast('Все данные, фото и планы хранятся только на этом устройстве'); return; } currentView = b.dataset.view; if (currentView === 'today') selectedDate = todayKey; syncNav(); render(); }));
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('#installButton').hidden = false; });
$('#installButton').addEventListener('click', async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('#installButton').hidden = true; });
showUpdatedNoticeIfNeeded();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => { await navigator.serviceWorker.register('sw.js?v=60'); await ensurePushSubscription(false); checkForAppUpdate(false, true); setInterval(() => checkForAppUpdate(false, true), 10 * 60 * 1000); });
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type !== 'DAY_PUSH') return;
    showReminderAlert(event.data.taskId || '', event.data.title || 'Новое уведомление', event.data.body || '');
  });
}

function handleOpenTaskFromUrl() {
  const params = new URLSearchParams(location.search); const taskId = params.get('openTask');
  if (!taskId) return;
  history.replaceState(null, '', location.pathname);
  openNotificationTask(taskId);
}

async function initializeAccount() {
  if (new URLSearchParams(location.search).get('recovery') === 'code') {
    refreshSyncUi(); const email = localStorage.getItem('day-password-recovery-email') || ''; $('#syncEmail').value = email; $('#syncRecoveryEmail').value = email; $('#syncAuthForm').hidden = true; $('#syncConnected').hidden = true; $('#syncRecoveryCodeForm').hidden = false; $('#syncDialog').showModal();
    setSyncStatus('', 'Восстановление пароля', 'Введите email, получите новый код и укажите его здесь.'); return;
  }
  try {
    const recovery = await window.DaySync?.consumeRecoveryFromUrl?.();
    if (recovery === 'signup') {
      markPinUnlocked(); switchAccountData(); refreshSyncUi(); await performSync(false); toast('Почта подтверждена. Аккаунт подключён'); return;
    }
    if (recovery === 'recovery') {
      markPinUnlocked(); refreshSyncUi(); $('#syncAuthForm').hidden = true; $('#syncConnected').hidden = true; $('#syncResetForm').hidden = false; $('#syncDialog').showModal();
      setSyncStatus('connected', 'Ссылка подтверждена', 'Теперь задайте новый пароль.'); return;
    }
  } catch (error) {
    if (!window.DaySync?.user()) { await window.DaySync?.signOut?.(); }
    refreshSyncUi(); const email = localStorage.getItem('day-password-recovery-email') || ''; $('#syncEmail').value = email; $('#syncRecoveryEmail').value = email; $('#syncAuthForm').hidden = true; $('#syncRecoveryCodeForm').hidden = false; $('#syncDialog').showModal();
    setSyncStatus('error', 'Старая ссылка недействительна', 'Вернитесь ко входу и запросите новое письмо. Открывайте только самое новое письмо.'); return;
  }
  refreshSyncUi();
  if (window.DaySync?.user()) { await maybeLockApp(); await performSync(false); }
  handleOpenTaskFromUrl();
}
window.addEventListener('online', () => { renderConnectionState(); performSync(false); });
window.addEventListener('offline', renderConnectionState);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { appHiddenAt = Date.now(); return; }
  if (appHiddenAt && Date.now() - appHiddenAt >= PIN_RELOCK_MS) { pinUnlocked = false; maybeLockApp(); }
  refreshSharedPresence();
  performSync(false);
});
setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine) performSync(false); }, 15000);
setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine) refreshSharedPresence(); }, 30000);

runAutoCarry(); save(); render(); renderProfile(); renderConnectionState(); refreshUpdateIndicator(); initializeAccount(); checkReminders(); setInterval(checkReminders, 30000);
