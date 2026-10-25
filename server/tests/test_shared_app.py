"""Поручения: те же правки, что делает настоящий app.js (чтобы правила прав не сломали работу исполнителя)."""
import copy
import os
import subprocess
import sys

import pytest

from conftest import ADMIN_EMAIL, ADMIN_PASSWORD, ROOT, T0, new_task
from test_shared import T1, get, owner_set, worker_patch

pytestmark = pytest.mark.etap3


def test_worker_accepts_like_app(server, make_user):
    """acceptSharedInvite: ответ, затем статус «Принял» с statusBy/statusAt и запись в историю."""
    o, w = make_user(), make_user()
    t = new_task(o, [w.email])
    assert server.post('/api/shared', t, o.token)[0] == 201
    assert server.post(f"/api/shared/{t['id']}/answer", {'accept': True}, w.token)[0] == 204
    team = {'id': t['id'], 'owner': o, 'worker': w}
    def ch(p):
        p.update(status='accepted', statusBy=w.email, statusAt=T1)
        p['activity'] = (p['activity'] + [{'type': 'accepted', 'email': w.email, 'at': T1}])[-30:]
    assert worker_patch(server, team, ch) == 204


def test_worker_reopens_after_owner_completed_with_status_by(server, team):
    """Организатор завершил (statusBy = он), исполнитель снимает галочку: statusBy остаётся прежним — это не подмена."""
    o = team['owner'].email
    owner_set(server, team, lambda p: p.update(status='completed', completed=True, statusBy=o, statusAt=T0))
    def ch(p):
        p.update(status='open', completed=False)
        p['activity'].append({'type': 'reopened', 'email': team['worker'].email, 'at': T1})
    assert worker_patch(server, team, ch) == 204


def test_worker_cannot_set_status_in_someone_elses_name(server, team):
    assert worker_patch(server, team, lambda p: p.update(status='open', statusBy=team['owner'].email)) == 403


def test_worker_unticks_owner_subtask(server, team):
    o = team['owner'].email
    owner_set(server, team, lambda p: p['subtasks'][0].update(done=True, doneBy=o, doneAt=T0))
    assert worker_patch(server, team, lambda p: p['subtasks'][0].update(done=False, doneBy='', doneAt='')) == 204
    assert worker_patch(server, team, lambda p: p['subtasks'][1].update(done=True, doneBy=o, doneAt=T1)) == 403


def test_old_task_without_reports_and_activity(server, make_user):
    """Старые задачи (до отчётов) не имеют полей reports/activity — исполнитель всё равно может отчитаться."""
    o, w = make_user(), make_user()
    t = new_task(o, [w.email])
    for key in ('reports', 'activity'):
        t['payload'].pop(key)
    assert server.post('/api/shared', t, o.token)[0] == 201
    assert server.post(f"/api/shared/{t['id']}/answer", {'accept': True}, w.token)[0] == 204
    team = {'id': t['id'], 'owner': o, 'worker': w}
    def ch(p):
        p['reports'] = [{'id': 'r1', 'by': w.email, 'at': T1, 'text': 'готово'}]
        p['activity'] = [{'type': 'report', 'email': w.email, 'at': T1}]
    assert worker_patch(server, team, ch) == 204


def test_worker_report_with_photo_from_this_task_only(server, team):
    w = team['worker'].email
    status, body, _ = server.post(f"/api/files/shared/{team['id']}?ext=jpg", token=team['worker'].token, raw=b'\xff\xd8\xff' + b'1' * 100,
                                  headers={'Content-Type': 'image/jpeg'})
    assert status == 201
    assert worker_patch(server, team, lambda p: p['reports'].append({'id': 'r1', 'by': w, 'at': T1, 'text': '', 'photo': body['path']})) == 204
    other = 'shared/00000000-0000-4000-8000-000000000000/x.jpg'
    assert worker_patch(server, team, lambda p: p['reports'].append({'id': 'r2', 'by': w, 'at': T1, 'photo': other})) == 403


def test_worker_deletes_own_report_between_others(server, team):
    o, w = team['owner'].email, team['worker'].email
    owner_set(server, team, lambda p: p.update(reports=[{'id': 'a', 'by': o, 'at': T0}, {'id': 'b', 'by': w, 'at': T0}, {'id': 'c', 'by': o, 'at': T0}]))
    assert worker_patch(server, team, lambda p: p.update(reports=[r for r in p['reports'] if r['id'] != 'b'])) == 204
    assert [r['id'] for r in get(server, team)['payload']['reports']] == ['a', 'c']


