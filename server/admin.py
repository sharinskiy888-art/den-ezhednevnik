"""Команды администратора для компьютера с сервером: python -m server.admin <команда>.

Работают с базой напрямую (сервер при этом может быть запущен). Ответы — простым текстом по-русски.
"""
import hashlib
import re
import secrets
import sys
import time

from . import auth, backup, db, migration

HELP = """Команды:
  users                         список пользователей
  add <email> <пароль> [admin] [--id <id>]  добавить пользователя (--id — прежний id из Supabase,
                                тогда данные на его телефоне подхватятся без переноса ключей)
  invite <email>                код приглашения (действует 7 дней)
  password <email> <пароль>     задать новый пароль (все входы этого человека закроются)
  delete <email>                удалить пользователя и его личные данные
  feedback                      сообщения обратной связи
  backup                        сделать копию базы сейчас
  crm <email> manager|worker|none   доступ к разделу «Клиенты»: руководитель, монтажник или нет
  reconcile                     сверка переноса: записи на устройствах и на сервере по каждому человеку"""


def find(con, email):
    row = con.execute('select id, email, role from users where email=?', (email.strip().lower(),)).fetchone()
    if not row:
        sys.exit(f'Нет пользователя {email}')
    return row


def main(argv):
    if not argv or argv[0] in ('-h', '--help', 'help'):
        print(HELP)
        return
    cmd, args = argv[0], argv[1:]
    db.DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = db.connect()
    db.migrate(con)
    try:
        if cmd == 'users':
            for r in con.execute('select email, role, created_at from users order by created_at'):
                print(f"{r['email']:<40} {r['role']:<6} с {r['created_at'][:10]}")
        elif cmd == 'add' and len(args) >= 2:
            user_id = None
            if '--id' in args:
                at = args.index('--id')
                if at + 1 >= len(args) or not args[at + 1].strip():
                    sys.exit('После --id укажите id')
                user_id, args = args[at + 1].strip(), args[:at] + args[at + 2:]
                if not re.fullmatch(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', user_id):
                    sys.exit('id должен быть как в Supabase: 8-4-4-4-12 шестнадцатеричных знаков')
                user_id = user_id.lower()
            if len(args) not in (2, 3) or args[2:] not in ([], ['admin']):
                print(HELP)
                sys.exit(2)
            with db.tx(con):
                u = auth.create_user(con, auth.norm_email(args[0]), auth.hash_password(auth.check_new_password(args[1])),
                                     'admin' if args[2:] == ['admin'] else 'user', user_id)
            print(f"Добавлен {u['email']} ({u['role']})")
        elif cmd == 'invite' and len(args) == 1:
            email, code = auth.norm_email(args[0]), secrets.token_urlsafe(12)
            with db.tx(con):
                con.execute('insert into invites (code_hash, email, role, expires_at) values (?,?,?,?)',
                            (hashlib.sha256(code.encode()).hexdigest(), email, 'user', time.time() + 7 * 24 * 3600))
            print(f'Код приглашения для {email}: {code}\nЧеловек вводит его в окне входа в поле «Код приглашения» и жмёт «Регистрация».')
        elif cmd == 'password' and len(args) == 2:
            u = find(con, args[0])
            with db.tx(con):
                con.execute('update users set password_hash=? where id=?', (auth.hash_password(auth.check_new_password(args[1])), u['id']))
                auth.revoke_user_sessions(con, u['id'])
            print(f"Новый пароль для {u['email']} задан. Передайте его человеку лично.")
        elif cmd == 'delete' and len(args) == 1:
            u = find(con, args[0])
            auth.delete_account(con, u['id'])
            print(f"Удалён {u['email']}")
        elif cmd == 'crm' and len(args) == 2 and args[1] in ('manager', 'worker', 'none'):
            u = find(con, args[0])
            with db.tx(con):
                con.execute('update users set crm_role=? where id=?', ('' if args[1] == 'none' else args[1], u['id']))
            print(f"{u['email']}: раздел «Клиенты» — {({'manager': 'руководитель', 'worker': 'монтажник', 'none': 'нет доступа'})[args[1]]}")
        elif cmd == 'reconcile':
            names = {'tasks': 'задач', 'plans': 'планов', 'expenses': 'операций', 'incomeKop': 'доходы, коп.', 'expenseKop': 'расходы, коп.'}
            for r in migration.reconcile_rows(con):
                s = r['server']
                print(f"{r['email']}: {r['status'].upper()}\n  сервер: " + ', '.join(f"{names[k]} {s[k]}" for k in names)
                      + f", своих поручений {s['sharedOwned']}")
                for d in r['devices']:
                    rep = d['report']
                    print(f"  {d['label'] or 'устройство'} ({d['at'][:16].replace('T', ' ')}): {'совпадает' if d['ok'] else 'РАСХОЖДЕНИЕ'} — "
                          + ', '.join(f"{names[k]} {rep[k]}" for k in names))
                    sb = rep.get('supabase')
                    if sb:
                        print('    из Supabase: ' + ', '.join(f'{k} {v}' for k, v in sb.items()))
        elif cmd == 'feedback':
            for r in con.execute('select text, email, photo is not null as has_photo, created_at from feedback order by id desc limit 50'):
                print(f"— {r['created_at']} от {r['email'] or 'без email'}{' (с фото)' if r['has_photo'] else ''}\n{r['text']}\n")
        elif cmd == 'backup':
            name, size = backup.make_backup()
            print(f'Копия: {db.BACKUP_DIR / name} ({size // 1024} КБ)')
        else:
            print(HELP)
            sys.exit(2)
    except auth.ApiError as error:
        sys.exit(error.message)
    finally:
        con.close()


if __name__ == '__main__':
    main(sys.argv[1:])
