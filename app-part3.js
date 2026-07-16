function startVoiceInput() { return startVoiceForField('taskTitle', 'voiceButton', { openTask: true, parseTask: true, prompt: 'Слушаю… Назовите задачу, дату и время', success: 'Задача распознана. Проверьте и сохраните' }); }

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

async function enableNotifications() {
  if (!('Notification' in window)) { toast('Уведомления не поддерживаются'); return; }
  const permission = await Notification.requestPermission(); renderMiniTasks(); toast(permission === 'granted' ? 'Уведомления включены' : 'Уведомления не разрешены');
}
async function checkReminders() {
  const now = new Date(); const due = tasks.filter(t => !t.completed && t.reminder && !t.notified && new Date(t.reminder) <= now);
  if (!due.length) return;
  for (const task of due) {
    task.notified = true;
    task.updatedAt = new Date().toISOString();
    if ('Notification' in window && Notification.permission === 'granted') {
      const registration = await navigator.serviceWorker?.ready;
      if (registration) registration.showNotification('День — пора выполнить задачу', { body: task.title, icon: 'assets/icon-192.png', badge: 'assets/icon-192.png', tag: task.id, data: { taskId: task.id } });
      else new Notification('День — пора выполнить задачу', { body: task.title });
    }
  }
  save(); if ($('#reminderDialog').open === false) toast(`Напоминание: ${due[0].title}`);
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
  const button = $('#syncButton'); button.classList.remove('connected', 'syncing', 'error');
  if (status) button.classList.add(status);
  $('#syncStateTitle').textContent = title; $('#syncStateText').textContent = text;
}
function refreshSyncUi() {
  const user = window.DaySync?.user();
  $('#syncAuthForm').hidden = !!user; $('#syncConnected').hidden = !user; $('#syncResetForm').hidden = true;
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
    suppressSync = true; save(); suppressSync = false; render(); renderProfile();
    setSyncStatus('connected', 'Синхронизировано', `Задач в облаке: ${tasks.length}`);
    if (showMessage) toast('Данные синхронизированы');
  } catch (error) {
    suppressSync = false; setSyncStatus('error', 'Ошибка синхронизации', error.message); if (showMessage) toast(error.message);
  } finally { syncInFlight = false; }
}
async function handleSyncLogin(event) {
  event.preventDefault(); const email = $('#syncEmail').value.trim(); const password = $('#syncPassword').value;
  setSyncStatus('syncing', 'Выполняется вход…', email);
  try { await window.DaySync.signIn(email, password); pinUnlocked = true; $('#syncPassword').value = ''; switchAccountData(); await performSync(); }
  catch (error) { setSyncStatus('error', 'Не удалось войти', error.message); }
}
async function handleSyncSignUp() {
  const form = $('#syncAuthForm'); if (!form.reportValidity()) return;
  const email = $('#syncEmail').value.trim(); const password = $('#syncPassword').value;
  setSyncStatus('syncing', 'Создаём аккаунт…', email);
  try {
    const result = await window.DaySync.signUp(email, password); $('#syncPassword').value = '';
    if (result.access_token) { pinUnlocked = true; switchAccountData(); await performSync(); }
    else setSyncStatus('', 'Подтвердите email', 'Откройте письмо Supabase, затем войдите здесь.');
  } catch (error) { setSyncStatus('error', 'Не удалось зарегистрироваться', error.message); }
}
async function handleForgotPassword() {
  const email = $('#syncEmail').value.trim();
  if (!email || !$('#syncEmail').checkValidity()) { $('#syncEmail').reportValidity(); return; }
  setSyncStatus('syncing', 'Отправляем письмо…', email);
  try { await window.DaySync.resetPassword(email); setSyncStatus('', 'Письмо отправлено', 'Откройте письмо и нажмите ссылку. Затем задайте новый пароль.'); toast('Письмо для восстановления отправлено'); }
  catch (error) { setSyncStatus('error', 'Не удалось отправить письмо', error.message); }
}
async function handleResetPassword(event) {
  event.preventDefault(); const password = $('#syncNewPassword').value; const confirm = $('#syncNewPasswordConfirm').value;
  if (password !== confirm) { setSyncStatus('error', 'Пароли не совпадают', 'Введите одинаковый пароль в двух полях.'); return; }
  try {
    await window.DaySync.updatePassword(password); pinUnlocked = true; history.replaceState(null, '', location.pathname);
    $('#syncNewPassword').value = ''; $('#syncNewPasswordConfirm').value = ''; switchAccountData(); await performSync(false); toast('Новый пароль сохранён');
  } catch (error) { setSyncStatus('error', 'Не удалось сменить пароль', error.message); }
}
async function hashPin(pin) {
  const bytes = new TextEncoder().encode(`${accountSuffix()}:${pin}`); const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
async function savePin() {
  const pin = $('#pinSetupInput').value.trim(); if (!/^\d{4}$/.test(pin)) { toast('Введите ровно четыре цифры'); return; }
  localStorage.setItem(pinStorageKey(), await hashPin(pin)); $('#pinSetupInput').value = ''; pinUnlocked = true; refreshSyncUi(); toast('PIN установлен на этом устройстве');
}
function removePin() { localStorage.removeItem(pinStorageKey()); $('#pinSetupInput').value = ''; pinUnlocked = true; refreshSyncUi(); toast('PIN удалён'); }
async function maybeLockApp() {
  if (!window.DaySync?.user() || pinUnlocked || !localStorage.getItem(pinStorageKey()) || $('#pinDialog').open) return;
  $('#pinUnlockInput').value = ''; $('#pinError').textContent = ''; $('#pinDialog').showModal(); setTimeout(() => $('#pinUnlockInput').focus(), 50);
}
async function unlockWithPin(event) {
  event.preventDefault(); const entered = await hashPin($('#pinUnlockInput').value);
  if (entered !== localStorage.getItem(pinStorageKey())) { $('#pinError').textContent = 'Неверный PIN. Попробуйте ещё раз.'; $('#pinUnlockInput').select(); return; }
  pinUnlocked = true; $('#pinDialog').close(); performSync(false);
}
async function useAccountPassword() {
  $('#pinDialog').close(); save(); await window.DaySync.signOut(); pinUnlocked = false; switchAccountData(); $('#syncDialog').showModal();
}
async function handleSyncLogout() { save(); await window.DaySync.signOut(); pinUnlocked = false; switchAccountData(); toast('Вы вышли. Личные задачи этого аккаунта скрыты.'); }

$('#quickForm').addEventListener('submit', e => { e.preventDefault(); addQuickTask($('#quickInput').value); });
$('#quickInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addQuickTask(e.currentTarget.value); } });
$('#taskSearch').addEventListener('input', e => { searchQuery = e.currentTarget.value.trim().toLocaleLowerCase('ru'); renderTasks(); renderStats(); });
$('#weekOverviewButton').addEventListener('click', () => { currentView = 'today'; currentPeriod = 'week'; syncNav(); render(); });
$('#voiceButton').addEventListener('click', startVoiceInput);
$('#voiceTitleButton').addEventListener('click', () => startVoiceForField('taskTitle', 'voiceTitleButton', { parseTask: true, prompt: 'Слушаю название, дату и время', success: 'Название задачи добавлено' }));
$('#voiceSubtasksButton').addEventListener('click', () => startVoiceForField('taskSubtasks', 'voiceSubtasksButton', { prompt: 'Продиктуйте одну подзадачу', success: 'Подзадача добавлена новой строкой' }));
$('#voiceNoteButton').addEventListener('click', () => startVoiceForField('taskNote', 'voiceNoteButton', { prompt: 'Продиктуйте заметку', success: 'Заметка добавлена' }));
$('#addButton').addEventListener('click', () => openDialog()); $('#mobileAddButton').addEventListener('click', () => openDialog()); $('#mobileNewTaskButton').addEventListener('click', () => openDialog()); $('#emptyAddButton').addEventListener('click', () => openDialog());
$('#closeDialog').addEventListener('click', closeDialog); $('#cancelDialog').addEventListener('click', closeDialog); $('#taskForm').addEventListener('submit', handleSubmit); $('#deleteTask').addEventListener('click', deleteCurrent);
$('#taskCameraButton').addEventListener('click', () => $('#taskCameraInput').click()); $('#taskGalleryButton').addEventListener('click', () => $('#taskGalleryInput').click()); $('#taskDocumentButton').addEventListener('click', () => $('#taskDocumentInput').click());
['taskCameraInput', 'taskGalleryInput', 'taskDocumentInput'].forEach(id => $('#' + id).addEventListener('change', e => { prepareAttachment(e.target.files[0]); e.target.value = ''; }));
$('#removePhoto').addEventListener('click', () => { pendingPhoto = null; pendingAttachment = null; renderPhotoPreview(); });
$('#taskTimeMode').addEventListener('change', updateTimeMode);
$('#reminderButton').addEventListener('click', () => { currentPlanningView = 'week'; planningAnchorDate = selectedDate; renderPlanningDialog(); $('#reminderDialog').showModal(); }); $('#closeReminders').addEventListener('click', () => $('#reminderDialog').close()); $('#enableNotifications').addEventListener('click', enableNotifications);
$('#mobilePlansButton').addEventListener('click', () => { currentPlanningView = 'week'; planningAnchorDate = selectedDate; renderPlanningDialog(); $('#reminderDialog').showModal(); });
$$('[data-planning-view]').forEach(button => button.addEventListener('click', () => { currentPlanningView = button.dataset.planningView; renderPlanningDialog(); })); $('#planForm').addEventListener('submit', addPeriodPlans);
$('#planPeriodPrev').addEventListener('click', () => movePlanningPeriod(-1)); $('#planPeriodNext').addEventListener('click', () => movePlanningPeriod(1));
$('#syncButton').addEventListener('click', () => { if ($('#profileDialog').open) $('#profileDialog').close(); refreshSyncUi(); $('#syncDialog').showModal(); }); $('#closeSync').addEventListener('click', () => $('#syncDialog').close());
$('#accountEntryButton').addEventListener('click', () => { refreshSyncUi(); $('#syncDialog').showModal(); });
$('#profileButton').addEventListener('click', openProfile); $('#closeProfile').addEventListener('click', () => $('#profileDialog').close()); $('#profileForm').addEventListener('submit', saveProfileForm);
$('#chooseProfilePhoto').addEventListener('click', () => $('#profilePhotoInput').click()); $('#profileGalleryButton').addEventListener('click', () => $('#profilePhotoInput').click()); $('#profileCameraButton').addEventListener('click', () => $('#profileCameraInput').click());
$('#profilePhotoInput').addEventListener('change', e => { prepareProfilePhoto(e.target.files[0]); e.target.value = ''; }); $('#profileCameraInput').addEventListener('change', e => { prepareProfilePhoto(e.target.files[0]); e.target.value = ''; });
$('#removeProfilePhoto').addEventListener('click', () => { pendingProfilePhoto = ''; $('#profilePhotoInput').value = ''; $('#profileCameraInput').value = ''; renderProfile(); });
$('#syncAuthForm').addEventListener('submit', handleSyncLogin); $('#syncSignUp').addEventListener('click', handleSyncSignUp); $('#syncForgotPassword').addEventListener('click', handleForgotPassword); $('#syncResetForm').addEventListener('submit', handleResetPassword);
$('#syncNow').addEventListener('click', () => performSync()); $('#syncLogout').addEventListener('click', handleSyncLogout); $('#pinSaveButton').addEventListener('click', savePin); $('#pinRemoveButton').addEventListener('click', removePin);
$('#pinUnlockForm').addEventListener('submit', unlockWithPin); $('#pinUsePassword').addEventListener('click', useAccountPassword);
$$('[data-period]').forEach(b => b.addEventListener('click', () => { currentPeriod = b.dataset.period; currentView = 'today'; syncNav(); render(); }));
$('#periodPrev').addEventListener('click', () => movePeriod(-1)); $('#periodNext').addEventListener('click', () => movePeriod(1)); $('#periodToday').addEventListener('click', () => { selectedDate = todayKey; render(); });
$$('[data-view]').forEach(b => b.addEventListener('click', () => { if (b.dataset.view === 'settings') { toast('Все данные, фото и планы хранятся только на этом устройстве'); return; } currentView = b.dataset.view; if (currentView === 'today') selectedDate = todayKey; syncNav(); render(); }));
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('#installButton').hidden = false; });
$('#installButton').addEventListener('click', async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('#installButton').hidden = true; });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js?v=33'));

