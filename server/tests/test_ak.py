"""Модуль АК-Сервера (код crm): чек-лист из ТЗ модуля на заглушке ядра (ak_core.py).

Модуль запускается так же, как его запускает ядро: python -m server.run с переменными AK_* и без den.env.
"""
import json
import os
import re
import zipfile
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import pytest

from ak_core import Core, signed_headers
from conftest import ROOT, T0, free_port

pytestmark = pytest.mark.etap7
SECRET_HEX = 'ab12' * 16
SECRET = bytes.fromhex(SECRET_HEX)
BOSS, WORKER, VIEWER, NOBODY, CASHIER, GONE = (str(uuid.uuid4()) for _ in range(6))
EMPLOYEES = {BOSS: {'id': BOSS, 'name': 'Шамиль', 'email': 'Boss@Firma.ru'},
             WORKER: {'id': WORKER, 'name': 'Иван Монтажник', 'email': 'ivan@firma.ru'},
             VIEWER: {'id': VIEWER, 'name': 'Бухгалтер'},  # без email — ключ «<uuid>@ak»
             CASHIER: {'id': CASHIER, 'name': 'Кассир', 'email': 'kassa@firma.ru'},
             GONE: {'id': GONE, 'name': 'Удалённый', 'deleted': True}}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None  # переадресацию проверяем сами: повтор без подписи ядро не отправит


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)


def http(url, method='GET', body=None, headers=None):
    data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers={**({'Content-Type': 'application/json'} if body is not None else {}), **(headers or {})})
    try:
        with OPENER.open(req, timeout=30) as r:
            status, raw, rh = r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        status, raw, rh = e.code, e.read(), e.headers
    try:
        return status, json.loads(raw) if raw else None, rh
    except ValueError:
        return status, raw.decode('utf-8', 'replace'), rh


