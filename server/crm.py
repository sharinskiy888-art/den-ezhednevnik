"""CRM: клиенты, объекты, заявки, договоры ТО, деньги по заявкам (в копейках), справочник.

Хранится как личные данные (id + payload + updated_at), но общее для всей фирмы; кто что видит — access.py.
Заявка с исполнителями сама становится поручением (shared.py), договор ТО сам создаёт заявки.
"""
import calendar
import datetime as dt
import json
import re
import time

from fastapi import APIRouter, Request
from fastapi.responses import Response

from . import db, files, shared
from .access import CRM_ROLES, SAFE_ID, ApiError, bad, crm_role, crm_visible, current_user, field, read_json, require_admin, require_crm
from .sync import MAX_ROW, json_response, rows_json

router = APIRouter(prefix='/api')
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
STAGES = ('new', 'kp', 'work', 'done', 'paid')
DEFAULT_DICT = {'id': 'dict', 'workTypes': ['Монтаж', 'Ремонт', 'ТО', 'Проект'],
                'systems': ['АПС', 'СОУЭ', 'Видеонаблюдение', 'Электрика'], 'updatedAt': '1970-01-01T00:00:00.000Z'}
REF = {'objects': 'clientId', 'orders': 'objectId', 'contracts': 'objectId', 'payments': 'orderId'}
LEAD_DAYS, MAX_CATCH_UP = 7, 60
MAX_ID = {'contracts': 70}  # из id договора сервер строит id заявок ТО и поручений: «crm-to-<id>-<дата>» ≤ 100
MAX_KOP = 10 ** 15


# --- Проверка полей: неизвестные поля хранятся как есть, известные должны быть правильного вида ---

def _check(cond, name):
    if not cond:
        raise bad(f'Неверное поле «{name}»', 'bad_field')


def _text(p, name, required=False, limit=2000):
    v = p.get(name)
    if v is None and not required:
        return
    _check(isinstance(v, str) and len(v) <= limit and (v.strip() or not required), name)


def _int(p, name, low=0, high=MAX_KOP):
    if name in p:
        _check(isinstance(p[name], int) and not isinstance(p[name], bool) and low <= p[name] <= high, name)


def _date(p, name):
    if p.get(name) not in (None, ''):
        _check(isinstance(p[name], str) and DATE.match(p[name]), name)
        try:
            dt.date.fromisoformat(p[name])
        except ValueError:
            _check(False, name)


def _strings(p, name):
    if name in p:
        _check(isinstance(p[name], list) and len(p[name]) <= 200 and all(isinstance(x, str) and len(x) <= 300 for x in p[name]), name)


def validate(kind, p):
    if p.get('__deleted'):
        return
    if kind == 'clients':
        _text(p, 'name', required=True, limit=300)
        for name in ('inn', 'phone', 'email', 'contact', 'note'):
            _text(p, name)
    elif kind == 'objects':
        _text(p, 'clientId', required=True, limit=100)
        for name in ('address', 'equipment', 'note'):
            _text(p, name)
        _strings(p, 'systems')
        _strings(p, 'photos')
    elif kind == 'orders':
        _text(p, 'objectId', required=True, limit=100)
        _text(p, 'type', limit=100)
        _text(p, 'note')
        _check(p.get('stage', 'new') in STAGES, 'stage')
        _strings(p, 'assignees')
        _date(p, 'due')
        _int(p, 'sumKop')
    elif kind == 'contracts':
        _text(p, 'objectId', required=True, limit=100)
        _int(p, 'periodMonths', 1, 24)
        _int(p, 'priceKop')
        _date(p, 'nextDate')
        _int(p, 'dayOfMonth', 1, 31)
        _strings(p, 'assignees')
        _check(isinstance(p.get('active', True), bool), 'active')
    elif kind == 'payments':
        _text(p, 'orderId', required=True, limit=100)
        _check(p.get('kind') in ('income', 'expense'), 'kind')
        _int(p, 'amountKop', 1)
        _check('amountKop' in p, 'amountKop')
        _date(p, 'date')
        _text(p, 'note')
    elif kind == 'dict':
        for name in ('workTypes', 'systems'):
            _strings(p, name)
            _check(all(len(x) <= 100 for x in p.get(name) or []), name)


