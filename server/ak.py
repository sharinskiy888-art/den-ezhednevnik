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
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from . import backup, db, errlog, partners
from .access import MAX_BODY, ApiError, bad, current_user, field, read_json, require_ak_owner, require_ak_service

SKEW, NONCE_TTL = 60, 120  # ±60 с по времени, nonce не повторяется 120 с (п. 10 ТЗ модуля)
UUID = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
COPY_NAME = re.compile(r'^[0-9A-Za-z][0-9A-Za-z_.-]{0,63}$')
COPIES_KEPT = 3
RESTORE_MAX = 100 * 1024 * 1024  # больше ядро всё равно не пропустит (413)
RESTORE_PATH = '/api/ak/restore'
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # ядро на 127.0.0.1: системный прокси не нужен
SERVER = None  # uvicorn.Server из run.py: по /ak/v1/stop ему говорят «завершиться»
state = {'inflight': 0, 'backup': False, 'stopping': False, 'restoring': False}
router = APIRouter()


# --- Подпись ---

def sign_string(frm, to, method, uri, body, ts, nonce, user, org, roles, user_name):
    """body — байты тела или уже посчитанный sha256 hex (большое тело считается по кусочкам)."""
    digest = body if isinstance(body, str) else hashlib.sha256(body).hexdigest()
    return '|'.join(['v1', frm, to, method, uri, digest, ts, nonce, user, org, roles, user_name])


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


def tmp_dir():
    """Временные файлы — только внутри AK_DATA_DIR (п. ТЗ: писать вне AK_DATA_DIR и AK_LOG_DIR нельзя)."""
    path = db.DATA_DIR / 'tmp'
    path.mkdir(parents=True, exist_ok=True)
    return path


def check_sign(method, uri, body, h, now=None):
    """None — подпись верна; иначе код ошибки для ответа 401. h — заголовки с именами в нижнем регистре."""
    now = time.time() if now is None else now
    ts, nonce, got = h.get('x-ak-time', ''), h.get('x-ak-nonce', ''), h.get('x-ak-sign', '')
    if h.get('x-ak-from') != 'core' or not ts or not 16 <= len(nonce) <= 128 or not re.fullmatch(r'[0-9a-fA-F]{64}', got):
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


