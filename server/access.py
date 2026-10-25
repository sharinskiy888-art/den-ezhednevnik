"""Все проверки прав в одном месте (вместо RLS Supabase) и разбор входящих запросов.

Любой маршрут получает пользователя только через current_user(): токен проверяется подписью, сроком
и живой сессией в базе. Личные данные всегда ищутся по user_id из токена, а не из тела запроса.
"""
import base64
import hashlib
import hmac
import json
import math
import time
from dataclasses import dataclass

from fastapi import Request

from . import db


class ApiError(Exception):
    def __init__(self, status, message, code='error', headers=None):
        self.status, self.message, self.code, self.headers = status, message, code, headers or {}


def bad(message, code='bad_request'):
    return ApiError(400, message, code)


async def read_json(request: Request):
    raw = await request.body()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        raise bad('Неверный формат данных (ожидается JSON)', 'bad_json')


def field(body, name, kind=str, required=True, max_len=None):
    value = body.get(name) if isinstance(body, dict) else None
    if value is None:
        if required:
            raise bad(f'Не хватает поля «{name}»', 'missing_field')
        return None
    if not isinstance(value, kind) or (kind is int and isinstance(value, bool)):
        raise bad(f'Неверное поле «{name}»', 'bad_field')
    if max_len and len(value) > max_len:
        raise bad(f'Слишком длинное поле «{name}»', 'bad_field')
    return value


# --- Токены: den1.<данные>.<подпись> ---

def _b64(data: bytes):
    return base64.urlsafe_b64encode(data).decode().rstrip('=')


def _unb64(text: str):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def sign(message: str):
    return _b64(hmac.new(db.SECRET.encode(), message.encode(), hashlib.sha256).digest())


def make_access_token(user, sid):
    exp = math.ceil(time.time() + db.ACCESS_TTL)
    data = _b64(json.dumps({'sub': user['id'], 'email': user['email'], 'role': user['role'], 'iss': db.PUBLIC_URL,
                            'exp': exp, 'sid': sid}, separators=(',', ':')).encode())
    return f'den1.{data}.{sign("den1." + data)}', exp


@dataclass
class User:
    id: str
    email: str
    role: str
    sid: str

    @property
    def is_admin(self):
        return self.role == 'admin'


def user_from_token(con, token):
    parts = token.split('.')
    if len(parts) != 3 or parts[0] != 'den1' or not hmac.compare_digest(sign(f'den1.{parts[1]}'), parts[2]):
        return None
    try:
        data = json.loads(_unb64(parts[1]))
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get('exp', 0) < time.time():
        return None
    row = con.execute('select u.id, u.email, u.role from sessions s join users u on u.id = s.user_id '
                      'where s.id=? and s.user_id=? and s.revoked=0 and s.expires_at>?',
                      (data.get('sid'), data.get('sub'), time.time())).fetchone()
    return User(row['id'], row['email'], row['role'], data['sid']) if row else None


def current_user(request: Request) -> User:
    header = request.headers.get('authorization', '')
    token = header[7:].strip() if header[:7].lower() == 'bearer ' else ''
    user = user_from_token(request.app.state.con, token) if token else None
    if not user:
        raise ApiError(401, 'Вход истёк или недействителен. Войдите снова.', 'unauthorized')
    return user


def require_admin(request: Request) -> User:
    user = current_user(request)
    if not user.is_admin:
        raise ApiError(403, 'Это может только администратор', 'forbidden')
    return user


# --- Личные данные: только свои строки ---

PERSONAL_TABLES = {'tasks', 'expenses'}


def personal_table(name):
    if name not in PERSONAL_TABLES:
        raise ApiError(404, 'Нет такого раздела данных', 'not_found')
    return name


def owner_of_personal_rows(user: User):
    """Владелец личных строк — всегда тот, кто вошёл; user_id из тела запроса не учитывается."""
    return user.id


# --- Лимит попыток ---

class RateLimiter:
    """Не больше limit событий за window секунд на каждый ключ (адрес, email). Хранится в памяти процесса."""
    def __init__(self, limit, window):
        self.limit, self.window, self.events = limit, window, {}

    def _recent(self, key, now):
        items = [t for t in self.events.get(key, []) if t > now - self.window]
        if items:
            self.events[key] = items
        else:
            self.events.pop(key, None)
        return items

    def check(self, *keys):
        now = time.time()
        for key in keys:
            items = self._recent(key, now)
            if len(items) >= self.limit:
                wait = max(1, math.ceil(items[0] + self.window - now))
                raise ApiError(429, f'Слишком много попыток. Подождите {wait} с.', 'too_many', {'Retry-After': str(wait)})

    def hit(self, *keys):
        now = time.time()
        for key in keys:
            self.events.setdefault(key, []).append(now)
        if len(self.events) > 10000:  # защита памяти от перебора тысяч адресов
            for key in list(self.events):
                self._recent(key, now)


def client_ip(request: Request):
    return request.client.host if request.client else '?'
