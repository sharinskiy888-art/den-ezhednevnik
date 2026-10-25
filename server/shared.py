"""Поручения (совместные задачи) и «кто сейчас в сети». Что кому можно — решает access.py, здесь только чтение и запись."""
import json

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from . import db, files
from .access import (NOT_FOUND_SHARED, SHARED_COLUMNS, ApiError, bad, check_new_shared_id, check_owner_patch, check_worker_patch,
                     current_user, email_list, field, read_json, require_shared)
from .sync import MAX_ROW, json_response

router = APIRouter(prefix='/api')
LIST_COLUMNS = ('invited_emails', 'accepted_emails', 'leave_requests')


def load(con, task_id):
    row = con.execute('select * from shared where id=?', (task_id,)).fetchone()
    if not row:
        return None
    out = dict(row)
    for name in LIST_COLUMNS:
        out[name] = json.loads(out[name])
    out['payload_text'] = out['payload']
    out['payload'] = json.loads(out['payload'])
    return out


def row_json(r):
    # payload уходит готовым текстом из базы, без повторного разбора и сборки.
    head = {k: r[k] for k in ('id', 'owner_id', 'owner_email', 'updated_at')}
    head.update({k: r[k] if isinstance(r[k], list) else json.loads(r[k]) for k in LIST_COLUMNS})
    return json.dumps(head, ensure_ascii=False)[:-1] + ',"payload":' + r['payload'] + '}'


def payload_text(payload):
    if not isinstance(payload, dict):
        raise bad('payload должен быть объектом', 'bad_field')
    text = json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    if len(text.encode()) > MAX_ROW:
        raise ApiError(413, 'Запись слишком большая (больше 8 МБ). Уменьшите вложение.', 'too_large')
    return text


def save(con, task_id, row):
    """Записывает изменённые столбцы и обновляет список участников для быстрых выборок."""
    pu = row['payload'].get('updatedAt')
    con.execute('update shared set owner_email=?, invited_emails=?, accepted_emails=?, leave_requests=?, payload=?, updated_at=?, pu=? where id=?',
                (row['owner_email'], *(json.dumps(row[k], ensure_ascii=False) for k in LIST_COLUMNS),
                 payload_text(row['payload']), row['updated_at'], pu if isinstance(pu, str) else None, task_id))
    con.execute('delete from shared_members where task_id=?', (task_id,))
    con.executemany('insert or ignore into shared_members values (?,?)',
                    [(task_id, e) for e in {*row['invited_emails'], *row['accepted_emails']}])


def forget_email(con, email):
    """Убирает почту удалённого аккаунта из всех поручений (вызывается внутри транзакции)."""
    for (task_id,) in con.execute('select task_id from shared_members where email=?', (email,)).fetchall():
        row = load(con, task_id)
        for name in LIST_COLUMNS:
            row[name] = [e for e in row[name] if e != email]
        save(con, task_id, row)


def visible_where(user):
    return '(owner_id=? or id in (select task_id from shared_members where email=?))', (user.id, user.email.lower())


@router.get('/shared/heads')
async def heads(request: Request):
    user = current_user(request)
    where, args = visible_where(user)
    rows = request.app.state.con.execute(f'select id, updated_at, pu, {", ".join(LIST_COLUMNS)} from shared where {where} '
                                         'order by updated_at desc', args)
    return [{'id': r['id'], 'updated_at': r['updated_at'], 'pu': r['pu'], **{k: json.loads(r[k]) for k in LIST_COLUMNS}} for r in rows]


@router.get('/shared')
async def read_many(request: Request, ids: str | None = None):
    user = current_user(request)
    where, args = visible_where(user)
    con = request.app.state.con
    if ids is None:
        rows = con.execute(f'select * from shared where {where}', args).fetchall()
    else:
        wanted, rows = [i for i in dict.fromkeys(ids.split(',')) if i], []
        for i in range(0, len(wanted), 500):
            part = wanted[i:i + 500]
            rows += con.execute(f'select * from shared where {where} and id in ({",".join("?" * len(part))})', (*args, *part)).fetchall()
    return json_response('[' + ','.join(row_json(r) for r in rows) + ']')


@router.get('/shared/{task_id}')
async def read_one(task_id: str, request: Request):
    user = current_user(request)
    row = load(request.app.state.con, task_id)
    require_shared(row, user)
    return json_response(row_json({**row, 'payload': row['payload_text']}))


def updated_at(body, required=True):
    return field(body, 'updated_at', required=required, max_len=40)


