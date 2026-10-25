"""Поручения: кто что видит и меняет (раздел 3 ТЗ, закрытие дыры прав shared_tasks), присутствие."""
import copy

import pytest

from conftest import T0, new_task

pytestmark = pytest.mark.etap3
T1 = '2026-10-25T11:00:00.000Z'


def get(server, team, who='owner'):
    status, body, _ = server.get(f"/api/shared/{team['id']}", team[who].token)
    assert status == 200, (status, body)
    return body


def owner_set(server, team, change):
    """Организатор правит payload так же, как нынешний sync.js: присылает всю строку целиком."""
    cur = get(server, team)
    change(cur['payload'])
    body = {k: v for k, v in cur.items() if k != 'id'}
    assert server.patch(f"/api/shared/{team['id']}", body, team['owner'].token)[0] == 204


def worker_patch(server, team, change, who='worker'):
    cur = get(server, team, who)
    payload = copy.deepcopy(cur['payload'])
    change(payload)
    payload['updatedAt'] = T1
    return server.patch(f"/api/shared/{team['id']}", {'payload': payload, 'updated_at': T1}, team[who].token)[0]


# --- Видимость ---

def test_participants_see_task(server, team):
    for who in ('owner', 'worker', 'invited'):
        heads = server.get('/api/shared/heads', team[who].token)[1]
        mine = [h for h in heads if h['id'] == team['id']]
        assert mine and set(mine[0]) >= {'id', 'updated_at', 'pu', 'invited_emails', 'accepted_emails'}, who


def test_heads_newest_first_and_fetch_by_ids(server, make_user):
    o = make_user()
    old, new = new_task(o), new_task(o)
    old['updated_at'] = old['payload']['updatedAt'] = '2026-01-01T00:00:00.000Z'
    new['updated_at'] = new['payload']['updatedAt'] = '2026-12-01T00:00:00.000Z'
    for t in (old, new):
        assert server.post('/api/shared', t, o.token)[0] == 201
    assert [h['id'] for h in server.get('/api/shared/heads', o.token)[1]] == [new['id'], old['id']]
    got = server.get(f"/api/shared?ids={old['id']},{new['id']},missing", o.token)[1]
    assert sorted(r['id'] for r in got) == sorted([old['id'], new['id']])
    assert set(got[0]) >= {'id', 'owner_id', 'owner_email', 'invited_emails', 'accepted_emails', 'leave_requests', 'payload', 'updated_at'}


def test_stranger_sees_nothing(server, team):
    s = team['stranger']
    assert all(h['id'] != team['id'] for h in server.get('/api/shared/heads', s.token)[1])
    assert server.get(f"/api/shared/{team['id']}", s.token)[0] == 404
    assert server.get(f"/api/shared?ids={team['id']}", s.token)[1] == []


def test_answer_moves_email_to_accepted_and_repeat_is_ok(server, team):
    row = get(server, team)
    assert team['worker'].email in row['accepted_emails'] and team['worker'].email not in row['invited_emails']
    assert team['invited'].email in row['invited_emails']
    assert server.post(f"/api/shared/{team['id']}/answer", {'accept': True}, team['worker'].token)[0] == 204  # двойное нажатие
    assert get(server, team)['accepted_emails'].count(team['worker'].email) == 1


def test_invite_email_case_insensitive(server, make_user):
    o, w = make_user(), make_user()
    t = new_task(o, [w.email.upper()])
    assert server.post('/api/shared', t, o.token)[0] == 201
    assert server.post(f"/api/shared/{t['id']}/answer", {'accept': True}, w.token)[0] == 204


def test_cannot_decline(server, team):
    assert server.post(f"/api/shared/{team['id']}/answer", {'accept': False}, team['invited'].token)[0] == 400
    assert team['invited'].email in get(server, team)['invited_emails']


def test_stranger_cannot_answer(server, team):
    assert server.post(f"/api/shared/{team['id']}/answer", {'accept': True}, team['stranger'].token)[0] == 404
    assert team['stranger'].email not in get(server, team)['accepted_emails']


# --- Создание ---

def test_owner_comes_from_token_and_accepted_starts_empty(server, make_user):
    a, b = make_user(), make_user()
    t = new_task(a, [b.email])
    t['owner_id'], t['owner_email'] = b.id, b.email
    t['accepted_emails'] = [b.email]  # нельзя «принять» за другого
    assert server.post('/api/shared', t, a.token)[0] == 201
    r = server.get(f"/api/shared/{t['id']}", a.token)[1]
    assert r['owner_id'] == a.id and r['owner_email'] == a.email and r['accepted_emails'] == [] and r['updated_at'] == T0


def test_repeat_create_by_owner_updates(server, make_user):
    """Ответ на создание потерялся, телефон шлёт ещё раз — это не ошибка."""
    o = make_user()
    t = new_task(o)
    assert server.post('/api/shared', t, o.token)[0] == 201
    t['payload']['title'] = 'Уточнил'
    assert server.post('/api/shared', t, o.token)[0] == 200
    assert server.get(f"/api/shared/{t['id']}", o.token)[1]['payload']['title'] == 'Уточнил'


