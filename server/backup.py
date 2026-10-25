"""Копии базы и папки files/: по кнопке админа и по расписанию; старые сверх DEN_BACKUP_KEEP удаляются."""
import sqlite3
import threading
import time
import zipfile

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import db
from .access import require_admin

router = APIRouter(prefix='/api/admin')
_lock = threading.Lock()


def make_backup():
    with _lock:
        db.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime('%Y%m%d-%H%M%S', time.gmtime()) + f'-{int(time.time() * 1000) % 1000:03d}'
        n, name = 0, stamp
        while (db.BACKUP_DIR / f'den-{name}.db').exists():
            n += 1
            name = f'{stamp}-{n}'
        target = db.BACKUP_DIR / f'den-{name}.db'
        archive = db.BACKUP_DIR / f'files-{name}.zip'
        try:
            src, dst = sqlite3.connect(db.DB_PATH, timeout=5), sqlite3.connect(target)
            try:
                src.backup(dst)
            finally:
                dst.close()
                src.close()
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_STORED) as z:
                if db.FILES_DIR.is_dir():
                    for path in sorted(db.FILES_DIR.rglob('*')):
                        if path.is_file():
                            z.write(path, path.relative_to(db.FILES_DIR).as_posix())
        except Exception:
            target.unlink(missing_ok=True)  # недописанная копия хуже, чем никакой: её могли бы принять за целую
            archive.unlink(missing_ok=True)
            raise
        for pattern in ('den-*.db', 'files-*.zip'):
            old = sorted(db.BACKUP_DIR.glob(pattern), key=lambda p: p.stat().st_mtime_ns)
            for path in old[:-db.BACKUP_KEEP] if db.BACKUP_KEEP > 0 else []:
                path.unlink(missing_ok=True)
        return target.name, target.stat().st_size


def last_backup_age():
    copies = list(db.BACKUP_DIR.glob('den-*.db')) if db.BACKUP_DIR.is_dir() else []
    return time.time() - max(p.stat().st_mtime for p in copies) if copies else float('inf')


def start_schedule(stop: threading.Event):
    """Отсчёт — от последней копии, а не от запуска: компьютер, который выключают каждый вечер, тоже получит копии."""
    def loop():
        while True:
            wait = max(1.0, db.BACKUP_EVERY - last_backup_age())
            if stop.wait(min(wait, 600)):
                return
            if last_backup_age() < db.BACKUP_EVERY:
                continue
            try:
                make_backup()
            except Exception as error:  # копия не должна ронять сервер; ошибку видно в журнале
                print(f'Автокопия не удалась: {error!r}', flush=True)
    threading.Thread(target=loop, name='den-backup', daemon=True).start()


@router.post('/backup', status_code=201)
async def backup_now(request: Request):
    require_admin(request)
    name, size = await run_in_threadpool(make_backup)
    return JSONResponse({'file': name, 'size': size}, status_code=201)