def test_worker_cannot_edit_old_report_text(server, team):
    w = team['worker'].email
    assert worker_patch(server, team, lambda p: p['reports'].append({'id': 'r1', 'by': w, 'at': T0, 'text': 'было'})) == 204
    def ch(p): p['reports'][0]['text'] = 'стало'
    assert worker_patch(server, team, ch) == 403  # правка отчёта = удалить и добавить новый


def test_owner_removing_worker_clears_leave_request(server, team):
    w = team['worker']
    assert server.post(f"/api/shared/{team['id']}/leave", token=w.token)[0] == 204
    row = get(server, team)
    body = {'accepted_emails': [e for e in row['accepted_emails'] if e != w.email], 'updated_at': row['updated_at']}
    assert server.patch(f"/api/shared/{team['id']}", body, team['owner'].token)[0] == 204
    assert get(server, team)['leave_requests'] == []


def test_owner_cannot_add_leave_request_for_someone(server, team):
    row = get(server, team)
    assert server.patch(f"/api/shared/{team['id']}", {'leave_requests': [team['worker'].email]}, team['owner'].token)[0] == 403


def test_answer_and_leave_keep_payload_untouched(server, team):
    before = get(server, team)
    assert server.post(f"/api/shared/{team['id']}/leave", token=team['worker'].token)[0] == 204
    assert server.post(f"/api/shared/{team['id']}/answer", {'accept': True}, team['invited'].token)[0] == 204
    after = get(server, team)
    assert after['payload'] == before['payload'] and after['updated_at'] == before['updated_at']
    assert team['invited'].email in after['accepted_emails'] and team['invited'].email not in after['invited_emails']


def test_bad_task_id_rejected(server, make_user):
    o = make_user()
    t = new_task(o)
    t['id'] = '../x'
    assert server.post('/api/shared', t, o.token)[0] == 400


def test_heads_change_when_someone_accepts(server, team):
    """sync.js узнаёт об ответе приглашённого по списку участников в «шапке»."""
    head = lambda: next(h for h in server.get('/api/shared/heads', team['owner'].token)[1] if h['id'] == team['id'])
    before = head()
    assert server.post(f"/api/shared/{team['id']}/answer", {'accept': True}, team['invited'].token)[0] == 204
    assert head()['accepted_emails'] != before['accepted_emails']
    assert server.post(f"/api/shared/{team['id']}/leave", token=team['worker'].token)[0] == 204
    assert head()['leave_requests'] == [team['worker'].email]  # и о просьбе выйти — тоже


def test_admin_delete_user_removes_owned_tasks_and_files(fresh_server):
    api = fresh_server()
    admin = api.login(ADMIN_EMAIL, ADMIN_PASSWORD)['access_token']
    status, user, _ = api.post('/api/admin/users', {'email': 'gone@den.test', 'password': 'gone-pass-1'}, admin)
    assert status == 201
    token = api.login('gone@den.test', 'gone-pass-1')['access_token']
    class U: pass
    u = U(); u.id, u.email, u.token = user['id'], 'gone@den.test', token
    t = new_task(u)
    assert api.post('/api/shared', t, token)[0] == 201
    assert api.post(f"/api/files/shared/{t['id']}?ext=jpg", token=token, raw=b'x' * 10, headers={'Content-Type': 'image/jpeg'})[0] == 201
    folder = api.data_dir / 'files' / 'shared' / t['id']
    assert folder.exists()
    assert api.delete(f"/api/admin/users/{user['id']}", admin)[0] == 204
    assert not folder.exists()