def test_create_with_someone_elses_id_conflicts(server, team):
    t = new_task(team['stranger'])
    t['id'] = team['id']
    assert server.post('/api/shared', t, team['stranger'].token)[0] == 409
    assert server.post('/api/shared', t, team['worker'].token)[0] == 409
    assert get(server, team)['owner_id'] == team['owner'].id


# --- Организатор ---

def test_owner_changes_everything_with_full_row(server, team):
    def ch(p):
        p.update(title='Новый текст', nudgeAt='2026-10-25T12:00:00.000Z', updatedAt='2026-10-25T12:00:00.000Z')
    owner_set(server, team, ch)
    assert get(server, team)['payload']['title'] == 'Новый текст'
    cur = get(server, team)
    body = {'invited_emails': [], 'accepted_emails': cur['accepted_emails'], 'updated_at': cur['updated_at']}
    assert server.patch(f"/api/shared/{team['id']}", body, team['owner'].token)[0] == 204
    assert get(server, team)['invited_emails'] == []


def test_owner_cannot_give_away_ownership_by_patch(server, team):
    status = server.patch(f"/api/shared/{team['id']}", {'owner_id': team['worker'].id, 'owner_email': team['worker'].email}, team['owner'].token)[0]
    assert status == 403
    assert get(server, team)['owner_id'] == team['owner'].id


def test_only_owner_deletes(server, team):
    assert server.delete(f"/api/shared/{team['id']}", team['worker'].token)[0] == 404
    assert server.delete(f"/api/shared/{team['id']}", team['stranger'].token)[0] == 404
    assert server.get(f"/api/shared/{team['id']}", team['owner'].token)[0] == 200
    assert server.delete(f"/api/shared/{team['id']}", team['owner'].token)[0] == 204
    assert server.get(f"/api/shared/{team['id']}", team['owner'].token)[0] == 404


# --- Исполнитель: что можно ---

def test_worker_sets_status(server, team):
    def ch(p): p.update(status='review', statusBy=team['worker'].email, statusAt=T1)
    assert worker_patch(server, team, ch) == 204
    assert get(server, team)['payload']['status'] == 'review'


def test_worker_reopens_completed_task(server, team):
    owner_set(server, team, lambda p: p.update(status='completed', completed=True))
    assert worker_patch(server, team, lambda p: p.update(status='open', completed=False)) == 204


def test_worker_ticks_subtask(server, team):
    def ch(p): p['subtasks'][0].update(done=True, doneBy=team['worker'].email, doneAt=T1)
    assert worker_patch(server, team, ch) == 204
    assert get(server, team)['payload']['subtasks'][0]['done'] is True


def test_worker_sends_full_row_with_unchanged_columns(server, team):
    """Если клиент пришлёт и прежние столбцы участников — это не попытка их изменить."""
    cur = get(server, team, 'worker')
    cur['payload']['status'] = 'open'
    body = {k: v for k, v in cur.items() if k != 'id'}
    assert server.patch(f"/api/shared/{team['id']}", body, team['worker'].token)[0] == 204


def test_worker_adds_and_removes_own_report(server, team):
    w = team['worker'].email
    def add(p): p['reports'].append({'id': 'r1', 'by': w, 'at': T0, 'text': 'Сделал', 'photo': f"shared/{team['id']}/a.jpg"})
    assert worker_patch(server, team, add) == 204
    def remove(p): p['reports'] = [r for r in p['reports'] if r['id'] != 'r1']
    assert worker_patch(server, team, remove) == 204
    assert get(server, team)['payload']['reports'] == []


def test_51st_report_may_push_out_oldest(server, team):
    """app.js хранит последние 50 отчётов: новый отчёт исполнителя вытесняет самый старый, даже чужой."""
    o = team['owner'].email
    owner_set(server, team, lambda p: p.update(reports=[{'id': f'o{i}', 'by': o, 'at': T0, 'text': str(i)} for i in range(50)]))
    w = team['worker'].email
    def add(p): p['reports'] = (p['reports'] + [{'id': 'w1', 'by': w, 'at': T1, 'text': 'новый'}])[-50:]
    assert worker_patch(server, team, add) == 204
    assert [r['id'] for r in get(server, team)['payload']['reports']][-1] == 'w1'


def test_worker_appends_activity_and_old_entries_may_drop(server, team):
    w = team['worker'].email
    o = team['owner'].email
    owner_set(server, team, lambda p: p.update(activity=[{'type': 'updated', 'email': o, 'at': T0}] * 30))
    def ch(p): p['activity'] = (p['activity'] + [{'type': 'status', 'status': 'open', 'email': w, 'at': T1}])[-30:]
    assert worker_patch(server, team, ch) == 204


# --- Исполнитель: что нельзя (дыра прав shared_tasks) ---