@router.post('/shared')
async def create(request: Request):
    user = current_user(request)
    body = await read_json(request)
    if not isinstance(body, dict) or set(body) - SHARED_COLUMNS - {'id'}:
        raise bad('Неверная строка поручения', 'bad_row')
    task_id = field(body, 'id', max_len=100)
    check_new_shared_id(task_id)
    new = {'invited_emails': email_list(body.get('invited_emails') or [], 'invited_emails'),
           'payload': body.get('payload'), 'updated_at': updated_at(body)}
    text = payload_text(new['payload'])
    con = request.app.state.con
    with db.tx(con):
        existing = load(con, task_id)
        if existing:
            if existing['owner_id'] != user.id:
                raise ApiError(409, 'Задача с таким id уже есть', 'exists')
            # Повтор создания (ответ потерялся): это правка организатора; принявших и просьбы о выходе не трогаем.
            existing.update(new)
            save(con, task_id, existing)
            status = 200
        else:
            con.execute('insert into shared (id, owner_id, owner_email, payload, updated_at) values (?,?,?,?,?)',
                        (task_id, user.id, user.email, text, new['updated_at']))
            row = {'owner_email': user.email, 'accepted_emails': [], 'leave_requests': [], **new}
            save(con, task_id, row)
            status = 201
        result = load(con, task_id)
    return Response(row_json({**result, 'payload': result['payload_text']}), status_code=status, media_type='application/json')


@router.patch('/shared/{task_id}', status_code=204)
async def patch(task_id: str, request: Request):
    user = current_user(request)
    body = await read_json(request)
    if not isinstance(body, dict) or set(body) - SHARED_COLUMNS - {'id'} or body.get('id', task_id) != task_id:
        raise bad('Неверная правка поручения', 'bad_row')
    con = request.app.state.con
    with db.tx(con):
        row = load(con, task_id)
        role = require_shared(row, user, 'owner', 'worker')
        if role == 'owner':
            row.update(check_owner_patch(row, body))
        else:
            check_worker_patch(row, body, user, task_id)
        if 'payload' in body:
            payload_text(body['payload'])  # не объект — 400 до записи
            row['payload'] = body['payload']
        if 'updated_at' in body:
            row['updated_at'] = updated_at(body)
        save(con, task_id, row)
    return Response(status_code=204)


@router.delete('/shared/{task_id}', status_code=204)
async def delete(task_id: str, request: Request):
    user = current_user(request)
    con = request.app.state.con
    with db.tx(con):
        row = load(con, task_id)
        if not row or row['owner_id'] != user.id:
            raise ApiError(404, NOT_FOUND_SHARED, 'not_found')
        con.execute('delete from shared where id=?', (task_id,))
    files.remove_task_files([task_id])
    return Response(status_code=204)


@router.post('/shared/{task_id}/answer', status_code=204)
async def answer(task_id: str, request: Request):
    user = current_user(request)
    body = await read_json(request)
    con = request.app.state.con
    with db.tx(con):
        row = load(con, task_id)
        role = require_shared(row, user, 'invited', 'worker')
        if not isinstance(body, dict) or body.get('accept') is not True:
            raise bad('Отказаться от поручения нельзя. Если не можете выполнить — напишите организатору.', 'cannot_decline')
        if role == 'invited':
            me = user.email.lower()
            row['invited_emails'] = [e for e in row['invited_emails'] if e != me]
            row['accepted_emails'] = row['accepted_emails'] + [me]
            save(con, task_id, row)
    return Response(status_code=204)


@router.post('/shared/{task_id}/leave', status_code=204)
async def leave(task_id: str, request: Request):
    """Выйти можно только с согласия организатора: здесь лишь просьба, убирает из участников организатор."""
    user = current_user(request)
    con = request.app.state.con
    with db.tx(con):
        row = load(con, task_id)
        require_shared(row, user, 'worker')
        me = user.email.lower()
        if me not in row['leave_requests']:
            row['leave_requests'] = row['leave_requests'] + [me]
            save(con, task_id, row)
    return Response(status_code=204)


@router.post('/presence', status_code=204)
async def touch_presence(request: Request):
    user = current_user(request)
    body = await read_json(request) or {}
    locale = 'en' if isinstance(body, dict) and body.get('locale') == 'en' else 'ru'
    with db.tx(request.app.state.con) as con:
        con.execute('insert into presence values (?,?,?,?) on conflict (user_id) do update set email=excluded.email, '
                    'locale=excluded.locale, last_seen=excluded.last_seen', (user.id, user.email.lower(), locale, db.now_iso()))
    return Response(status_code=204)


@router.get('/presence')
async def read_presence(request: Request):
    """Только люди, с которыми у меня есть общее поручение: организатор и принявшие (приглашённый ещё не участвует)."""
    user = current_user(request)
    where, args = visible_where(user)
    con = request.app.state.con
    mates = {r[0].lower() for r in con.execute(f'select owner_email from shared where {where}', args)}
    for r in con.execute(f'select accepted_emails from shared where {where}', args):
        mates.update(json.loads(r[0]))
    mates.discard(user.email.lower())
    if not mates:
        return JSONResponse([])
    rows = con.execute(f'select email, last_seen from presence where email in ({",".join("?" * len(mates))})', tuple(mates))
    return [dict(r) for r in rows]
