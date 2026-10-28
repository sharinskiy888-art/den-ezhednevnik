"""Помощник установщика (den-setup-…-pc.exe). Запускается встроенным Python из папки программы.

  setup_den.py env <папка данных>   создать den.env (секрет — случайный, только этот компьютер), если его нет
  setup_den.py admin <email>        первый администратор; пароль — из DEN_NEW_PASSWORD (не в командной строке)
  setup_den.py backup               копия базы перед обновлением (если база уже есть)
"""
import os
import secrets
import subprocess
import sys
from pathlib import Path

APP = Path(__file__).resolve().parent
ENV = APP / 'den.env'


def run(*args):
    return subprocess.call([sys.executable, str(APP / 'den.py'), *args], cwd=APP)


def main(argv):
    if argv[:1] == ['env'] and len(argv) == 2:
        if ENV.exists():
            return 0
        Path(argv[1]).mkdir(parents=True, exist_ok=True)
        ENV.write_text('# Секреты и настройки сервера «День». Не копировать в архивы и чаты.\n'
                       f'DEN_SECRET={secrets.token_urlsafe(48)}\n'
                       f'DEN_DATA_DIR={argv[1]}\n'
                       f'DEN_STATIC_DIR={APP}\n'
                       'DEN_HOST=127.0.0.1\n'  # только этот компьютер: наружу ничего не открыто
                       'DEN_PORT=8787\n', encoding='utf-8')
        return 0
    if argv[:1] == ['admin'] and len(argv) == 2:
        if not os.environ.get('DEN_NEW_PASSWORD'):
            return 2
        return run('admin', 'add', argv[1], '-', 'admin')
    if argv == ['backup']:
        return run('admin', 'backup') if ENV.exists() else 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
