"""Синхронизация личных данных (задачи, планы, финансы). Сервер только хранит: «кто новее» решает устройство."""
import json

from fastapi import APIRouter, Request
from fastapi.responses import Response

from . import db
from .access import ApiError, bad, current_user, owner_of_personal_rows, personal_table, read_json

router = APIRouter(prefix='/api/data')
MAX_ROW = 8 * 1024 * 1024
ALLOWED_KEYS = {'id', 'payload', 'updated_at', 'user_id'}


def json_response(text):
    return Response(text, media_type='application/json')


def rows_json(rows):
    # payload лежит в базе готовым JSON-текстом и уходит как есть, без повторного разбора.
    return '[' + ','.join('{"id":%s,"payload":%s,"updated_at":%s}' % (json.dumps(r['id'], ensure_ascii=False), r['payload'],
                                                                      json.dumps(r['updated_at'], ensure_ascii=False)) for r in rows) + ']'


def parse_rows(body):
    if not isinstance(body, list):
        raise bad('Ожидается список строк', 'bad_rows')
    out = []
    for item in body:
        if not isinstance(item, dict) or set(item) - ALLOWED_KEYS:
            raise bad('Неверная строка данных', 'bad_row')
        row_id, payload, updated_at = item.get('id'), item.get('payload'), item.get('updated_at')
        if not isinstance(row_id, str) or not 0 < len(row_id) <= 100:
            raise bad('У строки неверный id', 'bad_row')
        if not isinstance(payload, dict):
            raise bad('У строки payload должен быть объектом', 'bad_row')
        if not isinstance(updated_at, str) or not 0 < len(updated_at) <= 40:
            raise bad('У строки нет времени правки', 'bad_row')
        text = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        if len(text.encode()) > MAX_ROW:
            raise ApiError(413, 'Запись слишком большая (больше 8 МБ). Уменьшите вложение.', 'too_large')
        pu = payload.get('updatedAt')
        out.append((row_id, text, updated_at, pu if isinstance(pu, str) else None))
    return out


@router.get('/{table}/heads')
async def heads(table: str, request: Request):
    table = personal_table(table)
    owner = owner_of_personal_rows(current_user(request))
    rows = request.app.state.con.execute('select id, updated_at, pu from rows where user_id=? and tbl=?', (owner, table))
    return [dict(r) for r in rows]


@router.get('/{table}')
async def read_rows(table: str, request: Request, ids: str | None = None):
    table = personal_table(table)
    owner = owner_of_personal_rows(current_user(request))
    con = request.app.state.con
    if ids is None:
        return json_response(rows_json(con.execute('select id, payload, updated_at from rows where user_id=? and tbl=?', (owner, table))))
    wanted = [i for i in dict.fromkeys(ids.split(',')) if i]
    found = []
    for i in range(0, len(wanted), 500):
        part = wanted[i:i + 500]
        found += con.execute(f'select id, payload, updated_at from rows where user_id=? and tbl=? and id in ({",".join("?" * len(part))})',
                             (owner, table, *part)).fetchall()
    return json_response(rows_json(found))


@router.post('/{table}', status_code=204)
async def write_rows(table: str, request: Request):
    table = personal_table(table)
    owner = owner_of_personal_rows(current_user(request))
    rows = parse_rows(await read_json(request))
    with db.tx(request.app.state.con) as con:
        con.executemany('insert into rows (user_id, tbl, id, payload, updated_at, pu) values (?,?,?,?,?,?) '
                        'on conflict (user_id, tbl, id) do update set payload=excluded.payload, updated_at=excluded.updated_at, pu=excluded.pu',
                        [(owner, table, *r) for r in rows])
    return Response(status_code=204)


@router.delete('/{table}/{row_id}', status_code=204)
async def delete_row(table: str, row_id: str, request: Request):
    table = personal_table(table)
    owner = owner_of_personal_rows(current_user(request))
    with db.tx(request.app.state.con) as con:
        con.execute('delete from rows where user_id=? and tbl=? and id=?', (owner, table, row_id))
    return Response(status_code=204)