# Части программы для ролей (module.json → share/external): адрес /m/crm/<часть>/… — та же программа, только экран роли
PARTS = ('worker',)
PARTS_BARE = tuple(f'/{name}' for name in PARTS)


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
        # Тело целиком нужно для подписи. Большое (копия для восстановления, до 100 МБ) — не в памяти, а во временном
        # файле в AK_DATA_DIR/tmp; sha256 считается по кусочкам.
        limit = MAX_BODY
        if path == base + RESTORE_PATH:
            # до 100 МБ — только запросу, похожему на ядро от имени владельца (подпись проверится после тела:
            # в ней sha256 тела); иначе чужой процесс на 127.0.0.1 мог бы забивать диск
            h = {k.decode('latin-1').lower(): v.decode('latin-1') for k, v in scope['headers']}
            if (h.get('x-ak-from') == 'core' and UUID.match(h.get('x-ak-user', '')) and re.fullmatch(r'\d{1,16}', h.get('x-ak-time', ''))
                    and abs(time.time() - int(h['x-ak-time'])) <= SKEW and 'owner' in h.get('x-ak-roles', '').split(',')):
                limit = RESTORE_MAX
        spool, digest, size, more = None, hashlib.sha256(), 0, True
        try:
            while more:
                message = await receive()
                if message['type'] == 'http.disconnect':
                    return
                chunk = message.get('body', b'')
                size += len(chunk)
                if size > limit:
                    return await reply(send, 413, f'Слишком большой запрос (больше {limit // 1024 // 1024} МБ)', 'too_large')
                if chunk:
                    if spool is None:
                        spool = tempfile.SpooledTemporaryFile(max_size=1 << 20, dir=tmp_dir())
                    spool.write(chunk)
                    digest.update(chunk)
                more = message.get('more_body', False)
            return await self.serve(scope, receive, send, spool, digest.hexdigest(), size)
        finally:
            if spool is not None:
                spool.close()

    async def serve(self, scope, receive, send, spool, body_hash, size):
        base, path, method = db.AK_BASE, scope['path'], scope['method']
        raw = scope.get('raw_path') or path.encode()
        query = scope.get('query_string') or b''
        uri = raw.decode('latin-1') + ('?' + query.decode('latin-1') if query else '')
        headers = {}
        for key, value in scope['headers']:
            headers.setdefault(key.decode('latin-1').lower(), value.decode('latin-1'))
        error = check_sign(method, uri, body_hash, headers)
        if error:
            return await reply(send, 401, 'Запрос не от АК-Сервера: подпись не прошла проверку', error)
        if path == base:  # относительные ссылки приложения работают только от «/m/crm/»
            location = (base + '/' + ('?' + query.decode('latin-1') if query else '')).encode()
            return await reply(send, 308, 'Адрес модуля — с косой чертой в конце', 'redirect', [(b'location', location)])
        if not path.startswith(base + '/') or not raw.startswith(base.encode() + b'/'):
            return await reply(send, 404, 'Не найдено', 'not_found')
        inner, part = path[len(base):], ''
        if inner in PARTS_BARE:  # «/worker» из кнопки «Отправить» → «/worker/»: относительные ссылки части — от неё
            location = (base + inner + '/' + ('?' + query.decode('latin-1') if query else '')).encode()
            return await reply(send, 308, 'Адрес части — с косой чертой в конце', 'redirect', [(b'location', location)])
        for prefix in PARTS:  # часть роли: всё её (страница, файлы, API) — под одним адресом, его ядро пускает из интернета
            if inner.startswith(f'/{prefix}/') and raw.startswith(f'{base}/{prefix}/'.encode()):
                inner, part, raw = inner[len(prefix) + 1:], prefix, raw[:len(base)] + raw[len(base) + len(prefix) + 1:]
                if inner.startswith('/ak/v1/') or inner == RESTORE_PATH:  # служебное ядра и восстановление — только по своим адресам
                    return await reply(send, 404, 'Не найдено', 'not_found')
                break
        user = headers.get('x-ak-user', '')
        if inner.startswith('/ak/v1/'):
            # Служебные адреса вызывает только ядро, без пользователя; из браузера (cookie, Origin, Sec-Fetch) — закрыты.
            if user or any(k in headers for k in ('cookie', 'origin', 'sec-fetch-mode', 'sec-fetch-site')):
                return await reply(send, 404, 'Не найдено', 'not_found')
        elif not UUID.match(user):
            return await reply(send, 401, 'Откройте «День» через АК-Сервер: вход — там', 'no_user')
        roles = [r.strip() for r in headers.get('x-ak-roles', '').split(',') if r.strip()]
        if user and state['restoring'] and inner != RESTORE_PATH:  # база сейчас подменяется копией — через несколько секунд всё снова работает
            return await reply(send, 503, 'Идёт восстановление данных из копии. Подождите несколько секунд.', 'restoring', [(b'retry-after', b'5')])
        name = urllib.parse.unquote_plus(headers.get('x-ak-user-name', ''))[:200]  # ядро кодирует имя через quote_plus
        inner_scope = {**scope, 'path': inner, 'raw_path': raw[len(base):],
                       'ak': {'user': user.lower(), 'roles': roles, 'org': headers.get('x-ak-org', ''), 'name': name, 'part': part}}
        if spool is not None:
            spool.seek(0)
        done = False

        async def replay():
            nonlocal done
            if done:
                return await receive()
            chunk = spool.read(1 << 20) if spool is not None else b''
            following = spool is not None and spool.tell() < size
            done = not following
            return {'type': 'http.request', 'body': chunk, 'more_body': following}

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
    data = info.get('data') if isinstance(info.get('data'), dict) else {}
    for source in (data, info):
        name = source.get('name') or source.get('full_name') or source.get('fio')
        if name:
            return str(name).strip()[:200]
    return ''


