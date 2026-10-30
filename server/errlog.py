"""Журнал ошибок модуля (п. 8 общих правил АК): всегда строкой в logs/errors.log и, в режиме модуля, ядру POST /core/v1/log.

Файл — в AK_LOG_DIR (его даёт ядро), иначе в <папка данных>/logs. Ядро старое (404/405) или не отвечает — запись остаётся
только в файле, в ядро повторно не шлётся (после 404/405 — больше никогда до перезапуска). Из текста убираются email
и телефоны: пароли, ключи и данные клиентов в журнал не попадают (вызывающий пишет только что делали и тип ошибки).
"""
import os
import queue
import re
import threading
import time
from pathlib import Path

from . import db

LOG_DIR = Path(os.environ.get('AK_LOG_DIR') or db.DATA_DIR / 'logs')
LEVELS = ('error', 'warning', 'info')
PRIVATE = re.compile(r'[\w.+-]+@[\w-]+(\.[\w-]+)+|(?<![\w.-])(?:(?:\+7|8|7)[ (-]*)?9\d\d[ )-]*\d{3}[ -]*\d\d[ -]*\d\d(?!\d)')  # email, мобильный РФ
MAX_SIZE = 5 * 1024 * 1024  # больше — прежний файл становится errors.log.1, начинается новый
state = {'core': db.AK, 'worker': None}  # core False — ядро без /core/v1/log
_file_lock = threading.Lock()
_outbox = queue.Queue(maxsize=200)  # одна очередь и один поток отправки; переполнилась — запись только в файле


def clean(text):
    return PRIVATE.sub('***', ' '.join(str(text).split()))[:1000]


def write(level, text, wait=False):
    """Не бросает исключений и не ждёт ядро (wait=True — ждёт до 5 с: запись перед выходом программы)."""
    level = level if level in LEVELS else 'error'
    text = clean(text)
    stamp = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    try:
        with _file_lock:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            path = LOG_DIR / 'errors.log'
            if path.is_file() and path.stat().st_size > MAX_SIZE:
                os.replace(path, LOG_DIR / 'errors.log.1')
            with open(LOG_DIR / 'errors.log', 'a', encoding='utf-8') as f:
                f.write(f'{stamp} {level} {text}\n')
    except OSError:
        pass
    print(f'{time.strftime("%Y-%m-%d %H:%M:%S")} {level}: {text}', flush=True)
    if state['core']:
        entry = {'module': db.AK_CODE, 'version': db.MODULE_VERSION, 'level': level,
                 'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'text': text}
        if wait:
            _send(entry)
            return
        try:
            _outbox.put_nowait(entry)
        except queue.Full:
            return
        with _file_lock:
            if state['worker'] is None:
                state['worker'] = threading.Thread(target=_work, name='errlog', daemon=True)
                state['worker'].start()


def _work():
    while True:
        entry = _outbox.get()
        if state['core']:
            _send(entry)


def _send(entry):
    from . import ak
    try:
        ak.core('POST', '/core/v1/log', entry, timeout=5)
    except ak.CoreError as e:
        if e.status in (404, 405):
            state['core'] = False
    except Exception:
        pass
