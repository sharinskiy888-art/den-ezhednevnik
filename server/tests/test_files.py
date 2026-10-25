"""Фото и голосовые отчётов: отдаются только участникам своей задачи (раздел 3 ТЗ)."""
import uuid

import pytest

from test_shared import new_task

pytestmark = pytest.mark.etap3
JPEG = b'\xff\xd8\xff\xe0' + b'0' * 2000


@pytest.fixture
def setup(server, make_user):
    owner, worker, stranger = make_user(), make_user(), make_user()
    t = new_task(owner, [worker.email])
    server.post('/api/shared', t, owner.token)
    server.post(f"/api/shared/{t['id']}/answer", {'accept': True}, worker.token)
    return owner, worker, stranger, t['id']


def upload(server, user, tid, data=JPEG, ext='jpg', ctype='image/jpeg'):
    return server.post(f'/api/files/shared/{tid}?ext={ext}', token=user.token, raw=data, headers={'Content-Type': ctype})


def test_participant_uploads_and_all_participants_read(server, setup):
    owner, worker, _, tid = setup
    status, body, _ = upload(server, worker, tid)
    assert status in (200, 201) and body['path'].startswith(f'shared/{tid}/') and body['path'].endswith('.jpg')
    for u in (owner, worker):
        st, data, _ = server.get(f"/api/files/{body['path']}", u.token)
        assert st == 200 and data == JPEG


def test_stranger_cannot_read_or_upload(server, setup):
    owner, _, stranger, tid = setup
    path = upload(server, owner, tid)[1]['path']
    assert server.get(f'/api/files/{path}', stranger.token)[0] == 404
    assert server.get(f'/api/files/{path}')[0] == 401
    assert upload(server, stranger, tid)[0] in (403, 404)


def test_upload_to_unknown_task(server, setup):
    owner = setup[0]
    assert upload(server, owner, str(uuid.uuid4()))[0] in (403, 404)


@pytest.mark.parametrize('ext', ['exe', 'html', 'svg', 'js', '../x'])
def test_bad_extension_rejected(server, setup, ext):
    owner, _, _, tid = setup
    assert upload(server, owner, tid, ext=ext)[0] == 400


@pytest.mark.parametrize('path', ['shared/../den.db', 'shared/%2e%2e/den.db', '..%2fden.db', 'shared/x/..%2f..%2fden.db'])
def test_path_traversal_blocked(server, setup, path):
    owner = setup[0]
    status, body, _ = server.get(f'/api/files/{path}', owner.token)
    assert status in (400, 404) and not (isinstance(body, bytes) and body.startswith(b'SQLite'))


def test_too_big_file_rejected(server, setup):
    owner, _, _, tid = setup
    assert upload(server, owner, tid, data=b'0' * (21 * 1024 * 1024))[0] == 413


def test_files_removed_with_task(server, setup):
    owner, _, _, tid = setup
    path = upload(server, owner, tid)[1]['path']
    server.delete(f'/api/shared/{tid}', owner.token)
    assert not (server.data_dir / 'files' / path).exists()


def test_voice_formats_accepted(server, setup):
    owner, _, _, tid = setup
    for ext, ctype in (('webm', 'audio/webm'), ('m4a', 'audio/mp4'), ('ogg', 'audio/ogg')):
        assert upload(server, owner, tid, data=b'voice', ext=ext, ctype=ctype)[0] in (200, 201)
