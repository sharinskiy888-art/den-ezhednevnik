"""Поручения: кто что видит и меняет (раздел 3 ТЗ, закрытие дыры прав shared_tasks), присутствие."""
import copy
import uuid

import pytest

pytestmark = pytest.mark.etap3
T0 = '2026-10-25T10:00:00.000Z'


def new_task(owner, invited=(), **payload):
    tid = str(uuid.uuid4())
    base = {'title': 'Смонтировать АПС', 'date': '2026-10-26', 'note': 'объект на Ленина', 'status': 'new', 'completed': False,
            'subtasks': [{'title': 'Кабель', 'done': False}, {'title': 'Датчики', 'done': False}],
            'reports': [], 'activity': [{'type': 'created', 'email': owner.email, 'at': T0}], 'updatedAt': T0}
    base.update(payload)
    return {'id': tid, 'owner_id': owner.id, 'owner_email': owner.email,
            'invited_emails': list(invited), 'accepted_emails': [], 'payload': base, 'updated_at': T0}


@pytest.fixture
def team(server, make_user):
    """Организатор, принявший исполнитель, приглашённый (ещё не принял) и посторонний."""
    owner, worker, invited, stranger = make_user(), make_user(), make_user(), make_user()
    task = new_task(owner, [worker.email, invited.email])
    assert server.post('/api/shared', task, owner.token)[0] in (200, 201, 204)
    assert server.post(f"/api/shared/{task['id']}/answer", {'accept': True}, worker.token)[0] in (200, 204)
    return {'owner': owner, 'worker': worker, 'invited': invited, 'stranger': stranger, 'id': task['id']}


def get(server, team, who='owner'):
    status, body, _ = server.get(f"/api/shared/{team['id']}", team[who].token)
    assert status == 200, (status, body)
    return body


def worker_patch(server, team, change, who='worker'):
    cur = get(server, team, who)
    payload = copy.deepcopy(cur['payload'])
    change(payload)
    payload['updatedAt'] = '2026-10-25T11:00:00.000Z'
    return server.patch(f"/api/shared/{team['id']}", {'payload': payload, 'updated_at': payload['updatedAt']}, team[who].token)[0]


# --- Видимость ---

def test_participants_see_task(server, team):
    for who in ('owner', 'worker', 'invited'):
        heads = server.get('/api/shared/heads', team[who].token)[1]
        assert any(h['id'] == team['id'] for h in heads), who
        assert set(heads[0]) >= {'id', 'updated_at', 'pu', 'invited_emails', 'accepted_emails'}


def test_stranger_sees_nothing(server, team):
    s = team['stranger']
    assert all(h['id'] != team['id'] for h in server.get('/api/shared/heads', s.token)[1])
    assert server.get(f"/api/shared/{team['id']}", s.token)[0] == 404
    assert server.get(f"/api/shared?ids={team['id']}", s.token)[1] == []


def test_answer_moves_email_to_accepted(server, team):
    row = get(server, team)
    assert team['worker'].email in row['accepted_emails'] and team['worker'].email not in row['invited_emails']
    assert team['invited'].email in row['invited_emails']


def test_cannot_decline(server, team):
    assert server.post(f"/api/shared/{team['id']}/answer", {'accept': False}, team['invited'].token)[0] == 400
    assert team['invited'].email in get(server, team)['invited_emails']


def test_stranger_cannot_answer(server, team):
    assert server.post(f"/api/shared/{team['id']}/answer", {'accept': True}, team['stranger'].token)[0] in (403, 404)
    assert team['stranger'].email not in get(server, team)['accepted_emails']


# --- Создание ---

def test_owner_comes_from_token(server, make_user):
    a, b = make_user(), make_user()
    t = new_task(a)
    t['owner_id'], t['owner_email'] = b.id, b.email
    assert server.post('/api/shared', t, a.token)[0] in (200, 201, 204)
    row = server.get(f"/api/shared/{t['id']}", a.token)[1]
    assert row['owner_id'] == a.id and row['owner_email'] == a.email


