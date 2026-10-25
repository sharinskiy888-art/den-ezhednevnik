"""Служебное: CORS, формат ошибок, обратная связь, автокопии, раздача экранов."""
import sqlite3
import time
import urllib.request

import pytest

from conftest import ORIGIN, ROOT

pytestmark = pytest.mark.etap2


def test_cors_allows_only_configured_site(server):
    ok = server.call('OPTIONS', '/api/auth/login', headers={'Origin': ORIGIN, 'Access-Control-Request-Method': 'POST',
                                                             'Access-Control-Request-Headers': 'content-type,authorization'})
    assert ok[2].get('Access-Control-Allow-Origin') == ORIGIN
    bad = server.call('OPTIONS', '/api/auth/login', headers={'Origin': 'https://evil.example', 'Access-Control-Request-Method': 'POST'})
    assert bad[2].get('Access-Control-Allow-Origin') in (None, '')


def test_errors_are_json_with_message(server):
    for status, body, headers in (server.get('/api/auth/user'), server.get('/api/nope'), server.post('/api/auth/login', {'email': 1})):
        assert 'application/json' in headers.get('Content-Type', '') and isinstance(body.get('message'), str), (status, body)


def test_no_server_header_details_or_tracebacks(server):
    status, body, _ = server.call('POST', '/api/data/tasks', raw=b'{not json', headers={'Content-Type': 'application/json', 'Authorization': 'Bearer x'})
    assert status in (400, 401, 422) and 'Traceback' not in str(body)


def test_feedback_saved_and_visible_to_admin(server, admin, alice):
    assert server.post('/api/feedback', {'text': 'Кнопка не работает', 'email': alice.email}, alice.token)[0] in (200, 201, 204)
    status, items, _ = server.get('/api/admin/feedback', admin.token)
    assert status == 200 and any(i['text'] == 'Кнопка не работает' for i in items)


def test_feedback_rate_limited(fresh_server):
    api = fresh_server()
    codes = [api.post('/api/feedback', {'text': f'спам {i}'})[0] for i in range(7)]
    assert codes[-1] == 429 and all(c in (200, 201, 204) for c in codes[:5])


def test_manual_backup_is_valid_sqlite(server, admin):
    status, body, _ = server.post('/api/admin/backup', token=admin.token)
    assert status in (200, 201) and body['size'] > 0
    path = server.data_dir / 'backups' / body['file']
    db = sqlite3.connect(path)
    assert db.execute('pragma integrity_check').fetchone()[0] == 'ok'
    assert db.execute('select count(*) from users').fetchone()[0] >= 1
    db.close()


def test_backups_rotate(fresh_server):
    api = fresh_server(DEN_BACKUP_KEEP=3)
    from conftest import ADMIN_EMAIL, ADMIN_PASSWORD
    token = api.login(ADMIN_EMAIL, ADMIN_PASSWORD)['access_token']
    for _ in range(5):
        assert api.post('/api/admin/backup', token=token)[0] in (200, 201)
        time.sleep(1.1)
    assert len(list((api.data_dir / 'backups').glob('*.db'))) == 3


def test_secrets_not_in_repository():
    for p in ROOT.joinpath('server').rglob('*'):
        if p.is_file() and p.suffix in ('.py', '.md', '.txt', '.ini', '.env'):
            assert p.name != 'den.env', p
    gi = ROOT / '.gitignore'
    assert gi.exists() and 'den.env' in gi.read_text() and 'data/' in gi.read_text()


def test_server_refuses_to_start_without_secret(tmp_path):
    import os, subprocess, sys
    env = {k: v for k, v in os.environ.items() if not k.startswith('DEN_')}
    env['DEN_DATA_DIR'] = str(tmp_path)
    p = subprocess.run([sys.executable, '-c', 'import server.main'], cwd=ROOT, env=env, capture_output=True, text=True, timeout=30)
    assert p.returncode != 0 and 'DEN_SECRET' in (p.stderr + p.stdout)


def test_serves_app_screens_when_static_dir_set(fresh_server):
    api = fresh_server(DEN_STATIC_DIR=str(ROOT))
    status, html, headers = api.get('/')
    assert status == 200 and 'text/html' in headers.get('Content-Type', '') and '<html' in html.lower()
    assert api.get('/sync.js')[0] == 200
    assert api.get('/server/main.py')[0] == 404 and api.get('/.git/config')[0] == 404
