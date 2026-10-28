"""Заглушка ядра АК-Сервера для тестов (только стандартная библиотека), по тексту ТЗ модуля.

- /m/<код>/… — передаёт запрос модулю с подписью, как ядро: пользователь берётся из заголовков X-Test-User,
  X-Test-Roles, X-Test-Name (их ставит тест или Playwright); в HTML перед </body> вставляет кнопку «АК».
- /core/v1/users/{uuid}, /core/v1/employees[/{uuid}] — сотрудники; подпись модуля проверяется, итог — в checked.

Отдельно: python server/tests/ak_core.py <порт ядра> <порт модуля> <секрет hex> [код]
"""
import datetime
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

LOCK = threading.Lock()
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


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class Core:
    def __init__(self, secret_hex, module_port, code='crm', employees=None):
        self.secret, self.code, self.module_port = bytes.fromhex(secret_hex), code, module_port
        self.employees = employees or {}  # uuid -> {"id","name","email",…}
        self.checked = []  # (путь, подпись верна)
        self.down = False
        self.reject = set()  # id, на которые справочник отвечает 400
        self.partners, self.seq, self.notices = {}, 0, []  # справочник partners: id -> {id, rev, deleted, updated_at, data, seq}
        handler = type('H', (Handler,), {'core': self})
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        self.port = self.http.server_address[1]
        self.url = f'http://127.0.0.1:{self.port}'

    def change_partner(self, pid, deleted=False, **data):
        """Изменение клиента «в другой программе»: rev + 1. Возвращает тело события partner.changed."""
        with LOCK:
            old = self.partners.get(pid)
            self.seq += 1
            rec = {'id': pid, 'rev': (old['rev'] if old else 0) + 1, 'deleted': deleted, 'updated_at': now_iso(),
                   'data': {**(old['data'] if old else {}), **data}, 'seq': self.seq}
            self.partners[pid] = rec
        return {'id': pid, 'rev': rec['rev'], 'deleted': deleted}

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
        for name in ('Content-Type', 'Authorization', 'X-Den-User', 'X-Den-Epoch'):
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
        record = lambda e: {'id': e['id'], 'rev': 1, 'deleted': bool(e.get('deleted')), 'updated_at': '2026-10-28T00:00:00Z',
                            'data': {k: v for k, v in e.items() if k not in ('id', 'deleted')}}
        if parts[2:3] == ['users'] and len(parts) == 4:  # {"uuid","login","name","roles","active"}
            e = core.employees.get(parts[3])
            return self._send(200, {'uuid': e['id'], 'login': e.get('email', ''), 'name': e.get('name', ''), 'roles': [],
                                    'active': not e.get('deleted')}) if e else self._send(404, {'error': {'code': 'not_found', 'message': 'нет'}})
        if parts[2:3] == ['employees'] and len(parts) == 4:
            e = core.employees.get(parts[3])
            return self._send(200, record(e)) if e else self._send(404, {'error': {'code': 'not_found', 'message': 'нет'}})
        if parts[2:3] == ['partners']:
            return self._partners(parts, path, body)
        if parts[2:] == ['notify'] and self.command == 'POST':
            core.notices.append(json.loads(body))
            return self._send(200, {'ok': True})
        if parts[2:] == ['employees']:  # {"items":[{id,rev,deleted,updated_at,data}],"next_cursor","more"}
            q = urllib.parse.parse_qs(path.query)
            items = sorted(core.employees.values(), key=lambda e: e['id'])
            start = int((q.get('cursor') or ['0'])[0] or 0)
            page = items[start:start + 2]  # по 2 — чтобы проверить переход по курсору
            more = start + 2 < len(items)
            return self._send(200, {'items': [record(e) for e in page], 'next_cursor': str(start + 2), 'more': more})
        self._send(404, {'error': {'code': 'not_found', 'message': 'нет'}})


    def _partners(self, parts, path, body):
        """Справочник partners по ТЗ: PUT — запись целиком с rev (0 — создать), 409 при чужом rev, 400 без name."""
        core, out = self.core, lambda r: {k: v for k, v in r.items() if k != 'seq'}
        if len(parts) == 3 and self.command == 'GET':
            q = urllib.parse.parse_qs(path.query)
            cursor, limit = int((q.get('cursor') or ['0'])[0] or 0), int((q.get('limit') or ['500'])[0])
            rows = sorted((r for r in core.partners.values() if r['seq'] > cursor), key=lambda r: r['seq'])
            page = rows[:min(limit, 2)]  # по 2 — чтобы проверить курсор
            return self._send(200, {'items': [out(r) for r in page], 'next_cursor': str(page[-1]['seq'] if page else cursor),
                                    'more': len(rows) > len(page)})
        if len(parts) != 4:
            return self._send(404, {'error': {'code': 'not_found', 'message': 'нет'}})
        pid, rec = parts[3], core.partners.get(parts[3])
        if self.command == 'GET':
            return self._send(200, out(rec)) if rec else self._send(404, {'error': {'code': 'not_found', 'message': 'нет'}})
        if self.command != 'PUT':
            return self._send(405, {'error': {'code': 'method', 'message': 'нет'}})
        data = json.loads(body)
        if data.get('rev') != (rec['rev'] if rec else 0):
            return self._send(409, {'error': {'code': 'conflict', 'message': 'rev'}})
        if not data.get('name') or pid in core.reject:
            return self._send(400, {'error': {'code': 'bad_field', 'message': 'name'}})
        with LOCK:
            core.seq += 1
            new = {'id': pid, 'rev': data['rev'] + 1, 'deleted': bool(data.get('deleted')), 'updated_at': now_iso(),
                   'data': {k: v for k, v in data.items() if k not in ('rev', 'deleted')}, 'seq': core.seq}
            core.partners[pid] = new
        self._send(200, {'id': pid, 'rev': new['rev'], 'updated_at': new['updated_at']})


if __name__ == '__main__':
    port, module_port, secret = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    code = sys.argv[4] if len(sys.argv) > 4 else 'crm'
    employees = json.loads(sys.argv[5]) if len(sys.argv) > 5 else {}
    core = Core(secret, module_port, code, employees)
    core.http.server_close()
    core.http = ThreadingHTTPServer(('127.0.0.1', port), type('H', (Handler,), {'core': core}))
    print(f'ядро-заглушка: http://127.0.0.1:{port}/m/{code}/', flush=True)
    core.http.serve_forever()
