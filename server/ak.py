"""Режим модуля АК-Сервера (код crm): подпись запросов ядра, срез /m/crm, служебные адреса /ak/v1/*, запросы к ядру.

Включается, когда ядро передало AK_MODULE_SECRET (db.AK). Кто пользователь — только из заголовков X-AK-*
и только после проверки подписи (Gate). Права по ролям решает access.py.
"""
import asyncio
import collections
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import signal
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from . import backup, db
from .access import MAX_BODY, ApiError, bad, current_user, field, read_json, require_ak_service

SKEW, NONCE_TTL = 60, 120  # ±60 с по времени, nonce не повторяется 120 с (п. 10 ТЗ модуля)
UUID = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
COPY_NAME = re.compile(r'^[0-9A-Za-z][0-9A-Za-z_.-]{0,63}$')
COPIES_KEPT = 3
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # ядро на 127.0.0.1: системный прокси не нужен
SERVER = None  # uvicorn.Server из run.py: по /ak/v1/stop ему говорят «завершиться»
state = {'inflight': 0, 'backup': False, 'stopping': False}
router = APIRouter()


# --- Подпись ---

def sign_string(frm, to, method, uri, body, ts, nonce, user, org, roles, user_name):
    return '|'.join(['v1', frm, to, method, uri, hashlib.sha256(body).hexdigest(), ts, nonce, user, org, roles, user_name])


def signature(*parts, encoding='utf-8'):
    return hmac.new(db.AK_SECRET, sign_string(*parts).encode(encoding), hashlib.sha256).hexdigest()


def parse_time(value):
    """X-AK-Time: секунды Unix (или миллисекунды) либо RFC3339. Непонятное — None."""
    if re.fullmatch(r'\d{1,16}', value):
        number = int(value)
        return number / 1000 if number > 10 ** 11 else number
    try:
        stamp = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return stamp.timestamp() if stamp.tzinfo else None


class Nonces:
    """Уже виденные nonce за последние 120 с: повтор того же запроса отклоняется."""
    def __init__(self):
        self.seen, self.order, self.lock = set(), collections.deque(), threading.Lock()

    def add(self, nonce, now):
        with self.lock:
            while self.order and self.order[0][0] < now:
                self.seen.discard(self.order.popleft()[1])
            if nonce in self.seen:
                return False
            self.seen.add(nonce)
            self.order.append((now + NONCE_TTL, nonce))
            return True


nonces = Nonces()


def check_sign(method, uri, body, h, now=None):
    """None — подпись верна; иначе код ошибки для ответа 401. h — заголовки с именами в нижнем регистре."""
    now = time.time() if now is None else now
    ts, nonce, got = h.get('x-ak-time', ''), h.get('x-ak-nonce', ''), h.get('x-ak-sign', '')
    if h.get('x-ak-from') != 'core' or not ts or not 0 < len(nonce) <= 200 or not re.fullmatch(r'[0-9a-fA-F]{64}', got):
        return 'bad_sign'
    # Заголовки и путь прочитаны как latin-1 — обратно в те же байты, что пришли по сети (как подписывает ядро).
    rest = (body, ts, nonce, h.get('x-ak-user', ''), h.get('x-ak-org', ''), h.get('x-ak-roles', ''), h.get('x-ak-user-name', ''))
    uris = (uri, uri + '?') if '?' not in uri else (uri,)  # «…/busy?» с пустым запросом приходит без «?»
    if not any(hmac.compare_digest(signature('core', db.AK_CODE, method, u, *rest, encoding='latin-1'), got.lower()) for u in uris):
        return 'bad_sign'
    stamp = parse_time(ts)
    if stamp is None or abs(now - stamp) > SKEW:
        return 'replay'
    if not nonces.add(nonce, now):  # после проверки подписи: чужой запрос не может «занять» nonce
        return 'replay'
    return None


async def reply(send, status, message, code, extra=(), body=None):
    data = json.dumps(body or {'message': message, 'code': code, 'error': {'code': code, 'message': message}}, ensure_ascii=False).encode()
    await send({'type': 'http.response.start', 'status': status,
                'headers': [(b'content-type', b'application/json; charset=utf-8'), (b'content-length', str(len(data)).encode()),
                            (b'cache-control', b'no-store'), *extra]})
    await send({'type': 'http.response.body', 'body': data})


