"""Синхронизация личных данных: задачи, планы (строка состояния), финансы. Договор с sync.js."""
import json
import uuid

import pytest

from conftest import row

pytestmark = pytest.mark.etap2
STATE_ID = '00000000-0000-4000-8000-000000000001'
TABLES = ['tasks', 'expenses']


@pytest.mark.parametrize('table', TABLES)
def test_requires_login(server, table):
    for method in ('GET', 'POST'):
        assert server.call(method, f'/api/data/{table}', [] if method == 'POST' else None)[0] == 401
    assert server.get(f'/api/data/{table}/heads')[0] == 401


def test_unknown_table_404(server, alice):
    assert server.get('/api/data/users', alice.token)[0] == 404
    assert server.post('/api/data/planner_tasks', [row()], alice.token)[0] == 404


@pytest.mark.parametrize('table', TABLES)
def test_empty_for_new_user(server, alice, table):
    assert server.get(f'/api/data/{table}', alice.token)[:2] == (200, [])
    assert server.get(f'/api/data/{table}/heads', alice.token)[:2] == (200, [])


@pytest.mark.parametrize('table', TABLES)
def test_upsert_and_read_back(server, alice, table):
    r = row(note='первая')
    assert server.post(f'/api/data/{table}', [r], alice.token)[0] == 204
    status, rows, _ = server.get(f'/api/data/{table}', alice.token)
    assert status == 200 and rows == [r]


def test_payload_kept_byte_for_byte(server, alice):
    """Неизвестные поля, вложенность, юникод и большие числа не теряются: сервер не разбирает payload."""
    r = row(title='Проверка «ёжик» 🚒', subtasks=[{'title': 'а', 'done': True, 'doneBy': '', 'doneAt': ''}],
            futureField={'deep': [1, 2.5, None, True]}, amount=1234567.89, attachment={'name': 'a.jpg', 'data': 'data:image/jpeg;base64,' + 'A' * 1000})
    server.post('/api/data/tasks', [r], alice.token)
    rows = server.get('/api/data/tasks', alice.token)[1]
    assert json.dumps(rows[0]['payload'], sort_keys=True) == json.dumps(r['payload'], sort_keys=True)


def test_updated_at_stored_as_sent_by_device(server, alice):
    r = row(updated_at='2020-01-02T03:04:05.678Z')
    server.post('/api/data/tasks', [r], alice.token)
    assert server.get('/api/data/tasks', alice.token)[1][0]['updated_at'] == '2020-01-02T03:04:05.678Z'


def test_replace_existing_row(server, alice):
    r = row(title='старое')
    server.post('/api/data/tasks', [r], alice.token)
    r2 = row(id=r['id'], updated_at='2026-10-25T11:00:00.000Z', title='новое')
    server.post('/api/data/tasks', [r2], alice.token)
    rows = server.get('/api/data/tasks', alice.token)[1]
    assert len(rows) == 1 and rows[0]['payload']['title'] == 'новое'


def test_heads_are_light(server, alice):
    a = row(attachment={'data': 'X' * 50000})
    b = {'id': 'no-pu', 'payload': {'id': 'no-pu'}, 'updated_at': '2026-01-01T00:00:00.000Z'}
    server.post('/api/data/tasks', [a, b], alice.token)
    status, heads, _ = server.get('/api/data/tasks/heads', alice.token)
    assert status == 200
    by_id = {h['id']: h for h in heads}
    assert by_id[a['id']] == {'id': a['id'], 'updated_at': a['updated_at'], 'pu': a['payload']['updatedAt']}
    assert by_id['no-pu']['pu'] is None
    assert len(json.dumps(heads)) < 1000


def test_fetch_by_ids(server, alice):
    rows = [row() for _ in range(5)]
    server.post('/api/data/tasks', rows, alice.token)
    ids = [rows[1]['id'], rows[3]['id'], 'missing-id']
    status, got, _ = server.get('/api/data/tasks?ids=' + ','.join(ids), alice.token)
    assert status == 200 and sorted(r['id'] for r in got) == sorted(ids[:2])


