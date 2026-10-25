"""Все проверки прав в одном месте (вместо RLS Supabase) и разбор входящих запросов.

Любой маршрут получает пользователя только через current_user(): токен проверяется подписью, сроком
и живой сессией в базе. Личные данные всегда ищутся по user_id из токена, а не из тела запроса.
"""
import base64
import hashlib
import hmac
import json
import math
import re
import time
from dataclasses import dataclass

from fastapi import Request

from . import db


class ApiError(Exception):
    def __init__(self, status, message, code='error', headers=None):
        self.status, self.message, self.code, self.headers = status, message, code, headers or {}


def bad(message, code='bad_request'):
    return ApiError(400, message, code)


MAX_BODY = 32 * 1024 * 1024


async def read_body(request: Request, limit=MAX_BODY):
    """Тело запроса с пределом: считаем байты по мере чтения, а не верим заголовку Content-Length."""
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise ApiError(413, f'Слишком большой запрос (больше {limit // (1024 * 1024)} МБ)', 'too_large')
        chunks.append(chunk)
    return b''.join(chunks)


async def read_json(request: Request):
    raw = await read_body(request)
    if not raw:
        return None
    try:
        return json.loads(raw, parse_constant=_no_constant)
    except ValueError:
        raise bad('Неверный формат данных (ожидается JSON)', 'bad_json')


def _no_constant(name):
    raise ValueError(name)  # NaN и Infinity браузер не прочитает: такая запись сломала бы загрузку у всех


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
        return now

    def undo(self, stamp, *keys):
        """Попытка оказалась удачной — не засчитываем её."""
        for key in keys:
            items = self.events.get(key, [])
            if stamp in items:
                items.remove(stamp)
        if len(self.events) > 10000:  # защита памяти от перебора тысяч адресов
            now = time.time()
            for key in list(self.events):
                self._recent(key, now)


def client_ip(request: Request):
    """Адрес устройства. За nginx (VPS) все приходят с адреса прокси — тогда берём X-Forwarded-For, но только от него."""
    host = request.client.host if request.client else '?'
    if db.TRUSTED_PROXY and host == db.TRUSTED_PROXY:
        forwarded = request.headers.get('x-forwarded-for', '').split(',')[-1].strip()
        return forwarded or host
    return host


# --- Поручения (совместные задачи): кто что может ---
# Организатор меняет задачу целиком. Исполнитель (принял) — только статус (кроме «завершено»), галочки подзадач,
# свои отчёты и записи истории. Приглашённый (ещё не принял) только смотрит. Посторонний задачу не видит (404).

SAFE_ID = re.compile(r'^[A-Za-z0-9_-]{1,100}$')  # id задачи — это и имя папки с её файлами
FILE_TYPES = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'webp': 'image/webp', 'webm': 'audio/webm',
              'ogg': 'audio/ogg', 'm4a': 'audio/mp4', 'aac': 'audio/aac', 'mp4': 'video/mp4', 'mp3': 'audio/mpeg', 'wav': 'audio/wav'}
FILE_NAME = r'[A-Za-z0-9-]{1,100}\.(' + '|'.join(FILE_TYPES) + ')'
MEDIA_PATH = re.compile(r'^shared/[A-Za-z0-9_-]{1,100}/' + FILE_NAME + '$')
SHARED_COLUMNS = {'owner_id', 'owner_email', 'invited_emails', 'accepted_emails', 'leave_requests', 'payload', 'updated_at'}
WORKER_FIELDS = {'status', 'statusBy', 'statusAt', 'completed', 'subtasks', 'reports', 'activity', 'updatedAt'}
REPORTS_KEPT, ACTIVITY_KEPT = 50, 30  # столько хранит app.js (.slice(-50), .slice(-30))
NOT_FOUND_SHARED = 'Эта совместная задача удалена или вам закрыли к ней доступ'


