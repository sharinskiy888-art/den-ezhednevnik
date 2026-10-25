"""Этап 5: перенос из Supabase (поручения организатора) и сверка «устройство = сервер» в копейках."""
import subprocess
import sys
import uuid

import pytest

from conftest import ADMIN_EMAIL, ADMIN_PASSWORD, ROOT, SECRET, T0, User, row

pytestmark = pytest.mark.etap5
STATE_ID = '00000000-0000-4000-8000-000000000001'


def counts(**kw):
    base = {'tasks': 0, 'plans': 0, 'expenses': 0, 'incomeKop': '0', 'expenseKop': '0'}
    return {**base, **kw}


def report(server, user, device='dev-1', **kw):
    return server.post('/api/migration/report', {'device': device, 'label': 'Тест', 'counts': counts(**kw)}, user.token)


def fill(server, user):
    server.post('/api/data/tasks', [row(), row(), row(id='gone', __deleted=True),
                                     {'id': STATE_ID, 'payload': {'__type': 'app_state', 'periodPlans': [{'id': 'p1'}, {'id': 'p2'}, 'мусор'],
                                                                  'updatedAt': T0}, 'updated_at': T0}], user.token)
    server.post('/api/data/expenses', [row(kind='income', amount=1000.5), row(kind='expense', amount=0.1), row(kind='expense', amount=0.2),
                                        row(amount='250'), row(kind='expense', amount=19.995), row(id='del', __deleted=True, amount=5)], user.token)


# --- Сверка ---

def test_reconcile_counts_match(server, alice):
    fill(server, alice)
    status, body, _ = report(server, alice, tasks=2, plans=2, expenses=5, incomeKop='100050', expenseKop='27030')
    assert status == 200, body
    assert body['ok'] is True, body
    assert body['server'] == counts(tasks=2, plans=2, expenses=5, incomeKop='100050', expenseKop='27030')


def test_reconcile_mismatch_reported(server, alice, admin):
    fill(server, alice)
    status, body, _ = report(server, alice, tasks=3, plans=2, expenses=5, incomeKop='100050', expenseKop='27030')
    assert status == 200 and body['ok'] is False
    rows = {r['email']: r for r in server.get('/api/admin/reconcile', admin.token)[1]}
    assert rows[alice.email]['status'] == 'расхождение'
    assert rows[alice.email]['devices'][0]['report']['tasks'] == 3
    report(server, alice, tasks=2, plans=2, expenses=5, incomeKop='100050', expenseKop='27030')
    rows = {r['email']: r for r in server.get('/api/admin/reconcile', admin.token)[1]}
    assert rows[alice.email]['status'] == 'совпадает' and len(rows[alice.email]['devices']) == 1  # тот же телефон — одна строка


def test_reconcile_empty_user(server, bob):
    assert report(server, bob)[1]['ok'] is True


def test_reconcile_only_own_rows(server, alice, bob):
    fill(server, alice)
    assert report(server, bob)[1]['server'] == counts()


@pytest.mark.parametrize('bad', [{'tasks': -1}, {'tasks': 1.5}, {'tasks': True}, {'incomeKop': 12}, {'incomeKop': '1e5'},
                                 {'expenseKop': 'x'}, {'plans': '2'}, {'incomeKop': '--5'}, {'incomeKop': '²'}, {'incomeKop': '1' * 30}])
def test_reconcile_bad_numbers(server, alice, bad):
    assert report(server, alice, **bad)[0] == 400


def test_reconcile_needs_login_and_admin(server, alice):
    assert server.post('/api/migration/report', {'device': 'd', 'counts': counts()})[0] == 401
    assert server.get('/api/admin/reconcile', alice.token)[0] == 403


def test_reconcile_huge_sums_exact(server, alice):
    server.post('/api/data/expenses', [row(kind='income', amount=12345678901234.56)], alice.token)
    body = report(server, alice, expenses=1, incomeKop='1234567890123456')[1]
    assert body['ok'] is True, body


def test_reconcile_supabase_note_saved(server, alice, admin):
    server.post('/api/migration/report', {'device': 'd9', 'counts': counts(), 'supabase': {'shared': 2, 'files': 3}}, alice.token)
    rows = {r['email']: r for r in server.get('/api/admin/reconcile', admin.token)[1]}
    assert rows[alice.email]['devices'][0]['report']['supabase'] == {'shared': 2, 'files': 3}