def test_create_with_existing_id_conflicts(server, team):
    t = new_task(team['stranger'])
    t['id'] = team['id']
    assert server.post('/api/shared', t, team['stranger'].token)[0] == 409
    assert get(server, team)['owner_id'] == team['owner'].id


# --- Организатор ---

def test_owner_changes_everything(server, team):
    row = get(server, team)
    row['payload']['title'] = 'Новый текст'
    row['payload']['nudgeAt'] = '2026-10-25T12:00:00.000Z'
    row['invited_emails'] = []
    row['updated_at'] = row['payload']['updatedAt'] = '2026-10-25T12:00:00.000Z'
    body = {k: row[k] for k in ('payload', 'updated_at', 'invited_emails', 'accepted_emails')}
    assert server.patch(f"/api/shared/{team['id']}", body, team['owner'].token)[0] in (200, 204)
    after = get(server, team)
    assert after['payload']['title'] == 'Новый текст' and after['invited_emails'] == []


def test_owner_cannot_give_away_ownership_by_patch(server, team):
    status = server.patch(f"/api/shared/{team['id']}", {'owner_id': team['worker'].id, 'owner_email': team['worker'].email}, team['owner'].token)[0]
    assert status in (400, 403) or get(server, team)['owner_id'] == team['owner'].id
    assert get(server, team)['owner_id'] == team['owner'].id


def test_only_owner_deletes(server, team):
    assert server.delete(f"/api/shared/{team['id']}", team['worker'].token)[0] in (403, 404)
    assert server.delete(f"/api/shared/{team['id']}", team['stranger'].token)[0] in (403, 404)
    assert server.get(f"/api/shared/{team['id']}", team['owner'].token)[0] == 200
    assert server.delete(f"/api/shared/{team['id']}", team['owner'].token)[0] == 204
    assert server.get(f"/api/shared/{team['id']}", team['owner'].token)[0] == 404


# --- Исполнитель: что можно ---

def test_worker_sets_status(server, team):
    def ch(p): p.update(status='review', statusBy=team['worker'].email, statusAt='2026-10-25T11:00:00.000Z')
    assert worker_patch(server, team, ch) in (200, 204)
    assert get(server, team)['payload']['status'] == 'review'


def test_worker_ticks_subtask(server, team):
    def ch(p): p['subtasks'][0].update(done=True, doneBy=team['worker'].email, doneAt='2026-10-25T11:00:00.000Z')
    assert worker_patch(server, team, ch) in (200, 204)
    assert get(server, team)['payload']['subtasks'][0]['done'] is True


def test_worker_adds_and_removes_own_report(server, team):
    w = team['worker'].email
    def add(p): p['reports'].append({'id': 'r1', 'by': w, 'at': T0, 'text': 'Сделал', 'photo': f"shared/{team['id']}/a.jpg"})
    assert worker_patch(server, team, add) in (200, 204)
    def remove(p): p['reports'] = [r for r in p['reports'] if r['id'] != 'r1']
    assert worker_patch(server, team, remove) in (200, 204)
    assert get(server, team)['payload']['reports'] == []


def test_worker_appends_activity_and_old_entries_may_drop(server, team):
    w = team['worker'].email
    def ch(p): p['activity'] = p['activity'][1:] + [{'type': 'status', 'status': 'open', 'email': w, 'at': T0}]
    assert worker_patch(server, team, ch) in (200, 204)


# --- Исполнитель: что нельзя (дыра прав shared_tasks) ---

