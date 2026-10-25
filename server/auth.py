"""Вход, обновление входа, выход, смена пароля, приглашения и управление пользователями админом."""
import asyncio
import base64
import hashlib
import hmac
import secrets
import time
import uuid

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response

from . import db
from .access import ApiError, RateLimiter, bad, client_ip, current_user, field, make_access_token, read_json, require_admin, sign

router = APIRouter(prefix='/api')
login_limiter = RateLimiter(db.LOGIN_LIMIT, db.LOGIN_WINDOW)
SCRYPT = {'n': 2 ** 14, 'r': 8, 'p': 1}
SCRYPT_SLOTS = asyncio.Semaphore(4)  # каждая проверка пароля берёт 16 МБ памяти: не больше 4 одновременно


async def scrypt_call(func, *args):
    async with SCRYPT_SLOTS:
        return await run_in_threadpool(func, *args)
WRONG_LOGIN = 'Неверный email или пароль'


# --- Пароли: scrypt с солью ---

def hash_password(password: str):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **SCRYPT)
    return 'scrypt${n}${r}${p}${salt}${hash}'.format(**SCRYPT, salt=base64.b64encode(salt).decode(), hash=base64.b64encode(digest).decode())


def check_password(password: str, stored: str):
    try:
        _, n, r, p, salt, digest = stored.split('$')
        got = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), dklen=32, n=int(n), r=int(r), p=int(p))
        return hmac.compare_digest(got, base64.b64decode(digest))
    except (ValueError, TypeError):
        return False


DUMMY_HASH = hash_password(secrets.token_hex(8))  # чтобы неизвестный email отвечал так же долго, как неверный пароль


def norm_email(value):
    email = value.strip().lower()
    if '@' not in email or len(email) > 254 or ' ' in email:
        raise bad('Неверный email', 'bad_email')
    return email


def check_new_password(password):
    if len(password) < 8:
        raise bad('Пароль должен быть не короче 8 символов', 'weak_password')
    if len(password) > 200:
        raise bad('Слишком длинный пароль', 'bad_field')
    return password


def create_user(con, email, password_hash, role='user', user_id=None):
    if role not in ('user', 'admin'):
        raise bad('Роль — user или admin', 'bad_field')
    user_id = user_id or str(uuid.uuid4())
    if con.execute('select 1 from users where id=? or email=?', (user_id, email)).fetchone():
        raise ApiError(409, 'Такой пользователь уже есть', 'exists')
    con.execute('insert into users (id, email, password_hash, role, created_at) values (?,?,?,?,?)',
                (user_id, email, password_hash, role, db.now_iso()))
    return {'id': user_id, 'email': email, 'role': role}


def ensure_first_admin(con):
    if db.ADMIN_EMAIL and db.ADMIN_PASSWORD and not con.execute('select 1 from users limit 1').fetchone():
        with db.tx(con):
            create_user(con, db.ADMIN_EMAIL, hash_password(db.ADMIN_PASSWORD), 'admin')


# --- Сессии. Refresh-токен = <sid>.<номер>.<подпись>: сервер может пересчитать текущий токен, не храня его ---

def refresh_token(sid, counter):
    return f'{sid}.{counter}.{sign(f"refresh.{sid}.{counter}")}'


def session_response(user, sid, counter):
    access, exp = make_access_token(user, sid)
    return {'access_token': access, 'refresh_token': refresh_token(sid, counter), 'token_type': 'bearer',
            'expires_in': db.ACCESS_TTL, 'expires_at': exp,
            'user': {'id': user['id'], 'email': user['email'], 'role': user['role']}}


def new_session(con, user):
    sid = secrets.token_urlsafe(16)
    now = time.time()
    con.execute('delete from sessions where expires_at < ? or revoked = 1', (now,))
    con.execute('insert into sessions (id, user_id, counter, rotated_at, expires_at, created_at) values (?,?,0,?,?,?)',
                (sid, user['id'], now, now + db.REFRESH_TTL, now))
    return session_response(user, sid, 0)


def revoke_user_sessions(con, user_id, keep_sid=None):
    con.execute('update sessions set revoked=1 where user_id=? and id is not ?', (user_id, keep_sid))


@router.post('/auth/login')
async def login(request: Request):
    body = await read_json(request)
    email = field(body, 'email', max_len=300).strip().lower()
    password = field(body, 'password', max_len=200)
    keys = ('ip:' + client_ip(request), 'email:' + email)
    login_limiter.check(*keys)
    stamp = login_limiter.hit(*keys)  # засчитываем до проверки: параллельные попытки не проскочат лимит
    con = request.app.state.con
    user = con.execute('select * from users where email=?', (email,)).fetchone()
    ok = await scrypt_call(check_password, password, user['password_hash'] if user else DUMMY_HASH)
    if not (user and ok):
        raise ApiError(401, WRONG_LOGIN, 'invalid_credentials')
    login_limiter.undo(stamp, *keys)
    with db.tx(con):
        return new_session(con, user)


