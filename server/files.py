"""Фото и голосовые отчётов: папка files/shared/<id задачи>/. Отдаются только участникам этой задачи."""
import re
import shutil
import uuid

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse

from . import db
from .access import FILE_NAME, FILE_TYPES as TYPES, SAFE_ID, ApiError, bad, crm_visible, current_user, read_body, require_crm, require_shared

router = APIRouter(prefix='/api/files')
MAX_FILE = 20 * 1024 * 1024
MAX_FILES = 500  # на одну задачу: чтобы участник не забил диск
NAME_RE = re.compile('^' + FILE_NAME + '$')


def task_dir(task_id, area='shared'):
    if not SAFE_ID.match(task_id):
        raise ApiError(404, 'Не найдено', 'not_found')
    return db.FILES_DIR / area / task_id


def remove_task_files(task_ids):
    for task_id in task_ids:
        if SAFE_ID.match(task_id):
            shutil.rmtree(db.FILES_DIR / 'shared' / task_id, ignore_errors=True)


def task_row(request, task_id):
    from .shared import load  # shared.py импортирует этот файл: берём load при вызове
    return load(request.app.state.con, task_id)


async def store(request, task_id, name, area='shared'):
    data = await read_body(request, MAX_FILE)
    if not data:
        raise bad('Пустой файл', 'empty')
    folder = task_dir(task_id, area)
    folder.mkdir(parents=True, exist_ok=True)
    if sum(1 for _ in folder.iterdir()) >= MAX_FILES:
        raise ApiError(413, f'В задаче уже {MAX_FILES} файлов — удалите старые отчёты', 'too_many_files')
    try:
        with open(folder / name, 'xb') as out:  # 'x' — не перезаписывать существующий файл
            out.write(data)
    except FileExistsError:
        raise ApiError(409, 'Такой файл уже есть', 'exists')
    return JSONResponse({'path': f'{area}/{task_id}/{name}'}, status_code=201)


@router.post('/shared/{task_id}')
async def upload(task_id: str, request: Request, ext: str = ''):
    user = current_user(request)
    require_shared(task_row(request, task_id), user, 'owner', 'worker')  # приглашённый, пока не принял, только смотрит
    ext = ext.lower()
    if ext not in TYPES:
        raise bad('Такой тип файла не принимается', 'bad_type')
    return await store(request, task_id, f'{uuid.uuid4()}.{ext}')


@router.put('/shared/{task_id}/{name}')
async def put_with_name(task_id: str, name: str, request: Request):
    """Перенос из Supabase с прежним именем файла (ссылки в отчётах не меняются). Только организатор."""
    user = current_user(request)
    require_shared(task_row(request, task_id), user, 'owner')
    match = NAME_RE.match(name)
    if not match:
        raise bad('Неверное имя файла', 'bad_name')
    return await store(request, task_id, name)


@router.get('/shared/{task_id}/{name}')
async def download(task_id: str, name: str, request: Request):
    user = current_user(request)
    match = NAME_RE.match(name)
    if not match:
        raise bad('Неверное имя файла', 'bad_name')
    require_shared(task_row(request, task_id), user)
    path = task_dir(task_id) / name
    if not path.is_file():
        raise ApiError(404, 'Файл не найден', 'not_found')
    return FileResponse(path, media_type=TYPES[match.group(1)], headers={'Cache-Control': 'no-store'})


# --- Фото объектов CRM: загружает руководитель, видят все, кому виден объект ---

def visible_object(request, user, object_id):
    require_crm(user)
    where, args = crm_visible(user, 'objects')
    if not request.app.state.con.execute(f'select 1 from crm c where {where} and c.id=?', (*args, object_id)).fetchone():
        raise ApiError(404, 'Объект не найден', 'not_found')


@router.post('/crm/{object_id}')
async def upload_object_photo(object_id: str, request: Request, ext: str = ''):
    user = current_user(request)
    require_crm(user, write=True)
    visible_object(request, user, object_id)
    ext = ext.lower()
    if ext not in TYPES:
        raise bad('Такой тип файла не принимается', 'bad_type')
    return await store(request, object_id, f'{uuid.uuid4()}.{ext}', 'crm')


@router.get('/crm/{object_id}/{name}')
async def download_object_photo(object_id: str, name: str, request: Request):
    user = current_user(request)
    match = NAME_RE.match(name)
    if not match:
        raise bad('Неверное имя файла', 'bad_name')
    visible_object(request, user, object_id)
    path = task_dir(object_id, 'crm') / name
    if not path.is_file():
        raise ApiError(404, 'Файл не найден', 'not_found')
    return FileResponse(path, media_type=TYPES[match.group(1)], headers={'Cache-Control': 'no-store'})
