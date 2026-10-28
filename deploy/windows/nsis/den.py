"""Запуск «Дня» из установки без компиляции (python/python.exe den.py …) — то же, что den-server.exe и python -m server.run.

  den.py open   для значка на рабочем столе: сервер уже работает — только открыть «День» в браузере;
                иначе запустить сервер и открыть браузер, когда он ответит
"""
import sys
import threading
import time
import urllib.request
import webbrowser

URL = 'http://localhost:8787/'


def alive():
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open('http://127.0.0.1:8787/api/health', timeout=2) as r:
            return r.status == 200
    except OSError:
        return False


def open_when_ready():
    for _ in range(60):
        if alive():
            webbrowser.open(URL)
            return
        time.sleep(1)


if __name__ == '__main__':
    from server.run import main
    if sys.argv[1:] == ['open']:
        if alive():
            webbrowser.open(URL)
            sys.exit(0)
        threading.Thread(target=open_when_ready, daemon=True).start()
        sys.argv = sys.argv[:1]
    main()
