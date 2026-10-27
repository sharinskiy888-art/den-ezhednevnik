"""Заглушка ядра АК-Сервера для тестов (только стандартная библиотека), по тексту ТЗ модуля.

- /m/<код>/… — передаёт запрос модулю с подписью, как ядро: пользователь берётся из заголовков X-Test-User,
  X-Test-Roles, X-Test-Name (их ставит тест или Playwright); в HTML перед </body> вставляет кнопку «АК».
- /core/v1/users/{uuid}, /core/v1/employees[/{uuid}] — сотрудники; подпись модуля проверяется, итог — в checked.

Отдельно: python server/tests/ak_core.py <порт ядра> <порт модуля> <секрет hex> [код]
"""
import hashlib
import hmac
import json
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
AK_BUTTON = '<script id="ak-button">/* кнопка АК */</script>'


def sign_string(frm, to, method, uri, body, ts, nonce, user, org, roles, user_name):
    return '|'.join(['v1', frm, to, method, uri, hashlib.sha256(body).hexdigest(), ts, nonce, user, org, roles, user_name])


def sign(secret, *parts):
    return hmac.new(secret, sign_string(*parts).encode(), hashlib.sha256).hexdigest()


def signed_headers(secret, code, method, uri, body=b'', user='', roles='', name='', org='org-1', ts=None, nonce=None):
    """Заголовки, которые ядро добавляет к запросу модулю. name — уже в url-кодировке."""
    ts = str(int(time.time())) if ts is None else ts
    nonce = nonce or secrets.token_hex(16)
    h = {'X-AK-From': 'core', 'X-AK-Time': ts, 'X-AK-Nonce': nonce,
         'X-AK-Sign': sign(secret, 'core', code, method, uri, body, ts, nonce, user, org if user else '', roles, name)}
    if user:
        h.update({'X-AK-User': user, 'X-AK-Org': org, 'X-AK-Roles': roles, 'X-AK-User-Name': name})
    return h


class Core:
    def __init__(self, secret_hex, module_port, code='crm', employees=None):
        self.secret, self.code, self.module_port = bytes.fromhex(secret_hex), code, module_port
        self.employees = employees or {}  # uuid -> {"id","name","email",…}
        self.checked = []  # (путь, подпись верна)
        self.down = False
        handler = type('H', (Handler,), {'core': self})
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        self.port = self.http.server_address[1]
        self.url = f'http://127.0.0.1:{self.port}'

    def start(self):
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        return self

    def stop(self):
        self.http.shutdown()


class Handler(BaseHTTPRequestHandler):
    core: Core

    def log_message(self, *args):
        pass

    def _send(self, status, body, ctype='application/json', headers=()):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        return self.rfile.read(int(self.headers.get('Content-Length') or 0))

    def _any(self):
        core, body = self.core, self._body()
        if self.path.startswith(f'/m/{core.code}'):
            return self._proxy(body)
        if self.path.startswith('/core/v1/'):
            return self._core_api(body)
        self._send(404, {'error': {'code': 'not_found', 'message': 'нет'}})

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = _any

    def _proxy(self, body):
        core = self.core
        # Кто вошёл: заголовки X-Test-* (тесты) или cookie ak_core_test=<uuid>|<роли> (браузер: её шлёт и service worker).
        cookie = dict(c.strip().split('=', 1) for c in (self.headers.get('Cookie') or '').split(';') if '=' in c)
        user, roles = self.headers.get('X-Test-User', ''), self.headers.get('X-Test-Roles', '')
        if not user and cookie.get('ak_core_test'):
            user, _, roles = urllib.parse.unquote(cookie['ak_core_test']).partition('|')
        h = signed_headers(core.secret, core.code, self.command, self.path, body, user, roles,
                           self.headers.get('X-Test-Name', ''))  # имя уже в url-кодировке, как у ядра
        for name in ('Content-Type', 'Authorization', 'X-Den-User'):
            if self.headers.get(name):
                h[name] = self.headers[name]
        req = urllib.request.Request(f'http://127.0.0.1:{core.module_port}{self.path}', data=body or None,
                                     method=self.command, headers=h)
        try:
            with OPENER.open(req, timeout=60) as r:
                status, data, rh = r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            status, data, rh = e.code, e.read(), e.headers
        except (urllib.error.URLError, OSError):
            return self._send(502, {'error': {'code': 'module_down', 'message': 'модуль не отвечает'}})
        ctype = rh.get('Content-Type', 'application/octet-stream')
        if ctype.startswith('text/html') and data.rstrip().endswith(b'</html>') and b'</body>' in data:
            i = data.rfind(b'</body>')
            data = data[:i] + AK_BUTTON.encode() + data[i:]
        keep = [(k, v) for k, v in rh.items() if k.lower() in ('location', 'cache-control', 'retry-after')]
        self._send(status, data, ctype, keep)

    def _core_api(self, body):
        core = self.core
        if core.down:
            self.connection.close()
            return
        h = self.headers
        ok = h.get('X-AK-From') == core.code and hmac.compare_digest(
            sign(core.secret, h.get('X-AK-From', ''), 'core', self.command, self.path, body, h.get('X-AK-Time', ''),
                 h.get('X-AK-Nonce', ''), h.get('X-AK-User', ''), '', '', ''), h.get('X-AK-Sign', ''))
        core.checked.append((self.path, ok))
        if not ok:
            return self._send(401, {'error': {'code': 'bad_sign', 'message': 'подпись'}})
        path = urllib.parse.urlsplit(self.path)
        parts = path.path.strip('/').split('/')
        if parts[2:3] in (['users'], ['employees']) and len(parts) == 4:
            e = core.employees.get(parts[3])
            return self._send(200, e) if e else self._send(404, {'error': {'code': 'not_found', 'message': 'нет'}})
        if parts[2:] == ['employees']:
            q = urllib.parse.parse_qs(path.query)
            items = sorted(core.employees.values(), key=lambda e: e['id'])
            start = int((q.get('cursor') or ['0'])[0] or 0)
            page = items[start:start + 2]  # по 2 — чтобы проверить переход по курсору
            nxt = str(start + 2) if start + 2 < len(items) else ''
            return self._send(200, {'items': page, 'next_cursor': nxt})
        self._send(404, {'error': {'code': 'not_found', 'message': 'нет'}})


if __name__ == '__main__':
    port, module_port, secret = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    code = sys.argv[4] if len(sys.argv) > 4 else 'crm'
    employees = json.loads(sys.argv[5]) if len(sys.argv) > 5 else {}
    core = Core(secret, module_port, code, employees)
    core.http.server_close()
    core.http = ThreadingHTTPServer(('127.0.0.1', port), type('H', (Handler,), {'core': core}))
    print(f'ядро-заглушка: http://127.0.0.1:{port}/m/{code}/', flush=True)
    core.http.serve_forever()