def shared_role(row, user: User):
    """owner / worker (принял) / invited (ещё не принял) / None — посторонний."""
    if row is None:
        return None
    if row['owner_id'] == user.id:
        return 'owner'
    email = user.email.lower()
    if email in row['accepted_emails']:
        return 'worker'
    if email in row['invited_emails']:
        return 'invited'
    return None


def require_shared(row, user: User, *roles):
    role = shared_role(row, user)
    if role is None:
        raise ApiError(404, NOT_FOUND_SHARED, 'not_found')
    if roles and role not in roles:
        raise forbidden('Это может только организатор задачи' if roles == ('owner',) else 'Это действие вам недоступно')
    return role


def forbidden(message):
    return ApiError(403, message, 'forbidden')


def email_list(value, name):
    if not isinstance(value, list) or len(value) > 200 or not all(isinstance(e, str) and 0 < len(e.strip()) <= 300 for e in value):
        raise bad(f'Неверное поле «{name}»', 'bad_field')
    return list(dict.fromkeys(e.strip().lower() for e in value))


def check_owner_patch(row, body):
    """Организатор: всё, кроме смены владельца; принять за другого нельзя — из участников можно только убирать."""
    changes = {}
    for name in ('owner_id', 'owner_email'):
        if name in body and str(body[name] or '').lower() != str(row[name]).lower():
            raise forbidden('Организатора задачи сменить нельзя')
    if 'invited_emails' in body:
        changes['invited_emails'] = email_list(body['invited_emails'], 'invited_emails')
    for name in ('accepted_emails', 'leave_requests'):
        if name in body:
            value = email_list(body[name], name)
            if set(value) - set(row[name]):
                raise forbidden('Принимает задачу только сам приглашённый' if name == 'accepted_emails' else 'Просьбу о выходе пишет только сам исполнитель')
            changes[name] = value
    accepted = changes.get('accepted_emails', row['accepted_emails'])
    changes['leave_requests'] = [e for e in changes.get('leave_requests', row['leave_requests']) if e in accepted]
    return changes


def check_worker_patch(row, body, user: User, task_id):
    """Исполнитель: столбцы участников и владельца прежние, в payload — только разрешённые правки."""
    for name in SHARED_COLUMNS - {'payload', 'updated_at'}:
        if name in body:
            same = set(email_list(body[name], name)) == set(row[name]) if isinstance(row[name], list) \
                else str(body[name] or '').lower() == str(row[name]).lower()
            if not same:
                raise forbidden('Участников и организатора меняет только организатор')
    if 'payload' in body:
        check_worker_payload(row['payload'], body['payload'], user.email.lower(), task_id)


def check_worker_payload(old, new, me, task_id):
    if not isinstance(new, dict):
        raise bad('payload должен быть объектом', 'bad_field')
    for key in set(old) | set(new):
        if key not in WORKER_FIELDS and old.get(key, ...) != new.get(key, ...):
            raise forbidden('Текст, дату, вложения и напоминания меняет только организатор')
    if new.get('status') != old.get('status'):
        if new.get('status') == 'completed' or not isinstance(new.get('status'), str) or len(new['status']) > 40:
            raise forbidden('Завершить задачу может только организатор')
    if new.get('statusBy') != old.get('statusBy') and new.get('statusBy') not in (me, None):
        raise forbidden('Статус ставится только от своего имени')
    if new.get('completed', False) is not False and new.get('completed') != old.get('completed'):
        raise forbidden('Завершить задачу может только организатор')
    for key in ('statusBy', 'statusAt', 'updatedAt'):
        if key in new and new[key] != old.get(key) and not (isinstance(new[key], str) and len(new[key]) <= 100):
            raise bad(f'Неверное поле «{key}»', 'bad_field')
    if 'completed' in new and new['completed'] != old.get('completed') and not isinstance(new['completed'], bool):
        raise bad('Неверное поле «completed»', 'bad_field')
    check_subtasks(old.get('subtasks', ...), new.get('subtasks', ...), me)
    old_list = lambda key: old.get(key) if isinstance(old.get(key), list) else []  # старые или повреждённые данные
    check_reports(old_list('reports'), new.get('reports', old_list('reports')), me, task_id)
    check_activity(old_list('activity'), new.get('activity', old_list('activity')), me)