class Module:
    """Модуль, запущенный «ядром»: прямые подписанные запросы и запросы через заглушку ядра от имени сотрудника."""
    def __init__(self, tmp_path, data_dir=None, core_port=None, **env):
        self.port = free_port()
        self.data = data_dir or tmp_path / f'ak-data-{self.port}'
        self.core = Core(SECRET_HEX, self.port, employees=EMPLOYEES).start()
        self.url = f'http://127.0.0.1:{self.port}'
        base = {k: v for k, v in os.environ.items() if not k.startswith(('DEN_', 'AK_'))}
        self.env = {**base, 'AK_MODULE_ID': 'crm', 'AK_MODULE_VERSION': '', 'AK_MODULE_SECRET': SECRET_HEX, 'AK_HOST': '127.0.0.1',
                    'AK_PORT': str(self.port), 'AK_BASE_PATH': '/m/crm', 'AK_CORE_URL': self.core.url, 'AK_CORE_VERSION': '1.0.3',
                    'AK_PROTOCOL': '1', 'AK_DATA_DIR': str(self.data), 'AK_LOG_DIR': str(tmp_path / 'logs'),
                    'DEN_ENV_FILE': str(tmp_path / 'den.env'), **env}
        (tmp_path / 'den.env').write_text('DEN_SECRET=короткий\nDEN_DATA_DIR=/нельзя\n', encoding='utf-8')  # в режиме модуля не читается
        self.log = tmp_path / f'ak-{self.port}.log'
        self.start()

    def start(self):
        with open(self.log, 'ab') as log:
            self.proc = subprocess.Popen([sys.executable, '-m', 'server.run'], cwd=ROOT, env=self.env, stdout=log, stderr=subprocess.STDOUT)
        for _ in range(150):
            if self.proc.poll() is not None:
                break
            try:
                if http(self.url + '/m/crm/healthz')[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(0.1)
        pytest.fail('Модуль не запустился:\n' + self.log.read_text(errors='replace')[-3000:])

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(10)
        self.core.stop()

    def signed(self, method, path, body=None, user='', roles='', name='', **kw):
        """Прямой запрос на AK_PORT с подписью ядра (как служебные вызовы ядра)."""
        data = b'' if body is None else body if isinstance(body, bytes) else json.dumps(body).encode()
        h = signed_headers(SECRET, 'crm', method, path, data, user, roles, name, **kw)
        return http(self.url + path, method, data if body is not None else None, h)

    def as_user(self, user, roles, method='GET', path='', body=None, name='', epoch=True):
        """Запрос через ядро-заглушку от имени сотрудника — как из браузера. Запись — с меткой данных, как у приложения."""
        h = {'X-Test-User': user, 'X-Test-Roles': roles, 'X-Test-Name': urllib.parse.quote(name)}
        if method not in ('GET', 'HEAD') and epoch:
            h['X-Den-Epoch'] = epoch if isinstance(epoch, str) else http(f'{self.core.url}/m/crm/api/ak/me', headers=h)[1]['epoch']
        return http(f'{self.core.url}/m/crm/{path}', method, body, h)


@pytest.fixture(scope='module')
def mod(tmp_path_factory):
    m = Module(tmp_path_factory.mktemp('ak'))
    yield m
    m.stop()


def rows(*items):
    return [{'id': p['id'], 'payload': {'updatedAt': T0, **p}, 'updated_at': T0} for p in items]


# --- п. 4 чек-листа: подпись ---

def test_healthz_and_version(mod):
    status, body, _ = http(mod.url + '/m/crm/healthz')
    version = json.load(open(ROOT / 'version.json'))['version']
    assert status == 200 and body == {'ok': True, 'version': f'1.0.{version}', 'app': version}


def test_unsigned_tampered_and_replayed_requests_get_401(mod):
    path = '/m/crm/api/data/tasks/heads'
    assert http(mod.url + path, headers={'X-AK-User': BOSS, 'X-AK-Roles': 'owner'})[0] == 401  # без подписи
    assert mod.signed('GET', path, user=BOSS, roles='owner')[0] == 200
    # изменённое тело
    h = signed_headers(SECRET, 'crm', 'POST', '/m/crm/api/data/tasks', b'[]', BOSS, 'owner')
    assert http(mod.url + '/m/crm/api/data/tasks', 'POST', json.dumps(rows({'id': 'evil'})).encode(), h)[0] == 401
    # подмена пользователя или ролей после подписи
    h = signed_headers(SECRET, 'crm', 'GET', path, b'', WORKER, 'courier')
    assert http(mod.url + path, headers={**h, 'X-AK-Roles': 'owner'})[0] == 401
    assert http(mod.url + path, headers={**h, 'X-AK-User': BOSS})[0] == 401
    # повтор того же nonce
    h = signed_headers(SECRET, 'crm', 'GET', path, b'', BOSS, 'owner')
    assert http(mod.url + path, headers=h)[0] == 200
    status, body, _ = http(mod.url + path, headers=h)
    assert status == 401 and body['error']['code'] == 'replay'
    # время вне ±60 с, чужой отправитель, чужой ключ, другой путь
    assert mod.signed('GET', path, user=BOSS, roles='owner', ts=str(int(time.time()) - 120))[0] == 401
    assert mod.signed('GET', path, user=BOSS, roles='owner', ts=str(int(time.time()) + 120))[0] == 401
    h = signed_headers(SECRET, 'crm', 'GET', path, b'', BOSS, 'owner')
    assert http(mod.url + path, headers={**h, 'X-AK-From': 'retail'})[0] == 401
    h = signed_headers(bytes(32), 'crm', 'GET', path, b'', BOSS, 'owner')
    assert http(mod.url + path, headers=h)[0] == 401
    h = signed_headers(SECRET, 'crm', 'GET', path + '?ids=1', b'', BOSS, 'owner')
    assert http(mod.url + path, headers=h)[0] == 401
    h = signed_headers(SECRET, 'retail', 'GET', path, b'', BOSS, 'owner')  # подписано для другого модуля
    assert http(mod.url + path, headers=h)[0] == 401
    # время в формате RFC3339 тоже понимается
    stamp = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    assert mod.signed('GET', path, user=BOSS, roles='owner', ts=stamp)[0] == 200


def test_user_name_signed_as_is(mod):
    name = urllib.parse.quote('Шамиль Ш.')
    assert mod.signed('GET', '/m/crm/api/ak/me', user=BOSS, roles='owner', name=name)[1]['user']['name'] == 'Шамиль Ш.'
    name = urllib.parse.quote_plus('Шамиль Ш.')  # так кодирует ядро 1.0.3: пробел = «+»
    assert '+' in name and mod.signed('GET', '/m/crm/api/ak/me', user=BOSS, roles='owner', name=name)[1]['user']['name'] == 'Шамиль Ш.'


def test_nonce_length(mod):
    path = '/m/crm/api/data/tasks/heads'
    assert mod.signed('GET', path, user=BOSS, roles='owner', nonce='a' * 15)[0] == 401  # nonce 16–128 символов
    assert mod.signed('GET', path, user=BOSS, roles='owner', nonce='b' * 129)[0] == 401
    assert mod.signed('GET', path, user=BOSS, roles='owner', nonce=secrets.token_hex(8))[0] == 200


# --- п. 8–9: адреса /m/crm/ и вход только через ядро ---

def test_paths_only_under_base(mod):
    assert mod.signed('GET', '/api/health', user=BOSS, roles='owner')[0] == 404
    assert mod.signed('GET', '/m/retail/', user=BOSS, roles='owner')[0] == 404
    status, _, headers = mod.signed('GET', '/m/crm', user=BOSS, roles='owner')
    assert status == 308 and headers['Location'] == '/m/crm/'


def test_no_user_no_access_and_no_own_login(mod):
    assert mod.signed('GET', '/m/crm/')[0] == 401
    assert mod.signed('GET', '/m/crm/api/data/tasks/heads')[0] == 401
    assert mod.signed('GET', '/m/crm/api/data/tasks/heads', user='not-a-uuid', roles='owner')[0] == 401
    for path in ('api/auth/login', 'api/auth/register', 'api/admin/users'):
        assert mod.as_user(BOSS, 'owner', 'POST', path, {'email': 'a@b.c', 'password': 'x' * 10})[0] == 404
    assert mod.as_user(BOSS, 'owner', 'PUT', f'api/admin/users/{WORKER}/crm', {'role': 'manager'})[0] == 403


def test_pages_and_relative_links(mod):
    status, html, _ = mod.as_user(BOSS, 'owner', path='')
    assert status == 200 and html.rstrip().endswith('</html>') and 'id="ak-button"' in html
    assert 'href="/' not in html and 'src="/' not in html
    status, js, _ = mod.as_user(BOSS, 'owner', path='sync.js')
    assert status == 200 and "'api'" in js and "`/api`" not in js
    for path in ('den.env', 'server/ak.py', 'version.json/../server/db.py', '.git/config'):
        assert mod.as_user(BOSS, 'owner', path=path)[0] == 404


# --- п. 3, 11: люди и роли из ядра ---

def test_first_login_key_is_uuid(mod):
    status, body, _ = mod.as_user(BOSS, 'owner', path='api/ak/me', name='Шамиль')
    assert status == 200 and body['user'] == {'id': BOSS, 'email': f'{BOSS}@ak', 'name': 'Шамиль', 'role': 'admin'}
    assert body['crm_role'] == 'manager'
    assert mod.as_user(VIEWER, 'viewer', path='api/ak/me')[1]['user']['email'] == f'{VIEWER}@ak'
    assert mod.as_user(WORKER, 'courier', path='api/ak/me')[1]['crm_role'] == 'worker'
    body = mod.as_user(CASHIER, 'admin', path='api/ak/me')[1]
    assert re.fullmatch(r'[0-9a-f]{16}', body.pop('epoch'))
    assert body.pop('restored') == ''  # восстановлений ещё не было
    assert body == {'ak': True, 'crm_role': 'manager', 'user': {'id': CASHIER, 'email': f'{CASHIER}@ak', 'name': '', 'role': 'user'}}


def test_employees_list_for_assignees(mod):
    mod.as_user(BOSS, 'owner', path='api/ak/me')
    status, body, _ = mod.as_user(BOSS, 'owner', path='api/ak/employees')
    assert status == 200
    keys = {e['id']: e['key'] for e in body}
    # справочник ядра {items:[{id,rev,deleted,updated_at,data}], more} по курсору; удалённый не показывается
    assert {u: f'{u}@ak' for u in (BOSS, WORKER, VIEWER, CASHIER)}.items() <= keys.items()
    assert {'Шамиль', 'Иван Монтажник', 'Бухгалтер', 'Кассир'} <= {e['name'] for e in body} and 'Удалённый' not in {e['name'] for e in body}
    # кто уже входил в «День», виден по имени из X-AK-User-Name, даже если его нет в справочнике
    newcomer = str(uuid.uuid4())
    mod.as_user(newcomer, 'courier', path='api/ak/me', name='Пётр Новый')
    assert {'id': newcomer, 'name': 'Пётр Новый', 'key': f'{newcomer}@ak'} in mod.as_user(BOSS, 'owner', path='api/ak/employees')[1]
    assert all(ok for _, ok in mod.core.checked) and mod.core.checked  # запросы модуля к ядру подписаны верно


def test_core_down(tmp_path):
    m = Module(tmp_path)
    try:
        m.core.down = True
        assert m.as_user(str(uuid.uuid4()), 'owner', path='api/ak/me')[0] == 200  # вход ядру не нужен: ключ из UUID
        fresh = m.as_user(BOSS, 'owner', path='api/ak/employees')[1]  # ядро не отвечает: остаются те, кто уже входил
        assert [e['key'] for e in fresh] and all(e['key'].endswith('@ak') for e in fresh)
    finally:
        m.stop()


def test_roles_in_crm(mod):
    for uid, roles in ((BOSS, 'owner'), (WORKER, 'courier,partner'), (VIEWER, 'viewer'), (NOBODY, '')):
        mod.as_user(uid, roles, path='api/ak/me')
    client, obj, order, contract = (str(uuid.uuid4()) for _ in range(4))
    assert mod.as_user(BOSS, 'owner', 'POST', 'api/crm/clients', rows({'id': client, 'name': 'ООО Ромашка', 'phone': '+7 900'}))[0] == 204
    assert mod.as_user(BOSS, 'owner', 'POST', 'api/crm/objects', rows({'id': obj, 'clientId': client, 'address': 'Ленина, 1'}))[0] == 204
    assert mod.as_user(BOSS, 'owner', 'POST', 'api/crm/orders', rows({'id': order, 'objectId': obj, 'stage': 'new',
                                                                        'assignees': [f'{WORKER}@ak'], 'sumKop': 100000}))[0] == 204
    assert mod.as_user(BOSS, 'owner', 'POST', 'api/crm/contracts', rows({'id': contract, 'objectId': obj, 'nextDate': '2027-01-10',
                                                                           'periodMonths': 1, 'sumKop': 500000}))[0] == 204
    heads = lambda uid, roles, kind: {h['id'] for h in mod.as_user(uid, roles, path=f'api/crm/{kind}/heads')[1]}
    assert order in heads(WORKER, 'courier,partner', 'orders') and heads(WORKER, 'courier,partner', 'contracts') == set()
    assert contract in heads(VIEWER, 'viewer', 'contracts') and order in heads(VIEWER, 'viewer', 'orders')
    assert mod.as_user(VIEWER, 'viewer', 'POST', 'api/crm/clients', rows({'id': str(uuid.uuid4()), 'name': 'x'}))[0] == 403
    assert mod.as_user(WORKER, 'courier', 'POST', 'api/crm/clients', rows({'id': str(uuid.uuid4()), 'name': 'x'}))[0] == 403
    assert mod.as_user(NOBODY, '', path='api/crm/orders/heads')[0] == 403
    assert mod.as_user(BOSS, 'owner', path='api/crm/me')[1]['role'] == 'manager'
    # заявка с исполнителем — поручение у него
    shared = mod.as_user(WORKER, 'courier', path='api/shared')[1]
    assert any(t['id'] == f'crm-{order}' and f'{WORKER}@ak' in t['invited_emails'] for t in shared)


def test_personal_data_and_shared_tasks_by_employee(mod):
    for uid, roles in ((BOSS, 'owner'), (WORKER, 'courier')):
        mod.as_user(uid, roles, path='api/ak/me')
    assert mod.as_user(BOSS, 'owner', 'POST', 'api/data/tasks', rows({'id': 'boss-task', 'title': 'Своё'}))[0] == 204
    assert {r['id'] for r in mod.as_user(WORKER, 'courier', path='api/data/tasks')[1]} == set()  # чужие личные не видны
    tid = str(uuid.uuid4())
    task = {'id': tid, 'owner_id': BOSS, 'owner_email': f'{BOSS}@ak', 'invited_emails': [f'{WORKER}@ak'], 'accepted_emails': [],
            'payload': {'title': 'Смонтировать АПС', 'status': 'new', 'completed': False, 'subtasks': [], 'reports': [], 'activity': [],
                        'updatedAt': T0}, 'updated_at': T0}
    assert mod.as_user(BOSS, 'owner', 'POST', 'api/shared', task)[0] in (200, 201)
    assert mod.as_user(WORKER, 'courier', 'POST', f'api/shared/{tid}/answer', {'accept': True})[0] == 204
    got = mod.as_user(WORKER, 'courier', path=f'api/shared/{tid}')[1]
    assert f'{WORKER}@ak' in got['accepted_emails']
    # исполнитель меняет только статус и подзадачи, не текст
    patch = {'payload': {**task['payload'], 'title': 'Другое', 'updatedAt': '2026-10-26T10:00:00.000Z'}}
    assert mod.as_user(WORKER, 'courier', 'PATCH', f'api/shared/{tid}', patch)[0] == 403


def test_feedback_limited_per_person(mod):
    assert mod.as_user(BOSS, 'owner', 'POST', 'api/feedback', {'text': 'Проверка'})[0] == 204
    con = sqlite3.connect(mod.data / 'den.db')
    assert con.execute('select email from feedback order by id desc').fetchone()[0] == f'{BOSS}@ak'
    con.close()


# --- п. 17–19: служебные адреса ---

def test_service_paths_closed_to_browser(mod):
    for method, path in (('GET', 'ak/v1/busy'), ('POST', 'ak/v1/stop'), ('POST', 'ak/v1/backup'), ('POST', 'ak/v1/events')):
        assert mod.as_user(BOSS, 'owner', method, path, {'name': '2026-10-27_1200'})[0] == 404
    assert http(mod.url + '/m/crm/ak/v1/busy')[0] == 401  # без подписи
    h = signed_headers(SECRET, 'crm', 'GET', '/m/crm/ak/v1/busy', b'')
    assert http(mod.url + '/m/crm/ak/v1/busy', headers={**h, 'Origin': 'http://x'})[0] == 404  # пришло из браузера


def test_busy(mod):
    status, body, _ = mod.signed('GET', '/m/crm/ak/v1/busy')
    assert status == 200 and body == {'busy': False, 'reason': ''}


def test_events_idempotent(mod):
    event = {'seq': 1, 'event_id': 'ev-1', 'type': 'product.changed', 'source': 'uchet', 'time': T0, 'data': {}}
    assert mod.signed('POST', '/m/crm/ak/v1/events', event) [1] == {'ok': True, 'duplicate': False}
    assert mod.signed('POST', '/m/crm/ak/v1/events', event)[1] == {'ok': True, 'duplicate': True}
    # непонятное событие принимается (иначе ядро повторяло бы его вечно и держало следующие)
    assert mod.signed('POST', '/m/crm/ak/v1/events', {'seq': 2})[1] == {'ok': True, 'ignored': True}
    assert mod.signed('POST', '/m/crm/ak/v1/events', {'event_id': 7})[1] == {'ok': True, 'duplicate': False}
    assert mod.signed('POST', '/m/crm/ak/v1/events', b'not json')[0] == 200


def test_backup_restore_and_stop(tmp_path):
    m = Module(tmp_path)
    try:
        m.as_user(BOSS, 'owner', path='api/ak/me')
        assert m.as_user(BOSS, 'owner', 'POST', 'api/data/tasks', rows({'id': 'keep-me', 'title': 'Важное'}))[0] == 204
        files = m.data / 'files' / 'shared' / 't1'
        files.mkdir(parents=True)
        (files / 'a.jpg').write_bytes(b'jpg')
        assert m.signed('POST', '/m/crm/ak/v1/backup', {'name': '../evil'})[0] == 400
        for i in range(5):
            status, body, _ = m.signed('POST', '/m/crm/ak/v1/backup', {'name': f'2026-10-2{i}_1200'})
            assert status == 200 and body['ok'], body
            time.sleep(0.05)
        copies = sorted(p.name for p in (m.data / '.backup').iterdir())
        assert copies == ['2026-10-22_1200', '2026-10-23_1200', '2026-10-24_1200']  # старые модуль удаляет сам
        copy = m.data / '.backup' / '2026-10-24_1200'
        assert (copy / 'files' / 'shared' / 't1' / 'a.jpg').read_bytes() == b'jpg'
        con = sqlite3.connect(copy / 'den.db')
        assert con.execute('pragma integrity_check').fetchone()[0] == 'ok'
        assert con.execute("select count(*) from rows where id='keep-me'").fetchone()[0] == 1
        con.close()
        # остановка по команде ядра: ответ, затем штатный выход
        assert m.signed('POST', '/m/crm/ak/v1/stop')[0] == 200
        assert m.proc.wait(10) == 0
        assert not (m.data / 'den.db-wal').exists() or (m.data / 'den.db-wal').stat().st_size == 0
        # перезапуск на тех же данных — без потерь
        m.start()
        assert {r['id'] for r in m.as_user(BOSS, 'owner', path='api/data/tasks')[1]} == {'keep-me'}
    finally:
        m.stop()
    # восстановление на «чистом сервере»: папка данных = содержимое копии
    clean = tmp_path / 'clean'
    shutil.copytree(copy, clean)
    r = Module(tmp_path, data_dir=clean)
    try:
        assert {x['id'] for x in r.as_user(BOSS, 'owner', path='api/data/tasks')[1]} == {'keep-me'}
        assert r.as_user(BOSS, 'owner', path='api/files/shared/t1/a.jpg')[0] in (200, 404)  # файл на месте (доступ — по правам задачи)
        assert (clean / 'files' / 'shared' / 't1' / 'a.jpg').exists()
    finally:
        r.stop()



# --- п. 29–30: «Восстановить из файла» в самом модуле (только владелец, без перезапуска) ---

def zip_of(folder, prefix=''):
    path = folder.parent / f'{folder.name}-{secrets.token_hex(3)}.zip'
    with zipfile.ZipFile(path, 'w') as z:
        for p in folder.rglob('*'):
            if p.is_file():
                z.write(p, prefix + p.relative_to(folder).as_posix())
    return path.read_bytes()


def task_ids(m, epoch=None):
    h = {'X-Test-User': BOSS, 'X-Test-Roles': 'owner', **({'X-Den-Epoch': epoch} if epoch else {})}
    status, body, _ = http(f'{m.core.url}/m/crm/api/data/tasks', headers=h)
    return status, ({r['id'] for r in body} if status == 200 else body)


def test_restore_from_file(tmp_path):
    m = Module(tmp_path)
    try:
        epoch = m.as_user(BOSS, 'owner', path='api/ak/me', name='Шамиль')[1]['epoch']
        assert m.as_user(BOSS, 'owner', 'POST', 'api/data/tasks', rows({'id': 'old', 'title': 'Было в копии'}))[0] == 204
        photo = m.data / 'files' / 'shared' / 't1' / 'a.jpg'
        photo.parent.mkdir(parents=True)
        photo.write_bytes(b'jpg-old')
        for name in ('2026-10-26_0300', '2026-10-27_0300'):
            assert m.signed('POST', '/m/crm/ak/v1/backup', {'name': name})[0] == 200
        copies = m.data / '.backup'
        # общий архив АК: данные ядра + modules/crm/<имя>/ (берётся последняя копия)
        ak_zip = tmp_path / 'ak-2026-10-27.zip'
        with zipfile.ZipFile(ak_zip, 'w') as z:
            z.writestr('core/ak.db', b'core')
            for name in ('2026-10-26_0300', '2026-10-27_0300'):
                for p in (copies / name).rglob('*'):
                    if p.is_file():
                        z.write(p, f'modules/crm/{name}/{p.relative_to(copies / name).as_posix()}')
        shutil.copytree(copies / '2026-10-27_0300', tmp_path / 'own')
        # после копии: новая задача и другое фото
        assert m.as_user(BOSS, 'owner', 'POST', 'api/data/tasks', rows({'id': 'new', 'title': 'После копии'}))[0] == 204
        photo.write_bytes(b'jpg-new')
        # только владелец; не zip; zip без «Дня»; выход за папку — отказ, данные не тронуты
        assert m.as_user(WORKER, 'admin', 'POST', 'api/ak/restore', ak_zip.read_bytes())[0] == 403
        assert m.as_user(BOSS, 'owner', 'POST', 'api/ak/restore', b'not a zip')[1]['code'] == 'bad_backup'
        bad = tmp_path / 'bad.zip'
        with zipfile.ZipFile(bad, 'w') as z:
            z.writestr('modules/retail/2026-10-27_0300/retail.db', b'x')
        assert m.as_user(BOSS, 'owner', 'POST', 'api/ak/restore', bad.read_bytes())[0] == 400
        with zipfile.ZipFile(bad, 'w') as z:
            z.writestr('den.db', (copies / '2026-10-27_0300' / 'den.db').read_bytes())
            z.writestr('files/../../evil.txt', b'x')
        assert m.as_user(BOSS, 'owner', 'POST', 'api/ak/restore', bad.read_bytes())[0] == 400
        assert not (m.data.parent / 'evil.txt').exists() and task_ids(m)[1] == {'old', 'new'}
        # восстановление из общего архива АК — сразу, без перезапуска
        status, body, _ = m.as_user(BOSS, 'owner', 'POST', 'api/ak/restore', ak_zip.read_bytes())
        assert status == 200 and body['ok'] and body['copy'] == '2026-10-27_0300' and body['epoch'] != epoch, body
        assert m.proc.poll() is None and task_ids(m)[1] == {'old'} and photo.read_bytes() == b'jpg-old'
        aside = m.data / body['aside']
        con = sqlite3.connect(aside / 'den.db')
        assert con.execute("select count(*) from rows where id='new'").fetchone()[0] == 1  # прежнее отложено, не потеряно
        con.close()
        assert (aside / 'files' / 'shared' / 't1' / 'a.jpg').read_bytes() == b'jpg-new'
        # устройство с прежними данными: сервер не берёт их, а просит забыть и скачать заново
        status, err = task_ids(m, epoch)
        assert status == 409 and err['code'] == 'data_restored'
        status, err, _ = m.as_user(BOSS, 'owner', 'POST', 'api/data/tasks', rows({'id': 'new', 'title': 'Старое устройство'}), epoch=epoch)
        assert status == 409 and err['code'] == 'data_restored'
        # запись без метки (старая версия приложения) тоже не принимается; чтение — можно
        status, err, _ = m.as_user(BOSS, 'owner', 'POST', 'api/data/tasks', rows({'id': 'new', 'title': 'Без метки'}), epoch=False)
        assert status == 409 and err['code'] == 'epoch_required'
        me = m.as_user(BOSS, 'owner', path='api/ak/me')[1]
        assert me['restored'] and me['epoch'] == body['epoch']
        assert task_ids(m, body['epoch'])[0] == 200
        assert m.as_user(BOSS, 'owner', path='api/ak/me')[1]['epoch'] == body['epoch']
        # свой zip (содержимое одной папки копии); копия от прежней версии модуля — миграции те же, что при запуске
        old_db = tmp_path / 'own' / 'den.db'
        con = sqlite3.connect(old_db)
        con.execute('alter table users drop column name')
        con.execute("update meta set value='5' where key='schema'")  # до столбца users.name
        con.commit()
        con.close()
        status, body, _ = m.as_user(BOSS, 'owner', 'POST', 'api/ak/restore', zip_of(tmp_path / 'own'))
        assert status == 200, body
        assert task_ids(m, body['epoch'])[1] == {'old'}
        assert m.as_user(BOSS, 'owner', path='api/ak/me', name='Шамиль')[0] == 200  # столбец name снова есть
        # копия от более новой версии — отказ
        con = sqlite3.connect(old_db)
        con.execute("update meta set value='999' where key='schema'")
        con.commit()
        con.close()
        status, err, _ = m.as_user(BOSS, 'owner', 'POST', 'api/ak/restore', zip_of(tmp_path / 'own'))
        assert status == 400 and 'новой версией' in err['message']
        assert task_ids(m, body['epoch'])[0] == 200
        # после перезапуска — те же восстановленные данные и та же метка
        assert m.signed('POST', '/m/crm/ak/v1/stop')[0] == 200 and m.proc.wait(10) == 0
        m.start()
        assert task_ids(m, body['epoch'])[1] == {'old'}
        assert not list((m.data / 'tmp').glob('*'))  # временные файлы убраны
    finally:
        m.stop()


# --- ТЗ «АК-День»: клиенты — в справочнике ядра partners ---

def wait_for(check, seconds=20):
    end = time.time() + seconds
    while time.time() < end:
        result = check()
        if result:
            return result
        time.sleep(0.2)
    return check()


def crm_clients(m):
    return {r['id']: r['payload'] for r in m.as_user(BOSS, 'owner', path='api/crm/clients')[1]}


def core_now():
    from ak_core import now_iso
    return now_iso()


def event(m, data, event_id=None):
    return m.signed('POST', '/m/crm/ak/v1/events', {'seq': 1, 'event_id': event_id or str(uuid.uuid4()), 'type': 'partner.changed',
                                                     'source': 'retail', 'time': T0, 'data': data})


def test_clients_in_core_partners(tmp_path):
    m = Module(tmp_path)
    try:
        core = m.core
        client = {'id': 'cl-1', 'name': 'ООО Ромашка', 'inn': '7700000001', 'phone': '+7 900 111-22-33', 'note': 'вход со двора'}
        assert m.as_user(BOSS, 'owner', 'POST', 'api/crm/clients', rows(client))[0] == 204
        rec = wait_for(lambda: core.partners.get('cl-1'))
        assert rec and rec['rev'] == 1 and rec['data']['name'] == 'ООО Ромашка' and rec['data']['phone'] == '+7 900 111-22-33'
        assert rec['data']['inn'] == '7700000001' and not rec['deleted']
        # правка в «Дне» — новый rev
        assert m.as_user(BOSS, 'owner', 'POST', 'api/crm/clients', rows({**client, 'name': 'ООО Ромашка-2'}))[0] == 204
        assert wait_for(lambda: core.partners['cl-1']['rev'] == 2 and core.partners['cl-1']['data']['name'] == 'ООО Ромашка-2')
        # правка в другой программе: событие partner.changed → карточка в «Дне», свои поля карточки сохраняются
        same = str(uuid.uuid4())
        assert event(m, core.change_partner('cl-1', name='ООО Ромашка (из Ритейла)'), same)[0] == 200
        got = wait_for(lambda: crm_clients(m)['cl-1']['name'] == 'ООО Ромашка (из Ритейла)' and crm_clients(m)['cl-1'])
        assert got and got['phone'] == '+7 900 111-22-33' and got['updatedAt'] > T0
        # тот же event_id второй раз — не обрабатывается; устаревший rev — ничего не меняет
        core.change_partner('cl-1', name='Не должно прийти по старому событию')
        status, answer, _ = event(m, {'id': 'cl-1', 'rev': 99}, same)
        assert status == 200 and answer['duplicate']
        assert event(m, {'id': 'cl-1', 'rev': 1, 'deleted': False})[0] == 200
        time.sleep(3)
        assert crm_clients(m)['cl-1']['name'] == 'ООО Ромашка (из Ритейла)'
        # 409: запись в ядре изменили, а событие не дошло. Правка «Дня» новее — уходит в ядро с новым rev...
        now = core_now()
        assert m.as_user(BOSS, 'owner', 'POST', 'api/crm/clients', rows({**client, 'name': 'Ромашка — новее', 'updatedAt': now}))[0] == 204
        assert wait_for(lambda: core.partners['cl-1']['data']['name'] == 'Ромашка — новее')
        # ...правка старее записи ядра — уступает: в «Дне» становится запись ядра
        middle = core_now()
        time.sleep(0.05)
        core.change_partner('cl-1', name='Ромашка из ядра')
        assert m.as_user(BOSS, 'owner', 'POST', 'api/crm/clients', rows({**client, 'name': 'Старая правка', 'updatedAt': middle}))[0] == 204
        assert wait_for(lambda: crm_clients(m)['cl-1']['name'] == 'Ромашка из ядра')
        assert core.partners['cl-1']['data']['name'] == 'Ромашка из ядра'
        # 400 (ядро не приняло): владелец получает одно уведомление, повтор — не раньше чем через час, а не при каждом проходе
        core.reject = {'cl-bad'}
        assert m.as_user(BOSS, 'owner', 'POST', 'api/crm/clients', rows({'id': 'cl-bad', 'name': 'Отказ'}))[0] == 204
        assert wait_for(lambda: core.notices)
        time.sleep(3)
        assert len(core.notices) == 1 and 'cl-bad' not in core.partners
        # ядро не отвечает: правка ждёт в очереди и уходит, когда ядро вернулось
        core.down = True
        assert m.as_user(BOSS, 'owner', 'POST', 'api/crm/clients', rows({**client, 'id': 'cl-2', 'name': 'ИП Петров'}))[0] == 204
        time.sleep(3)
        assert 'cl-2' not in core.partners
        core.down = False
        assert wait_for(lambda: core.partners.get('cl-2'), 30)
        # удаление в «Дне» — в ядре пометка deleted:true, запись не стирается
        assert m.as_user(BOSS, 'owner', 'POST', 'api/crm/clients', rows({'id': 'cl-2', '__deleted': True, 'updatedAt': core_now()}))[0] == 204
        assert wait_for(lambda: core.partners['cl-2']['deleted'])
        assert core.partners['cl-2']['data']['name'] == 'ИП Петров' and core.partners['cl-2']['data']['phone'] == '+7 900 111-22-33'
        # партнёр, заведённый в ядре, пока модуль был остановлен, появляется при запуске (проход справочника)
        assert m.signed('POST', '/m/crm/ak/v1/stop')[0] == 200 and m.proc.wait(10) == 0
        core.change_partner('p-new', name='Партнёр из Ритейла', phone='+7 900 000-00-01')
        m.start()
        assert wait_for(lambda: crm_clients(m).get('p-new', {}).get('name') == 'Партнёр из Ритейла')
        # монтажник клиентов (и их телефонов) не видит, как и раньше
        status, body, _ = m.as_user(WORKER, 'courier', path='api/crm/clients')
        assert status == 200 and body == [], (status, body)
        assert all(ok for _, ok in core.checked)  # все запросы модуля к ядру подписаны
    finally:
        m.stop()
    text = m.log.read_text(errors='replace')
    assert '900 111' not in text and 'Ромашка' not in text, 'телефоны и названия клиентов не пишутся в журнал'
    assert 'Traceback' not in text


# --- ТЗ «АК-День»: данные прежней установки переносятся при первом запуске ---

def make_legacy(folder):
    """Прежняя установка «Дня» (свой сервер): администратор и монтажник со своими данными, клиент CRM, фото."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(('DEN_', 'AK_'))}
    env.update({'DEN_DATA_DIR': str(folder), 'DEN_SECRET': 's' * 40, 'DEN_ENV_FILE': str(folder / 'нет.env'),
                'DEN_NEW_PASSWORD': 'old-pass-123'})
    for email, *role in (('admin@old.ru', 'admin'), ('ivan@firma.ru',)):
        subprocess.run([sys.executable, '-m', 'server.admin', 'add', email, '-', *role], cwd=ROOT, env=env, check=True, capture_output=True)
    con = sqlite3.connect(folder / 'den.db')
    ids = dict(con.execute('select email, id from users'))
    con.executemany('insert into rows values (?,?,?,?,?,null)', [
        (ids['admin@old.ru'], 'tasks', 'old-task', json.dumps({'id': 'old-task', 'title': 'Старая задача', 'updatedAt': T0}), T0),
        (ids['ivan@firma.ru'], 'tasks', 'ivan-task', json.dumps({'id': 'ivan-task', 'title': 'Задача Ивана', 'updatedAt': T0}), T0)])
    con.execute("insert into crm values ('orders','o-1',?,?,null,'obj-1')",
                (json.dumps({'id': 'o-1', 'objectId': 'obj-1', 'assignees': ['ivan@firma.ru'], 'updatedAt': T0}), T0))
    con.execute("insert into crm_assignees values ('o-1','ivan@firma.ru')")
    con.commit()
    con.close()
    (folder / 'files' / 'crm' / 'obj-1').mkdir(parents=True)
    (folder / 'files' / 'crm' / 'obj-1' / 'a.jpg').write_bytes(b'old-photo')


def test_legacy_data_moved_on_first_start(tmp_path):
    legacy = tmp_path / 'Users' / 'shamil' / 'AppData' / 'Local' / 'Den' / 'data'
    legacy.mkdir(parents=True)
    make_legacy(legacy)
    before = {p.relative_to(legacy).as_posix(): p.stat().st_mtime_ns for p in legacy.rglob('*') if p.is_file()}
    m = Module(tmp_path, DEN_LEGACY_DATA=str(legacy))
    try:
        assert (m.data / 'files' / 'crm' / 'obj-1' / 'a.jpg').read_bytes() == b'old-photo'
        # владелец получает данные единственного прежнего администратора
        assert m.as_user(BOSS, 'owner', path='api/ak/me')[0] == 200
        assert {r['id'] for r in m.as_user(BOSS, 'owner', path='api/data/tasks')[1]} == {'old-task'}
        # монтажник узнан по email (логин в ядре ivan@firma.ru): его задачи и заявка
        assert m.as_user(WORKER, 'courier', path='api/ak/me')[0] == 200
        assert {r['id'] for r in m.as_user(WORKER, 'courier', path='api/data/tasks')[1]} == {'ivan-task'}
        orders = m.as_user(WORKER, 'courier', path='api/crm/orders')[1]
        assert [o['payload']['assignees'] for o in orders] == [[f'{WORKER}@ak']]
        # входа по старому паролю в модуле нет
        assert m.as_user(BOSS, 'owner', 'POST', 'api/auth/login', {'email': 'admin@old.ru', 'password': 'old-pass-123'})[0] == 404
    finally:
        m.stop()
    after = {p.relative_to(legacy).as_posix(): p.stat().st_mtime_ns for p in legacy.rglob('*') if p.is_file()}
    assert after == before, 'прежняя папка должна только читаться'
    assert 'взяты из' in m.log.read_text(errors='replace')
    # второй запуск: база модуля уже есть — повторно ничего не переносится
    m2 = Module(tmp_path, data_dir=m.data, DEN_LEGACY_DATA=str(legacy))
    try:
        assert {r['id'] for r in m2.as_user(BOSS, 'owner', path='api/data/tasks')[1]} == {'old-task'}
    finally:
        m2.stop()

def test_legacy_waits_while_old_server_runs(tmp_path):
    """Прежний сервер ещё запущен (держит свой den.lock): база не копируется посреди записи, модуль работает пустым
    и переносит данные при следующем запуске, если в нём ещё ничего не завели."""
    import fcntl
    legacy = tmp_path / 'old'
    legacy.mkdir()
    make_legacy(legacy)
    lock = open(legacy / 'den.lock', 'a+')
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    m = Module(tmp_path, DEN_LEGACY_DATA=str(legacy))
    try:
        assert m.as_user(BOSS, 'owner', path='api/data/tasks')[1] == []
    finally:
        m.stop()
        lock.close()
    assert 'сейчас запущен' in m.log.read_text(errors='replace')
    m2 = Module(tmp_path, data_dir=m.data, DEN_LEGACY_DATA=str(legacy))
    try:
        assert {r['id'] for r in m2.as_user(BOSS, 'owner', path='api/data/tasks')[1]} == {'old-task'}
    finally:
        m2.stop()


# --- п. 4 (запуск): только 127.0.0.1, данные только в AK_DATA_DIR ---

def test_refuses_external_host(tmp_path):
    env = {k: v for k, v in os.environ.items() if not k.startswith(('DEN_', 'AK_'))}
    env.update({'AK_MODULE_SECRET': SECRET_HEX, 'AK_DATA_DIR': str(tmp_path / 'd'), 'AK_HOST': '0.0.0.0', 'AK_PORT': str(free_port())})
    out = subprocess.run([sys.executable, '-m', 'server.run'], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
    assert out.returncode != 0 and '127.0.0.1' in out.stderr
    env.update({'AK_HOST': '127.0.0.1', 'AK_MODULE_SECRET': 'не-hex'})
    out = subprocess.run([sys.executable, '-m', 'server.run'], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
    assert out.returncode != 0 and 'hex' in out.stderr


def test_listens_only_on_loopback_and_writes_only_data_dir(mod):
    ip = socket.gethostbyname(socket.gethostname())
    if ip.startswith('127.'):
        pytest.skip('у машины нет другого адреса')
    with pytest.raises(OSError):
        socket.create_connection((ip, mod.port), timeout=2).close()


def test_written_only_in_data_dir(mod):
    names = {p.name for p in mod.data.iterdir()}
    assert {'den.db', 'den.lock'} <= names
    assert not (ROOT / 'data' / 'den.db').exists() or (ROOT / 'data' / 'den.db').stat().st_mtime < time.time() - 3600


# --- п. 1–3: пакет zip с module.json и icon.png ---

@pytest.mark.skipif(sys.platform == 'win32', reason='на Windows пакет проверяется настоящей сборкой в CI')
def test_package_builds_and_starts_like_core(tmp_path):
    """Пакет из «сборки», где den-server.exe — сценарий запуска этого же кода: проверка как у ядра (deploy/ak/smoke.py)."""
    import zipfile
    dist = tmp_path / 'dist'
    dist.mkdir()
    shutil.copy(ROOT / 'version.json', dist)
    (dist / 'task.ps1').write_text('# только для отдельной установки')
    exe = dist / 'den-server.exe'
    exe.write_text(f'#!/bin/sh\ncd "{ROOT}" && exec "{sys.executable}" -m server.run "$@"\n')
    exe.chmod(0o755)
    out = subprocess.run([sys.executable, 'deploy/ak/make_module.py', str(dist), str(tmp_path / 'out')], cwd=ROOT,
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    version = json.load(open(ROOT / 'version.json'))['version']
    package = tmp_path / 'out' / f'AK-Crm-Modul-1.0.{version}.zip'
    with zipfile.ZipFile(package) as z:
        names = set(z.namelist())
        meta = json.loads(z.read('module.json'))
    assert {'module.json', 'icon.png', 'den-server.exe', 'version.json', 'CHANGELOG.md'} <= names and 'task.ps1' not in names
    assert meta['id'] == 'crm' and meta['version'] == f'1.0.{version}' and meta['protocol'] == 1 and meta['min_core'] == '1.0.3' and meta['start_timeout_sec'] == 120
    assert meta['start'] == 'den-server.exe' and '..' not in meta['start'] and 'viewer' in meta['roles'] and 'CRM' in meta['about']
    (tmp_path / 'work').mkdir()
    out = subprocess.run([sys.executable, 'deploy/ak/smoke.py', str(package), str(tmp_path / 'work')], cwd=ROOT,
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0 and 'Пакет проверен' in out.stdout, out.stdout + out.stderr


def test_other_employee_in_same_browser_gets_409(mod):
    mod.as_user(BOSS, 'owner', path='api/ak/me')
    h = {'X-Test-User': WORKER, 'X-Test-Roles': 'courier', 'X-Den-User': BOSS}
    status, body, _ = http(f'{mod.core.url}/m/crm/api/data/tasks/heads', headers=h)
    assert status == 409 and body['code'] == 'user_changed'


def test_signature_edge_cases(mod):
    # пустой запрос «?» в конце и имя в UTF-8 без url-кодировки подписываются как пришли по сети
    req_path = '/m/crm/ak/v1/busy?'
    h = signed_headers(SECRET, 'crm', 'GET', req_path, b'')
    conn = __import__('http.client').client.HTTPConnection('127.0.0.1', mod.port, timeout=10)
    conn.request('GET', req_path, headers=h)
    assert conn.getresponse().status == 200
    conn.close()
    name = 'Шамиль'
    ts, nonce = str(int(time.time())), uuid.uuid4().hex
    line = '|'.join(['v1', 'core', 'crm', 'GET', '/m/crm/api/ak/me', __import__('hashlib').sha256(b'').hexdigest(), ts, nonce,
                     BOSS, 'org-1', 'owner', name]).encode()
    sign = __import__('hmac').new(SECRET, line, 'sha256').hexdigest()
    conn = __import__('http.client').client.HTTPConnection('127.0.0.1', mod.port, timeout=10)
    conn.putrequest('GET', '/m/crm/api/ak/me')
    for k, v in {'X-AK-From': 'core', 'X-AK-Time': ts, 'X-AK-Nonce': nonce, 'X-AK-Sign': sign, 'X-AK-User': BOSS,
                 'X-AK-Org': 'org-1', 'X-AK-Roles': 'owner'}.items():
        conn.putheader(k, v)
    conn.putheader('X-AK-User-Name', name.encode())
    conn.endheaders()
    assert conn.getresponse().status == 200
    conn.close()


def test_standalone_says_not_module(server):
    """Отдельный сервер: приложение узнаёт, что это не АК-Сервер, и показывает свой вход; служебных адресов нет."""
    assert server.get('/api/ak/me')[1] == {'ak': False}
    assert server.get('/api/ak/employees')[0] == 404
    assert server.get('/ak/v1/busy')[0] == 404
    assert server.post('/ak/v1/stop')[0] in (404, 405)