# --- Перенос поручений ---

@pytest.fixture
def mserver(fresh_server):
    api = fresh_server(DEN_MIGRATION=1)
    admin = User(api.login(ADMIN_EMAIL, ADMIN_PASSWORD), ADMIN_PASSWORD)

    def make():
        email = f'u-{uuid.uuid4().hex[:8]}@den.test'
        assert api.post('/api/admin/users', {'email': email, 'password': 'user-pass-123'}, admin.token)[0] == 201
        return User(api.login(email, 'user-pass-123'), 'user-pass-123')
    api.make = make
    return api


def old_task(owner_email, worker_email, **kw):
    tid = str(uuid.uuid4())
    payload = {'title': 'АПС на складе', 'status': 'work', 'subtasks': [{'title': 'Кабель', 'done': True, 'doneBy': worker_email}],
               'reports': [{'id': 'r1', 'email': worker_email, 'text': 'готово', 'photo': f'shared/{tid}/{uuid.uuid4()}.jpg'}],
               'ownerId': 'старый-id', 'ownerEmail': owner_email, 'invitedEmails': ['чужой@x'], 'acceptedEmails': ['чужой@x'], '__remote': True,
               'updatedAt': T0}
    body = {'id': tid, 'invited_emails': [worker_email], 'accepted_emails': [worker_email], 'payload': payload, 'updated_at': T0}
    body.update(kw)
    return body


def test_import_shared_members_invited_and_fields_stripped(mserver):
    owner, worker = mserver.make(), mserver.make()
    task = old_task(owner.email, worker.email)
    status, body, _ = mserver.post('/api/migration/shared', task, owner.token)
    assert status == 201 and body == {'imported': True}
    got = mserver.get(f"/api/shared/{task['id']}", worker.token)[1]
    # Принятие сервер проверить не может: исполнитель приглашён и принимает задачу сам
    assert got['owner_id'] == owner.id and got['invited_emails'] == [worker.email] and got['accepted_emails'] == []
    assert not {'ownerId', 'ownerEmail', 'invitedEmails', 'acceptedEmails', '__remote'} & set(got['payload'])
    assert mserver.post(f"/api/shared/{task['id']}/answer", {'accept': True}, worker.token)[0] in (200, 204)
    got = mserver.get(f"/api/shared/{task['id']}", worker.token)[1]
    patch = {'payload': {**got['payload'], 'status': 'review', 'updatedAt': '2026-10-26T10:00:00.000Z'}, 'updated_at': '2026-10-26T10:00:00.000Z'}
    assert mserver.patch(f"/api/shared/{task['id']}", patch, worker.token)[0] == 204


def test_import_cannot_force_accept_stranger(mserver):
    owner, victim = mserver.make(), mserver.make()
    task = old_task(owner.email, victim.email, invited_emails=[])
    assert mserver.post('/api/migration/shared', task, owner.token)[0] == 201
    got = mserver.get(f"/api/shared/{task['id']}", victim.token)[1]
    assert got['accepted_emails'] == [] and got['invited_emails'] == [victim.email]
    assert mserver.get('/api/presence', owner.token)[1] == [] or all(p['email'] != victim.email for p in mserver.get('/api/presence', owner.token)[1])


def test_import_after_delete_not_restored(mserver):
    owner, worker = mserver.make(), mserver.make()
    task = old_task(owner.email, worker.email)
    mserver.post('/api/migration/shared', task, owner.token)
    assert mserver.delete(f"/api/shared/{task['id']}", owner.token)[0] == 204
    assert mserver.post('/api/migration/shared', task, owner.token)[1] == {'imported': False}  # второй телефон организатора
    assert mserver.get(f"/api/shared/{task['id']}", owner.token)[0] == 404


def test_import_twice_does_not_overwrite(mserver):
    owner, worker = mserver.make(), mserver.make()
    task = old_task(owner.email, worker.email)
    mserver.post('/api/migration/shared', task, owner.token)
    again = {**task, 'payload': {**task['payload'], 'title': 'старое'}}
    assert mserver.post('/api/migration/shared', again, owner.token)[1] == {'imported': False}
    assert mserver.get(f"/api/shared/{task['id']}", owner.token)[1]['payload']['title'] == 'АПС на складе'


