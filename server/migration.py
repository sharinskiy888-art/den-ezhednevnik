"""Перенос из Supabase и сверка (этап 5): поручения организатора и «сколько записей на устройстве и на сервере»."""
import json
import math
import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from . import db
from .access import ApiError, bad, check_import, current_user, field, read_json, require_admin, require_migration_open
from .shared import load, payload_text, save

router = APIRouter(prefix='/api')
STATE_ID = '00000000-0000-4000-8000-000000000001'
COUNTS = ('tasks', 'plans', 'expenses', 'incomeKop', 'expenseKop')


DECIMAL = re.compile(r'[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?', re.ASCII)
PREFIXED = re.compile(r'0([xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)', re.ASCII)
KOP_TEXT = re.compile(r'-?\d{1,24}', re.ASCII)


def js_number(text):
    """Как Number(строка) в JS: пробелы по краям, пусто = 0, десятичная запись или 0x/0o/0b; остальное — не число."""
    text = text.strip()
    if not text:
        return 0
    if PREFIXED.fullmatch(text):
        return int(text[2:], {'x': 16, 'o': 8, 'b': 2}[text[1].lower()])
    if text in ('Infinity', '+Infinity', '-Infinity') or not DECIMAL.fullmatch(text):
        return None
    return float(text)


def to_kop(value):
    """Сумма в копейках так же, как считает приложение: Number(amount), округление половины вверх по десятичной записи."""
    if value is None:
        return 0
    if isinstance(value, bool):
        return int(value) * 100  # Number(true) в приложении — 1
    if isinstance(value, str):
        value = js_number(value)
    if isinstance(value, int):
        value = float(value)  # приложение тоже видит любое число как double
    if not isinstance(value, float) or not math.isfinite(value):
        return 0
    if abs(value) >= 1e21:
        return int(value) * 100
    try:
        return int((Decimal(repr(value)) * 100).quantize(Decimal(1), ROUND_HALF_UP))
    except InvalidOperation:
        return 0


def server_counts(con, user_id):
    out = dict.fromkeys(COUNTS, 0)
    for r in con.execute("select tbl, id, payload from rows where user_id=? and tbl in ('tasks','expenses')", (user_id,)):
        p = json.loads(r['payload'])
        if not isinstance(p, dict) or p.get('__deleted'):
            continue
        if r['tbl'] == 'tasks':
            if r['id'] == STATE_ID or p.get('__type') == 'app_state':
                plans = p.get('periodPlans')
                out['plans'] = sum(1 for x in plans if isinstance(x, dict)) if isinstance(plans, list) else 0
            else:
                out['tasks'] += 1
        else:
            out['expenses'] += 1
            out['incomeKop' if p.get('kind') == 'income' else 'expenseKop'] += to_kop(p.get('amount'))
    out['incomeKop'], out['expenseKop'] = str(out['incomeKop']), str(out['expenseKop'])  # строкой: в JS больше 2^53 не влезает
    return out


def device_counts(body):
    counts = body.get('counts')
    if not isinstance(counts, dict):
        raise bad('Нет чисел устройства', 'bad_field')
    out = {}
    for name in COUNTS:
        value = counts.get(name)
        if name.endswith('Kop'):
            if not isinstance(value, str) or not KOP_TEXT.fullmatch(value):
                raise bad(f'Неверное поле «{name}»', 'bad_field')
            out[name] = str(int(value))
        else:
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 10 ** 7:
                raise bad(f'Неверное поле «{name}»', 'bad_field')
            out[name] = value
    return out


@router.post('/migration/report')
async def report(request: Request):
    """Устройство после синхронизации присылает свои числа; сервер сравнивает со своими и запоминает итог."""
    user = current_user(request)
    body = await read_json(request)
    if not isinstance(body, dict):
        raise bad('Ожидается объект', 'bad_row')
    device = field(body, 'device', max_len=64)
    label = field(body, 'label', required=False, max_len=60) or ''
    counts = device_counts(body)
    supabase = body.get('supabase')
    if supabase is not None and (not isinstance(supabase, dict) or len(json.dumps(supabase)) > 2000):
        raise bad('Неверное поле «supabase»', 'bad_field')
    con = request.app.state.con
    with db.tx(con):
        mine = server_counts(con, user.id)
        ok = mine == counts
        stored = {**counts, **({'supabase': supabase} if supabase else {})}
        con.execute('insert or replace into reconcile values (?,?,?,?,?,?,?)',
                    (user.id, device, label, json.dumps(stored, ensure_ascii=False), json.dumps(mine), int(ok), db.now_iso()))
        # Хранится не больше 20 устройств на человека: самые старые отчёты уходят.
        con.execute('delete from reconcile where user_id=? and device not in '
                    '(select device from reconcile where user_id=? order by created_at desc limit 20)', (user.id, user.id))
    return {'ok': ok, 'server': mine, 'device': counts}


def reconcile_rows(con):
    users = con.execute('select id, email from users order by created_at').fetchall()
    out = []
    for u in users:
        now = server_counts(con, u['id'])
        devices = [{'device': r['device'], 'label': r['label'], 'at': r['created_at'], 'ok': bool(r['ok']),
                    'report': json.loads(r['report']), 'server': json.loads(r['server'])}
                   for r in con.execute('select * from reconcile where user_id=? order by created_at desc', (u['id'],))]
        shared = con.execute('select count(*) from shared where owner_id=?', (u['id'],)).fetchone()[0]
        out.append({'email': u['email'], 'server': {**now, 'sharedOwned': shared}, 'devices': devices,
                    'status': 'нет отчёта' if not devices else 'совпадает' if devices[0]['ok'] else 'расхождение'})
    return out


@router.get('/admin/reconcile')
async def reconcile(request: Request):
    require_admin(request)
    return reconcile_rows(request.app.state.con)


@router.post('/migration/shared')
async def import_shared(request: Request):
    """Поручение из Supabase переносит его организатор, один раз: уже перенесённое (даже если потом удалено) не возвращается."""
    user = current_user(request)
    require_migration_open()
    body = await read_json(request)
    invited, payload = check_import(body)
    task_id, stamp = body['id'], field(body, 'updated_at', max_len=40)
    text = payload_text(payload)
    con = request.app.state.con
    with db.tx(con):
        done = con.execute('select owner_id from imported_shared where id=?', (task_id,)).fetchone()
        existing = load(con, task_id)
        if done or existing:
            if (done and done['owner_id'] != user.id) or (existing and existing['owner_id'] != user.id):
                raise ApiError(409, 'Задача с таким id уже есть', 'exists')
            return JSONResponse({'imported': False}, status_code=200)
        con.execute('insert into shared (id, owner_id, owner_email, payload, updated_at) values (?,?,?,?,?)',
                    (task_id, user.id, user.email, text, stamp))
        save(con, task_id, {'owner_email': user.email, 'invited_emails': invited, 'accepted_emails': [],
                            'leave_requests': [], 'payload': payload, 'updated_at': stamp})
        con.execute('insert into imported_shared values (?,?)', (task_id, user.id))
    return JSONResponse({'imported': True}, status_code=201)