FORBIDDEN = {
    'текст задачи': lambda p, t: p.update(title='Подмена'),
    'заметку': lambda p, t: p.update(note='Подмена'),
    'дату': lambda p, t: p.update(date='2030-01-01'),
    'вложение': lambda p, t: p.update(attachment={'name': 'x.jpg', 'data': 'data:'}),
    'статус «завершено»': lambda p, t: p.update(status='completed', completed=True),
    'completed=true': lambda p, t: p.update(completed=True),
    'напоминание организатора': lambda p, t: p.update(nudgeAt=T1, nudgeNumber=1),
    'название подзадачи': lambda p, t: p['subtasks'][0].update(title='Другое'),
    'число подзадач': lambda p, t: p['subtasks'].append({'title': 'Новая', 'done': False}),
    'чужой отчёт': lambda p, t: p['reports'].append({'id': 'r9', 'by': t['owner'].email, 'at': T0, 'text': 'от имени организатора'}),
    'запись истории от чужого имени': lambda p, t: p['activity'].append({'type': 'completed', 'email': t['owner'].email, 'at': T0}),
    'старую запись истории': lambda p, t: p['activity'][0].update(type='deleted'),
    'новое поле': lambda p, t: p.update(price=100000),
    'удалить поле': lambda p, t: p.pop('note'),
}


@pytest.mark.parametrize('what', FORBIDDEN)
def test_worker_cannot_change(server, team, what):
    before = get(server, team)['payload']
    assert worker_patch(server, team, lambda p: FORBIDDEN[what](p, team)) == 403
    assert get(server, team)['payload'] == before


def test_worker_cannot_delete_owner_report_in_middle(server, team):
    o, w = team['owner'].email, team['worker'].email
    owner_set(server, team, lambda p: p.update(reports=[{'id': 'r0', 'by': o, 'at': T0, 'text': 'Задание'},
                                                       {'id': 'r1', 'by': w, 'at': T0, 'text': 'Мой'}]))
    assert worker_patch(server, team, lambda p: p.update(reports=[p['reports'][1]])) == 403


@pytest.mark.parametrize('column', ['owner_id', 'owner_email', 'invited_emails', 'accepted_emails', 'leave_requests'])
def test_worker_cannot_change_columns(server, team, column):
    value = {'owner_id': team['worker'].id, 'owner_email': team['worker'].email}.get(column, [team['worker'].email, 'friend@den.test'])
    before = get(server, team)
    assert server.patch(f"/api/shared/{team['id']}", {column: value, 'updated_at': before['updated_at']}, team['worker'].token)[0] == 403
    assert get(server, team)[column] == before[column]


def test_worker_cannot_remove_self(server, team):
    w = team['worker'].email
    row = get(server, team)
    body = {'accepted_emails': [e for e in row['accepted_emails'] if e != w], 'updated_at': row['updated_at']}
    assert server.patch(f"/api/shared/{team['id']}", body, team['worker'].token)[0] == 403
    assert w in get(server, team)['accepted_emails']


def test_invited_but_not_accepted_cannot_edit(server, team):
    assert worker_patch(server, team, lambda p: p.update(status='open'), who='invited') == 403


def test_stranger_cannot_patch(server, team):
    assert server.patch(f"/api/shared/{team['id']}", {'payload': {'title': 'x'}, 'updated_at': T0}, team['stranger'].token)[0] == 404


# --- Выход только с согласия организатора ---

def test_leave_request_then_owner_removes(server, team):
    w = team['worker']
    assert server.post(f"/api/shared/{team['id']}/leave", token=w.token)[0] == 204
    row = get(server, team)
    assert w.email in row['leave_requests'] and w.email in row['accepted_emails']
    body = {'accepted_emails': [e for e in row['accepted_emails'] if e != w.email], 'leave_requests': [], 'updated_at': row['updated_at']}
    assert server.patch(f"/api/shared/{team['id']}", body, team['owner'].token)[0] == 204
    assert server.get(f"/api/shared/{team['id']}", w.token)[0] == 404


def test_leave_only_for_accepted_worker(server, team):
    assert server.post(f"/api/shared/{team['id']}/leave", token=team['stranger'].token)[0] == 404
    assert server.post(f"/api/shared/{team['id']}/leave", token=team['invited'].token)[0] == 403
    assert get(server, team)['leave_requests'] == []


# --- Присутствие ---

def test_presence_only_for_teammates(server, team):
    for who in ('owner', 'worker', 'stranger'):
        assert server.post('/api/presence', {'locale': 'ru'}, team[who].token)[0] == 204
    seen = {r['email'] for r in server.get('/api/presence', team['owner'].token)[1]}
    assert team['worker'].email in seen and team['stranger'].email not in seen
    assert team['owner'].email not in {r['email'] for r in server.get('/api/presence', team['stranger'].token)[1]}


def test_presence_requires_login(server):
    assert server.get('/api/presence')[0] == 401
    assert server.post('/api/presence', {'locale': 'ru'})[0] == 401
