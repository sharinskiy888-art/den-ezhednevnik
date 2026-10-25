"""Вход, токены, приглашения, сброс пароля админом, лимит попыток (раздел 3 ТЗ)."""
import base64
import json
import sqlite3
import time

import pytest

from conftest import ADMIN_EMAIL, ADMIN_PASSWORD

pytestmark = pytest.mark.etap2


def token_data(token):
    part = token.split('.')[1]
    return json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))


def user_hash(server, email):
    db = sqlite3.connect(server.data_dir / 'den.db')
    try:
        return db.execute('select password_hash from users where email=?', (email,)).fetchone()[0]
    finally:
        db.close()


def test_health_without_login(server):
    status, body, _ = server.get('/api/health')
    assert status == 200 and body['ok'] is True and body['version']


def test_first_admin_created_from_env(admin):
    assert admin.email == ADMIN_EMAIL and admin.session['user']['role'] == 'admin'


def test_session_shape_matches_sync_js(admin):
    s = admin.session
    assert set(s) >= {'access_token', 'refresh_token', 'token_type', 'expires_in', 'expires_at', 'user'}
    assert s['token_type'] == 'bearer' and set(s['user']) >= {'id', 'email', 'role'}
    assert s['expires_at'] == token_data(s['access_token'])['exp']


def test_token_has_issuer_readable_like_supabase(server, admin):
    data = token_data(admin.token)
    assert data['iss'].startswith(server.base) and data['sub'] == admin.id and data['sid']


def test_login_email_is_case_insensitive(server, make_user):
    u = make_user(email='Case@Den.Test')
    assert u.email == 'case@den.test'
    assert server.post('/api/auth/login', {'email': '  CASE@den.test ', 'password': u.password})[0] == 200


def test_wrong_password_and_unknown_email_look_the_same(server, alice):
    a = server.post('/api/auth/login', {'email': alice.email, 'password': 'wrong-pass'})
    b = server.post('/api/auth/login', {'email': 'nobody@den.test', 'password': 'wrong-pass'})
    assert a[0] == b[0] == 401 and a[1]['message'] == b[1]['message']


def test_login_bad_body_is_400(server):
    assert server.post('/api/auth/login', {'email': 1})[0] == 400
    assert server.post('/api/auth/login', raw=b'{oops', headers={'Content-Type': 'application/json'})[0] == 400


def test_get_user_requires_token(server, alice):
    assert server.get('/api/auth/user')[0] == 401
    status, body, _ = server.get('/api/auth/user', alice.token)
    assert status == 200 and body == {'id': alice.id, 'email': alice.email, 'role': 'user'}


@pytest.mark.parametrize('header', ['Bearer ', 'Bearer abc', 'Bearer den1.e30.AAAA', 'Basic YTpi'])
def test_garbage_token_rejected(server, header):
    assert server.get('/api/auth/user', headers={'Authorization': header})[0] == 401


def test_tampered_token_rejected(server, alice):
    head, _, sig = alice.token.split('.')
    payload = token_data(alice.token)
    payload['role'] = 'admin'
    forged = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')
    assert server.get('/api/auth/user', f'{head}.{forged}.{sig}')[0] == 401
    assert server.get('/api/admin/users', f'{head}.{forged}.{sig}')[0] == 401


def test_token_signed_with_other_secret_rejected(fresh_server, alice):
    other = fresh_server(DEN_SECRET='another-secret-' + 'y' * 40)
    assert other.get('/api/auth/user', alice.token)[0] == 401


def test_expired_access_token_gives_401_and_refresh_works(fresh_server):
    api = fresh_server(DEN_ACCESS_TTL=2)
    s = api.login(ADMIN_EMAIL, ADMIN_PASSWORD)
    time.sleep(3.2)
    assert api.get('/api/auth/user', s['access_token'])[0] == 401
    status, new, _ = api.post('/api/auth/refresh', {'refresh_token': s['refresh_token']})
    assert status == 200 and new['access_token'] != s['access_token']
    assert api.get('/api/auth/user', new['access_token'])[0] == 200


def test_refresh_returns_full_session(server, make_user):
    u = make_user()
    status, new, _ = server.post('/api/auth/refresh', {'refresh_token': u.session['refresh_token']})
    assert status == 200 and set(new) >= {'access_token', 'refresh_token', 'expires_at', 'expires_in', 'user'}
    assert new['user']['id'] == u.id and new['refresh_token'] != u.session['refresh_token']


def test_parallel_refresh_within_grace_is_ok(server, make_user):
    """Синхронизация и присутствие обновляют вход одновременно одним и тем же токеном — человека не выкидывает."""
    u = make_user()
    a = server.post('/api/auth/refresh', {'refresh_token': u.session['refresh_token']})
    b = server.post('/api/auth/refresh', {'refresh_token': u.session['refresh_token']})
    assert a[0] == b[0] == 200
    assert server.get('/api/auth/user', a[1]['access_token'])[0] == 200
    assert server.get('/api/auth/user', b[1]['access_token'])[0] == 200


