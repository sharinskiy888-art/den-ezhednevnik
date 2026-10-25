"""Общие заготовки тестов: настоящий сервер в отдельном процессе и простой клиент на urllib.

Тесты ходят в сервер по HTTP, как это делает sync.js, поэтому не зависят от того, как сервер устроен внутри.
Отдельная библиотека для HTTP-клиента не нужна (лимит внешних библиотек по ТЗ — 4).
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]  # корень репозитория: там лежит пакет server/
ADMIN_EMAIL = 'admin@den.test'
ADMIN_PASSWORD = 'admin-pass-123'
SECRET = 'test-secret-' + 'x' * 40
ORIGIN = 'https://sharinskiy888-art.github.io'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Api:
    def __init__(self, base, data_dir):
        self.base = base
        self.data_dir = Path(data_dir)

    def call(self, method, path, body=None, token=None, headers=None, raw=None):
        """Возвращает (статус, тело, заголовки). Тело — разобранный JSON, байты (для файлов) или None."""
        hdrs = dict(headers or {})
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            hdrs.setdefault('Content-Type', 'application/json')
        if token:
            hdrs['Authorization'] = f'Bearer {token}'
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                status, content, rh = r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            status, content, rh = e.code, e.read(), e.headers
        ctype = rh.get('Content-Type', '')
        if not content:
            parsed = None
        elif 'application/json' in ctype:
            parsed = json.loads(content)
        elif ctype.startswith('text/'):
            parsed = content.decode('utf-8', 'replace')
        else:
            parsed = content
        return status, parsed, rh

    def get(self, path, token=None, **kw): return self.call('GET', path, token=token, **kw)
    def post(self, path, body=None, token=None, **kw): return self.call('POST', path, body, token, **kw)
    def put(self, path, body=None, token=None, **kw): return self.call('PUT', path, body, token, **kw)
    def patch(self, path, body=None, token=None, **kw): return self.call('PATCH', path, body, token, **kw)
    def delete(self, path, token=None, **kw): return self.call('DELETE', path, token=token, **kw)

    def login(self, email, password):
        status, body, _ = self.post('/api/auth/login', {'email': email, 'password': password})
        assert status == 200, (status, body)
        return body


class User:
    def __init__(self, session, password):
        self.session = session
        self.id = session['user']['id']
        self.email = session['user']['email']
        self.token = session['access_token']
        self.password = password


def start_server(tmp_path, **env_extra):
    """Запускает сервер с чистой базой во временной папке. Если сервера ещё нет (этап 1) — тест падает с понятной причиной."""
    port = free_port()
    data_dir = tmp_path / f'data-{port}'
    env = {**os.environ,
           'DEN_DATA_DIR': str(data_dir), 'DEN_SECRET': SECRET,
           'DEN_PUBLIC_URL': f'http://127.0.0.1:{port}',
           'DEN_ADMIN_EMAIL': ADMIN_EMAIL, 'DEN_ADMIN_PASSWORD': ADMIN_PASSWORD,
           'DEN_ALLOWED_ORIGINS': ORIGIN,
           **{k: str(v) for k, v in env_extra.items()}}
    log = open(tmp_path / f'server-{port}.log', 'wb')
    proc = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', str(port)],
                            cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    api = Api(f'http://127.0.0.1:{port}', data_dir)
    deadline = time.time() + 15
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        try:
            if api.get('/api/health')[0] == 200:
                return proc, api
        except OSError:
            pass
        time.sleep(0.1)
    proc.kill()
    log.close()
    pytest.fail('Сервер не запустился:\n' + (tmp_path / f'server-{port}.log').read_text(errors='replace')[-2000:])


@pytest.fixture(scope='session')
def server(tmp_path_factory):
    proc, api = start_server(tmp_path_factory.mktemp('main'))
    yield api
    proc.terminate()
    proc.wait(10)


@pytest.fixture
def fresh_server(tmp_path):
    """Отдельный сервер для тестов, которые меняют настройки или копят попытки входа."""
    procs = []

    def make(**env):
        proc, api = start_server(tmp_path, **env)
        procs.append(proc)
        return api
    yield make
    for p in procs:
        p.terminate()
        p.wait(10)


@pytest.fixture(scope='session')
def admin(server):
    return User(server.login(ADMIN_EMAIL, ADMIN_PASSWORD), ADMIN_PASSWORD)


@pytest.fixture
def make_user(server, admin):
    """Создаёт нового пользователя через админа и входит под ним."""
    def make(email=None, password='user-pass-123', role='user', id=None):
        email = email or f'u-{uuid.uuid4().hex[:10]}@den.test'
        body = {'email': email, 'password': password, 'role': role}
        if id:
            body['id'] = id
        status, created, _ = server.post('/api/admin/users', body, admin.token)
        assert status in (200, 201), (status, created)
        return User(server.login(email, password), password)
    return make


@pytest.fixture
def alice(make_user): return make_user()


@pytest.fixture
def bob(make_user): return make_user()


def row(id=None, updated_at='2026-10-25T10:00:00.000Z', **payload):
    id = id or str(uuid.uuid4())
    return {'id': id, 'payload': {'id': id, 'title': 'Задача', 'updatedAt': updated_at, **payload}, 'updated_at': updated_at}
