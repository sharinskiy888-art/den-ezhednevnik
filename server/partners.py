"""Модуль АК: клиенты CRM — в справочнике ядра partners (/core/v1/partners, событие partner.changed).

Главный список — у ядра; в базе модуля — рабочая копия (таблица crm, kind='clients'): «Клиенты» открываются и правятся
без ядра. Изменения уходят через очередь core_outbox (в той же транзакции, что и сохранение), фоновый поток раз в 2 с
отправляет по порядку. Чужие изменения приходят событием partner.changed и догоняются по курсору при запуске.
Телефоны и прочие поля клиента в журнал не пишутся — только id и код ошибки.
"""
import collections
import datetime as dt
import json
import re
import threading
import time

from . import backup, db, errlog

BOOK = 'partners'
FIELDS = ('name', 'inn', 'phone', 'email', 'contact', 'note')  # что из карточки клиента уходит в ядро
CORE_ID = re.compile(r'^[A-Za-z0-9_.-]{1,64}$')  # id записи ядра (п. 17 ТЗ модуля)
RETRY = (5, 30, 120, 300)  # нет связи, 5xx, 401 (п. 7 общих правил АК): 5 с, 30 с, 2 мин, дальше раз в 5 мин
STALE = 24 * 3600  # не подтверждено сутки — в журнал ошибок и warning в /ak/v1/busy
state = {'resync': True, 'stale': 0}  # resync — полный проход справочника; stale — сколько правок ждут больше суток
events = collections.deque(maxlen=10000)  # partner.changed от ядра: разбирает фоновый поток (своё соединение с базой)
CONFLICTS = 3  # 409 подряд — дальше повтор по RETRY, а не сразу


def log(text):
    print(f'{time.strftime("%Y-%m-%d %H:%M:%S")} Клиенты ↔ АК: {text}', flush=True)


def enqueue(con, ids, fresh=True):
    """Вызывается внутри транзакции сохранения клиентов (crm.write): строка очереди появится вместе с правкой.
    fresh=False (проход справочника) — не ставить, если клиент уже ждёт отправки: иначе отложенный повтор
    (например, после 400) начинался бы заново каждые 10 минут."""
    if not db.AK:
        return
    for i in ids:
        if not CORE_ID.match(i):
            continue
        if not fresh and con.execute('select 1 from core_outbox where book=? and id=?', (BOOK, i)).fetchone():
            continue
        con.execute('insert into core_outbox (book, id, created_at) values (?,?,?)', (BOOK, i, time.time()))


def stamp(value):
    """updatedAt карточки / updated_at ядра → секунды (кто новее — тот побеждает). Не разобралось — 0."""
    try:
        moment = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return (moment if moment.tzinfo else moment.replace(tzinfo=dt.timezone.utc)).timestamp()
    except ValueError:
        return 0.0


def to_core(payload, rev, current=None):
    """Карточка → полная запись ядра (PUT передаёт запись целиком). Удаление — запись ядра как есть плюс deleted:true
    (current — её data): у удалённой карточки полей уже нет, а стирать их в справочнике нельзя."""
    if payload.get('__deleted'):
        body = {k: v for k, v in (current or {}).items() if k not in ('rev', 'deleted', 'id')}
        body.setdefault('name', 'Клиент без названия')
        return {**body, 'rev': rev, 'deleted': True}
    body = {'rev': rev, 'name': str(payload.get('name') or 'Клиент без названия')[:300]}
    for name in FIELDS[1:]:
        if payload.get(name):
            body[name] = str(payload[name])
    return body


def from_core(record, local):
    """Запись ядра → карточка клиента. Свои поля карточки, которых нет в ядре, сохраняются."""
    data = record.get('data') if isinstance(record.get('data'), dict) else record
    now = db.now_iso()
    if record.get('deleted') or data.get('deleted'):
        return {'id': record['id'], '__deleted': True, 'updatedAt': now}
    payload = {k: v for k, v in (local or {}).items() if k not in FIELDS and k != '__deleted'}
    payload.update({'id': record['id'], 'updatedAt': now})
    payload['name'] = str(data.get('name') or 'Клиент без названия')[:300]
    for name in FIELDS[1:]:
        if data.get(name):
            payload[name] = str(data[name])[:2000]
    return payload


def core_rev(con, partner_id):
    row = con.execute('select core_rev from core_links where book=? and id=?', (BOOK, partner_id)).fetchone()
    return row[0] if row else 0


def save_rev(con, partner_id, rev):
    con.execute('insert into core_links values (?,?,?) on conflict (book, id) do update set core_rev=excluded.core_rev',
                (BOOK, partner_id, int(rev)))


