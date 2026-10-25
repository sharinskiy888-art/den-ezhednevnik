"""Фото и голосовые отчётов: отдаются только участникам своей задачи (раздел 3 ТЗ)."""
import uuid

import pytest

pytestmark = pytest.mark.etap3
JPEG = b'\xff\xd8\xff\xe0' + b'0' * 2000


def upload(server, user, tid, data=JPEG, ext='jpg', ctype='image/jpeg'):
    return server.post(f'/api/files/shared/{tid}?ext={ext}', token=user.token, raw=data, headers={'Content-Type': ctype})


def test_participant_uploads_and_all_participants_read(server, team):
    status, body, _ = upload(server, team['worker'], team['id'])
    assert status == 201 and body['path'].startswith(f"shared/{team['id']}/") and body['path'].endswith('.jpg')
    for who in ('owner', 'worker', 'invited'):
        st, data, _ = server.get(f"/api/files/{body['path']}", team[who].token)
        assert st == 200 and data == JPEG, who


def test_stranger_cannot_read_or_upload(server, team):
    path = upload(server, team['owner'], team['id'])[1]['path']
    assert server.get(f'/api/files/{path}', team['stranger'].token)[0] == 404
    assert server.get(f'/api/files/{path}')[0] == 401
    assert upload(server, team['stranger'], team['id'])[0] == 404


def test_upload_to_unknown_task(server, team):
    assert upload(server, team['owner'], str(uuid.uuid4()))[0] == 404


@pytest.mark.parametrize('ext', ['exe', 'html', 'svg', 'js', '..%2fx', ''])
def test_bad_extension_rejected(server, team, ext):
    assert upload(server, team['owner'], team['id'], ext=ext)[0] == 400


@pytest.mark.parametrize('tail', ['..%2f..%2fden.db', '%2e%2e/%2e%2e/den.db', '..%5c..%5cden.db', '../../den.db', '%2e%2e%2f%2e%2e%2fden.db'])
def test_path_traversal_blocked(server, team, tail):
    """Участник своей задачи пытается выйти из её папки к базе."""
    status, body, _ = server.get(f"/api/files/shared/{team['id']}/{tail}", team['owner'].token)
    leaked = body if isinstance(body, bytes) else str(body or '').encode()
    assert status in (400, 404) and b'SQLite format' not in leaked


def test_too_big_file_rejected(server, team):
    assert upload(server, team['owner'], team['id'], data=b'0' * (21 * 1024 * 1024))[0] in (413, 0)


def test_files_removed_with_task(server, team):
    path = upload(server, team['owner'], team['id'])[1]['path']
    assert (server.data_dir / 'files' / path).exists()
    assert server.delete(f"/api/shared/{team['id']}", team['owner'].token)[0] == 204
    assert not (server.data_dir / 'files' / path).exists()
    assert server.get(f'/api/files/{path}', team['owner'].token)[0] == 404


def test_voice_formats_accepted(server, team):
    for ext, ctype in (('webm', 'audio/webm'), ('m4a', 'audio/mp4'), ('ogg', 'audio/ogg')):
        assert upload(server, team['owner'], team['id'], data=b'voice', ext=ext, ctype=ctype)[0] == 201


def test_owner_puts_file_with_old_name_for_migration(server, team):
    name = f'{uuid.uuid4()}.jpg'
    path = f"/api/files/shared/{team['id']}/{name}"
    status, body, _ = server.put(path, token=team['owner'].token, raw=JPEG, headers={'Content-Type': 'image/jpeg'})
    assert status == 201 and body['path'] == f"shared/{team['id']}/{name}"
    assert server.put(path, token=team['owner'].token, raw=JPEG, headers={'Content-Type': 'image/jpeg'})[0] == 409
    assert server.put(f"/api/files/shared/{team['id']}/x.jpg", token=team['worker'].token, raw=JPEG)[0] == 403
    assert server.put(f"/api/files/shared/{team['id']}/bad%20name.exe", token=team['owner'].token, raw=JPEG)[0] == 400
    assert server.get(f"/api/files/shared/{team['id']}/{name}", team['worker'].token)[1] == JPEG
