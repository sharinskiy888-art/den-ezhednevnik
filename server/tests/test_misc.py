"""Служебное: CORS, кэш, формат ошибок, обратная связь, автокопии, раздача экранов, секреты."""
import base64
import os
import re
import sqlite3
import subprocess
import sys
import time
import zipfile

import pytest

from conftest import ADMIN_EMAIL, ADMIN_PASSWORD, ORIGIN, ROOT, free_port

pytestmark = pytest.mark.etap2


def test_cors_allows_only_configured_site(server):
    ok = server.call('OPTIONS', '/api/auth/login', headers={'Origin': ORIGIN, 'Access-Control-Request-Method': 'POST',
                                                             'Access-Control-Request-Headers': 'content-type,authorization,apikey'})
    assert ok[0] == 200 and ok[2].get('Access-Control-Allow-Origin') == ORIGIN
    allowed = ok[2].get('Access-Control-Allow-Headers', '').lower()
    assert all(h in allowed for h in ('authorization', 'content-type', 'apikey'))
    bad = server.call('OPTIONS', '/api/auth/login', headers={'Origin': 'https://evil.example', 'Access-Control-Request-Method': 'POST'})
    assert bad[2].get('Access-Control-Allow-Origin') in (None, '')


def test_cors_headers_on_errors_and_retry_after_exposed(fresh_server):
    api = fresh_server()
    h = {'Origin': ORIGIN}
    status, _, headers = api.get('/api/auth/user', headers=h)
    assert status == 401 and headers.get('Access-Control-Allow-Origin') == ORIGIN
    for _ in range(6):
        status, _, headers = api.post('/api/auth/login', {'email': 'x@den.test', 'password': 'bad'}, headers=h)
    assert status == 429 and headers.get('Access-Control-Allow-Origin') == ORIGIN
    assert 'retry-after' in headers.get('Access-Control-Expose-Headers', '').lower()


def test_api_responses_not_cached(server, alice):
    for status, _, headers in (server.get('/api/data/tasks', alice.token), server.get('/api/health'), server.get('/api/auth/user')):
        assert 'no-store' in headers.get('Cache-Control', '')


def test_errors_are_json_with_message(server):
    for status, body, headers in (server.get('/api/auth/user'), server.get('/api/nope'), server.post('/api/auth/login', {'email': 1})):
        assert 'application/json' in headers.get('Content-Type', '') and isinstance(body.get('message'), str), (status, body)


def test_feedback_saved_and_visible_to_admin(server, admin, alice):
    photo = 'data:image/jpeg;base64,' + base64.b64encode(b'\xff\xd8\xff' + b'0' * 500).decode()
    assert server.post('/api/feedback', {'text': 'Кнопка не работает', 'email': alice.email, 'photo': photo}, alice.token)[0] == 204
    assert server.post('/api/feedback', {'text': 'без входа'})[0] == 204
    status, items, _ = server.get('/api/admin/feedback', admin.token)
    mine = [i for i in items if i['text'] == 'Кнопка не работает']
    assert status == 200 and mine and mine[0]['photo'] == photo and mine[0]['email'] == alice.email


def test_feedback_validation(server):
    assert server.post('/api/feedback', {'text': ''})[0] == 400
    assert server.post('/api/feedback', {'text': 'x', 'photo': 'javascript:alert(1)'})[0] == 400


def test_feedback_rate_limited(fresh_server):
    api = fresh_server()
    codes = [api.post('/api/feedback', {'text': f'спам {i}'})[0] for i in range(7)]
    assert codes[:5] == [204] * 5 and codes[-1] == 429


def test_manual_backup_is_valid_sqlite(server, admin):
    status, body, _ = server.post('/api/admin/backup', token=admin.token)
    assert status == 201 and body['size'] > 0
    db = sqlite3.connect(server.data_dir / 'backups' / body['file'])
    assert db.execute('pragma integrity_check').fetchone()[0] == 'ok'
    assert db.execute('select count(*) from users').fetchone()[0] >= 1
    db.close()


def test_backup_includes_files_folder(server, admin):
    sample = server.data_dir / 'files' / 'shared' / 'probe' / 'x.jpg'
    sample.parent.mkdir(parents=True, exist_ok=True)
    sample.write_bytes(b'probe')
    assert server.post('/api/admin/backup', token=admin.token)[0] == 201
    zips = sorted((server.data_dir / 'backups').glob('files-*.zip'))
    assert zips and 'shared/probe/x.jpg' in zipfile.ZipFile(zips[-1]).namelist()


def test_backups_rotate(fresh_server):
    api = fresh_server(DEN_BACKUP_KEEP=3)
    token = api.login(ADMIN_EMAIL, ADMIN_PASSWORD)['access_token']
    names = []
    for _ in range(5):
        status, body, _ = api.post('/api/admin/backup', token=token)
        assert status == 201
        names.append(body['file'])
    assert len(set(names)) == 5  # копии подряд в одну секунду не затирают друг друга
    assert len(list((api.data_dir / 'backups').glob('den-*.db'))) == 3


def test_automatic_backup_on_schedule(fresh_server):
    api = fresh_server(DEN_BACKUP_EVERY=2)
    time.sleep(5)
    assert list((api.data_dir / 'backups').glob('den-*.db'))