def test_rate_limiter_cleanup_with_many_addresses():
    """Очистка памяти лимитера при 10 000+ адресах не падает (раньше там была необъявленная переменная)."""
    code = ('from server.access import RateLimiter\n'
            'r = RateLimiter(5, 60)\n'
            'for i in range(10002):\n'
            '    s = r.hit(f"ip:{i}")\n'
            'r.undo(s, "ip:1")\nprint("ok")')
    env = {**os.environ, 'DEN_SECRET': 'unit-' + 'u' * 40}
    p = subprocess.run([sys.executable, '-c', code], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
    assert p.stdout.strip() == 'ok', p.stderr[-500:]


def test_nan_and_infinity_rejected(server, team):
    """NaN/Infinity браузер не прочитает — такая запись сломала бы загрузку поручений у всех участников."""
    import json as _json
    cur = get(server, team, 'worker')
    cur['payload']['subtasks'][0]['doneAt'] = None
    raw = _json.dumps({'payload': cur['payload'], 'updated_at': T1}).replace('"doneAt": null', '"doneAt": NaN')
    status = server.patch(f"/api/shared/{team['id']}", token=team['worker'].token, raw=raw.encode(), headers={'Content-Type': 'application/json'})[0]
    assert status == 400
    assert server.post('/api/data/tasks', token=team['worker'].token, raw=b'[{"id":"x","payload":{"a":Infinity},"updated_at":"t"}]',
                       headers={'Content-Type': 'application/json'})[0] == 400


@pytest.mark.parametrize('bad_id', [['x'], {'a': 1}, 5])
def test_report_id_must_be_text(server, team, bad_id):
    w = team['worker'].email
    assert worker_patch(server, team, lambda p: p['reports'].append({'id': bad_id, 'by': w, 'at': T1})) == 400


@pytest.mark.parametrize('payload', ['x', None, [1]])
def test_owner_payload_must_be_object(server, team, payload):
    assert server.patch(f"/api/shared/{team['id']}", {'payload': payload}, team['owner'].token)[0] == 400


def test_report_media_path_strict(server, team):
    w = team['worker'].email
    for path in (f"shared/{team['id']}/../../../auth/me", f"shared/{team['id']}/a/b.jpg", f"shared/{team['id']}/x.exe"):
        assert worker_patch(server, team, lambda p: p['reports'].append({'id': 'r1', 'by': w, 'at': T1, 'photo': path})) == 403, path


def test_worker_cannot_tick_in_someone_elses_name(server, team):
    o = team['owner'].email
    owner_set(server, team, lambda p: p['subtasks'][0].update(done=True, doneBy=o, doneAt=T0))
    assert worker_patch(server, team, lambda p: p['subtasks'][0].update(done=False)) == 204  # снять можно, имя остаётся
    assert worker_patch(server, team, lambda p: p['subtasks'][0].update(done=True, doneAt=T1)) == 403


def test_invited_cannot_upload_until_accepted(server, team):
    status = server.post(f"/api/files/shared/{team['id']}?ext=jpg", token=team['invited'].token, raw=b'x' * 10, headers={'Content-Type': 'image/jpeg'})[0]
    assert status == 403


def test_presence_hides_people_who_only_got_invited(server, team):
    assert server.post('/api/presence', {'locale': 'ru'}, team['invited'].token)[0] == 204
    assert team['invited'].email not in {r['email'] for r in server.get('/api/presence', team['owner'].token)[1]}


def test_worker_cannot_flood_reports(server, team):
    w = team['worker'].email
    assert worker_patch(server, team, lambda p: p.update(reports=[{'id': f'f{i}', 'by': w, 'at': T1} for i in range(51)])) == 400


def test_aac_voice_accepted(server, team):
    assert server.post(f"/api/files/shared/{team['id']}?ext=aac", token=team['worker'].token, raw=b'voice', headers={'Content-Type': 'audio/aac'})[0] == 201


def test_deleted_account_email_loses_access(fresh_server):
    api = fresh_server()
    admin = api.login(ADMIN_EMAIL, ADMIN_PASSWORD)['access_token']
    ids = {}
    for e in ('boss@den.test', 'mont@den.test'):
        ids[e] = api.post('/api/admin/users', {'email': e, 'password': 'pass-12345'}, admin)[1]['id']
    class U: pass
    boss = U(); boss.id, boss.email = ids['boss@den.test'], 'boss@den.test'
    boss_token = api.login('boss@den.test', 'pass-12345')['access_token']
    t = new_task(boss, ['mont@den.test'])
    assert api.post('/api/shared', t, boss_token)[0] == 201
    mont = api.login('mont@den.test', 'pass-12345')['access_token']
    assert api.post(f"/api/shared/{t['id']}/answer", {'accept': True}, mont)[0] == 204
    assert api.delete(f"/api/admin/users/{ids['mont@den.test']}", admin)[0] == 204
    assert 'mont@den.test' not in api.get(f"/api/shared/{t['id']}", boss_token)[1]['accepted_emails']
    api.post('/api/admin/users', {'email': 'mont@den.test', 'password': 'pass-12345'}, admin)
    again = api.login('mont@den.test', 'pass-12345')['access_token']
    assert api.get(f"/api/shared/{t['id']}", again)[0] == 404