def employee_user(item):
    """UUID сотрудника для входа. Запись справочника — {id, rev, deleted, updated_at, data}: ссылка на вход может лежать
    в data (user_uuid / user_id / uuid), иначе id записи и есть UUID сотрудника."""
    data = item.get('data') if isinstance(item.get('data'), dict) else {}
    for value in (data.get('user_uuid'), data.get('user_id'), data.get('uuid'), item.get('uuid'), item.get('id')):
        if isinstance(value, str) and UUID.match(value):
            return value.lower()
    return ''


def core_list(book, limit_pages=50):
    """Весь справочник ядра по курсору (?cursor=&limit=500). Понимает и список, и {items, next_cursor}."""
    items, cursor = [], ''
    for _ in range(limit_pages):
        page = core_get(f'/core/v1/{book}?cursor={urllib.parse.quote(cursor)}&limit=500')
        rows = page if isinstance(page, list) else (page or {}).get('items') or (page or {}).get('data') or []
        items += [r for r in rows if isinstance(r, dict)]
        following = '' if isinstance(page, list) else str((page or {}).get('next_cursor') or (page or {}).get('cursor') or '')
        if not rows or not following or following == cursor or (page or {}).get('more') is False:
            break
        cursor = following
    return items


_employees = {'at': 0.0, 'items': []}


def employees(con):
    """Кого можно назначить: сотрудники из справочника ядра (кэш 60 с, удалённые не показываются) и все, кто уже
    входил в «День» (имя — из X-AK-User-Name последнего входа). Ключ тот же, что у access.ak_register."""
    if time.time() - _employees['at'] > 60:
        try:
            _employees['items'], _employees['at'] = core_list('employees'), time.time()
        except ApiError:
            if not _employees['items'] and not con.execute("select 1 from users where email like '%@ak' limit 1").fetchone():
                raise
            # ядро не отвечает (перезапуск, обновление) — остаются прежний список и те, кто уже входил
    people, gone = {}, set()
    for e in _employees['items']:
        uid = employee_user(e)
        if not uid:
            continue
        if e.get('deleted') or (isinstance(e.get('data'), dict) and e['data'].get('deleted')):
            gone.add(uid)
            continue
        people[uid] = employee_name(e)
    for row in con.execute("select id, name from users where email like '%@ak'"):
        if row['id'] not in gone and (row['id'] not in people or not people[row['id']]):
            people[row['id']] = people.get(row['id']) or row['name'] or ''
    return sorted(({'id': uid, 'name': name, 'key': f'{uid}@ak'} for uid, name in people.items()), key=lambda p: (not p['name'], p['name'].lower()))


# --- Маршруты приложения ---

@router.get('/api/ak/me')
async def me(request: Request):
    """Первый запрос приложения в режиме модуля: кто вошёл в АК-Сервер. Заводит человека в базе при первом входе."""
    user = await run_in_threadpool(current_user, request)
    return {'ak': True, 'user': {'id': user.id, 'email': user.email, 'name': request.scope['ak']['name'], 'role': user.role},
            'crm_role': user.crm_role, 'epoch': db.EPOCH, 'restored': restored_at(request.app.state.con)}


def restored_at(con):
    row = con.execute("select value from meta where key='restored_at'").fetchone()
    return row[0] if row else ''


@router.get('/api/ak/employees')
async def employee_list(request: Request):
    current_user(request)
    con = request.app.state.con
    return await run_in_threadpool(employees, con)


# --- Прежняя установка: люди, которых не удалось узнать автоматически (их email нет в ядре) ---