def apply(con, record):
    """Изменение из ядра → рабочая копия. Своя неотправленная правка важнее: она уйдёт в ядро следующей."""
    pid = str(record.get('id') or '')
    if not CORE_ID.match(pid):
        return False
    rev = int(record.get('rev') or 0)
    with db.tx(con):
        if con.execute('select 1 from core_outbox where book=? and id=?', (BOOK, pid)).fetchone():
            return False
        if rev <= core_rev(con, pid) and con.execute("select 1 from crm where kind='clients' and id=?", (pid,)).fetchone():
            return False
        row = con.execute("select payload from crm where kind='clients' and id=?", (pid,)).fetchone()
        local = json.loads(row[0]) if row else None
        if record.get('deleted') and not local:
            save_rev(con, pid, rev)
            return False
        payload = from_core(record, local)
        text = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        con.execute("insert into crm (kind, id, payload, updated_at, pu, ref) values ('clients',?,?,?,?,null) on conflict (kind, id) do update "
                    'set payload=excluded.payload, updated_at=excluded.updated_at, pu=excluded.pu', (pid, text, payload['updatedAt'], payload['updatedAt']))
        save_rev(con, pid, rev)
    return True


def fetch_one(pid):
    from . import ak
    return ak.core('GET', f'/core/v1/{BOOK}/{pid}')


def on_event(data):
    """partner.changed от ядра: только в очередь — запрос ядра и запись в базу делает фоновый поток."""
    if isinstance(data, dict):
        events.append(data)


def take_event(con, data):
    """partner.changed: {id, rev, deleted}. Если rev новее известного — взять запись целиком. Ядро недоступно — догоним позже."""
    from . import ak
    pid = str(data.get('id') or '')
    try:
        rev = int(data.get('rev') or 0)
    except (TypeError, ValueError):
        return
    if not CORE_ID.match(pid) or rev <= core_rev(con, pid):
        return
    try:
        record = fetch_one(pid)
    except ak.CoreError as e:
        if e.status == 404:
            return
        state['resync'] = True
        return
    if record:
        apply(con, record)


def resync(con):
    """Полный проход справочника с cursor=0 (при запуске и после восстановления ядра): чужие изменения — к себе,
    свои клиенты, которых в ядре нет или ядро «отстало» (rev меньше нашего), — в очередь на отправку."""
    from . import ak
    seen, cursor = set(), '0'
    for _ in range(1000):
        page = ak.core('GET', f'/core/v1/{BOOK}?cursor={cursor}&limit=500') or {}
        items = page.get('items') if isinstance(page, dict) else page
        for record in items or []:
            pid = str(record.get('id') or '')
            seen.add(pid)
            if int(record.get('rev') or 0) < core_rev(con, pid):  # ядро восстановили из копии
                with db.tx(con):
                    save_rev(con, pid, int(record.get('rev') or 0))
                    enqueue(con, [pid], fresh=False)
            else:
                apply(con, record)
        nxt = str(page.get('next_cursor') or '') if isinstance(page, dict) else ''
        if not items or not nxt or nxt == cursor or (isinstance(page, dict) and page.get('more') is False):
            break
        cursor = nxt
    waiting = {r[0] for r in con.execute('select id from core_outbox where book=?', (BOOK,))}
    missing = [r[0] for r in con.execute("select id, payload from crm where kind='clients'")
               if r[0] not in seen and r[0] not in waiting and not json.loads(r[1]).get('__deleted')]
    if missing:
        with db.tx(con):
            for pid in missing:
                save_rev(con, pid, 0)
            enqueue(con, missing, fresh=False)
        log(f'в АК-Сервер отправляются клиенты, которых там нет: {len(missing)}')