FORBIDDEN = {
    'текст задачи': lambda p, t: p.update(title='Подмена'),
    'заметку': lambda p, t: p.update(note='Подмена'),
    'дату': lambda p, t: p.update(date='2030-01-01'),
    'вложение': lambda p, t: p.update(attachment={'name': 'x.jpg', 'data': 'data:'}),
    'статус «завершено»': lambda p, t: p.update(status='completed', completed=True),
    'completed=true': lambda p, t: p.update(completed=True),
    'напоминание организатора': lambda p, t: p.update(nudgeAt='2026-10-25T11:00:00.000Z', nudgeNumber=1),
    'название подзадачи': lambda p, t: p['subtasks'][0].update(title='Другое'),
    'число подзадач': lambda p, t: p['subtasks'].append({'title': 'Новая', 'done': False}),
    'чужой отчёт': lambda p, t: p['reports'].append({'id': 'r9', 'by': t['owner'].email, 'at': T0, 'text': 'от имени организатора'}),
    'запись истории от чужого имени': lambda p, t: p['activity'].append({'type': 'completed', 'email': t['owner'].email, 'at': T0}),
    'новое поле': lambda p, t: p.update(price=100000),
}


@pytest.mark.parametrize('what', FORBIDDEN)
def test_worker_cannot_change(server, team, what):
    before = get(server, team)['payload']
    assert worker_patch(server, team, lambda p: FORBIDDEN[what](p, team)) == 403
    assert get(server, team)['payload'] == before


def test_worker_cannot_delete_owner_report(server, team):
    o = team['owner']
    row = get(server, team)
    row['payload']['reports'] = [{'id': 'r0', 'by': o.email, 'at': T0, 'text': 'Задание'}]
    server.patch(f"/api/shared/{team['id']}", {'payload': row['payload'], 'updated_at': row['updated_at']}, o.token)
    assert worker_patch(server, team, lambda p: p.update(reports=[])) == 403


@pytest.mark.parametrize('column', ['owner_id', 'owner_email', 'invited_emails', 'accepted_emails', 'leave_requests'])
def test_worker_cannot_change_columns(server, team, column):
    value = {'owner_id': team['worker'].id, 'owner_email': team['worker'].email}.get(column, [team['worker'].email, 'friend@den.test'])
    before = get(server, team)
    assert server.patch(f"/api/shared/{team['id']}", {column: value, 'updated_at': before['updated_at']}, team['worker'].token)[0] == 403
    after = get(server, team)
    assert after[column] == before[column]


def test_worker_cannot_remove_self(server, team):
    w = team['worker'].email
    row = get(server, team)
    body = {'accepted_emails': [e for e in row['accepted_emails'] if e != w], 'updated_at': row['updated_at']}
    assert server.patch(f"/api/shared/{team['id']}", body, team['worker'].token)[0] == 403
    assert w in get(server, team)['accepted_emails']


def test_invited_but_not_accepted_cannot_edit(server, team):
    assert worker_patch(server, team, lambda p: p.update(status='open'), who='invited') == 403


def test_stranger_cannot_patch(server, team):
    status = server.patch(f"/api/shared/{team['id']}", {'payload': {'title': 'x'}, 'updated_at': T0}, team['stranger'].token)[0]
    assert status in (403, 404)


# --- Выход только с согласия организатора ---

def test_leave_request_then_owner_removes(server, team):
    w = team['worker']
    assert server.post(f"/api/shared/{team['id']}/leave", token=w.token)[0] in (200, 204)
    row = get(server, team)
    assert w.email in row['leave_requests'] and w.email in row['accepted_emails']
    body = {'accepted_emails': [e for e in row['accepted_emails'] if e != w.email], 'leave_requests': [], 'updated_at': row['updated_at']}
    assert server.patch(f"/api/shared/{team['id']}", body, team['owner'].token)[0] in (200, 204)
    assert server.get(f"/api/shared/{team['id']}", w.token)[0] == 404


# --- Присутствие ---

def test_presence_only_for_teammates(server, team):
    for who in ('owner', 'worker', 'stranger'):
        assert server.post('/api/presence', {'locale': 'ru'}, team[who].token)[0] in (200, 204)
    seen = {r['email'] for r in server.get('/api/presence', team['owner'].token)[1]}
    assert team['worker'].email in seen and team['stranger'].email not in seen
    assert team['owner'].email not in {r['email'] for r in server.get('/api/presence', team['stranger'].token)[1]}


def test_presence_requires_login(server):
    assert server.get('/api/presence')[0] == 401