def check_subtasks(old, new, me):
    if old is ... or new is ...:
        if old != new:
            raise forbidden('Подзадачи меняет только организатор')
        return
    if not isinstance(new, list) or not isinstance(old, list) or len(new) != len(old):
        raise forbidden('Подзадачи меняет только организатор')
    for before, after in zip(old, new):
        if not isinstance(after, dict) or not isinstance(before, dict):
            raise forbidden('Подзадачи меняет только организатор')
        for key in set(before) | set(after):
            if key not in ('done', 'doneBy', 'doneAt') and before.get(key, ...) != after.get(key, ...):
                raise forbidden('Название подзадачи меняет только организатор')
        if (after.get('doneBy', '') not in ('', me) and after.get('doneBy') != before.get('doneBy')) or \
                (after.get('done') and not before.get('done') and after.get('doneBy') != me):
            raise forbidden('Подзадача отмечается только от своего имени')
        if not isinstance(after.get('done', False), bool):
            raise bad('Неверная отметка подзадачи', 'bad_field')


def _mine(item, me):
    return isinstance(item, dict) and item.get('by') == me


def check_reports(old, new, me, task_id):
    if not isinstance(new, list) or not all(isinstance(r, dict) for r in new):
        raise bad('Неверный список отчётов', 'bad_field')
    if not all(isinstance(r.get('id'), str) and len(r['id']) <= 100 for r in new):
        raise bad('У отчёта неверный id', 'bad_field')
    if len(new) > max(len(old), REPORTS_KEPT):
        raise bad(f'Отчётов не может быть больше {REPORTS_KEPT}', 'bad_field')
    old = [r if isinstance(r, dict) else {} for r in old]
    old_ids = {r.get('id') for r in old if isinstance(r.get('id'), str)}
    added = 0
    while added < len(new) and new[len(new) - 1 - added].get('id') not in old_ids:
        added += 1
    kept, fresh = new[:len(new) - added], new[len(new) - added:]
    if len({r.get('id') for r in fresh}) != len(fresh):
        raise bad('Повторяется id отчёта', 'bad_field')
    for r in fresh:
        if r.get('by') != me or not isinstance(r.get('id'), str):
            raise forbidden('Отчёт можно добавить только от своего имени')
        for media in ('photo', 'voice'):
            if media in r and not (isinstance(r[media], str) and MEDIA_PATH.match(r[media]) and r[media].split('/')[1] == task_id):
                raise forbidden('Файл отчёта должен лежать в папке этой задачи')
    # Оставшиеся старые отчёты — в прежнем порядке и без изменений; пропущены только свои или «голова» сверх предела.
    pos, first = 0, None
    for r in kept:
        while pos < len(old) and old[pos] != r:
            if first is not None and not _mine(old[pos], me):
                raise forbidden('Чужие отчёты удалять и менять нельзя')
            pos += 1
        if pos == len(old):
            raise forbidden('Чужие отчёты удалять и менять нельзя')
        first = pos if first is None else first
        pos += 1
    head = old[:first if first is not None else len(old)]
    if any(not _mine(r, me) for r in head) and len(new) < REPORTS_KEPT:
        raise forbidden('Чужие отчёты удалять и менять нельзя')
    if first is not None and any(not _mine(r, me) for r in old[pos:]):
        raise forbidden('Чужие отчёты удалять и менять нельзя')


def check_activity(old, new, me):
    if not isinstance(new, list) or not all(isinstance(a, dict) for a in new):
        raise bad('Неверная история задачи', 'bad_field')
    for k in range(min(len(old), len(new)), -1, -1):
        if new[:k] == old[len(old) - k:] and all(a.get('email') == me for a in new[k:]):
            if k < len(old) and len(new) < ACTIVITY_KEPT:
                break  # старое отрезано без причины
            return
    raise forbidden('Историю задачи можно только дополнять своими записями')
