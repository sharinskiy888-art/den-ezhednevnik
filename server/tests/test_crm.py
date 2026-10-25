"""CRM: клиенты, объекты, заявки, договоры ТО, деньги в копейках; монтажник видит только своё (раздел 4 ТЗ)."""
import datetime as dt
import time
import uuid

import pytest

from conftest import T0

pytestmark = pytest.mark.etap4


def rid():
    return str(uuid.uuid4())


def put(server, user, kind, items, status=204):
    rows = [{'id': p['id'], 'payload': {'updatedAt': T0, **p}, 'updated_at': p.get('updatedAt', T0)} for p in items]
    got = server.post(f'/api/crm/{kind}', rows, user.token)
    assert got[0] == status, got
    return got


def ids(server, user, kind):
    return {h['id'] for h in server.get(f'/api/crm/{kind}/heads', user.token)[1]}


@pytest.fixture
def crm(server, admin, make_user):
    """Руководитель, два монтажника, родственник без CRM и готовые клиент → объект → заявка на первого монтажника."""
    boss, m1, m2, family = make_user(), make_user(), make_user(), make_user()
    for user, role in ((boss, 'manager'), (m1, 'worker'), (m2, 'worker')):
        assert server.put(f'/api/admin/users/{user.id}/crm', {'role': role}, admin.token)[0] == 204
    c, o, order = rid(), rid(), rid()
    put(server, boss, 'clients', [{'id': c, 'name': 'ООО Ромашка', 'inn': '7701234567', 'phone': '+7 900 000-00-00'}])
    put(server, boss, 'objects', [{'id': o, 'clientId': c, 'address': 'ул. Ленина, 1', 'systems': ['АПС', 'СОУЭ']}])
    put(server, boss, 'orders', [{'id': order, 'objectId': o, 'type': 'Монтаж', 'stage': 'new', 'assignees': [m1.email],
                                   'due': '2026-11-01', 'sumKop': 15000000, 'note': 'щит в подвале'}])
    return {'boss': boss, 'm1': m1, 'm2': m2, 'family': family, 'client': c, 'object': o, 'order': order}


# --- Роли ---

def test_roles_reported(server, admin, crm):
    assert server.get('/api/crm/me', crm['boss'].token)[1]['role'] == 'manager'
    assert server.get('/api/crm/me', crm['m1'].token)[1]['role'] == 'worker'
    assert server.get('/api/crm/me', crm['family'].token)[1]['role'] == ''
    assert server.get('/api/crm/me', admin.token)[1]['role'] == 'manager'
    assert server.get('/api/crm/me')[0] == 401


def test_without_role_no_access(server, crm):
    for kind in ('clients', 'orders', 'dict'):
        assert server.get(f'/api/crm/{kind}/heads', crm['family'].token)[0] == 403
    assert server.post('/api/crm/clients', [], crm['family'].token)[0] == 403


def test_only_admin_sets_roles(server, crm):
    assert server.put(f"/api/admin/users/{crm['m1'].id}/crm", {'role': 'manager'}, crm['boss'].token)[0] == 403
    assert server.put(f"/api/admin/users/{crm['m1'].id}/crm", {'role': 'boss'}, crm['boss'].token)[0] == 403


def test_bad_role_rejected(server, admin, crm):
    assert server.put(f"/api/admin/users/{crm['m1'].id}/crm", {'role': 'boss'}, admin.token)[0] == 400


def test_unknown_kind_404(server, crm):
    assert server.get('/api/crm/secrets/heads', crm['boss'].token)[0] == 404


# --- Монтажник видит только своё ---

def test_worker_sees_only_assigned(server, crm):
    other_c, other_o, other_order = rid(), rid(), rid()
    put(server, crm['boss'], 'clients', [{'id': other_c, 'name': 'Чужой клиент'}])
    put(server, crm['boss'], 'objects', [{'id': other_o, 'clientId': other_c, 'address': 'ул. Мира, 5'}])
    put(server, crm['boss'], 'orders', [{'id': other_order, 'objectId': other_o, 'stage': 'new', 'assignees': [crm['m2'].email]}])
    m1 = crm['m1']
    assert ids(server, m1, 'orders') == {crm['order']}
    assert ids(server, m1, 'objects') == {crm['object']}
    assert ids(server, m1, 'clients') == {crm['client']}
    got = server.get(f"/api/crm/orders?ids={crm['order']},{other_order}", m1.token)[1]
    assert [r['id'] for r in got] == [crm['order']]
    assert server.get('/api/crm/clients', m1.token)[1][0]['payload']['phone'] == '+7 900 000-00-00'