def push(con):
    """Одна строка очереди (по порядку). True — есть ещё работа сейчас."""
    from . import ak
    row = con.execute('select seq, id, attempts from core_outbox where book=? and next_at<=? order by seq limit 1', (BOOK, time.time())).fetchone()
    if not row:
        return False
    seq, pid, attempts = row
    last = con.execute('select max(seq) from core_outbox where book=? and id=?', (BOOK, pid)).fetchone()[0]
    local = con.execute("select payload from crm where kind='clients' and id=?", (pid,)).fetchone()
    if not local:
        with db.tx(con):
            con.execute('delete from core_outbox where book=? and id=? and seq<=?', (BOOK, pid, last))
        return True
    payload = json.loads(local[0])
    rev = core_rev(con, pid)
    if payload.get('__deleted') and not rev:  # в ядре его и не было
        with db.tx(con):
            con.execute('delete from core_outbox where book=? and id=? and seq<=?', (BOOK, pid, last))
        return True
    try:
        current = None
        if payload.get('__deleted'):  # удаление: поля записи ядра остаются, добавляется deleted:true
            record = fetch_one(pid) or {}
            current = record.get('data') if isinstance(record.get('data'), dict) else record
        answer = ak.core('PUT', f'/core/v1/{BOOK}/{pid}', to_core(payload, rev, current)) or {}
    except ak.CoreError as e:
        if e.status == 404 and payload.get('__deleted'):  # удалять нечего
            with db.tx(con):
                con.execute('delete from core_outbox where book=? and id=? and seq<=?', (BOOK, pid, last))
            return True
        if e.status == 409 and attempts < CONFLICTS:  # запись в ядре уже изменили: кто новее — тот побеждает
            try:
                record = fetch_one(pid) or {}
            except ak.CoreError:
                record = None
            if record:
                with db.tx(con):
                    con.execute('update core_outbox set attempts=attempts+1 where seq=?', (seq,))
                    if stamp(record.get('updated_at')) > stamp(payload.get('updatedAt')):  # в ядре новее: правка уступает
                        con.execute('delete from core_outbox where book=? and id=? and seq<=?', (BOOK, pid, last))
                        save_rev(con, pid, 0)
                if stamp(record.get('updated_at')) > stamp(payload.get('updatedAt')):
                    apply(con, record)
                else:
                    with db.tx(con):
                        save_rev(con, pid, int(record.get('rev') or 0))
                return True
        with db.tx(con):
            delay = 3600 if e.status == 400 else RETRY[min(attempts, len(RETRY) - 1)]
            con.execute('update core_outbox set attempts=attempts+1, next_at=?, last_error=? where seq=?',
                        (time.time() + delay, f'{e.status} {e.code}', seq))
        if e.status == 400:  # данные не приняты: в журнал и владельцу; строку не удалять
            errlog.write('error', f'Клиенты ↔ АК: клиент {pid} не принят справочником партнёров ({e.code})')
            try:
                ak.core('POST', '/core/v1/notify', {'text': f'«День»: клиент не принят справочником партнёров ({e.code}). '
                                                            f'Откройте его в «Клиентах» и проверьте название.', 'level': 'error'})
            except ak.CoreError:
                pass
        elif attempts == 0:
            log(f'АК-Сервер не принял изменения клиентов ({e.status} {e.code}), повтор позже')
        return False
    with db.tx(con):
        save_rev(con, pid, int(answer.get('rev') or rev + 1))
        con.execute('delete from core_outbox where book=? and id=? and seq<=?', (BOOK, pid, last))
    return True


def check_stale(con):
    """Раз в 10 минут: правки клиентов, которые ядро не подтверждает больше суток — warning и одна запись в журнал."""
    count = con.execute('select count(distinct id) from core_outbox where book=? and created_at<?', (BOOK, time.time() - STALE)).fetchone()[0]
    if count and not state['stale']:
        errlog.write('warning', f'Клиенты ↔ АК: АК-Сервер больше суток не подтверждает изменения клиентов ({count})')
    state['stale'] = count


def start(stop: threading.Event):
    """Фоновый поток: раз в 2 с отправка очереди; при запуске и раз в 10 минут — проход справочника."""
    if not db.AK:
        return

    def loop():
        con = db.connect()  # своё соединение: поток не мешает запросам
        last_resync = last_stale = 0.0
        while not stop.is_set():
            # копия и восстановление (backup._lock) не идут одновременно с обменом: номера очереди после
            # восстановления — уже другие, а копия должна быть целой
            if not backup._lock.acquire(timeout=1):
                continue
            try:
                if time.time() - last_stale > 600:  # до прохода справочника: при выключенном ядре он падает
                    last_stale = time.time()
                    check_stale(con)
                while events and not stop.is_set():
                    take_event(con, events.popleft())
                if state['resync'] or time.time() - last_resync > 600:
                    state['resync'] = False
                    last_resync = time.time()
                    resync(con)
                for _ in range(5):  # потом отпустить замок: копия не должна ждать долго
                    if stop.is_set() or not push(con):
                        break
            except Exception as e:  # ядро недоступно и т. п. — следующий круг
                code = getattr(e, 'code', '') or type(e).__name__
                if code != 'unreachable':
                    errlog.write('error', f'Клиенты ↔ АК: ошибка обмена ({code})')
                state['resync'] = state['resync'] or code == 'unreachable'
                backup._lock.release()
                stop.wait(10)
                continue
            backup._lock.release()
            stop.wait(2)
        con.close()
    threading.Thread(target=loop, name='partners', daemon=True).start()
