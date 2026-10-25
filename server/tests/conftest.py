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
T0 = '2026-10-25T10:00:00.000Z'
# Без системного прокси: на Windows urllib иначе может отправить запросы к 127.0.0.1 в прокси из реестра.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


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
            with OPENER.open(req, timeout=30) as r:
                status, content, rh = r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            status, content, rh = e.code, e.read(), e.headers
        except (urllib.error.URLError, ConnectionError) as e:
            # Сервер вправе оборвать слишком большой запрос, не дочитав его: статус 0 = «соединение закрыто».
            if isinstance(e, urllib.error.URLError) and not isinstance(e.reason, ConnectionError):
                raise
            return 0, None, {}
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


def start_server(tmp_path, data_dir=None, **env_extra):
    """Запускает сервер (по умолчанию с чистой базой). Если сервера ещё нет (этап 1) — тест падает с понятной причиной."""
    port = free_port()
    data_dir = Path(data_dir) if data_dir else tmp_path / f'data-{port}'
    env = {**os.environ,
           'DEN_DATA_DIR': str(data_dir), 'DEN_SECRET': SECRET,
           'DEN_PUBLIC_URL': f'http://127.0.0.1:{port}',
           'DEN_ADMIN_EMAIL': ADMIN_EMAIL, 'DEN_ADMIN_PASSWORD': ADMIN_PASSWORD,
           'DEN_ALLOWED_ORIGINS': ORIGIN,
           **{k: str(v) for k, v in env_extra.items()}}
    log_path = tmp_path / f'server-{port}.log'
    with open(log_path, 'wb') as log:
        proc = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', str(port)],
                                cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    api = Api(f'http://127.0.0.1:{port}', data_dir)
    api.log_path = log_path
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
    proc.wait(10)
    pytest.fail('Сервер не запустился:\n' + log_path.read_text(errors='replace')[-2000:])


@pytest.fixture(scope='session')
def server(tmp_path_factory):
    # Общий сервер с большим лимитом попыток: неудачные входы из разных тестов не должны блокировать друг друга.
    proc, api = start_server(tmp_path_factory.mktemp('main'), DEN_LOGIN_LIMIT=10000, DEN_FEEDBACK_LIMIT=10000)
    yield api
    proc.terminate()
    proc.wait(10)


@pytest.fixture
def fresh_server(tmp_path):
    """Отдельный сервер для тестов, которые меняют настройки или копят попытки входа."""
    procs = []

    def make(data_dir=None, **env):
        proc, api = start_server(tmp_path, data_dir, **env)
        procs.append(proc)

        def stop():
            proc.terminate()
            proc.wait(10)
        api.stop = stop
        return api
    yield make
    for p in procs:
        if p.poll() is None:
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
        assert status == 201, (status, created)
        return User(server.login(email, password), password)
    return make


@pytest.fixture
def alice(make_user): return make_user()


@pytest.fixture
def bob(make_user): return make_user()


def row(id=None, updated_at='2026-10-25T10:00:00.000Z', **payload):
    id = id or str(uuid.uuid4())
    return {'id': id, 'payload': {'id': id, 'title': 'Задача', 'updatedAt': updated_at, **payload}, 'updated_at': updated_at}


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
    status, body, _ = server.post('/api/shared', task, owner.token)
    assert status == 201, (status, body)
    assert server.post(f"/api/shared/{task['id']}/answer", {'accept': True}, worker.token)[0] == 204
    return {'owner': owner, 'worker': worker, 'invited': invited, 'stranger': stranger, 'id': task['id']}
