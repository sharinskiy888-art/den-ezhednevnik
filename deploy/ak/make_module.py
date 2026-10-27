"""Пакет модуля для АК-Сервера: AK-Crm-Modul-X.Y.Z.zip (module.json и icon.png в корне архива + программа).

  python deploy/ak/make_module.py <папка собранной программы> <куда положить zip>

Папка программы — сборка Nuitka (build\\den_server.dist после build.ps1): den-server.exe, экраны, version.json.
Только стандартная библиотека Python. Ничего не скачивает.
"""
import json
import struct
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKIP = {'task.ps1', 'den.env', 'den-setup.iss'}  # только для самостоятельной установки; секретов в пакете нет
ROLES = ['owner', 'admin', 'cashier', 'storekeeper', 'courier', 'partner', 'viewer']


def module_json(version):
    return {'id': 'crm', 'name': 'День-CRM', 'version': version, 'protocol': 1, 'min_core': '0.8.8',
            'start': 'den-server.exe', 'args': [], 'start_timeout_sec': 60, 'icon': 'icon.png',
            'subscribes': [], 'emits': [], 'roles': ROLES}


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
    if not (dist / 'den-server.exe').is_file() and not (dist / 'den-server').is_file():
        raise SystemExit(f'В {dist} нет den-server.exe: сначала соберите программу (build.ps1)')
    icon = (ROOT / 'assets' / 'icon-192.png').read_bytes()
    width, height = png_size(icon)
    if width > 256 or height > 256:
        raise SystemExit('Значок больше 256×256')
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f'AK-Crm-Modul-{version}.zip'
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('module.json', json.dumps(module_json(version), ensure_ascii=False, indent=1))
        z.writestr('icon.png', icon)
        changelog = ROOT / 'CHANGELOG.md'
        if changelog.is_file():
            z.write(changelog, 'CHANGELOG.md')
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