def legacy_left(con):
    from . import legacy
    people = [{'email': r['email'], 'admin': r['role'] == 'admin',
               'records': con.execute('select count(*) from rows where user_id=?', (r['id'],)).fetchone()[0]} for r in legacy.legacy_users(con)]
    return {'people': people, 'invites': sorted(legacy.pending_emails(con))}


@router.get('/api/ak/legacy')
async def legacy_list(request: Request):
    """Владельцу: кого из прежней установки ещё не связали с сотрудником АК-Сервера."""
    require_ak_owner(request)
    return await run_in_threadpool(legacy_left, request.app.state.con)


def legacy_link(con, email, uid):
    from . import legacy
    if uid not in {p['id'] for p in employees(con)}:
        raise ApiError(400, 'Такого сотрудника нет в АК-Сервере', 'bad_field')
    old = next((r for r in legacy.legacy_users(con) if r['email'].lower() == email), None)
    if old:
        legacy.adopt(con, old, uid)
    elif email in legacy.pending_emails(con):
        with db.tx(con):
            legacy.rename(con, email, f'{uid}@ak')
    else:
        raise ApiError(404, 'Этого человека уже связали или его нет в прежних данных', 'not_found')
    return legacy_left(con)


@router.post('/api/ak/legacy/link')
async def legacy_link_route(request: Request):
    """Владелец связывает прежнего человека (email) с сотрудником ядра: его задачи, поручения и заявки переходят сотруднику."""
    require_ak_owner(request)
    body = await read_json(request)
    if not isinstance(body, dict):
        raise bad('Нужны email и сотрудник')
    email = field(body, 'email', str, max_len=320).strip().lower()
    uid = field(body, 'user', str, max_len=64).strip().lower()
    return await run_in_threadpool(legacy_link, request.app.state.con, email, uid)


# --- Служебные адреса (только ядро, без пользователя) ---

@router.get('/ak/v1/busy')
async def busy(request: Request):
    require_ak_service(request)
    if state['restoring']:
        return {'busy': True, 'reason': 'Идёт восстановление данных «Дня» из копии'}
    if state['backup']:
        return {'busy': True, 'reason': 'Идёт резервная копия данных «Дня»'}
    if state['inflight']:
        return {'busy': True, 'reason': 'Сейчас сохраняются данные «Дня» — подождите несколько секунд'}
    if partners.state['stale']:  # п. 7 общих правил АК: не мешает обновлению, но владелец видит, что обмен застрял
        return {'busy': False, 'reason': '', 'warning': f'АК-Сервер больше суток не подтверждает изменения клиентов «Дня» ({partners.state["stale"]})'}
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
                shutil.copytree(db.FILES_DIR, temp / 'files', symlinks=True, copy_function=shutil.copyfile)
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
    if fresh and kind == 'partner.changed':  # клиент изменён в АК-Сервере или другой программе
        partners.on_event(body.get('data'))  # разберёт фоновый поток: ответ ядру — сразу
    return {'ok': True, 'duplicate': not fresh}


# --- «Восстановить из файла» (п. 29 ТЗ модуля): только владелец, работает сразу, без перезапуска ---

class RestoreError(ApiError):
    def __init__(self, message):
        super().__init__(400, message, 'bad_backup')


def pick_copy(names):
    """Папка копии внутри архива: из общего архива АК — последняя modules/<код>/<имя>/, иначе — свой zip одной копии
    (den.db в корне или в единственной папке)."""
    tops = sorted({n[:-len('den.db')] for n in names if n == 'den.db' or n.endswith('/den.db')})
    ours = [p for p in tops if re.fullmatch(rf'modules/{re.escape(db.AK_CODE)}/[^/]+/', p)]
    if ours:
        return ours[-1]  # имена копий — ГГГГ-ММ-ДД_ЧЧММ: по алфавиту последняя и есть самая новая
    if '' in tops:
        return ''
    if len(tops) == 1 and tops[0].count('/') == 1:
        return tops[0]
    if any(n.startswith('modules/') for n in names):
        raise RestoreError('В архиве АК-Сервера нет копии «Дня». Возьмите архив, сделанный, когда «День» был запущен.')
    raise RestoreError('Это не копия «Дня»: в архиве нет файла den.db')


