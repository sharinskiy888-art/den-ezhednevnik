"""Журнал ошибок модуля (п. 8 общих правил АК): всегда строкой в logs/errors.log и, в режиме модуля, ядру POST /core/v1/log.

Файл — в AK_LOG_DIR (его даёт ядро), иначе в <папка данных>/logs. Ядро старое (404/405) или не отвечает — запись остаётся
только в файле, в ядро повторно не шлётся (после 404/405 — больше никогда до перезапуска). Из текста убираются email
и телефоны: пароли, ключи и данные клиентов в журнал не попадают (вызывающий пишет только что делали и тип ошибки).
"""
import os
import re
import threading
import time
from pathlib import Path

from . import db

LOG_DIR = Path(os.environ.get('AK_LOG_DIR') or db.DATA_DIR / 'logs')
LEVELS = ('error', 'warning', 'info')
PRIVATE = re.compile(r'[\w.+-]+@[\w-]+(\.[\w-]+)+|\+?\d(?:[ ()-]*\d){9,}')  # email, телефон (от 10 цифр)
state = {'core': db.AK}  # False — ядро без /core/v1/log
_file_lock = threading.Lock()


def clean(text):
    return PRIVATE.sub('***', ' '.join(str(text).split()))[:1000]


def write(level, text):
    """Не бросает исключений и не ждёт ядро: журнал не должен ронять или тормозить работу."""
    level = level if level in LEVELS else 'error'
    text = clean(text)
    stamp = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    try:
        with _file_lock:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            with open(LOG_DIR / 'errors.log', 'a', encoding='utf-8') as f:
                f.write(f'{stamp} {level} {text}\n')
    except OSError:
        pass
    print(f'{time.strftime("%Y-%m-%d %H:%M:%S")} {level}: {text}', flush=True)
    if state['core']:
        iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        threading.Thread(target=_send, args=({'module': db.AK_CODE, 'version': db.MODULE_VERSION, 'level': level,
                                               'time': iso, 'text': text},), daemon=True).start()


def _send(entry):
    from . import ak
    try:
        ak.core('POST', '/core/v1/log', entry, timeout=5)
    except ak.CoreError as e:
        if e.status in (404, 405):
            state['core'] = False
    except Exception:
        pass