def test_reused_refresh_token_after_grace_revokes_whole_session(fresh_server):
    api = fresh_server(DEN_REFRESH_GRACE=1)
    s = api.login(ADMIN_EMAIL, ADMIN_PASSWORD)
    status, new, _ = api.post('/api/auth/refresh', {'refresh_token': s['refresh_token']})
    assert status == 200
    time.sleep(2)
    # Старый токен кто-то украл и использовал позже — сессия отзывается целиком, включая новый токен.
    assert api.post('/api/auth/refresh', {'refresh_token': s['refresh_token']})[0] == 401
    assert api.post('/api/auth/refresh', {'refresh_token': new['refresh_token']})[0] == 401
    assert api.get('/api/auth/user', new['access_token'])[0] == 401


def test_bad_refresh_token(server):
    assert server.post('/api/auth/refresh', {'refresh_token': 'nope'})[0] == 401


def test_logout_revokes_access_and_refresh(server, make_user):
    u = make_user()
    assert server.post('/api/auth/logout', token=u.token)[0] == 204
    assert server.get('/api/auth/user', u.token)[0] == 401
    assert server.post('/api/auth/refresh', {'refresh_token': u.session['refresh_token']})[0] == 401


def test_change_password(server, make_user):
    u = make_user()
    other = server.login(u.email, u.password)  # вторая сессия, например телефон
    assert server.put('/api/auth/user', {'password': 'new-pass-456', 'old_password': 'wrong'}, u.token)[0] == 403
    assert server.put('/api/auth/user', {'password': 'new-pass-456', 'old_password': u.password}, u.token)[0] == 200
    assert server.get('/api/auth/user', u.token)[0] == 200  # текущая сессия жива
    assert server.get('/api/auth/user', other['access_token'])[0] == 401  # прочие отозваны
    assert server.post('/api/auth/login', {'email': u.email, 'password': u.password})[0] == 401
    assert server.post('/api/auth/login', {'email': u.email, 'password': 'new-pass-456'})[0] == 200


def test_short_password_rejected(server, admin):
    assert server.post('/api/admin/users', {'email': 'short@den.test', 'password': '123'}, admin.token)[0] == 400


def test_passwords_stored_as_salted_scrypt(server, make_user):
    a = make_user(password='very-unique-pass-777')
    b = make_user(password='very-unique-pass-777')
    raw = (server.data_dir / 'den.db').read_bytes()
    wal = server.data_dir / 'den.db-wal'
    raw += wal.read_bytes() if wal.exists() else b''
    assert b'very-unique-pass-777' not in raw
    ha, hb = user_hash(server, a.email), user_hash(server, b.email)
    assert ha.startswith('scrypt$') and hb.startswith('scrypt$') and ha != hb


def test_sqlite_uses_wal(server, admin):
    db = sqlite3.connect(server.data_dir / 'den.db')
    assert db.execute('pragma journal_mode').fetchone()[0].lower() == 'wal'
    db.close()


def test_restart_keeps_data_and_does_not_recreate_admin(fresh_server, tmp_path):
    data = tmp_path / 'keep'
    api = fresh_server(data_dir=data)
    token = api.login(ADMIN_EMAIL, ADMIN_PASSWORD)['access_token']
    assert api.post('/api/admin/users', {'email': 'stay@den.test', 'password': 'pass-123456'}, token)[0] == 201
    api.stop()
    again = fresh_server(data_dir=data, DEN_ADMIN_PASSWORD='other-pass-000')
    assert again.post('/api/auth/login', {'email': 'stay@den.test', 'password': 'pass-123456'})[0] == 200
    assert again.post('/api/auth/login', {'email': ADMIN_EMAIL, 'password': ADMIN_PASSWORD})[0] == 200