def parse_rows(kind, body):
    if not isinstance(body, list) or len(body) > 5000:
        raise bad('Ожидается список строк (до 5000 за раз)', 'bad_rows')
    out = []
    for item in body:
        if not isinstance(item, dict) or set(item) - {'id', 'payload', 'updated_at', 'user_id'}:
            raise bad('Неверная строка данных', 'bad_row')
        row_id, p, updated_at = item.get('id'), item.get('payload'), item.get('updated_at')
        if not isinstance(row_id, str) or not SAFE_ID.match(row_id) or len(row_id) > MAX_ID.get(kind, 90) or (kind == 'dict' and row_id != 'dict'):
            raise bad('У строки неверный id', 'bad_row')
        if not isinstance(p, dict) or not isinstance(updated_at, str) or not 0 < len(updated_at) <= 40:
            raise bad('Неверная строка данных', 'bad_row')
        validate(kind, p)
        text = json.dumps(p, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        if len(text.encode()) > MAX_ROW:
            raise ApiError(413, 'Запись слишком большая (больше 8 МБ)', 'too_large')
        pu = p.get('updatedAt')
        ref = None if p.get('__deleted') else p.get(REF.get(kind, ''))
        out.append((row_id, p, text, updated_at, pu if isinstance(pu, str) else None, ref if isinstance(ref, str) else None))
    return out


def write(con, kind, rows, author):
    """Записывает строки и делает то, что из них следует: поручения по заявкам, учёт исполнителей."""
    con.executemany('insert into crm (kind, id, payload, updated_at, pu, ref) values (?,?,?,?,?,?) on conflict (kind, id) do update set '
                    'payload=excluded.payload, updated_at=excluded.updated_at, pu=excluded.pu, ref=excluded.ref',
                    [(kind, r[0], r[2], r[3], r[4], r[5]) for r in rows])
    if kind != 'orders':
        return []
    removed = []
    for row_id, p, *_ in rows:
        assignees = [] if p.get('__deleted') else list(dict.fromkeys(e.strip().lower() for e in p.get('assignees') or [] if e.strip()))
        con.execute('delete from crm_assignees where order_id=?', (row_id,))
        con.executemany('insert into crm_assignees values (?,?)', [(row_id, e) for e in assignees])
        if p.get('__deleted'):
            removed += [f'crm-{row_id}'] if con.execute('delete from shared where id=?', (f'crm-{row_id}',)).rowcount else []
        else:
            link_task(con, row_id, p, assignees, author)
    return removed


def task_title(con, p):
    obj = con.execute("select payload from crm where kind='objects' and id=?", (p.get('objectId'),)).fetchone()
    where = json.loads(obj[0]).get('address') if obj else ''
    return f"{p.get('type') or 'Заявка'}: {where or 'объект'}"[:300]


def link_task(con, order_id, p, assignees, author):
    """Заявка с исполнителями = поручение crm-<id>: организатор — кто записал, приглашены исполнители заявки."""
    task_id, now = f'crm-{order_id}', time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    row = shared.load(con, task_id)
    if not row and (not assignees or not author.id):
        return
    fields = {'title': task_title(con, p), 'date': p.get('due') or now[:10], 'note': p.get('note') or '', 'crmOrderId': order_id}
    if not row:
        con.execute('insert into shared (id, owner_id, owner_email, payload, updated_at) values (?,?,?,?,?)',
                    (task_id, author.id, author.email, '{}', now))
        row = {'owner_email': author.email, 'accepted_emails': [], 'leave_requests': [], 'invited_emails': [],
               'payload': {'status': 'new', 'completed': False, 'subtasks': [], 'reports': [], 'time': '',
                           'activity': [{'type': 'created', 'email': author.email, 'at': now}]}}
    accepted = [e for e in row['accepted_emails'] if e in assignees]
    invited = [e for e in assignees if e not in accepted and e != str(row['owner_email']).lower()]  # организатор сам себя не приглашает
    changed = any(row['payload'].get(k) != v for k, v in fields.items()) or accepted != row['accepted_emails'] or invited != row['invited_emails']
    if not changed:
        return
    row['payload'].update(fields, updatedAt=now)
    row.update(accepted_emails=accepted, invited_emails=invited, updated_at=now,
               leave_requests=[e for e in row['leave_requests'] if e in accepted])
    shared.save(con, task_id, row)


# --- Договоры ТО ---

def add_months(day: dt.date, months, anchor):
    y, m = divmod(day.month - 1 + months, 12)
    year, month = day.year + y, m + 1
    return dt.date(year, month, min(anchor, calendar.monthrange(year, month)[1]))


def run_maintenance(con, today=None):
    """Создаёт заявки ТО на ближайшие 7 дней по активным договорам. Повторный запуск ничего не дублирует.

    Визиты, которые прошли больше месяца назад (сервер был долго выключен), не создаются — дата договора
    просто переходит к ближайшей, иначе монтажникам пришли бы пачки устаревших поручений.
    """
    today = today or dt.date.today()
    horizon, oldest, created = today + dt.timedelta(days=LEAD_DAYS), today - dt.timedelta(days=31), 0
    now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    for r in con.execute("select id, payload from crm where kind='contracts'").fetchall():
        try:
            with db.tx(con):
                created += maintain_contract(con, r['id'], json.loads(r['payload']), horizon, oldest, now)
        except Exception:  # один испорченный договор не должен останавливать остальные
            print(f'Договор {r["id"]}: заявки ТО не созданы', flush=True)
    return created


def maintain_contract(con, contract_id, c, horizon, oldest, now):
    if c.get('__deleted') or not c.get('active', True) or not c.get('nextDate'):
        return 0
    nxt = dt.date.fromisoformat(c['nextDate'])
    anchor = c.get('dayOfMonth') if c.get('dayOfMonth') in range(1, 32) else nxt.day
    period = c.get('periodMonths') if c.get('periodMonths') in range(1, 25) else 1
    owner = con.execute('select id, email from users where id=?', (c.get('ownerId'),)).fetchone() or \
        con.execute("select id, email from users where role='admin' order by created_at limit 1").fetchone()
    created = steps = 0
    while nxt <= horizon and steps < MAX_CATCH_UP:
        order_id = f"to-{contract_id}-{nxt.isoformat()}"
        if nxt >= oldest and not con.execute("select 1 from crm where kind='orders' and id=?", (order_id,)).fetchone():
            p = {'id': order_id, 'objectId': c.get('objectId'), 'type': c.get('type') or 'ТО', 'stage': 'new',
                 'due': nxt.isoformat(), 'sumKop': c.get('priceKop') or 0, 'assignees': c.get('assignees') or [],
                 'contractId': contract_id, 'note': c.get('note') or 'ТО по договору', 'updatedAt': now}
            text = json.dumps(p, ensure_ascii=False, separators=(',', ':'))
            write(con, 'orders', [(order_id, p, text, now, now, p['objectId'])], Author(owner))
            created += 1
        nxt, steps = add_months(nxt, period, anchor), steps + 1
    if steps:
        c.update(nextDate=nxt.isoformat(), dayOfMonth=anchor, updatedAt=now)
        con.execute("update crm set payload=?, updated_at=?, pu=? where kind='contracts' and id=?",
                    (json.dumps(c, ensure_ascii=False, separators=(',', ':')), now, now, contract_id))
    return created


def contract_row(con, user, row_id, p, text, *rest):
    """Кто завёл договор — организатор его поручений ТО. Дату перенесли вручную — число месяца берётся из новой даты."""
    old = con.execute("select payload from crm where kind='contracts' and id=?", (row_id,)).fetchone()
    old = json.loads(old[0]) if old else {}
    p = {**p, 'ownerId': old.get('ownerId') or user.id}  # не из тела запроса: чужим именем поручения не раздать
    if p.get('nextDate') != old.get('nextDate'):
        p.pop('dayOfMonth', None)
    return (row_id, p, json.dumps(p, ensure_ascii=False, separators=(',', ':')), *rest)


class Author:
    def __init__(self, row):
        self.id, self.email = (row['id'], row['email']) if row else ('', '')


# --- Маршруты ---

def ensure_dict(con):
    if not con.execute("select 1 from crm where kind='dict' and id='dict'").fetchone():
        with db.tx(con):
            con.execute("insert or ignore into crm (kind, id, payload, updated_at, pu) values ('dict','dict',?,?,?)",
                        (json.dumps(DEFAULT_DICT, ensure_ascii=False), DEFAULT_DICT['updatedAt'], DEFAULT_DICT['updatedAt']))


@router.get('/crm/me')
async def me(request: Request):
    return {'role': crm_role(current_user(request))}


@router.post('/crm/maintenance')
async def maintenance(request: Request, today: str | None = None):
    require_crm(current_user(request), write=True)
    try:
        day = dt.date.fromisoformat(today) if today else None
    except ValueError:
        raise bad('Дата — ГГГГ-ММ-ДД', 'bad_field')
    return {'created': run_maintenance(request.app.state.con, day)}


@router.get('/crm/{kind}/heads')
async def heads(kind: str, request: Request):
    user = current_user(request)
    require_crm(user, kind)
    con = request.app.state.con
    if kind == 'dict':
        ensure_dict(con)
    where, args = crm_visible(user, kind)
    return [dict(r) for r in con.execute(f'select c.id, c.updated_at, c.pu from crm c where {where}', args)]


@router.get('/crm/{kind}')
async def read(kind: str, request: Request, ids: str | None = None):
    user = current_user(request)
    require_crm(user, kind)
    con = request.app.state.con
    if kind == 'dict':
        ensure_dict(con)
    where, args = crm_visible(user, kind)
    if ids is None:
        return json_response(rows_json(con.execute(f'select c.id, c.payload, c.updated_at from crm c where {where}', args)))
    wanted, found = [i for i in dict.fromkeys(ids.split(',')) if i], []
    for i in range(0, len(wanted), 500):
        part = wanted[i:i + 500]
        found += con.execute(f'select c.id, c.payload, c.updated_at from crm c where {where} and c.id in ({",".join("?" * len(part))})',
                             (*args, *part)).fetchall()
    return json_response(rows_json(found))


@router.post('/crm/{kind}', status_code=204)
async def write_rows(kind: str, request: Request):
    user = current_user(request)
    require_crm(user, kind, write=True)
    rows = parse_rows(kind, await read_json(request))
    con = request.app.state.con
    if kind == 'contracts':
        rows = [contract_row(con, user, *r) for r in rows]
    with db.tx(con):
        removed = write(con, kind, rows, user)
    files.remove_task_files(removed)
    if kind == 'contracts':
        run_maintenance(con)
    return Response(status_code=204)


@router.delete('/crm/{kind}/{row_id}', status_code=204)
async def delete_row(kind: str, row_id: str, request: Request):
    """Убирает только истёкшее надгробие; живая запись удаляется надгробием (так узнают остальные устройства)."""
    require_crm(current_user(request), kind, write=True)
    with db.tx(request.app.state.con) as con:
        row = con.execute('select payload from crm where kind=? and id=?', (kind, row_id)).fetchone()
        if row and not json.loads(row[0]).get('__deleted'):
            raise ApiError(409, 'Запись не удалена: сначала удалите её в приложении', 'not_deleted')
        con.execute('delete from crm where kind=? and id=?', (kind, row_id))
        if kind == 'orders':
            con.execute('delete from crm_assignees where order_id=?', (row_id,))
    return Response(status_code=204)


@router.put('/admin/users/{user_id}/crm', status_code=204)
async def set_role(user_id: str, request: Request):
    require_admin(request)
    role = field(await read_json(request), 'role', max_len=20)
    if role not in CRM_ROLES:
        raise bad('Роль CRM — manager, worker или пусто', 'bad_field')
    with db.tx(request.app.state.con) as con:
        if not con.execute('update users set crm_role=? where id=?', (role, user_id)).rowcount:
            raise ApiError(404, 'Нет такого пользователя', 'not_found')
    return Response(status_code=204)
