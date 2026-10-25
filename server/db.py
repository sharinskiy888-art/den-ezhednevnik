"""Настройки и база: SQLite в режиме WAL, миграции только добавлением, замок от второго запуска."""
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_env_file():
    """den.env: строки ИМЯ=значение. Переменные окружения важнее файла.

    Ищется: DEN_ENV_FILE, текущая папка, папка программы (у службы Windows текущая папка — System32), корень проекта.
    """
    places = [os.environ.get('DEN_ENV_FILE'), Path.cwd() / 'den.env', Path(sys.argv[0]).resolve().parent / 'den.env', ROOT / 'den.env']
    path = next((Path(p) for p in places if p and Path(p).is_file()), None)
    if not path:
        return
    for line in path.read_text(encoding='utf-8-sig').splitlines():  # utf-8-sig: Блокнот пишет невидимую метку в начало
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            if not os.environ.get(key.strip()):
                os.environ[key.strip()] = value.strip().strip('"').strip("'")


_load_env_file()


def _int(name, default):
    try:
        return int(os.environ.get(name) or default)
    except ValueError:
        raise RuntimeError(f'{name} должно быть числом')


SECRET = os.environ.get('DEN_SECRET') or ''
if len(SECRET) < 32:
    raise RuntimeError('DEN_SECRET не задан или короче 32 символов: впишите длинный случайный секрет в den.env')

DATA_DIR = Path(os.environ.get('DEN_DATA_DIR') or ROOT / 'data').resolve()
FILES_DIR = DATA_DIR / 'files'
BACKUP_DIR = DATA_DIR / 'backups'
DB_PATH = DATA_DIR / 'den.db'
PUBLIC_URL = (os.environ.get('DEN_PUBLIC_URL') or 'http://localhost:8787').rstrip('/')
ALLOWED_ORIGINS = [o.strip().rstrip('/') for o in (os.environ.get('DEN_ALLOWED_ORIGINS') or 'https://sharinskiy888-art.github.io').split(',') if o.strip()]
ACCESS_TTL = _int('DEN_ACCESS_TTL', 3600)
REFRESH_TTL = _int('DEN_REFRESH_TTL', 30 * 24 * 3600)
REFRESH_GRACE = _int('DEN_REFRESH_GRACE', 10)
LOGIN_LIMIT = _int('DEN_LOGIN_LIMIT', 5)
LOGIN_WINDOW = _int('DEN_LOGIN_WINDOW', 60)
FEEDBACK_LIMIT = _int('DEN_FEEDBACK_LIMIT', 5)
FEEDBACK_DAILY = _int('DEN_FEEDBACK_DAILY', 100)
TRUSTED_PROXY = (os.environ.get('DEN_TRUSTED_PROXY') or '').strip()
BACKUP_KEEP = _int('DEN_BACKUP_KEEP', 14)
BACKUP_EVERY = _int('DEN_BACKUP_EVERY', 24 * 3600)
STATIC_DIR = Path(os.environ['DEN_STATIC_DIR']).resolve() if os.environ.get('DEN_STATIC_DIR') else None
ADMIN_EMAIL = (os.environ.get('DEN_ADMIN_EMAIL') or '').strip().lower()
ADMIN_PASSWORD = os.environ.get('DEN_ADMIN_PASSWORD') or ''


def _version():
    try:
        return str(json.loads((ROOT / 'version.json').read_text(encoding='utf-8'))['version'])
    except (OSError, ValueError, KeyError):
        return 'dev'


VERSION = _version()

# Каждая миграция только добавляет таблицы и столбцы: старые копии базы остаются читаемыми.
MIGRATIONS = [
    """
    create table users (id text primary key, email text not null unique, password_hash text not null,
                        role text not null default 'user', created_at text not null);
    create table sessions (id text primary key, user_id text not null references users(id) on delete cascade,
                           counter integer not null default 0, rotated_at real not null default 0,
                           expires_at real not null, revoked integer not null default 0, created_at real not null);
    create index sessions_user on sessions(user_id);
    create table invites (code_hash text primary key, email text not null, role text not null default 'user',
                          expires_at real not null, used_at real);
    create table rows (user_id text not null references users(id) on delete cascade, tbl text not null, id text not null,
                       payload text not null, updated_at text not null, pu text, primary key (user_id, tbl, id));
    create table feedback (id integer primary key autoincrement, text text not null, email text, photo text, created_at text not null);
    """,
    """
    create table shared (id text primary key, owner_id text not null references users(id) on delete cascade,
                         owner_email text not null, invited_emails text not null default '[]',
                         accepted_emails text not null default '[]', leave_requests text not null default '[]',
                         payload text not null, updated_at text not null, pu text);
    create index shared_owner on shared(owner_id);
    create table shared_members (task_id text not null references shared(id) on delete cascade, email text not null,
                                 primary key (task_id, email));
    create index shared_members_email on shared_members(email);
    create table presence (user_id text primary key references users(id) on delete cascade, email text not null,
                           locale text, last_seen text not null);
    """,
    """
    alter table users add column crm_role text not null default '';
    create table crm (kind text not null, id text not null, payload text not null, updated_at text not null, pu text,
                      ref text, primary key (kind, id));
    create index crm_ref on crm(kind, ref);
    create table crm_assignees (order_id text not null, email text not null, primary key (order_id, email));
    create index crm_assignees_email on crm_assignees(email);
    """,
]


def connect(path=DB_PATH):
    con = sqlite3.connect(path, timeout=5, isolation_level=None, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute('pragma journal_mode=wal')
    con.execute('pragma busy_timeout=5000')
    con.execute('pragma foreign_keys=on')
    con.execute('pragma synchronous=full')  # домашний ПК могут выключить из розетки — правка не должна пропасть
    return con


def migrate(con):
    con.execute('create table if not exists meta (key text primary key, value text)')
    row = con.execute("select value from meta where key='schema'").fetchone()
    done = int(row[0]) if row else 0
    for number, sql in enumerate(MIGRATIONS[done:], start=done + 1):
        con.execute('begin immediate')
        try:
            for statement in filter(str.strip, sql.split(';')):
                con.execute(statement)
            con.execute("insert or replace into meta values ('schema', ?)", (str(number),))
            con.execute('commit')
        except Exception:
            con.execute('rollback')
            raise


class tx:
    """with tx(con): ... — запись одним куском: либо всё, либо ничего."""
    def __init__(self, con):
        self.con = con

    def __enter__(self):
        self.con.execute('begin immediate')
        return self.con

    def __exit__(self, exc_type, *_):
        if exc_type:
            self.con.execute('rollback')
            return
        try:
            self.con.execute('commit')
        except Exception:  # например, кончился диск: не оставляем открытую транзакцию на общем подключении
            if self.con.in_transaction:
                self.con.execute('rollback')
            raise


_lock_file = None


def lock_data_dir():
    """Второй сервер на ту же папку данных не запустится: два процесса испортили бы копии и файлы."""
    global _lock_file
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _lock_file = open(DATA_DIR / 'den.lock', 'a+')
    try:
        if sys.platform == 'win32':
            import msvcrt
            msvcrt.locking(_lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(_lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise RuntimeError(f'Папка данных {DATA_DIR} уже занята другим запущенным сервером «День»')


def now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
