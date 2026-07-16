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
  if (activeRecognition) { activeRecognition.stop(); resetVoiceButton(); toast('Голосовой ввод остановлен'); return; }
  if (options.openTask) { openDialog(); $('#dialogTitle').textContent = 'Новая задача голосом'; $('#taskAutoCarry').checked = true; }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { voiceFallback(targetId, 'Нажмите микрофон на клавиатуре телефона и продиктуйте текст'); return; }
  if (!isSecureContext) { toast('Микрофон работает только в установленном приложении или через HTTPS'); return; }
  try {
    if (navigator.mediaDevices?.getUserMedia) { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(track => track.stop()); }
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
    recognition.onend = resetVoiceButton; recognition.start();
  } catch (error) {
    resetVoiceButton(); if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') toast('Разрешите приложению доступ к микрофону'); else toast('Не удалось включить микрофон');
  }
}
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
  $('#syncAuthForm').hidden = !!user; $('#syncConnected').hidden = !user;
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
  setSyncStatus('syncing', 'Синхронизация…', 'Обмениваемся изменениями с облаком');
  try {
    const merged = await window.DaySync.sync(tasks, deletedIds);
    tasks = merged; deletedIds = []; localStorage.setItem(deletedStorageKey(), '[]');
    suppressSync = true; save(); suppressSync = false; render();
    setSyncStatus('connected', 'Синхронизировано', `Задач в облаке: ${tasks.length}`);
    if (showMessage) toast('Данные синхронизированы');
  } catch (error) {
    suppressSync = false; setSyncStatus('error', 'Ошибка синхронизации', error.message); if (showMessage) toast(error.message);
  }
}
async function handleSyncLogin(event) {
  event.preventDefault(); const email = $('#syncEmail').value.trim(); const password = $('#syncPassword').value;
  setSyncStatus('syncing', 'Выполняется вход…', email);
  try { await window.DaySync.signIn(email, password); $('#syncPassword').value = ''; switchAccountData(); await performSync(); }
  catch (error) { setSyncStatus('error', 'Не удалось войти', error.message); }
}
async function handleSyncSignUp() {
  const form = $('#syncAuthForm'); if (!form.reportValidity()) return;
  const email = $('#syncEmail').value.trim(); const password = $('#syncPassword').value;
  setSyncStatus('syncing', 'Создаём аккаунт…', email);
  try {
    const result = await window.DaySync.signUp(email, password); $('#syncPassword').value = '';
    if (result.access_token) { switchAccountData(); await performSync(); }
    else setSyncStatus('', 'Подтвердите email', 'Откройте письмо Supabase, затем войдите здесь.');
  } catch (error) { setSyncStatus('error', 'Не удалось зарегистрироваться', error.message); }
}
async function handleSyncLogout() { save(); await window.DaySync.signOut(); switchAccountData(); toast('Вы вышли. Личные задачи этого аккаунта скрыты.'); }

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
$('#reminderButton').addEventListener('click', () => { currentPlanningView = 'today'; planningAnchorDate = selectedDate; renderPlanningDialog(); $('#reminderDialog').showModal(); }); $('#closeReminders').addEventListener('click', () => $('#reminderDialog').close()); $('#enableNotifications').addEventListener('click', enableNotifications);
$$('[data-planning-view]').forEach(button => button.addEventListener('click', () => { currentPlanningView = button.dataset.planningView; renderPlanningDialog(); })); $('#planForm').addEventListener('submit', addPeriodPlans);
$('#planPeriodPrev').addEventListener('click', () => movePlanningPeriod(-1)); $('#planPeriodNext').addEventListener('click', () => movePlanningPeriod(1));
$('#syncButton').addEventListener('click', () => { if ($('#profileDialog').open) $('#profileDialog').close(); refreshSyncUi(); $('#syncDialog').showModal(); }); $('#closeSync').addEventListener('click', () => $('#syncDialog').close());
$('#accountEntryButton').addEventListener('click', () => { refreshSyncUi(); $('#syncDialog').showModal(); });
$('#profileButton').addEventListener('click', openProfile); $('#closeProfile').addEventListener('click', () => $('#profileDialog').close()); $('#profileForm').addEventListener('submit', saveProfileForm);
$('#chooseProfilePhoto').addEventListener('click', () => $('#profilePhotoInput').click()); $('#profileGalleryButton').addEventListener('click', () => $('#profilePhotoInput').click()); $('#profileCameraButton').addEventListener('click', () => $('#profileCameraInput').click());
$('#profilePhotoInput').addEventListener('change', e => { prepareProfilePhoto(e.target.files[0]); e.target.value = ''; }); $('#profileCameraInput').addEventListener('change', e => { prepareProfilePhoto(e.target.files[0]); e.target.value = ''; });
$('#removeProfilePhoto').addEventListener('click', () => { pendingProfilePhoto = ''; $('#profilePhotoInput').value = ''; $('#profileCameraInput').value = ''; renderProfile(); });
$('#syncAuthForm').addEventListener('submit', handleSyncLogin); $('#syncSignUp').addEventListener('click', handleSyncSignUp); $('#syncNow').addEventListener('click', () => performSync()); $('#syncLogout').addEventListener('click', handleSyncLogout);
$$('[data-period]').forEach(b => b.addEventListener('click', () => { currentPeriod = b.dataset.period; currentView = 'today'; syncNav(); render(); }));
$('#periodPrev').addEventListener('click', () => movePeriod(-1)); $('#periodNext').addEventListener('click', () => movePeriod(1)); $('#periodToday').addEventListener('click', () => { selectedDate = todayKey; render(); });
$$('[data-view]').forEach(b => b.addEventListener('click', () => { if (b.dataset.view === 'settings') { toast('Все данные, фото и планы хранятся только на этом устройстве'); return; } currentView = b.dataset.view; if (currentView === 'today') selectedDate = todayKey; syncNav(); render(); }));
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('#installButton').hidden = false; });
$('#installButton').addEventListener('click', async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('#installButton').hidden = true; });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js?v=31'));

runAutoCarry(); save(); render(); refreshSyncUi(); renderProfile(); if (window.DaySync?.user()) performSync(false); checkReminders(); setInterval(checkReminders, 30000);
