"""Сервер «День»: запуск, общие правила ответов, обратная связь и раздача экранов приложения.

Запуск: python -m uvicorn server.main:app --host 0.0.0.0 --port 8787 (настройки — в den.env).
"""
import base64
import binascii
import re
import threading
import traceback
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import auth, backup, db, files, shared, sync
from .access import MAX_BODY, ApiError, RateLimiter, bad, client_ip, field, read_json, require_admin, user_from_token

STATIC_FILES = {'index.html', 'app.js', 'sync.js', 'sync-config.js', 'i18n-en.js', 'styles.css', 'sw.js', 'version.js',
                'version.json', 'manifest.webmanifest', 'install.html', 'qr-iphone.svg'}
PHOTO_RE = re.compile(r'^data:image/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/=]+)$')
feedback_limiter = RateLimiter(db.FEEDBACK_LIMIT, 60)

db.lock_data_dir()
con = db.connect()
db.migrate(con)
auth.ensure_first_admin(con)


@asynccontextmanager
async def lifespan(app):
    stop = threading.Event()
    backup.start_schedule(stop)
    yield
    stop.set()


app = FastAPI(title='День', docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.state.con = con


def error(status, message, code, headers=None):
    return JSONResponse({'message': message, 'code': code}, status_code=status, headers=headers)


@app.exception_handler(ApiError)
async def api_error(request, exc: ApiError):
    return error(exc.status, exc.message, exc.code, exc.headers)


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    return error(400, 'Неверные данные запроса', 'bad_request')


@app.exception_handler(StarletteHTTPException)
async def http_error(request, exc):
    texts = {404: 'Не найдено', 405: 'Этот метод здесь не поддерживается'}
    return error(exc.status_code, texts.get(exc.status_code, 'Ошибка запроса'), 'not_found' if exc.status_code == 404 else 'http_error')


@app.exception_handler(Exception)
async def crash(request, exc):
    traceback.print_exc()  # в журнал без тел запросов: пароли и токены туда не попадают
    return error(500, 'Внутренняя ошибка сервера. Попробуйте ещё раз.', 'server_error')


@app.middleware('http')
async def limits_and_cache(request: Request, call_next):
    length = request.headers.get('content-length')
    if length and length.isdigit() and int(length) > MAX_BODY:
        return error(413, 'Слишком большой запрос (больше 32 МБ)', 'too_large')
    response = await call_next(request)
    if request.url.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
    return response


# Добавляется последним, значит, работает снаружи всех: заголовки CORS будут и на ответах-ошибках.
app.add_middleware(CORSMiddleware, allow_origins=db.ALLOWED_ORIGINS, allow_credentials=False,
                   allow_methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
                   allow_headers=['Authorization', 'Content-Type', 'apikey'], expose_headers=['Retry-After'], max_age=600)

app.include_router(auth.router)
app.include_router(sync.router)
app.include_router(shared.router)
app.include_router(files.router)
app.include_router(backup.router)


@app.get('/api/health')
async def health():
    return {'ok': True, 'version': db.VERSION}


@app.post('/api/feedback', status_code=204)
async def feedback(request: Request):
    """Обратная связь из приложения (раньше уходила на сторонний formsubmit.co)."""
    ip = 'ip:' + client_ip(request)
    feedback_limiter.check(ip)
    today = con.execute("select count(*) from feedback where created_at >= ?", (db.now_iso()[:10],)).fetchone()[0]
    if today >= db.FEEDBACK_DAILY:
        raise ApiError(429, 'Сегодня уже слишком много сообщений. Попробуйте завтра.', 'too_many', {'Retry-After': '3600'})
    body = await read_json(request)
    text = (field(body, 'text', max_len=5000) or '').strip()
    if not text:
        raise bad('Напишите текст сообщения', 'empty')
    email = field(body, 'email', required=False, max_len=300)
    photo = field(body, 'photo', required=False, max_len=7 * 1024 * 1024)
    if photo:
        match = PHOTO_RE.match(photo)
        try:
            if not match or len(base64.b64decode(match.group(2), validate=True)) > 5 * 1024 * 1024:
                raise bad('Фото должно быть картинкой до 5 МБ', 'bad_photo')
        except binascii.Error:
            raise bad('Фото повреждено', 'bad_photo')
    header = request.headers.get('authorization', '')
    user = user_from_token(con, header[7:].strip()) if header[:7].lower() == 'bearer ' else None
    feedback_limiter.hit(ip)
    with db.tx(con):
        con.execute('insert into feedback (text, email, photo, created_at) values (?,?,?,?)',
                    (text, email or (user.email if user else None), photo or None, db.now_iso()))
    return Response(status_code=204)


@app.get('/api/admin/feedback')
async def feedback_list(request: Request):
    require_admin(request)
    return [dict(r) for r in con.execute('select id, text, email, photo, created_at from feedback order by id desc')]


@app.api_route('/api/{rest:path}', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
async def api_not_found(rest: str):
    raise ApiError(404, 'Нет такого адреса API', 'not_found')


@app.api_route('/{path:path}', methods=['GET', 'HEAD'])
async def screens(path: str):
    """Экраны приложения — только из списка, чтобы наружу не ушли код сервера, база или .git."""
    if db.STATIC_DIR is None:
        raise ApiError(404, 'Не найдено', 'not_found')
    path = path or 'index.html'
    allowed = path in STATIC_FILES or (path.startswith('assets/') and re.fullmatch(r'assets/[\w.-]+', path))
    target = (db.STATIC_DIR / path).resolve() if allowed else None
    if not target or not target.is_file() or target.parent not in (db.STATIC_DIR, db.STATIC_DIR / 'assets'):
        raise ApiError(404, 'Не найдено', 'not_found')
    headers = {'Cache-Control': 'no-cache'}
    return FileResponse(target, headers=headers, media_type='application/manifest+json' if path.endswith('.webmanifest') else None)