def test_worker_gets_no_money_and_contracts(server, crm):
    put(server, crm['boss'], 'payments', [{'id': rid(), 'orderId': crm['order'], 'kind': 'income', 'amountKop': 5000000, 'date': '2026-10-25'}])
    put(server, crm['boss'], 'contracts', [{'id': rid(), 'objectId': crm['object'], 'periodMonths': 1, 'priceKop': 300000, 'nextDate': '2027-01-01', 'active': False}])
    for kind in ('payments', 'contracts'):
        assert server.get(f'/api/crm/{kind}/heads', crm['m1'].token)[1] == []
        assert server.get(f'/api/crm/{kind}', crm['m1'].token)[1] == []


def test_worker_cannot_write(server, crm):
    put(server, crm['m1'], 'orders', [{'id': crm['order'], 'objectId': crm['object'], 'stage': 'paid', 'assignees': [crm['m1'].email]}], status=403)
    assert server.delete(f"/api/crm/orders/{crm['order']}", crm['m1'].token)[0] == 403
    assert server.get(f"/api/crm/orders?ids={crm['order']}", crm['boss'].token)[1][0]['payload']['stage'] == 'new'


def test_unassigned_worker_loses_access(server, crm):
    put(server, crm['boss'], 'orders', [{'id': crm['order'], 'objectId': crm['object'], 'stage': 'work', 'assignees': [], 'updatedAt': '2026-10-25T11:00:00.000Z'}])
    assert ids(server, crm['m1'], 'orders') == set() and ids(server, crm['m1'], 'clients') == set()


def test_dictionary_defaults_and_visible_to_worker(server, crm):
    rows = server.get('/api/crm/dict', crm['m1'].token)[1]
    d = rows[0]['payload'] if rows else None
    assert d and 'ТО' in d['workTypes'] and 'АПС' in d['systems']
    put(server, crm['boss'], 'dict', [{'id': 'dict', 'workTypes': ['Монтаж', 'ТО', 'Пусконаладка'], 'systems': ['АПС']}])
    assert 'Пусконаладка' in server.get('/api/crm/dict', crm['m1'].token)[1][0]['payload']['workTypes']


# --- Проверка данных ---

@pytest.mark.parametrize('kind,payload', [
    ('clients', {'name': ''}),
    ('clients', {'name': 'X', 'inn': 7701234567}),
    ('objects', {'address': 'без клиента'}),
    ('orders', {'objectId': 'x', 'stage': 'archived'}),
    ('orders', {'objectId': 'x', 'sumKop': 100.5}),
    ('orders', {'objectId': 'x', 'sumKop': -1}),
    ('orders', {'objectId': 'x', 'due': '01.11.2026'}),
    ('orders', {'objectId': 'x', 'assignees': 'm@den.test'}),
    ('payments', {'orderId': 'x', 'kind': 'income', 'amountKop': 0}),
    ('payments', {'orderId': 'x', 'kind': 'gift', 'amountKop': 100}),
    ('contracts', {'objectId': 'x', 'periodMonths': 0}),
    ('dict', {'workTypes': 'Монтаж'}),
])
def test_bad_fields_rejected(server, crm, kind, payload):
    put(server, crm['boss'], kind, [{'id': 'dict' if kind == 'dict' else rid(), **payload}], status=400)


def test_bad_id_rejected(server, crm):
    put(server, crm['boss'], 'clients', [{'id': '../x', 'name': 'X'}], status=400)


def test_money_in_kopecks_kept_exact(server, crm):
    pid = rid()
    put(server, crm['boss'], 'payments', [{'id': pid, 'orderId': crm['order'], 'kind': 'income', 'amountKop': 123456789012, 'date': '2026-10-25'}])
    got = server.get(f'/api/crm/payments?ids={pid}', crm['boss'].token)[1][0]['payload']
    assert got['amountKop'] == 123456789012 and isinstance(got['amountKop'], int)