def test_second_server_on_same_folder_refuses(fresh_server, tmp_path):
    import subprocess, sys, os
    from conftest import ROOT, SECRET, free_port
    data = tmp_path / 'locked'
    fresh_server(data_dir=data)
    env = {**os.environ, 'DEN_DATA_DIR': str(data), 'DEN_SECRET': SECRET}
    try:
        p = subprocess.run([sys.executable, '-m', 'uvicorn', 'server.main:app', '--port', str(free_port())],
                           cwd=ROOT, env=env, capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        pytest.fail('Второй сервер запустился на ту же папку данных')
    assert p.returncode != 0


def test_log_has_no_passwords_or_tokens(server, make_user):
    u = make_user(password='log-secret-pass-42')
    server.get('/api/auth/user', u.token)
    log = server.log_path.read_text(errors='replace')
    assert 'log-secret-pass-42' not in log and u.token not in log and u.session['refresh_token'] not in log


# --- Админ ---

def test_admin_endpoints_forbidden_for_user(server, alice):
    for method, path in [('GET', '/api/admin/users'), ('POST', '/api/admin/users'), ('POST', '/api/admin/invites'),
                         ('POST', '/api/admin/backup'), ('GET', '/api/admin/feedback'),
                         ('PUT', f'/api/admin/users/{alice.id}/password'), ('DELETE', f'/api/admin/users/{alice.id}')]:
        assert server.call(method, path, {'email': 'x@den.test', 'password': 'pass-123456'}, alice.token)[0] == 403, path


def test_admin_list_users_has_no_hashes(server, admin, alice):
    status, users, _ = server.get('/api/admin/users', admin.token)
    assert status == 200 and any(u['id'] == alice.id for u in users)
    assert all(not any('hash' in k or 'password' in k for k in u) for u in users)


def test_admin_creates_user_with_given_id_for_migration(make_user):
    old_id = '6f1c2d3e-0000-4000-8000-00000000abcd'
    assert make_user(id=old_id).id == old_id


def test_duplicate_email_or_id_conflict(server, admin, alice):
    assert server.post('/api/admin/users', {'email': alice.email, 'password': 'pass-123456'}, admin.token)[0] == 409
    assert server.post('/api/admin/users', {'email': 'other@den.test', 'password': 'pass-123456', 'id': alice.id}, admin.token)[0] == 409


def test_admin_reset_password_revokes_sessions(server, admin, make_user):
    u = make_user()
    assert server.put(f'/api/admin/users/{u.id}/password', {'password': 'reset-pass-999'}, admin.token)[0] == 204
    assert server.get('/api/auth/user', u.token)[0] == 401
    assert server.post('/api/auth/refresh', {'refresh_token': u.session['refresh_token']})[0] == 401
    assert server.post('/api/auth/login', {'email': u.email, 'password': 'reset-pass-999'})[0] == 200


def test_admin_delete_user(server, admin, make_user):
    u = make_user()
    assert server.delete(f'/api/admin/users/{u.id}', admin.token)[0] == 204
    assert server.get('/api/auth/user', u.token)[0] == 401
    assert server.post('/api/auth/login', {'email': u.email, 'password': u.password})[0] == 401


# --- Приглашения ---

def test_register_only_by_invite(server):
    assert server.post('/api/auth/register', {'email': 'street@den.test', 'password': 'pass-123456', 'invite': 'nope'})[0] == 403
    assert server.post('/api/auth/register', {'email': 'street@den.test', 'password': 'pass-123456'})[0] == 400


def test_invite_is_single_use_and_bound_to_email(server, admin):
    status, inv, _ = server.post('/api/admin/invites', {'email': 'Mont@Den.Test'}, admin.token)
    assert status == 201 and inv['invite'] and inv['email'] == 'mont@den.test'
    assert server.post('/api/auth/register', {'email': 'other@den.test', 'password': 'pass-123456', 'invite': inv['invite']})[0] == 403
    status, s, _ = server.post('/api/auth/register', {'email': 'mont@den.test', 'password': 'pass-123456', 'invite': inv['invite']})
    assert status == 200 and s['user']['email'] == 'mont@den.test' and s['user']['role'] == 'user'
    assert server.post('/api/auth/register', {'email': 'mont@den.test', 'password': 'pass-123456', 'invite': inv['invite']})[0] == 403


# --- Лимит попыток: 5 за минуту на адрес и на email ---

def test_login_rate_limit_per_email(fresh_server):
    api = fresh_server()
    for _ in range(5):
        assert api.post('/api/auth/login', {'email': ADMIN_EMAIL, 'password': 'wrong'})[0] == 401
    status, body, headers = api.post('/api/auth/login', {'email': ADMIN_EMAIL, 'password': ADMIN_PASSWORD})
    assert status == 429 and int(headers.get('Retry-After', '0')) > 0 and body['message']


def test_login_rate_limit_per_address(fresh_server):
    api = fresh_server()
    for i in range(5):
        api.post('/api/auth/login', {'email': f'n{i}@den.test', 'password': 'wrong'})
    assert api.post('/api/auth/login', {'email': 'n9@den.test', 'password': 'wrong'})[0] == 429


def test_rate_limit_also_guards_register(fresh_server):
    api = fresh_server()
    for _ in range(5):
        api.post('/api/auth/register', {'email': 'r@den.test', 'password': 'pass-123456', 'invite': 'bad'})
    assert api.post('/api/auth/register', {'email': 'r@den.test', 'password': 'pass-123456', 'invite': 'bad'})[0] == 429


def test_rate_limit_lifts_after_window(fresh_server):
    api = fresh_server(DEN_LOGIN_WINDOW=2)
    for _ in range(5):
        api.post('/api/auth/login', {'email': ADMIN_EMAIL, 'password': 'wrong'})
    assert api.post('/api/auth/login', {'email': ADMIN_EMAIL, 'password': ADMIN_PASSWORD})[0] == 429
    time.sleep(3.5)
    assert api.post('/api/auth/login', {'email': ADMIN_EMAIL, 'password': ADMIN_PASSWORD})[0] == 200
