"""Модуль АК: перенос данных прежней установки «Дня» (свой сервер на этом же компьютере) при первом запуске.

Откуда: C:\\Users\\<имя>\\AppData\\Local\\Den\\data (установщик для своего ПК) и C:\\ProgramData\\Den\\data (установщик
с автозапуском); для проверки — DEN_LEGACY_DATA. Берётся самая свежая база. Прежняя папка только читается, ничего в ней
не меняется. Копия базы — через backup API SQLite, фото — обычным копированием, всё — в AK_DATA_DIR.

Люди прежней установки входили по email и паролю; в модуле человек — сотрудник ядра «<uuid>@ak». При первом входе
сотрудника его прежние данные переходят к нему (adopt): по совпадению email с логином или email сотрудника в ядре,
а владельцу (owner) — данные единственного прежнего администратора, если по email никого не нашлось.
"""
import glob
import json
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path

from . import db, errlog


def log(text):
    print(f'{time.strftime("%Y-%m-%d %H:%M:%S")} Перенос прежних данных: {text}', flush=True)


def candidates():
    if os.environ.get('DEN_LEGACY_DATA'):
        places = [os.environ['DEN_LEGACY_DATA']]
    else:
        drive = os.environ.get('SystemDrive', 'C:')
        places = glob.glob(f'{drive}\\Users\\*\\AppData\\Local\\Den\\data') + [os.path.join(os.environ.get('ProgramData', f'{drive}\\ProgramData'), 'Den', 'data')]
    found = []
    for place in places:
        base = Path(place) / 'den.db'
        try:
            if base.is_file() and base.resolve() != db.DB_PATH.resolve():
                found.append((base.stat().st_mtime, Path(place)))
        except OSError:
            continue
    return [p for _, p in sorted(found, reverse=True)]


state = {'wait': ''}  # прежний сервер был запущен: перенос — при следующем запуске модуля (main пишет meta legacy_wait)


def old_server_lock(source):
    """Замок прежнего сервера (его den.lock): пока держим, он не запустится и не допишет базу посреди копии.
    None — прежний сервер сейчас работает. Файла замка нет — прежний сервер не запускался, замок не нужен."""
    path = source / 'den.lock'
    if not path.is_file():
        return open(os.devnull)
    try:
        handle = open(path, 'a+')  # только открыть: содержимое и дата файла не меняются
    except OSError:  # чужая папка без права записи: замок не взять, переносим без него (база копируется целиком)
        return open(os.devnull)
    try:
        if sys.platform == 'win32':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    return handle  # закрытие отпускает замок


def waiting_and_empty():
    """База модуля создана пустой, пока прежний сервер работал (meta legacy_wait), и в ней ещё ничего не завели."""
    try:
        con = sqlite3.connect(f'file:{db.DB_PATH}?mode=ro', uri=True, timeout=5)
        try:
            if not con.execute("select 1 from meta where key='legacy_wait'").fetchone():
                return False
            # клиенты (crm kind='clients') не в счёт: их сразу приносит справочник партнёров ядра
            return not any(con.execute(q).fetchone() for q in ('select 1 from rows limit 1', 'select 1 from shared limit 1',
                                                               "select 1 from crm where kind!='clients' limit 1"))
        finally:
            con.close()
    except sqlite3.Error:
        return False


def import_once():
    """До открытия базы модуля: только если её ещё нет (первый запуск) или она пустая и ждёт переноса."""
    if not db.AK:
        return None
    if db.DB_PATH.exists():
        if not waiting_and_empty():
            return None
        for suffix in ('', '-wal', '-shm'):
            Path(f'{db.DB_PATH}{suffix}').unlink(missing_ok=True)
    for source in candidates():
        target_tmp = db.DATA_DIR / 'den.db.import'
        # SQLite даже в режиме «только чтение» создаёт рядом -shm/-wal, поэтому база (с журналом WAL) сначала
        # копируется во временную папку модуля, и открывается уже копия — прежняя папка остаётся как была.
        copy_dir = db.DATA_DIR / 'legacy-copy'
        files_copied = False
        lock = old_server_lock(source)
        if lock is None:
            state['wait'] = str(source)
            log(f'прежний сервер «День» сейчас запущен ({source}). Закройте его и перезапустите модуль — данные перенесутся тогда')
            continue
        try:
            shutil.rmtree(copy_dir, ignore_errors=True)
            copy_dir.mkdir(parents=True)
            for name in ('den.db', 'den.db-wal'):
                if (source / name).is_file():
                    shutil.copyfile(source / name, copy_dir / name)
            src = sqlite3.connect(copy_dir / 'den.db', timeout=5)
            try:
                tables = {r[0] for r in src.execute("select name from sqlite_master where type='table'")}
                if not {'users', 'rows', 'meta'} <= tables:
                    continue
                dst = sqlite3.connect(target_tmp)
                try:
                    src.backup(dst)
                    if dst.execute('pragma quick_check').fetchone()[0] != 'ok':
                        raise RuntimeError('копия базы не прошла проверку')
                    dst.execute("delete from sessions")  # прежние входы по паролю в модуле не нужны
                    dst.execute("insert or replace into meta values ('legacy_from', ?)", (str(source),))
                    dst.commit()
                finally:
                    dst.close()
            finally:
                src.close()
            if (source / 'files').is_dir():
                files_copied = True
                shutil.copytree(source / 'files', db.FILES_DIR, dirs_exist_ok=True, copy_function=shutil.copyfile)
            target_tmp.rename(db.DB_PATH)
            state['wait'] = ''
            log(f'взяты из {source}')
            return source
        except Exception as e:
            target_tmp.unlink(missing_ok=True)
            if files_copied:  # фото неудачной попытки не остаются (своих фото у новой базы ещё нет)
                shutil.rmtree(db.FILES_DIR, ignore_errors=True)
            state['wait'] = state['wait'] or str(source)  # попробовать ещё раз при следующем запуске, пока база пустая
            log(f'не удалось взять из {source}: {type(e).__name__}')
            errlog.write('warning', f'Перенос прежних данных: не удалось взять из прежней папки «Дня» ({type(e).__name__})')  # путь с именем пользователя — только в module.log
        finally:
            lock.close()
            shutil.rmtree(copy_dir, ignore_errors=True)
    return None


