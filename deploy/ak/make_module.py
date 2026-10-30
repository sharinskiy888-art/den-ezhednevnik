"""Пакет модуля для АК-Сервера: AK-Crm-Modul-X.Y.Z.zip (module.json и icon.png в корне архива + программа).

  python deploy/ak/make_module.py <папка собранной программы> <куда положить zip>

Папка программы — build/ak-stage после build_module.sh (свой Python + crm.cmd) или сборка Nuitka (build\\den_server.dist после build.ps1).
Только стандартная библиотека Python. Ничего не скачивает.
"""
import json
import struct
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKIP = {'task.ps1', 'den.env', 'den-setup.iss'}  # только для самостоятельной установки; секретов в пакете нет
ABOUT = 'Ежедневник, поручения монтажникам с фото и отчётами, клиенты, объекты, заявки и ТО (CRM)'  # описание на плитке ядра
MIN_FROM = '1.0.106'  # самая ранняя версия модуля у клиентов: пакет ставится поверх неё и любой более новой
ROLES = ['owner', 'admin', 'cashier', 'storekeeper', 'courier', 'partner', 'viewer']


def module_json(version, start='den-server.exe'):
    return {'id': 'crm', 'name': 'День-CRM', 'version': version, 'protocol': 1, 'min_core': '1.0.3',
            'about': ABOUT, 'min_from': MIN_FROM,
            'start': start, 'args': [], 'start_timeout_sec': 120, 'icon': 'icon.png',
            'subscribes': ['partner.changed'], 'emits': [], 'roles': ROLES}


def png_size(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR':
        raise SystemExit('icon.png — не PNG')
    return struct.unpack('>II', data[16:24])


def build(dist, out_dir):
    dist, out_dir = Path(dist).resolve(), Path(out_dir).resolve()
    app = json.loads((dist / 'version.json').read_text(encoding='utf-8'))['version']
    if not str(app).isdigit():
        raise SystemExit(f'Номер версии «{app}» — не число')
    version = f'1.0.{app}'  # АК-Сервер принимает только X.Y.Z; 1.0.103 = сборка «Дня» 103
    # crm.cmd — сборка на Linux со своим Python (build_module.sh); den-server.exe — сборка Nuitka на Windows (build.ps1)
    start = next((n for n in ('crm.cmd', 'den-server.exe', 'den-server') if (dist / n).is_file()), None)
    if not start:
        raise SystemExit(f'В {dist} нет crm.cmd или den-server.exe: сначала соберите программу')
    icon = (ROOT / 'assets' / 'icon-192.png').read_bytes()
    width, height = png_size(icon)
    if width > 256 or height > 256:
        raise SystemExit('Значок больше 256×256')
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f'AK-Crm-Modul-{version}.zip'
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('module.json', json.dumps(module_json(version, 'den-server.exe' if start == 'den-server' else start), ensure_ascii=False, indent=1))
        z.writestr('icon.png', icon)
        changelog = ROOT / 'CHANGELOG.md'
        if changelog.is_file():
            z.write(changelog, 'CHANGELOG.md')
        note = ROOT / 'deploy' / 'ak' / 'ЧТО ВНУТРИ.txt'  # первая строка — 2–4 слова, их покажет ядро в уведомлениях
        if note.is_file():
            z.write(note, 'ЧТО ВНУТРИ.txt')
        for path in sorted(dist.rglob('*')):
            rel = path.relative_to(dist).as_posix()
            if path.is_file() and not path.is_symlink() and rel not in SKIP and rel not in ('module.json', 'icon.png'):
                z.write(path, rel)
    if target.stat().st_size >= 4 * 1024 ** 3:
        raise SystemExit('Пакет больше 4 ГБ')
    print(target)
    return target


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    build(sys.argv[1], sys.argv[2])