def test_import_foreign_id_refused(mserver):
    owner, other, worker = mserver.make(), mserver.make(), mserver.make()
    task = old_task(owner.email, worker.email)
    mserver.post('/api/migration/shared', task, owner.token)
    assert mserver.post('/api/migration/shared', task, other.token)[0] == 409


@pytest.mark.parametrize('change', [{'id': 'crm-1'}, {'id': '../x'}, {'owner_id': 'x'}, {'payload': []}, {'payload': None}])
def test_import_bad_rows(mserver, change):
    owner, worker = mserver.make(), mserver.make()
    assert mserver.post('/api/migration/shared', old_task(owner.email, worker.email, **change), owner.token)[0] in (400, 403)


def test_import_closed_without_flag(server, alice, bob):
    status, body, _ = server.post('/api/migration/shared', old_task(alice.email, bob.email), alice.token)
    assert status == 403 and body['code'] == 'migration_closed'


def test_import_files_with_old_names(mserver):
    owner, worker, stranger = mserver.make(), mserver.make(), mserver.make()
    task = old_task(owner.email, worker.email)
    mserver.post('/api/migration/shared', task, owner.token)
    name = task['payload']['reports'][0]['photo'].split('/')[-1]
    path = f"/api/files/shared/{task['id']}/{name}"
    assert mserver.put(path, token=owner.token, raw=b'\xff\xd8jpeg')[0] == 201
    assert mserver.put(path, token=owner.token, raw=b'\xff\xd8jpeg')[0] == 409  # повтор переноса — файл уже есть
    assert mserver.put(path, token=worker.token, raw=b'x')[0] in (403, 404)
    assert mserver.get(path, worker.token)[1] == b'\xff\xd8jpeg'  # приглашённый смотрит
    assert mserver.get(path, stranger.token)[0] == 404


# --- Команды администратора ---

def run_admin(data_dir, *args):
    env = {'DEN_DATA_DIR': str(data_dir), 'DEN_SECRET': SECRET, 'PATH': '', 'SYSTEMROOT': ''}
    return subprocess.run([sys.executable, '-m', 'server.admin', *args], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)


def test_cli_add_with_old_id_and_reconcile(tmp_path):
    data = tmp_path / 'cli'
    old_id = '5b0f3e0c-1111-4222-8333-444455556666'
    done = run_admin(data, 'add', 'old@den.test', 'user-pass-123', '--id', old_id)
    assert done.returncode == 0, done.stderr
    users = run_admin(data, 'users')
    assert 'old@den.test' in users.stdout
    import sqlite3
    con = sqlite3.connect(data / 'den.db')
    assert con.execute('select id from users where email=?', ('old@den.test',)).fetchone()[0] == old_id
    con.close()
    assert run_admin(data, 'add', 'x@den.test', 'user-pass-123', '--id').returncode != 0
    assert run_admin(data, 'add', 'x@den.test', 'user-pass-123', '--id', 'a:b').returncode != 0
    dup = run_admin(data, 'add', 'y@den.test', 'user-pass-123', '--id', old_id)
    assert dup.returncode != 0 and 'Traceback' not in dup.stderr
    out = run_admin(data, 'reconcile')
    assert out.returncode == 0 and 'old@den.test: НЕТ ОТЧЁТА' in out.stdout, out.stdout + out.stderr


# Копейки: те же ответы, что даёт toKop в sync.js (проверено и в живой проверке на настоящем браузере)
@pytest.mark.parametrize('value,kop', [(19.995, 2000), (1.005, 101), (-0.5, -50), ('250', 25000), ('', 0), (None, 0), (True, 100),
                                       (0.1 + 0.2, 30), (2.675, 268), ('1_000', 0), ('0x10', 1600), ('0b11', 300), ('١٢', 0),
                                       (' 7.5 ', 750), ('Infinity', 0), ('abc', 0), (1e21, 10 ** 23), (1e-7, 0), ([5], 0)])
def test_kopecks_like_app(value, kop):
    import importlib, os
    os.environ.setdefault('DEN_SECRET', SECRET)
    migration = importlib.import_module('server.migration')
    assert migration.to_kop(value) == kop