def legacy_users(con):
    return con.execute("select id, email, role from users where email not like '%@ak' and password_hash != '!ak'").fetchall()


def match(con, uid, roles, logins, others=()):
    """Чьи прежние данные отдать сотруднику uid: email = логин/email в ядре; иначе владельцу — единственный прежний админ,
    если его email не принадлежит другому сотруднику ядра (тот получит свои данные сам при входе)."""
    people = legacy_users(con)
    if not people:
        return None
    wanted = {x.strip().lower() for x in logins if x and '@' in x}
    for row in people:
        if row['email'].lower() in wanted:
            return row
    admins = [r for r in people if r['role'] == 'admin']
    if 'owner' in roles and len(admins) == 1 and admins[0]['email'].lower() not in others:
        return admins[0]
    return None


def rename(con, oemail, nemail):
    """Человек с прежним ключом oemail теперь nemail: в поручениях (приглашён, принял, просил выйти, отчёты, подзадачи)
    и в заявках CRM. Только внутри открытой транзакции."""
    qo, qn = f'"{oemail}"', f'"{nemail}"'
    for column in ('invited_emails', 'accepted_emails', 'leave_requests', 'payload'):
        con.execute(f'update shared set {column}=replace({column}, ?, ?) where instr({column}, ?)', (qo, qn, qo))
    # человека уже позвали под новым ключом в ту же задачу: прежняя строка не переименуется (ключ занят) — убрать её
    con.execute('update or ignore shared_members set email=? where email=?', (nemail, oemail))
    con.execute('delete from shared_members where email=?', (oemail,))
    con.execute('update or ignore crm_assignees set email=? where email=?', (nemail, oemail))
    con.execute('delete from crm_assignees where email=?', (oemail,))
    con.execute('update crm set payload=replace(payload, ?, ?) where instr(payload, ?)', (qo, qn, qo))
    for row in con.execute('select id, invited_emails, accepted_emails, leave_requests from shared where instr(invited_emails, ?) '
                           'or instr(accepted_emails, ?) or instr(leave_requests, ?)', (qn, qn, qn)).fetchall():
        lists = [list(dict.fromkeys(json.loads(row[k]))) for k in (1, 2, 3)]  # без повторов, порядок тот же
        accepted = set(lists[1])
        lists[0] = [e for e in lists[0] if e not in accepted]  # уже принял — не висит в приглашённых
        con.execute('update shared set invited_emails=?, accepted_emails=?, leave_requests=? where id=?',
                    (*(json.dumps(x, ensure_ascii=False) for x in lists), row[0]))


def adopt(con, old, uid):
    """Всё прежнего человека — сотруднику uid (в одной транзакции). Его старая запись входа удаляется."""
    oid, oemail, nemail = old['id'], old['email'].lower(), f'{uid}@ak'
    with db.tx(con):
        con.execute("insert or ignore into users (id, email, password_hash, role, created_at) values (?,?,'!ak','user',?)", (uid, nemail, db.now_iso()))
        # у сотрудника уже есть записи с теми же id (телефон успел выгрузить прежние данные): кто новее — тот остаётся
        con.execute('delete from rows where user_id=? and exists (select 1 from rows o where o.user_id=? and o.tbl=rows.tbl '
                    'and o.id=rows.id and o.updated_at > rows.updated_at)', (uid, oid))
        con.execute('update or ignore rows set user_id=? where user_id=?', (uid, oid))
        con.execute('update shared set owner_id=?, owner_email=? where owner_id=?', (uid, nemail, oid))
        rename(con, oemail, nemail)
        con.execute('update or ignore presence set user_id=?, email=? where user_id=?', (uid, nemail, oid))
        con.execute('update or ignore reconcile set user_id=? where user_id=?', (uid, oid))
        con.execute('update imported_shared set owner_id=? where owner_id=?', (uid, oid))
        con.execute('delete from users where id=?', (oid,))
    log(f'данные прежнего пользователя перешли к сотруднику {uid}')


def pending_emails(con):
    """Прежние email, которые ещё ждут своего сотрудника: приглашён или исполнитель, но в «Дне» не регистрировался."""
    found = {r[0].lower() for r in con.execute("select email from shared_members where email not like '%@ak'")}
    found |= {r[0].lower() for r in con.execute("select email from crm_assignees where email not like '%@ak'")}
    return found - {r['email'].lower() for r in legacy_users(con)}


def adopt_invites(con, emails, uid):
    """Приглашения прежней установки на email сотрудника (сам он в прежнем «Дне» не регистрировался) — ему."""
    waiting = pending_emails(con) & {e.strip().lower() for e in emails if e and '@' in e}
    if not waiting:
        return
    with db.tx(con):
        for email in waiting:
            rename(con, email, f'{uid}@ak')
    log(f'приглашения прежней установки перешли к сотруднику {uid}: {len(waiting)}')