def test_secrets_not_in_repository():
    tracked = subprocess.run(['git', 'ls-files'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split('\n')
    assert not [f for f in tracked if f.endswith(('den.env', '.db', '.db-wal')) or f.startswith('data/')]
    gi = (ROOT / '.gitignore').read_text()
    assert 'den.env' in gi and 'data/' in gi
    code = '\n'.join(p.read_text() for p in (ROOT / 'server').glob('*.py'))
    # Пустое значение по умолчанию с последующим отказом — нормально; непустое «запасное» значение секрета — нет.
    assert 'DEN_SECRET' in code
    assert not re.search(r"""(getenv|\.get)\(\s*['"]DEN_SECRET['"]\s*,\s*['"][^'"]+['"]""", code)


def run_without_secret(tmp_path, secret=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith('DEN_')}
    env['DEN_DATA_DIR'] = str(tmp_path / 'nosecret')
    if secret is not None:
        env['DEN_SECRET'] = secret
    try:
        p = subprocess.run([sys.executable, '-m', 'uvicorn', 'server.main:app', '--port', str(free_port())],
                           cwd=ROOT, env=env, capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        pytest.fail('Сервер запустился без нормального DEN_SECRET')
    return p


@pytest.mark.parametrize('secret', [None, 'short'])
def test_server_refuses_to_start_without_strong_secret(tmp_path, secret):
    p = run_without_secret(tmp_path, secret)
    assert p.returncode != 0 and 'DEN_SECRET' in (p.stderr + p.stdout)


def test_serves_only_app_files_when_static_dir_set(fresh_server):
    api = fresh_server(DEN_STATIC_DIR=str(ROOT))
    status, html, headers = api.get('/')
    assert status == 200 and 'text/html' in headers.get('Content-Type', '') and '<html' in html.lower()
    assert api.get('/sync.js')[0] == 200 and api.get('/assets/icon-192.png')[0] == 200
    for path in ('/server/main.py', '/.git/config', '/CLAUDE.md', '/arhiv/do-python/app.js', '/../etc/passwd', '/%2e%2e/den.db'):
        assert api.get(path)[0] == 404, path
    status, body, headers = api.get('/api/nope')
    assert status == 404 and 'application/json' in headers.get('Content-Type', '')


def test_chunked_body_over_limit_rejected(server):
    """Предел размера нельзя обойти, не указав длину тела (Transfer-Encoding: chunked)."""
    import http.client
    from urllib.parse import urlparse
    u = urlparse(server.base)
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=30)
    def body():
        chunk = b'A' * (1024 * 1024)
        yield b'{"text":"'
        for _ in range(40):
            yield chunk
        yield b'"}'
    try:
        conn.request('POST', '/api/feedback', body=body(), headers={'Content-Type': 'application/json'}, encode_chunked=True)
        status = conn.getresponse().status
    except (ConnectionError, http.client.HTTPException):
        status = 0
    finally:
        conn.close()
    assert status in (413, 0)


def test_feedback_daily_cap(fresh_server):
    api = fresh_server(DEN_FEEDBACK_DAILY=3, DEN_FEEDBACK_LIMIT=100)
    codes = [api.post('/api/feedback', {'text': f'сообщение {i}'})[0] for i in range(4)]
    assert codes == [204, 204, 204, 429]


def test_den_env_with_bom_from_notepad(tmp_path, fresh_server):
    env = tmp_path / 'den.env'
    env.write_bytes('﻿DEN_SECRET=bom-secret-'.encode('utf-8') + b'z' * 40 + b'\n')
    api = fresh_server(DEN_SECRET='', DEN_ENV_FILE=str(env))
    assert api.get('/api/health')[0] == 200


def test_backup_made_at_start_when_none_yet(fresh_server):
    api = fresh_server(DEN_BACKUP_EVERY=3600)
    time.sleep(2.5)
    assert list((api.data_dir / 'backups').glob('den-*.db'))


def test_head_request_for_screens(fresh_server):
    api = fresh_server(DEN_STATIC_DIR=str(ROOT))
    assert api.call('HEAD', '/index.html')[0] == 200


def admin_cli(data_dir, *args):
    env = {**os.environ, 'DEN_DATA_DIR': str(data_dir), 'DEN_SECRET': 'cli-secret-' + 'q' * 40}
    return subprocess.run([sys.executable, '-m', 'server.admin', *args], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)


def test_admin_command_line(tmp_path, fresh_server):
    data = tmp_path / 'cli'
    assert admin_cli(data, 'add', 'boss@den.test', 'boss-pass-123', 'admin').returncode == 0
    inv = admin_cli(data, 'invite', 'mont@den.test')
    code = inv.stdout.split(': ')[1].split()[0]
    assert admin_cli(data, 'password', 'boss@den.test', 'new-boss-456').returncode == 0
    assert 'boss@den.test' in admin_cli(data, 'users').stdout
    assert admin_cli(data, 'backup').returncode == 0
    assert admin_cli(data, 'password', 'nobody@den.test', 'x-pass-12345').returncode != 0
    api = fresh_server(data_dir=data, DEN_SECRET='cli-secret-' + 'q' * 40)
    assert api.post('/api/auth/login', {'email': 'boss@den.test', 'password': 'new-boss-456'})[0] == 200
    assert api.post('/api/auth/register', {'email': 'mont@den.test', 'password': 'mont-pass-1', 'invite': code})[0] == 200
    assert 'mont@den.test' in admin_cli(data, 'users').stdout