def test_unknown_fields_kept(server, crm):
    cid = rid()
    put(server, crm['boss'], 'clients', [{'id': cid, 'name': 'X', 'tags': ['vip'], 'future': {'a': 1}}])
    got = server.get(f'/api/crm/clients?ids={cid}', crm['boss'].token)[1][0]['payload']
    assert got['tags'] == ['vip'] and got['future'] == {'a': 1}


def test_tombstone_and_prune(server, crm):
    cid = rid()
    put(server, crm['boss'], 'clients', [{'id': cid, 'name': 'Удалю'}])
    put(server, crm['boss'], 'clients', [{'id': cid, '__deleted': True, 'updatedAt': '2026-10-26T00:00:00.000Z'}])
    assert server.get(f'/api/crm/clients?ids={cid}', crm['boss'].token)[1][0]['payload']['__deleted'] is True
    assert server.delete(f'/api/crm/clients/{cid}', crm['boss'].token)[0] == 204
    assert cid not in ids(server, crm['boss'], 'clients')


# --- Заявка с исполнителями = поручение ---

def shared_id(order):
    return f'crm-{order}'


def test_order_creates_shared_task_for_assignee(server, crm):
    m1 = crm['m1']
    heads = server.get('/api/shared/heads', m1.token)[1]
    assert shared_id(crm['order']) in [h['id'] for h in heads]
    task = server.get(f"/api/shared/{shared_id(crm['order'])}", m1.token)[1]
    assert task['owner_id'] == crm['boss'].id and m1.email in task['invited_emails']
    p = task['payload']
    assert p['crmOrderId'] == crm['order'] and p['date'] == '2026-11-01' and 'Ленина' in p['title'] and p['status'] == 'new'


def test_worker_reports_through_shared_task(server, crm):
    m1, tid = crm['m1'], shared_id(crm['order'])
    assert server.post(f'/api/shared/{tid}/answer', {'accept': True}, m1.token)[0] == 204
    task = server.get(f'/api/shared/{tid}', m1.token)[1]
    payload = task['payload']
    payload['reports'] = payload.get('reports', []) + [{'id': 'r1', 'by': m1.email, 'at': T0, 'text': 'Щит смонтирован'}]
    payload['status'] = 'review'
    assert server.patch(f'/api/shared/{tid}', {'payload': payload, 'updated_at': T0}, m1.token)[0] == 204


def test_reassign_moves_shared_task(server, crm):
    tid = shared_id(crm['order'])
    put(server, crm['boss'], 'orders', [{'id': crm['order'], 'objectId': crm['object'], 'stage': 'work', 'assignees': [crm['m2'].email],
                                         'due': '2026-11-02', 'updatedAt': '2026-10-25T12:00:00.000Z'}])
    assert server.get(f'/api/shared/{tid}', crm['m1'].token)[0] == 404
    task = server.get(f'/api/shared/{tid}', crm['m2'].token)[1]
    assert task['payload']['date'] == '2026-11-02'


def test_order_update_keeps_worker_progress(server, crm):
    m1, tid = crm['m1'], shared_id(crm['order'])
    assert server.post(f'/api/shared/{tid}/answer', {'accept': True}, m1.token)[0] == 204
    task = server.get(f'/api/shared/{tid}', m1.token)[1]
    task['payload']['status'] = 'open'
    assert server.patch(f'/api/shared/{tid}', {'payload': task['payload'], 'updated_at': T0}, m1.token)[0] == 204
    put(server, crm['boss'], 'orders', [{'id': crm['order'], 'objectId': crm['object'], 'stage': 'work', 'assignees': [m1.email],
                                         'due': '2026-11-05', 'note': 'новое', 'updatedAt': '2026-10-25T12:00:00.000Z'}])
    task = server.get(f'/api/shared/{tid}', m1.token)[1]
    assert task['payload']['status'] == 'open' and m1.email in task['accepted_emails'] and task['payload']['date'] == '2026-11-05'


def test_deleted_order_removes_shared_task(server, crm):
    put(server, crm['boss'], 'orders', [{'id': crm['order'], '__deleted': True, 'updatedAt': '2026-10-26T00:00:00.000Z'}])
    assert server.get(f"/api/shared/{shared_id(crm['order'])}", crm['boss'].token)[0] == 404