@router.post('/auth/refresh')
async def refresh(request: Request):
    token = field(await read_json(request), 'refresh_token', max_len=300)
    con = request.app.state.con
    expired = ApiError(401, 'Вход истёк. Войдите снова.', 'invalid_refresh')
    try:
        sid, counter, _sig = token.split('.')
        counter = int(counter)
    except ValueError:
        raise expired
    if not hmac.compare_digest(refresh_token(sid, counter), token):
        raise expired
    with db.tx(con):
        s = con.execute('select s.*, u.email, u.role from sessions s join users u on u.id=s.user_id where s.id=?', (sid,)).fetchone()
        if not s or s['revoked'] or s['expires_at'] < time.time():
            raise expired
        user = {'id': s['user_id'], 'email': s['email'], 'role': s['role']}
        if counter == s['counter']:
            # Пока человек пользуется приложением, вход продлевается (как было в Supabase).
            con.execute('update sessions set counter=counter+1, rotated_at=?, expires_at=? where id=?', (time.time(), time.time() + db.REFRESH_TTL, sid))
            return session_response(user, sid, counter + 1)
        if counter == s['counter'] - 1 and time.time() - s['rotated_at'] <= db.REFRESH_GRACE:
            return session_response(user, sid, s['counter'])  # параллельное обновление: тот же текущий токен
    # Старый токен пришёл поздно — его могли украсть: закрываем всю сессию.
    with db.tx(con):
        con.execute('update sessions set revoked=1 where id=?', (sid,))
    raise expired


@router.post('/auth/logout', status_code=204)
async def logout(request: Request):
    user = current_user(request)
    with db.tx(request.app.state.con) as con:
        con.execute('update sessions set revoked=1 where id=?', (user.sid,))
    return Response(status_code=204)


@router.get('/auth/user')
async def get_user(request: Request):
    user = current_user(request)
    return {'id': user.id, 'email': user.email, 'role': user.role}


@router.put('/auth/user')
async def change_password(request: Request):
    user = current_user(request)
    body = await read_json(request)
    password = check_new_password(field(body, 'password'))
    old = field(body, 'old_password', max_len=200)
    con = request.app.state.con
    stored = con.execute('select password_hash from users where id=?', (user.id,)).fetchone()[0]
    if not await scrypt_call(check_password, old, stored):
        raise ApiError(403, 'Старый пароль указан неверно', 'wrong_password')
    new_hash = await scrypt_call(hash_password, password)
    with db.tx(con):
        con.execute('update users set password_hash=? where id=?', (new_hash, user.id))
        revoke_user_sessions(con, user.id, keep_sid=user.sid)
    return {'id': user.id, 'email': user.email, 'role': user.role}


@router.post('/auth/register')
async def register(request: Request):
    body = await read_json(request)
    email = norm_email(field(body, 'email', max_len=300))
    password = check_new_password(field(body, 'password'))
    code = field(body, 'invite', max_len=200)
    keys = ('ip:' + client_ip(request), 'email:' + email)
    login_limiter.check(*keys)
    con = request.app.state.con
    code_hash = hashlib.sha256(code.encode()).hexdigest()
    invite = con.execute('select * from invites where code_hash=? and used_at is null and expires_at>?', (code_hash, time.time())).fetchone()
    if not invite or invite['email'] != email:
        login_limiter.hit(*keys)
        raise ApiError(403, 'Приглашение неверное, уже использовано или выдано на другой email', 'bad_invite')
    password_hash = await scrypt_call(hash_password, password)
    with db.tx(con):
        con.execute('update invites set used_at=? where code_hash=?', (time.time(), code_hash))
        user = create_user(con, email, password_hash, invite['role'])
        return new_session(con, user)


# --- Админ ---

@router.get('/admin/users')
async def list_users(request: Request):
    require_admin(request)
    rows = request.app.state.con.execute('select id, email, role, created_at from users order by created_at, email')
    return [dict(r) for r in rows]


@router.post('/admin/users', status_code=201)
async def add_user(request: Request):
    require_admin(request)
    body = await read_json(request)
    email = norm_email(field(body, 'email', max_len=300))
    password = check_new_password(field(body, 'password'))
    role = field(body, 'role', required=False) or 'user'
    user_id = field(body, 'id', required=False, max_len=100)
    if user_id is not None and not user_id.strip():
        raise bad('Пустой id', 'bad_field')
    password_hash = await scrypt_call(hash_password, password)
    with db.tx(request.app.state.con) as con:
        return JSONResponse(create_user(con, email, password_hash, role, user_id), status_code=201)


@router.put('/admin/users/{user_id}/password', status_code=204)
async def reset_password(user_id: str, request: Request):
    require_admin(request)
    password = check_new_password(field(await read_json(request), 'password'))
    password_hash = await scrypt_call(hash_password, password)
    with db.tx(request.app.state.con) as con:
        if not con.execute('update users set password_hash=? where id=?', (password_hash, user_id)).rowcount:
            raise ApiError(404, 'Нет такого пользователя', 'not_found')
        revoke_user_sessions(con, user_id)
    return Response(status_code=204)


@router.delete('/admin/users/{user_id}', status_code=204)
async def delete_user(user_id: str, request: Request):
    admin = require_admin(request)
    if user_id == admin.id:
        raise bad('Нельзя удалить самого себя', 'self_delete')
    with db.tx(request.app.state.con) as con:
        con.execute('delete from rows where user_id=?', (user_id,))
        con.execute('delete from sessions where user_id=?', (user_id,))
        if not con.execute('delete from users where id=?', (user_id,)).rowcount:
            raise ApiError(404, 'Нет такого пользователя', 'not_found')
    return Response(status_code=204)


@router.post('/admin/invites', status_code=201)
async def add_invite(request: Request):
    require_admin(request)
    body = await read_json(request)
    email = norm_email(field(body, 'email', max_len=300))
    role = field(body, 'role', required=False) or 'user'
    if role not in ('user', 'admin'):
        raise bad('Роль — user или admin', 'bad_field')
    code = secrets.token_urlsafe(12)
    expires = time.time() + 7 * 24 * 3600
    with db.tx(request.app.state.con) as con:
        con.execute('insert into invites (code_hash, email, role, expires_at) values (?,?,?,?)',
                    (hashlib.sha256(code.encode()).hexdigest(), email, role, expires))
    return JSONResponse({'invite': code, 'email': email, 'expires_at': int(expires)}, status_code=201)
