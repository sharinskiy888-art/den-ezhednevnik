"""Модуль АК-Сервера (код crm): чек-лист из ТЗ модуля на заглушке ядра (ak_core.py).

Модуль запускается так же, как его запускает ядро: python -m server.run с переменными AK_* и без den.env.
"""
import json
import os
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
BOSS, WORKER, VIEWER, NOBODY, CASHIER = (str(uuid.uuid4()) for _ in range(5))
EMPLOYEES = {BOSS: {'id': BOSS, 'name': 'Шамиль', 'email': 'Boss@Firma.ru'},
             WORKER: {'id': WORKER, 'name': 'Иван Монтажник', 'email': 'ivan@firma.ru'},
             VIEWER: {'id': VIEWER, 'name': 'Бухгалтер'},  # без email — ключ «<uuid>@ak»
             CASHIER: {'id': CASHIER, 'name': 'Кассир', 'email': 'kassa@firma.ru'},
             str(uuid.uuid4()): {'id': 'x', 'name': 'Удалённый', 'deleted': True}}
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
                    'AK_PORT': str(self.port), 'AK_BASE_PATH': '/m/crm', 'AK_CORE_URL': self.core.url, 'AK_CORE_VERSION': '0.8.8',
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

    def as_user(self, user, roles, method='GET', path='', body=None, name=''):
        """Запрос через ядро-заглушку от имени сотрудника — как из браузера."""
        h = {'X-Test-User': user, 'X-Test-Roles': roles, 'X-Test-Name': urllib.parse.quote(name)}
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
    assert mod.as_user(CASHIER, 'admin', path='api/ak/me')[1] == {'ak': True, 'crm_role': 'manager', 'user': {
        'id': CASHIER, 'email': f'{CASHIER}@ak', 'name': '', 'role': 'user'}}


def test_employees_list_for_assignees(mod):
    mod.as_user(BOSS, 'owner', path='api/ak/me')
    status, body, _ = mod.as_user(BOSS, 'owner', path='api/ak/employees')
    assert status == 200
    keys = {e['id']: e['key'] for e in body}
    assert keys == {u: f'{u}@ak' for u in (BOSS, WORKER, VIEWER, CASHIER)}  # удалённый не показывается; список — по курсору
    assert {e['name'] for e in body} == {'Шамиль', 'Иван Монтажник', 'Бухгалтер', 'Кассир'}
    assert all(ok for _, ok in mod.core.checked) and mod.core.checked  # запросы модуля к ядру подписаны верно


def test_core_down(tmp_path):
    m = Module(tmp_path)
    try:
        m.core.down = True
        assert m.as_user(str(uuid.uuid4()), 'owner', path='api/ak/me')[0] == 200  # вход ядру не нужен: ключ из UUID
        status, body, _ = m.as_user(BOSS, 'owner', path='api/ak/employees')
        assert status == 503 and body['code'] == 'core_unavailable'
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
    assert meta['id'] == 'crm' and meta['version'] == f'1.0.{version}' and meta['protocol'] == 1 and meta['min_core'] == '0.8.8'
    assert meta['start'] == 'den-server.exe' and '..' not in meta['start'] and 'viewer' in meta['roles']
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
