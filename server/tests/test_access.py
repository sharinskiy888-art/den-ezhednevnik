"""Права на личные данные: чужой пользователь не видит, не меняет и не удаляет чужие строки (раздел 3 ТЗ)."""
import pytest

from conftest import row

pytestmark = pytest.mark.etap2
TABLES = ['tasks', 'expenses']


@pytest.fixture(params=TABLES)
def alice_row(request, server, alice):
    r = row(title='секрет Алисы')
    assert server.post(f'/api/data/{request.param}', [r], alice.token)[0] == 204
    return request.param, r


def test_other_cannot_list(server, bob, alice_row):
    table, r = alice_row
    assert all(x['id'] != r['id'] for x in server.get(f'/api/data/{table}', bob.token)[1])
    assert all(x['id'] != r['id'] for x in server.get(f'/api/data/{table}/heads', bob.token)[1])


def test_other_cannot_fetch_by_id(server, bob, alice_row):
    table, r = alice_row
    assert server.get(f"/api/data/{table}?ids={r['id']}", bob.token)[1] == []


def test_other_cannot_overwrite(server, alice, bob, alice_row):
    table, r = alice_row
    fake = row(id=r['id'], updated_at='2030-01-01T00:00:00.000Z', title='взлом')
    fake['user_id'] = alice.id  # попытка подставить чужого владельца в теле
    server.post(f'/api/data/{table}', [fake], bob.token)
    mine = server.get(f"/api/data/{table}?ids={r['id']}", alice.token)[1]
    assert mine == [r]


def test_other_cannot_delete(server, alice, bob, alice_row):
    table, r = alice_row
    assert server.delete(f"/api/data/{table}/{r['id']}", bob.token)[0] in (204, 404)
    assert server.get(f"/api/data/{table}?ids={r['id']}", alice.token)[1] == [r]


def test_admin_does_not_see_user_data_through_sync(server, admin, alice_row):
    table, r = alice_row
    assert all(x['id'] != r['id'] for x in server.get(f'/api/data/{table}', admin.token)[1])


def test_deleted_user_data_removed(server, admin, make_user):
    u = make_user()
    r = row()
    server.post('/api/data/tasks', [r], u.token)
    server.delete(f'/api/admin/users/{u.id}', admin.token)
    v = make_user()
    assert server.get(f"/api/data/tasks?ids={r['id']}", v.token)[1] == []
