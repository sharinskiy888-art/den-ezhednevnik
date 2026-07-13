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
      ${t.priority === 'high' ? '<span class="priority-label high">Важно</span>' : t.priority === 'low' ? '<span class="priority-label low">Можно позже</span>' : ''}
    </div>${(t.subtasks || []).length ? `<div class="subtask-list">${t.subtasks.map((s, i) => `<button type="button" class="subtask ${s.done ? 'done' : ''}" data-subtask="${t.id}" data-sub-index="${i}"><i>${s.done ? '✓' : ''}</i>${escapeHtml(s.title)}</button>`).join('')}</div>` : ''}</div><button class="more-button" data-edit="${t.id}" aria-label="Редактировать ${escapeHtml(t.title)}">•••</button></article>`;
  }).join('');
  $('#emptyState').hidden = list.length > 0;
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
  const focus = day.find(t => !t.completed && t.priority === 'high') || day.find(t => !t.completed);
  $('#focusTitle').textContent = focus ? focus.title : 'Все дела завершены';
  $('#focusMeta').textContent = focus ? (focus.time ? `В ${focus.time}` : focus.autoCarry ? 'Переносится до выполнения' : 'В удобное время') : 'Можно спокойно отдохнуть';
  const periodList = visibleTasks(); const periodDone = periodList.filter(t => t.completed).length;
  $('#taskSummary').textContent = periodList.length ? `${periodDone} из ${periodList.length} выполнено` : 'Пока всё свободно';
  const todayOpen = tasks.filter(t => t.date === todayKey && !t.completed).length;
  $('#reminderBadge').textContent = todayOpen; $('#reminderBadge').hidden = todayOpen === 0;
}

function renderHeader() {
  const d = fromKey(selectedDate); const [start, end] = periodBounds();
  const periodLabel = currentPeriod === 'day' ? formatLong(selectedDate) : currentPeriod === 'week' ? `${fromKey(start).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} — ${fromKey(end).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}` : currentPeriod === 'month' ? d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }) : String(d.getFullYear());
  $('#weekOverviewLabel').textContent = formatWeekRange(selectedDate);
  $('#weekOverviewButton').hidden = currentView !== 'today' || currentPeriod !== 'day';
  $('#dateEyebrow').textContent = periodLabel;
  if (currentView === 'upcoming') { $('#pageTitle').textContent = 'Предстоящие дела'; $('#pageSubtitle').textContent = 'Всё важное — в одном списке.'; $('#listTitle').textContent = 'Ближайшие задачи'; }
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
function openProfile() {
  pendingProfilePhoto = profile.photo || ''; $('#profileName').value = profile.name || '';
  $('#profileEmail').textContent = window.DaySync?.user()?.email || 'Не выполнен вход'; renderProfile(); $('#profileDialog').showModal();
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
  const clone = { ...task, id: crypto.randomUUID(), date: nextDate, completed: false, notified: false, carriedFrom: '', carryCount: 0, recurrenceSource: source, subtasks: (task.subtasks || []).map(s => ({ title: s.title, done: false })), photo: null, photoCapturedAt: '', proofNote: '', updatedAt: new Date().toISOString() };
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
  lines.forEach(clean => { const parsed = parseQuickTask(clean); tasks.push({ id: crypto.randomUUID(), ...parsed, priority: 'normal', note: '', completed: false, autoCarry: true, reminder: '', notified: false, photo: null, photoCapturedAt: '', proofNote: '', repeat: 'none', subtasks: [], carryCount: 0, updatedAt: new Date().toISOString() }); });
  save(); $('#quickInput').value = ''; render(); toast(lines.length > 1 ? `Добавлено дел: ${lines.length}` : 'Дело добавлено с автопереносом');
}

function openDialog(id = null) {
  const task = tasks.find(t => t.id === id); $('#taskForm').reset(); pendingPhoto = task?.photo || null;
  $('#taskId').value = task?.id || ''; $('#dialogTitle').textContent = task ? 'Редактировать задачу' : 'Новая задача';
  $('#taskTitle').value = task?.title || ''; $('#taskDate').value = task?.date || selectedDate; $('#taskTime').value = task?.time || '';
  $('#taskTimeMode').value = task?.time ? 'exact' : 'anytime'; updateTimeMode();
  $('#taskPriority').value = task?.priority || 'normal'; $('#taskNote').value = task?.note || '';
  $('#taskAutoCarry').checked = task?.autoCarry || false; $('#taskReminder').value = task?.reminder || ''; $('#taskRepeat').value = task?.repeat || 'none';
  $('#taskSubtasks').value = (task?.subtasks || []).map(s => s.title).join('\n'); $('#taskProofNote').value = task?.proofNote || ''; $('#deleteTask').hidden = !task;
  renderPhotoPreview(); $('#taskDialog').showModal(); setTimeout(() => $('#taskTitle').focus(), 50);
}
function closeDialog() { $('#taskDialog').close(); }
function updateTimeMode() {
  const exact = $('#taskTimeMode').value === 'exact';
  $('#taskTime').hidden = !exact; $('#taskTime').required = exact;
  if (!exact) $('#taskTime').value = '';
}
function handleSubmit(event) {
  event.preventDefault(); const id = $('#taskId').value;
  const existing = tasks.find(t => t.id === id); const previousSubtasks = existing?.subtasks || [];
  const subtasks = $('#taskSubtasks').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean).map(title => ({ title, done: previousSubtasks.find(s => s.title === title)?.done || false }));
  const data = { title: $('#taskTitle').value.trim(), date: $('#taskDate').value, time: $('#taskTimeMode').value === 'exact' ? $('#taskTime').value : '', priority: $('#taskPriority').value, note: $('#taskNote').value.trim(), autoCarry: $('#taskAutoCarry').checked, reminder: $('#taskReminder').value, repeat: $('#taskRepeat').value, subtasks, proofNote: $('#taskProofNote').value.trim(), notified: false, photo: pendingPhoto, photoCapturedAt: pendingPhoto && pendingPhoto !== existing?.photo ? new Date().toISOString() : existing?.photoCapturedAt || '', updatedAt: new Date().toISOString() };
  if (!data.title) return;
  if (id) Object.assign(existing, data);
  else tasks.push({ id: crypto.randomUUID(), ...data, completed: false, carryCount: 0 });
  if (!save()) return; selectedDate = data.date; closeDialog(); render(); toast(id ? 'Изменения сохранены' : 'Задача добавлена');
}
function deleteCurrent() { const id = $('#taskId').value; if (!id) return; tasks = tasks.filter(t => t.id !== id); if (!deletedIds.includes(id)) deletedIds.push(id); localStorage.setItem(deletedStorageKey(), JSON.stringify(deletedIds)); save(); closeDialog(); render(); toast('Задача удалена'); }

async function preparePhoto(file) {
  if (!file) return;
  const url = URL.createObjectURL(file); const image = new Image();
  image.onload = () => {
    const max = 1280; const scale = Math.min(1, max / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height); pendingPhoto = canvas.toDataURL('image/jpeg', .76);
    URL.revokeObjectURL(url); renderPhotoPreview(); toast('Фото прикреплено');
  };
  image.onerror = () => { URL.revokeObjectURL(url); toast('Не удалось прочитать фото'); };
  image.src = url;
}
function renderPhotoPreview() {
  $('#photoPreview').hidden = !pendingPhoto;
  if (pendingPhoto) {
    $('#photoPreviewImage').src = pendingPhoto;
    const task = tasks.find(t => t.id === $('#taskId').value); $('#photoMeta').textContent = task?.photoCapturedAt ? `Добавлено ${new Date(task.photoCapturedAt).toLocaleString('ru-RU')}` : 'Новое фото';
  } else { $('#photoPreviewImage').removeAttribute('src'); $('#photoMeta').textContent = ''; }
}