def unpack(archive, target):
    """Проверка и распаковка копии в target (den.db и files/). Ссылки, «..», абсолютные пути — отказ."""
    try:
        z = zipfile.ZipFile(archive)
    except (zipfile.BadZipFile, OSError):
        raise RestoreError('Файл не похож на zip-архив копии')
    with z:
        infos = [(i, i.filename.replace('\\', '/')) for i in z.infolist()]
        prefix = pick_copy([n for _, n in infos])
        chosen, total = [], 0
        for info, name in infos:
            if not name.startswith(prefix) or name.endswith('/'):
                continue
            rel = name[len(prefix):]
            parts = rel.split('/')
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                continue  # ссылки ядро в копию не кладёт; чужие — пропускаем
            if rel.startswith('/') or ':' in rel or any(p in ('', '.', '..') for p in parts):
                raise RestoreError(f'Странный путь в архиве: {name[:100]}')
            if rel != 'den.db' and parts[0] != 'files':
                continue  # лишнее (например, журнал) не нужно
            chosen.append((info, rel))
            total += info.file_size
        free, live = shutil.disk_usage(db.DATA_DIR).free, db.DB_PATH.stat().st_size if db.DB_PATH.exists() else 0
        need = total * 2 + live + 50 * 1024 * 1024  # распаковка, рабочая база и отложенная копия нынешней
        if need > free:
            raise RestoreError(f'Мало места на диске: нужно {need // 1024 // 1024} МБ, свободно {free // 1024 // 1024} МБ')
        for info, rel in chosen:
            path = target / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(path, 'wb') as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
    check = sqlite3.connect(target / 'den.db')
    try:
        if check.execute('pragma quick_check').fetchone()[0] != 'ok':
            raise RestoreError('База в копии повреждена — выберите другую копию')
        tables = {r[0] for r in check.execute("select name from sqlite_master where type='table'")}
        if not {'users', 'rows', 'meta'} <= tables:
            raise RestoreError('Это не копия «Дня»: в базе нет нужных таблиц')
        row = check.execute("select value from meta where key='schema'").fetchone()
        if row and not str(row[0]).isdigit():
            raise RestoreError('Это не копия «Дня»: непонятная версия базы')
        if row and int(row[0]) > len(db.MIGRATIONS):
            raise RestoreError('Копия сделана более новой версией «Дня». Сначала обновите модуль, потом восстанавливайте.')
        count = check.execute('select count(*) from rows').fetchone()[0]
    except sqlite3.DatabaseError:
        raise RestoreError('Файл den.db в копии — не база данных')
    finally:
        check.close()
    return prefix, count


def copy_db(src_path, con):
    """База из файла — в рабочую базу на месте, через backup API (соединение не меняется: всё приложение продолжает работать)."""
    src = sqlite3.connect(src_path)
    try:
        src.backup(con)
    finally:
        src.close()
    con.execute('pragma journal_mode=wal')


def rollback(con, aside, moved, placed):
    """Вернуть как было. Сначала база (главное), каждый шаг отдельно: сбой одного не отменяет остальные."""
    for name, step in (('база', lambda: copy_db(aside / 'den.db', con)),
                       ('метка данных', lambda: db.load_epoch(con)),
                       ('фото восстановленной копии', lambda: placed and shutil.rmtree(db.FILES_DIR)),
                       ('фото', lambda: moved and (aside / 'files').rename(db.FILES_DIR))):
        try:
            step()
        except Exception:
            print(f'{time.strftime("%Y-%m-%d %H:%M:%S")} Откат: не удалось вернуть {name}; прежние данные лежат в {aside}', flush=True)
            traceback.print_exc()


