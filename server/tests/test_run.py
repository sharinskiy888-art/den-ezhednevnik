"""Этап 6: запуск одной командой (как у службы и den-server.exe), den.env для установщика, возврат из копии."""
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request

import pytest

from conftest import ROOT, SECRET, free_port

pytestmark = pytest.mark.etap6


def run(*args, env=None, cwd=ROOT):
    base = {'PATH': os.environ.get('PATH', ''), 'SYSTEMROOT': os.environ.get('SYSTEMROOT', '')}
    return subprocess.run([sys.executable, '-m', 'server.run', *args], cwd=cwd, env={**base, **(env or {})},
                          capture_output=True, text=True, timeout=60)


def test_version_and_admin_passthrough(tmp_path):
    env = {'DEN_SECRET': SECRET, 'DEN_DATA_DIR': str(tmp_path)}
    assert run('version', env=env).stdout.strip() == __import__('json').load(open(ROOT / 'version.json'))['version']
    assert run('admin', 'add', 'a@den.test', 'pass-12345', 'admin', env=env).returncode == 0
    assert 'a@den.test' in run('admin', 'users', env=env).stdout
    assert run('лишнее', env=env).returncode != 0


def test_no_secret_no_start(tmp_path):
    out = run('version', env={'DEN_DATA_DIR': str(tmp_path), 'DEN_ENV_FILE': str(tmp_path / 'нет.env')})
    assert out.returncode != 0 and 'DEN_SECRET' in out.stderr


def test_serves_on_port_and_lock(tmp_path):
    port = free_port()
    env = {**os.environ, 'DEN_SECRET': SECRET, 'DEN_DATA_DIR': str(tmp_path), 'DEN_PORT': str(port)}
    proc = subprocess.Popen([sys.executable, '-m', 'server.run'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            try:
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(f'http://127.0.0.1:{port}/api/health', timeout=2) as r:
                    assert r.status == 200
                    break
            except OSError:
                time.sleep(0.1)
        else:
            pytest.fail('сервер не ответил')
        restore = run('admin', 'restore', 'den-x.db', env={'DEN_SECRET': SECRET, 'DEN_DATA_DIR': str(tmp_path)})
        assert restore.returncode != 0
        busy = run('admin', 'backup', env={'DEN_SECRET': SECRET, 'DEN_DATA_DIR': str(tmp_path)})
        assert busy.returncode == 0  # копию можно сделать и на ходу
        name = sorted(p.name for p in (tmp_path / 'backups').glob('den-*.db'))[-1]
        restore = run('admin', 'restore', name, env={'DEN_SECRET': SECRET, 'DEN_DATA_DIR': str(tmp_path)})
        assert restore.returncode != 0 and 'остановите сервер' in restore.stderr  # при работающем сервере — нельзя
    finally:
        proc.terminate()
        proc.wait(10)


def test_restore_brings_back_db_and_files(tmp_path):
    env = {'DEN_SECRET': SECRET, 'DEN_DATA_DIR': str(tmp_path)}
    run('admin', 'add', 'a@den.test', 'pass-12345', env=env)
    (tmp_path / 'files' / 'shared' / 't1').mkdir(parents=True)
    (tmp_path / 'files' / 'shared' / 't1' / 'x.jpg').write_bytes(b'jpeg')
    assert run('admin', 'backup', env=env).returncode == 0
    name = next((tmp_path / 'backups').glob('den-*.db')).name
    run('admin', 'add', 'b@den.test', 'pass-12345', env=env)
    (tmp_path / 'files' / 'shared' / 't1' / 'x.jpg').unlink()
    out = run('admin', 'restore', name, env=env)
    assert out.returncode == 0, out.stderr
    con = sqlite3.connect(tmp_path / 'den.db')
    assert [r[0] for r in con.execute('select email from users')] == ['a@den.test']
    con.close()
    assert (tmp_path / 'files' / 'shared' / 't1' / 'x.jpg').read_bytes() == b'jpeg'
    assert len(list((tmp_path / 'backups').glob('den-*.db'))) == 2  # состояние до отката тоже сохранено
    assert run('admin', 'restore', '../den.db', env=env).returncode != 0


def test_init_env_for_installer(tmp_path):
    # den.env создаётся рядом с программой (sys.argv[0]); проверяем через копию пакета в отдельной папке
    import shutil
    app = tmp_path / 'app'
    shutil.copytree(ROOT / 'server', app / 'server', ignore=shutil.ignore_patterns('tests', '__pycache__'))
    shutil.copy(ROOT / 'version.json', app)
    (app / 'den_server.py').write_text('from server.run import main\nmain()\n', encoding='utf-8')
    base = {'PATH': os.environ.get('PATH', ''), 'SYSTEMROOT': os.environ.get('SYSTEMROOT', '')}
    go = lambda *a: subprocess.run([sys.executable, str(app / 'den_server.py'), *a], cwd=tmp_path, env=base, capture_output=True, text=True, timeout=60)
    assert go('init-env', str(tmp_path / 'data')).returncode == 0
    text = (app / 'den.env').read_text(encoding='utf-8')
    secret = [line for line in text.splitlines() if line.startswith('DEN_SECRET=')][0][11:]
    assert len(secret) >= 48 and f'DEN_DATA_DIR={tmp_path / "data"}' in text
    assert go('init-env', str(tmp_path / 'other')).returncode == 0 and (app / 'den.env').read_text(encoding='utf-8') == text  # не перезаписан
    assert go('version').returncode == 0  # сервер находит den.env рядом с программой
