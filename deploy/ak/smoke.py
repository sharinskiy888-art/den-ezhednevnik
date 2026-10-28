"""Проверка готового пакета так, как его запускает АК-Сервер: распаковать, запустить start из module.json с AK_*,
дождаться /healthz, проверить подпись, страницу через ядро-заглушку, копию и остановку.

  python deploy/ak/smoke.py AK-Crm-Modul-X.Y.Z.zip <пустая рабочая папка>
"""
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'server' / 'tests'))
from ak_core import Core, signed_headers  # noqa: E402

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http(url, method='GET', body=None, headers=None):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with OPENER.open(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def main(package, work):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # консоль Windows в CI — cp1252
    work = Path(work).resolve()
    program, data, logs = work / 'program', work / 'data', work / 'logs'
    with zipfile.ZipFile(package) as z:
        z.extractall(program)
    meta = json.loads((program / 'module.json').read_text(encoding='utf-8'))
    assert meta['id'] == 'crm' and meta['protocol'] == 1 and len(meta['version'].split('.')) == 3, meta
    assert (program / meta['icon']).is_file() and (program / meta['start']).is_file(), meta
    if os.name != 'nt':
        os.chmod(program / meta['start'], 0o755)  # zip не хранит право на запуск (на Windows не нужно)
    secret, port, boss = secrets.token_hex(32), free_port(), str(uuid.uuid4())
    core = Core(secret, port, employees={boss: {'id': boss, 'name': 'Владелец', 'email': 'owner@firma.ru'}}).start()
    env = {k: v for k, v in os.environ.items() if not k.startswith(('DEN_', 'AK_'))}
    tmp = data / 'tmp'
    tmp.mkdir(parents=True)
    logs.mkdir()
    env.update({'AK_MODULE_ID': 'crm', 'AK_MODULE_VERSION': meta['version'], 'AK_MODULE_SECRET': secret, 'AK_HOST': '127.0.0.1',
                'AK_PORT': str(port), 'AK_BASE_PATH': '/m/crm', 'AK_CORE_URL': core.url, 'AK_CORE_VERSION': '1.0.3', 'AK_PROTOCOL': '1',
                'AK_DATA_DIR': str(data), 'AK_LOG_DIR': str(logs), 'TEMP': str(tmp), 'TMP': str(tmp), 'HOME': str(tmp),
                'USERPROFILE': str(tmp), 'APPDATA': str(tmp)})
    before = {p.relative_to(program).as_posix(): p.stat().st_mtime_ns for p in program.rglob('*') if p.is_file()}
    log = open(work / 'module.log', 'wb')
    proc = subprocess.Popen([str(program / meta['start']), *meta['args']], cwd=program, env=env, stdout=log, stderr=subprocess.STDOUT)
    try:
        url = f'http://127.0.0.1:{port}'
        for _ in range(meta['start_timeout_sec'] * 10):
            try:
                status, body = http(url + '/m/crm/healthz')
                if status == 200:
                    break
            except OSError:
                time.sleep(0.1)
        else:
            raise SystemExit('нет ответа /healthz')
        assert json.loads(body)['version'] == meta['version'], body
        assert http(url + '/m/crm/', headers={'X-AK-User': boss, 'X-AK-Roles': 'owner'})[0] == 401, 'без подписи пустил'
        h = signed_headers(bytes.fromhex(secret), 'crm', 'GET', '/m/crm/', b'', boss, 'owner')
        assert http(url + '/m/crm/', headers=h)[0] == 200
        assert http(url + '/m/crm/', headers=h)[0] == 401, 'повтор nonce пустил'
        status, page = http(f'{core.url}/m/crm/', headers={'X-Test-User': boss, 'X-Test-Roles': 'owner'})
        assert status == 200 and b'id="ak-button"' in page, status
        status, me = http(f'{core.url}/m/crm/api/ak/me', headers={'X-Test-User': boss, 'X-Test-Roles': 'owner'})
        assert status == 200 and json.loads(me)['user']['email'] == f'{boss}@ak', me
        status, people = http(f'{core.url}/m/crm/api/ak/employees', headers={'X-Test-User': boss, 'X-Test-Roles': 'owner'})
        assert status == 200 and json.loads(people)[0]['name'] == 'Владелец', people  # подписанный запрос модуля к ядру
        assert core.checked and all(ok for _, ok in core.checked), core.checked
        body = json.dumps({'name': '2026-10-27_1200'}).encode()
        h = signed_headers(bytes.fromhex(secret), 'crm', 'POST', '/m/crm/ak/v1/backup', body)
        assert http(url + '/m/crm/ak/v1/backup', 'POST', body, {**h, 'Content-Type': 'application/json'})[0] == 200
        assert (data / '.backup' / '2026-10-27_1200' / 'den.db').is_file()
        bad_event = b'{"seq":1}'  # модуль пишет в журнал по-русски — не должен падать на кодировке Windows
        h = signed_headers(bytes.fromhex(secret), 'crm', 'POST', '/m/crm/ak/v1/events', bad_event)
        assert http(url + '/m/crm/ak/v1/events', 'POST', bad_event, {**h, 'Content-Type': 'application/json'})[0] == 200
        h = signed_headers(bytes.fromhex(secret), 'crm', 'POST', '/m/crm/ak/v1/stop', b'')
        assert http(url + '/m/crm/ak/v1/stop', 'POST', b'', h)[0] == 200
        assert proc.wait(15) == 0, 'не завершился по /ak/v1/stop'
    finally:
        if proc.poll() is None:
            proc.kill()
        log.close()
        core.stop()
    after = {p.relative_to(program).as_posix(): p.stat().st_mtime_ns for p in program.rglob('*') if p.is_file()}
    assert after == before, 'модуль менял файлы программы: ' + ', '.join(sorted(set(after) ^ set(before)))
    text = (work / 'module.log').read_text(errors='replace')
    assert secret not in text, 'секрет попал в журнал'
    print('Пакет проверен:', meta['version'])


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
