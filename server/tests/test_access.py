"""Права на личные данные: чужой пользователь не видит, не меняет и не удаляет чужие строки (раздел 3 ТЗ)."""
import pytest

from conftest import row

pytestmark = pytest.mark.etap2


@pytest.fixture(params=['tasks', 'expenses'])
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
    assert server.post(f'/api/data/{table}', [fake], bob.token)[0] == 204  # пишется в данные самого Боба
    assert server.get(f"/api/data/{table}?ids={r['id']}", alice.token)[1] == [r]
    assert server.get(f"/api/data/{table}?ids={r['id']}", bob.token)[1][0]['payload']['title'] == 'взлом'


def test_other_cannot_delete(server, alice, bob, alice_row):
    table, r = alice_row
    assert server.delete(f"/api/data/{table}/{r['id']}", bob.token)[0] == 204
    assert server.get(f"/api/data/{table}?ids={r['id']}", alice.token)[1] == [r]


def test_admin_does_not_see_user_data_through_sync(server, admin, alice_row):
    table, r = alice_row
    assert all(x['id'] != r['id'] for x in server.get(f'/api/data/{table}', admin.token)[1])


def test_deleted_user_data_really_removed(server, admin, make_user):
    u = make_user()
    r = row()
    server.post('/api/data/tasks', [r], u.token)
    assert server.delete(f'/api/admin/users/{u.id}', admin.token)[0] == 204
    again = make_user(id=u.id)  # тот же id — старые строки не должны «воскреснуть»
    assert server.get('/api/data/tasks', again.token)[1] == []
