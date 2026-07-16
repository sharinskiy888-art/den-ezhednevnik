const STORAGE_KEY = 'day-planner-tasks-v2';
const LEGACY_KEY = 'day-planner-tasks-v1';
const DELETED_KEY = 'day-planner-deleted-v1';
const PROFILE_KEY = 'day-planner-profile-v1';
const PLAN_KEY = 'day-planner-period-plans-v1';
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
let activeRecognition = null;
let activeVoiceButton = null;
let profile = loadProfile();
let pendingProfilePhoto = profile.photo || '';
let periodPlans = loadPeriodPlans();
let currentPlanningView = 'today';
let planningAnchorDate = selectedDate;

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
function savePeriodPlans() {
  try { localStorage.setItem(planStorageKey(), JSON.stringify(periodPlans)); return true; }
  catch { toast('Не удалось сохранить планы'); return false; }
}
function saveProfile() {
  try { localStorage.setItem(profileStorageKey(), JSON.stringify(profile)); return true; }
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
  tasks = loadTasks(); deletedIds = loadDeletedIds(); profile = loadProfile(); pendingProfilePhoto = profile.photo || ''; periodPlans = loadPeriodPlans(); runAutoCarry(); render(); refreshSyncUi(); renderProfile();
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
    const priorityText = importantCount ? `, важных задач: ${importantCount}` : '';
    return `<button class="day-button ${key === selectedDate ? 'selected' : ''} ${dayTasks.length ? 'has-tasks' : ''} ${importantCount ? 'has-high-priority' : ''}" data-date="${key}" aria-label="${formatLong(key)}${priorityText}"><em ${importantCount ? '' : 'hidden'} aria-hidden="true">!</em><span>${names[i]}</span><b>${d.getDate()}</b><i></i></button>`;
  }).join('');
  $$('.day-button').forEach(b => b.addEventListener('click', () => { selectedDate = b.dataset.date; if (currentPeriod === 'day') render(); else { renderPeriod(); renderStats(); } }));
}

function renderMonth() {
  const anchor = fromKey(selectedDate); const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(first); start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const heads = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(x => `<div class="month-grid-head">${x}</div>`).join('');
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start); d.setDate(start.getDate() + i); const key = toKey(d); const count = tasks.filter(t => t.date === key && !t.completed).length;
    return `<button class="month-day ${d.getMonth() !== anchor.getMonth() ? 'outside' : ''} ${key === selectedDate ? 'selected' : ''}" data-month-date="${key}"><b>${d.getDate()}</b>${count ? `<small>${count} дел</small>` : ''}</button>`;
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
  if (currentView === 'upcoming') result = tasks.filter(t => t.date >= todayKey && !t.completed);
  else if (currentView === 'completed') result = tasks.filter(t => t.completed);
  else result = tasks.filter(t => t.date >= start && t.date <= end);
  if (searchQuery) result = result.filter(t => `${t.title} ${t.note || ''} ${t.proofNote || ''} ${(t.subtasks || []).map(s => s.title).join(' ')}`.toLocaleLowerCase('ru').includes(searchQuery));
  const priorityOrder = { high: 0, normal: 1, low: 2 };
  return result.sort((a, b) => (a.date + (a.time || '99:99')).localeCompare(b.date + (b.time || '99:99')) || (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1));
}