class Gate:
    """Снаружи всего приложения. Пропускает только подписанные ядром запросы под AK_BASE_PATH и отрезает префикс:
    дальше маршруты те же, что у самостоятельного сервера (/api/…, экраны)."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'lifespan':
            return await self.app(scope, receive, send)
        if scope['type'] != 'http':
            return await send({'type': 'websocket.close', 'code': 1008})
        base, path, method = db.AK_BASE, scope['path'], scope['method']
        if path == base + '/healthz' and method in ('GET', 'HEAD'):  # ядро проверяет «жив ли» каждые 5 с
            ok = not state['stopping']
            return await reply(send, 200 if ok else 503, 'Останавливается', 'busy',
                               body={'ok': True, 'version': db.MODULE_VERSION, 'app': db.VERSION} if ok else None)
        chunks, size, more = [], 0, True
        while more:
            message = await receive()
            if message['type'] == 'http.disconnect':
                return
            chunk = message.get('body', b'')
            size += len(chunk)
            if size > MAX_BODY:
                return await reply(send, 413, 'Слишком большой запрос (больше 32 МБ)', 'too_large')
            chunks.append(chunk)
            more = message.get('more_body', False)
        body = b''.join(chunks)
        raw = scope.get('raw_path') or path.encode()
        query = scope.get('query_string') or b''
        uri = raw.decode('latin-1') + ('?' + query.decode('latin-1') if query else '')
        headers = {}
        for key, value in scope['headers']:
            headers.setdefault(key.decode('latin-1').lower(), value.decode('latin-1'))
        error = check_sign(method, uri, body, headers)
        if error:
            return await reply(send, 401, 'Запрос не от АК-Сервера: подпись не прошла проверку', error)
        if path == base:  # относительные ссылки приложения работают только от «/m/crm/»
            location = (base + '/' + ('?' + query.decode('latin-1') if query else '')).encode()
            return await reply(send, 308, 'Адрес модуля — с косой чертой в конце', 'redirect', [(b'location', location)])
        if not path.startswith(base + '/') or not raw.startswith(base.encode() + b'/'):
            return await reply(send, 404, 'Не найдено', 'not_found')
        inner = path[len(base):]
        user = headers.get('x-ak-user', '')
        if inner.startswith('/ak/v1/'):
            # Служебные адреса вызывает только ядро, без пользователя; из браузера (cookie, Origin, Sec-Fetch) — закрыты.
            if user or any(k in headers for k in ('cookie', 'origin', 'sec-fetch-mode', 'sec-fetch-site')):
                return await reply(send, 404, 'Не найдено', 'not_found')
        elif not UUID.match(user):
            return await reply(send, 401, 'Откройте «День» через АК-Сервер: вход — там', 'no_user')
        roles = [r.strip() for r in headers.get('x-ak-roles', '').split(',') if r.strip()]
        name = urllib.parse.unquote(headers.get('x-ak-user-name', ''))[:200]
        inner_scope = {**scope, 'path': inner, 'raw_path': raw[len(base):],
                       'ak': {'user': user.lower(), 'roles': roles, 'org': headers.get('x-ak-org', ''), 'name': name}}
        sent = False

        async def replay():
            nonlocal sent
            if not sent:
                sent = True
                return {'type': 'http.request', 'body': body, 'more_body': False}
            return await receive()

        counted = bool(user)
        state['inflight'] += counted
        try:
            await self.app(inner_scope, replay, send)
        finally:
            state['inflight'] -= counted


# --- Запросы к ядру ---

class CoreError(Exception):
    def __init__(self, status, code):
        super().__init__(f'ядро ответило {status} {code}')
        self.status, self.code = status, code


def core(method, path, body=None, user='', timeout=10):
    """Подписанный запрос к ядру (FROM = код модуля, TO = core). Ответ — разобранный JSON или None."""
    data = b'' if body is None else json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode()
    ts, nonce = str(int(time.time())), secrets.token_hex(16)
    headers = {'X-AK-From': db.AK_CODE, 'X-AK-Time': ts, 'X-AK-Nonce': nonce,
               'X-AK-Sign': signature(db.AK_CODE, 'core', method, path, data, ts, nonce, user, '', '', '')}
    if user:
        headers['X-AK-User'] = user
    if body is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(db.AK_CORE_URL + path, data=data if body is not None else None, method=method, headers=headers)
    try:
        with OPENER.open(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as e:
        try:
            code = json.loads(e.read()).get('error', {}).get('code', '')
        except (ValueError, AttributeError):
            code = ''
        raise CoreError(e.code, code or 'error')
    except (urllib.error.URLError, OSError):
        raise CoreError(0, 'unreachable')
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        raise CoreError(502, 'bad_json')


def core_get(path):
    """GET к ядру; 404 — None (такого сотрудника нет), недоступно ядро — ошибка 503 для приложения."""
    try:
        return core('GET', path)
    except CoreError as e:
        if e.status == 404:
            return None
        raise ApiError(503, 'АК-Сервер сейчас не отвечает. Попробуйте через минуту.', 'core_unavailable', {'Retry-After': '30'})


def employee_name(info):
    info = info or {}
    return str(info.get('name') or info.get('full_name') or info.get('fio') or '').strip()[:200]


def core_list(book, limit_pages=50):
    """Весь справочник ядра по курсору (?cursor=&limit=500). Понимает и список, и {items, next_cursor}."""
    items, cursor = [], ''
    for _ in range(limit_pages):
        page = core_get(f'/core/v1/{book}?cursor={urllib.parse.quote(cursor)}&limit=500')
        rows = page if isinstance(page, list) else (page or {}).get('items') or (page or {}).get('data') or []
        items += [r for r in rows if isinstance(r, dict)]
        following = '' if isinstance(page, list) else str((page or {}).get('next_cursor') or (page or {}).get('cursor') or '')
        if not rows or not following or following == cursor:
            break
        cursor = following
    return items


_employees = {'at': 0.0, 'items': []}


def employees(con):
    """Сотрудники ядра для выбора исполнителей (кэш 60 с). Удалённые (deleted:true) не показываются."""
    if time.time() - _employees['at'] > 60:
        _employees['items'], _employees['at'] = core_list('employees'), time.time()
    result = []
    for e in _employees['items']:
        uid = str(e.get('id') or '').lower()
        if not UUID.match(uid) or e.get('deleted'):
            continue
        result.append({'id': uid, 'name': employee_name(e), 'key': f'{uid}@ak'})  # тот же ключ, что у access.ak_register
    return result


# --- Маршруты приложения ---

@router.get('/api/ak/me')
async def me(request: Request):
    """Первый запрос приложения в режиме модуля: кто вошёл в АК-Сервер. Заводит человека в базе при первом входе."""
    user = await run_in_threadpool(current_user, request)
    return {'ak': True, 'user': {'id': user.id, 'email': user.email, 'name': request.scope['ak']['name'], 'role': user.role},
            'crm_role': user.crm_role}


@router.get('/api/ak/employees')
async def employee_list(request: Request):
    current_user(request)
    con = request.app.state.con
    return await run_in_threadpool(employees, con)


# --- Служебные адреса (только ядро, без пользователя) ---

@router.get('/ak/v1/busy')
async def busy(request: Request):
    require_ak_service(request)
    if state['backup']:
        return {'busy': True, 'reason': 'Идёт резервная копия данных «Дня»'}
    if state['inflight']:
        return {'busy': True, 'reason': 'Сейчас сохраняются данные «Дня» — подождите несколько секунд'}
    return {'busy': False, 'reason': ''}


def _exit():
    if SERVER is not None:
        SERVER.should_exit = True  # штатная остановка: дождаться текущих запросов, закрыть базу
    else:
        os.kill(os.getpid(), signal.SIGTERM)


@router.post('/ak/v1/stop')
async def stop(request: Request):
    require_ak_service(request)
    state['stopping'] = True
    asyncio.get_running_loop().call_later(0.2, _exit)  # сначала ответ ядру, потом выход
    return {'ok': True}


def make_copy(name):
    """Целостная копия в AK_DATA_DIR/.backup/<name>/: база через backup API SQLite и папка files/ — как в папке данных."""
    root = db.DATA_DIR / '.backup'
    target, temp = root / name, root / f'.{name}.part-{secrets.token_hex(4)}'
    with backup._lock:
        state['backup'] = True
        try:
            temp.mkdir(parents=True)
            src, dst = sqlite3.connect(db.DB_PATH, timeout=5), sqlite3.connect(temp / 'den.db')
            try:
                src.backup(dst)
                if dst.execute('pragma quick_check').fetchone()[0] != 'ok':
                    raise RuntimeError('копия базы не прошла проверку')
            finally:
                dst.close()
                src.close()
            if db.FILES_DIR.is_dir():
                shutil.copytree(db.FILES_DIR, temp / 'files', symlinks=True)
            if target.exists():
                shutil.rmtree(target)
            temp.rename(target)
            size = sum(p.stat().st_size for p in target.rglob('*') if p.is_file())
        except Exception:
            shutil.rmtree(temp, ignore_errors=True)  # недописанная копия хуже, чем никакой
            raise
        finally:
            state['backup'] = False
        copies = sorted((p for p in root.iterdir() if p.is_dir() and not p.name.startswith('.')), key=lambda p: p.stat().st_mtime_ns)
        for old in copies[:-COPIES_KEPT]:
            shutil.rmtree(old, ignore_errors=True)
    return size


@router.post('/ak/v1/backup')
async def make_backup(request: Request):
    require_ak_service(request)
    name = field(await read_json(request), 'name', max_len=64)
    if not COPY_NAME.match(name):
        raise bad('Имя копии — ГГГГ-ММ-ДД_ЧЧММ', 'bad_field')
    size = await run_in_threadpool(make_copy, name)
    return {'ok': True, 'name': name, 'size': size}


@router.post('/ak/v1/events')
async def event(request: Request):
    """События по подписке. Одно и то же event_id может прийти дважды — второй раз ничего не делаем.
    Непонятное событие тоже принимается (2xx): иначе ядро повторяло бы его вечно и держало все следующие."""
    require_ak_service(request)
    try:
        body = await read_json(request)
    except ApiError:
        body = None
    event_id = body.get('event_id') if isinstance(body, dict) else None
    if not isinstance(event_id, (str, int)) or isinstance(event_id, bool) or not str(event_id) or len(str(event_id)) > 200:
        print('Событие ядра без event_id пропущено', flush=True)
        return {'ok': True, 'ignored': True}
    event_id, kind = str(event_id), str(body.get('type') or '')[:200]
    con = request.app.state.con
    with db.tx(con):
        fresh = con.execute('insert or ignore into ak_events values (?,?,?)', (event_id, kind, db.now_iso())).rowcount
        con.execute('delete from ak_events where received_at < ?', (time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - 90 * 86400)),))
    return {'ok': True, 'duplicate': not fresh}