def restore(con, archive):
    """1) проверить; 2) отложить текущие данные в before-restore-<дата>/; 3) поставить копию; 4) миграции;
    5) новая метка данных и сброс кэшей. Ошибка на любом шаге — всё как было."""
    staged = Path(tempfile.mkdtemp(prefix='restore-', dir=tmp_dir()))
    try:
        prefix, count = unpack(archive, staged)
        with backup._lock:
            state['restoring'] = True
            try:
                for _ in range(600):  # дождаться запросов и записей, начатых до восстановления (кроме самого восстановления)
                    if state['inflight'] <= 1 and not con.in_transaction:
                        break
                    time.sleep(0.05)
                else:
                    raise ApiError(409, 'Сейчас идёт сохранение данных. Попробуйте восстановить через минуту.', 'busy')
                stamp = time.strftime('%Y-%m-%d_%H%M%S')
                aside, n = db.DATA_DIR / f'before-restore-{stamp}', 1
                while aside.exists():  # два восстановления за одну секунду
                    n += 1
                    aside = db.DATA_DIR / f'before-restore-{stamp}-{n}'
                aside.mkdir()
                keep = sqlite3.connect(aside / 'den.db')
                try:
                    con.backup(keep)
                finally:
                    keep.close()
                moved = placed = False
                try:
                    if db.FILES_DIR.exists():
                        db.FILES_DIR.rename(aside / 'files')
                        moved = True
                    if (staged / 'files').is_dir():
                        (staged / 'files').rename(db.FILES_DIR)
                        placed = True
                    copy_db(staged / 'den.db', con)
                    db.migrate(con)  # копия от прежней версии модуля — те же миграции, что при запуске
                    db.load_epoch(con, fresh=True)
                    with db.tx(con):
                        con.execute("insert or replace into meta values ('restored_at', ?)", (db.now_iso(),))
                except Exception as e:
                    errlog.write('error', f'Восстановление из копии не удалось ({type(e).__name__}), данные возвращены как было')
                    traceback.print_exc()
                    rollback(con, aside, moved, placed)
                    raise
                _employees['at'] = 0
                partners.state['resync'] = True  # клиенты копии сверяются со справочником ядра
                # отложенное не удаляется, пока ему нет 30 дней (владелец мог перебирать копии) и всегда остаются 3 последних
                olds = sorted(p for p in db.DATA_DIR.iterdir() if p.is_dir() and p.name.startswith('before-restore-'))
                for old in olds[:-COPIES_KEPT]:
                    if time.time() - old.stat().st_mtime > 30 * 86400:
                        shutil.rmtree(old, ignore_errors=True)
            finally:
                state['restoring'] = False
        print(f'{time.strftime("%Y-%m-%d %H:%M:%S")} Данные восстановлены из копии {prefix or "(свой архив)"}, '
              f'прежние — в {aside.name}', flush=True)
        return {'ok': True, 'copy': prefix.rstrip('/').rsplit('/', 1)[-1] or 'den.db', 'rows': count, 'aside': aside.name, 'epoch': db.EPOCH}
    finally:
        shutil.rmtree(staged, ignore_errors=True)


@router.post(RESTORE_PATH)
async def restore_from_file(request: Request):
    require_ak_owner(request)
    if state['restoring'] or state['backup']:
        raise ApiError(409, 'Сейчас уже идёт копия или восстановление. Попробуйте через минуту.', 'busy')
    fd, name = tempfile.mkstemp(prefix='upload-', suffix='.zip', dir=tmp_dir())
    try:
        with os.fdopen(fd, 'wb') as out:
            async for chunk in request.stream():
                out.write(chunk)
        return await run_in_threadpool(restore, request.app.state.con, name)
    finally:
        os.unlink(name)