async function initializeAccount() {
  try {
    const recovery = await window.DaySync?.consumeRecoveryFromUrl?.();
    if (recovery) {
      pinUnlocked = true; refreshSyncUi(); $('#syncAuthForm').hidden = true; $('#syncConnected').hidden = true; $('#syncResetForm').hidden = false; $('#syncDialog').showModal();
      setSyncStatus('connected', 'Ссылка подтверждена', 'Теперь задайте новый пароль.'); return;
    }
  } catch (error) {
    await window.DaySync?.signOut?.(); refreshSyncUi(); $('#syncEmail').value = ''; $('#syncDialog').showModal();
    setSyncStatus('error', 'Ссылка восстановления недействительна', `${error.message} Закройте это окно и запросите новое письмо.`); return;
  }
  refreshSyncUi();
  if (window.DaySync?.user()) { await maybeLockApp(); await performSync(false); }
}
window.addEventListener('online', () => performSync(false));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { appHiddenAt = Date.now(); return; }
  if (appHiddenAt && Date.now() - appHiddenAt > 60000) { pinUnlocked = false; maybeLockApp(); } performSync(false);
});
setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine) performSync(false); }, 15000);

runAutoCarry(); save(); render(); renderProfile(); initializeAccount(); checkReminders(); setInterval(checkReminders, 30000);