def test_order_without_assignees_has_no_task(server, crm):
    oid = rid()
    put(server, crm['boss'], 'orders', [{'id': oid, 'objectId': crm['object'], 'stage': 'kp', 'assignees': []}])
    assert server.get(f'/api/shared/{shared_id(oid)}', crm['boss'].token)[0] == 404


# --- Договор ТО сам создаёт заявки ---

def contract(server, crm, next_date, period=1, active=True, cid=None):
    cid = cid or rid()
    put(server, crm['boss'], 'contracts', [{'id': cid, 'objectId': crm['object'], 'periodMonths': period, 'priceKop': 500000,
                                            'nextDate': next_date, 'assignees': [crm['m1'].email], 'active': active,
                                            'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())}])
    return cid


def test_maintenance_creates_order_and_task_once(server, crm):
    today = dt.date.today().isoformat()  # без ?today= — по часам сервера
    cid = contract(server, crm, today)
    server.post('/api/crm/maintenance', token=crm['boss'].token)
    order_id = f'to-{cid}-{today}'
    got = server.get(f'/api/crm/orders?ids={order_id}', crm['boss'].token)[1]
    assert got and got[0]['payload']['type'] == 'ТО' and got[0]['payload']['sumKop'] == 500000 and got[0]['payload']['due'] == today
    assert server.get(f'/api/shared/{shared_id(order_id)}', crm['m1'].token)[0] == 200
    nxt = server.get(f'/api/crm/contracts?ids={cid}', crm['boss'].token)[1][0]['payload']['nextDate']
    assert nxt > today
    assert server.post('/api/crm/maintenance', token=crm['boss'].token)[1]['created'] == 0


def test_maintenance_month_end_and_skips_old_visits(server, crm):
    # Даты 2030 года: запись договора сама запускает ТО по сегодняшним часам, и будущие договоры она не трогает.
    cid = contract(server, crm, '2030-01-31', period=1)
    run = lambda day: server.post(f'/api/crm/maintenance?today={day}', token=crm['boss'].token)[1]['created']
    created = lambda: sorted(i for i in ids(server, crm['boss'], 'orders') if i.startswith(f'to-{cid}-'))
    next_date = lambda: server.get(f'/api/crm/contracts?ids={cid}', crm['boss'].token)[1][0]['payload']['nextDate']
    run('2030-03-05')  # 31.01 прошло больше месяца назад — не создаётся; 28.02 — создаётся
    assert created() == [f'to-{cid}-2030-02-28'] and next_date() == '2030-03-31'  # число месяца не «съезжает»
    run('2030-04-25')
    assert created()[-2:] == [f'to-{cid}-2030-03-31', f'to-{cid}-2030-04-30'] and next_date() == '2030-05-31'
    run('2030-04-25')
    assert len(created()) == 3  # повтор ничего не дублирует


def test_manual_next_date_change_resets_day_of_month(server, crm):
    cid = contract(server, crm, '2030-01-31')
    server.post('/api/crm/maintenance?today=2030-02-25', token=crm['boss'].token)
    c = server.get(f'/api/crm/contracts?ids={cid}', crm['boss'].token)[1][0]['payload']
    assert c['dayOfMonth'] == 31
    c.update(nextDate='2030-12-10', updatedAt='2030-12-01T00:00:00.000Z')
    put(server, crm['boss'], 'contracts', [c])
    server.post('/api/crm/maintenance?today=2030-12-05', token=crm['boss'].token)
    assert server.get(f'/api/crm/contracts?ids={cid}', crm['boss'].token)[1][0]['payload']['nextDate'] == '2031-01-10'


@pytest.mark.parametrize('bad', ['x', 0, 40, [1]])
def test_bad_day_of_month_rejected_and_others_keep_working(server, crm, bad):
    put(server, crm['boss'], 'contracts', [{'id': rid(), 'objectId': crm['object'], 'nextDate': '2030-03-01', 'dayOfMonth': bad}], status=400)
    good = contract(server, crm, '2030-03-01')
    server.post('/api/crm/maintenance?today=2030-03-01', token=crm['boss'].token)
    assert f'to-{good}-2030-03-01' in ids(server, crm['boss'], 'orders')


def test_crm_task_id_cannot_be_taken_in_advance(server, crm):
    from conftest import new_task
    t = new_task(crm['family'])
    t['id'] = 'crm-' + rid()
    assert server.post('/api/shared', t, crm['family'].token)[0] == 403


def test_contract_owner_not_from_request(server, crm):
    cid = rid()
    put(server, crm['boss'], 'contracts', [{'id': cid, 'objectId': crm['object'], 'nextDate': '2030-03-01', 'ownerId': crm['m1'].id,
                                            'assignees': [crm['m2'].email]}])
    server.post('/api/crm/maintenance?today=2030-03-01', token=crm['boss'].token)
    task = server.get(f'/api/shared/crm-to-{cid}-2030-03-01', crm['boss'].token)[1]
    assert task['owner_id'] == crm['boss'].id


def test_long_contract_id_rejected(server, crm):
    put(server, crm['boss'], 'contracts', [{'id': 'c' * 71, 'objectId': crm['object'], 'nextDate': '2026-03-01'}], status=400)


def test_delete_only_tombstones(server, crm):
    assert server.delete(f"/api/crm/orders/{crm['order']}", crm['boss'].token)[0] == 409
    assert server.get(f"/api/shared/crm-{crm['order']}", crm['m1'].token)[0] == 200


def test_huge_sum_rejected(server, crm):
    put(server, crm['boss'], 'orders', [{'id': rid(), 'objectId': crm['object'], 'sumKop': 10 ** 15 + 1}], status=400)


def test_inactive_or_future_contract_no_orders(server, crm):
    a = contract(server, crm, dt.date.today().isoformat(), active=False)
    b = contract(server, crm, (dt.date.today() + dt.timedelta(days=30)).isoformat())
    server.post('/api/crm/maintenance', token=crm['boss'].token)
    assert not [i for i in ids(server, crm['boss'], 'orders') if i.startswith((f'to-{a}', f'to-{b}'))]


def test_worker_cannot_run_maintenance(server, crm):
    assert server.post('/api/crm/maintenance', token=crm['m1'].token)[0] == 403


# --- Скорость сервера ---

def test_10000_clients_heads_fast(fresh_server):
    from conftest import ADMIN_EMAIL, ADMIN_PASSWORD
    api = fresh_server()
    token = api.login(ADMIN_EMAIL, ADMIN_PASSWORD)['access_token']
    rows = [{'id': f'c{i}', 'payload': {'name': f'Клиент {i}', 'inn': str(7700000000 + i), 'updatedAt': T0}, 'updated_at': T0} for i in range(10000)]
    for i in range(0, 10000, 2000):
        assert api.post('/api/crm/clients', rows[i:i + 2000], token)[0] == 204
    start = time.perf_counter()
    status, heads, _ = api.get('/api/crm/clients/heads', token)
    assert status == 200 and len(heads) == 10000 and time.perf_counter() - start < 1.0


def test_object_photo_only_for_those_who_see_object(server, crm):
    status, body, _ = server.post(f"/api/files/crm/{crm['object']}?ext=jpg", token=crm['boss'].token, raw=b'\xff\xd8' + b'1' * 50,
                                  headers={'Content-Type': 'image/jpeg'})
    assert status == 201 and body['path'].startswith(f"crm/{crm['object']}/")
    url = f"/api/files/{body['path']}"
    assert server.get(url, crm['m1'].token)[0] == 200
    assert server.get(url, crm['m2'].token)[0] == 404
    assert server.get(url, crm['family'].token)[0] == 403
    assert server.post(f"/api/files/crm/{crm['object']}?ext=jpg", token=crm['m1'].token, raw=b'x', headers={'Content-Type': 'image/jpeg'})[0] == 403


def test_admin_cli_sets_crm_role(tmp_path, fresh_server):
    from test_misc import admin_cli
    data = tmp_path / 'cli'
    assert admin_cli(data, 'add', 'mont@den.test', 'mont-pass-123').returncode == 0
    out = admin_cli(data, 'crm', 'mont@den.test', 'worker')
    assert out.returncode == 0 and 'монтажник' in out.stdout
    assert admin_cli(data, 'crm', 'mont@den.test', 'boss').returncode != 0