def test_more_than_1000_rows_returned_whole(server, make_user):
    u = make_user()
    rows = [row() for _ in range(1205)]
    for i in range(0, len(rows), 400):
        assert server.post('/api/data/tasks', rows[i:i + 400], u.token)[0] == 204
    assert len(server.get('/api/data/tasks/heads', u.token)[1]) == 1205
    assert len(server.get('/api/data/tasks', u.token)[1]) == 1205


def test_tombstone_is_ordinary_row(server, alice):
    t = {'id': 'gone', 'payload': {'id': 'gone', '__deleted': True, 'updatedAt': '2026-10-25T12:00:00.000Z'}, 'updated_at': '2026-10-25T12:00:00.000Z'}
    server.post('/api/data/tasks', [t], alice.token)
    got = server.get('/api/data/tasks?ids=gone', alice.token)[1]
    assert got == [t]


def test_delete_own_row(server, alice):
    r = row()
    server.post('/api/data/tasks', [r], alice.token)
    assert server.delete(f"/api/data/tasks/{r['id']}", alice.token)[0] == 204
    assert all(x['id'] != r['id'] for x in server.get('/api/data/tasks', alice.token)[1])


def test_state_row_per_user(server, alice, bob):
    a = {'id': STATE_ID, 'payload': {'__type': 'app_state', 'profile': {'name': 'Алиса'}, 'updatedAt': '2026-10-25T10:00:00.000Z'}, 'updated_at': '2026-10-25T10:00:00.000Z'}
    b = {'id': STATE_ID, 'payload': {'__type': 'app_state', 'profile': {'name': 'Боб'}, 'updatedAt': '2026-10-25T10:00:00.000Z'}, 'updated_at': '2026-10-25T10:00:00.000Z'}
    server.post('/api/data/tasks', [a], alice.token)
    server.post('/api/data/tasks', [b], bob.token)
    assert server.get(f'/api/data/tasks?ids={STATE_ID}', alice.token)[1][0]['payload']['profile']['name'] == 'Алиса'
    assert server.get(f'/api/data/tasks?ids={STATE_ID}', bob.token)[1][0]['payload']['profile']['name'] == 'Боб'


def test_tables_are_separate(server, alice):
    r = row()
    server.post('/api/data/expenses', [r], alice.token)
    assert all(x['id'] != r['id'] for x in server.get('/api/data/tasks', alice.token)[1])


@pytest.mark.parametrize('bad', [
    {'id': '', 'payload': {}, 'updated_at': '2026-10-25T10:00:00Z'},
    {'id': 'x' * 101, 'payload': {}, 'updated_at': '2026-10-25T10:00:00Z'},
    {'id': 'ok', 'payload': 'не объект', 'updated_at': '2026-10-25T10:00:00Z'},
    {'id': 'ok', 'payload': {}},
    {'payload': {}, 'updated_at': '2026-10-25T10:00:00Z'},
])
def test_bad_rows_rejected_and_nothing_written(server, make_user, bad):
    u = make_user()
    status, body, _ = server.post('/api/data/tasks', [row(), bad], u.token)
    assert status in (400, 422) and body.get('message')
    assert server.get('/api/data/tasks', u.token)[1] == []


def test_body_must_be_list(server, alice):
    assert server.post('/api/data/tasks', row(), alice.token)[0] in (400, 422)


def test_oversized_row_rejected(server, alice):
    big = row(attachment={'data': 'A' * (9 * 1024 * 1024)})
    assert server.post('/api/data/tasks', [big], alice.token)[0] == 413


def test_photo_row_under_limit_accepted(server, alice):
    ok = row(attachment={'data': 'A' * (5 * 1024 * 1024)})
    assert server.post('/api/data/tasks', [ok], alice.token)[0] == 204


def test_finance_amounts_untouched(server, alice):
    e = {'id': str(uuid.uuid4()), 'payload': {'kind': 'expense', 'title': 'Кабель', 'amount': 1234.56, 'category': 'other',
                                              'occurredAt': '2026-10-25T09:00:00.000Z', 'updatedAt': '2026-10-25T09:00:00.000Z'},
         'updated_at': '2026-10-25T09:00:00.000Z'}
    server.post('/api/data/expenses', [e], alice.token)
    assert server.get(f"/api/data/expenses?ids={e['id']}", alice.token)[1][0]['payload']['amount'] == 1234.56
