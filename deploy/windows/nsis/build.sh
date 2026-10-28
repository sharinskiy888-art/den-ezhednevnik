#!/usr/bin/env bash
# Сборка установщика «День» для своего ПК на Linux (без Windows, Nuitka и Inno Setup):
#   bash deploy/windows/nsis/build.sh            →  build/den-setup-<версия>-pc.exe
# Нужны: python3 с pip, makensis (apt install nsis), curl, unzip. Внутрь кладётся Python 3.12 для Windows (NuGet, пакет python)
# и библиотеки сервера (колёса win_amd64 из PyPI) — на ПК ничего скачивать не нужно.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
PY=${PYTHON:-python3}
PYVER=3.12.7
VER=$("$PY" -c "import json;print(json.load(open('version.json'))['version'])")
STAGE=build/pc-stage
CACHE=build/pc-cache
rm -rf "$STAGE" && mkdir -p "$STAGE" "$CACHE"

# 1. Python для Windows (полный, из NuGet) — без тестов, IDLE, tkinter, pip
[ -s "$CACHE/python-$PYVER.nupkg" ] || curl -fsSL -o "$CACHE/python-$PYVER.nupkg" "https://api.nuget.org/v3-flatcontainer/python/$PYVER/python.$PYVER.nupkg"
rm -rf "$CACHE/nupkg" && mkdir "$CACHE/nupkg" && unzip -q "$CACHE/python-$PYVER.nupkg" 'tools/*' -d "$CACHE/nupkg"
cp -r "$CACHE/nupkg/tools" "$STAGE/python"
( cd "$STAGE/python" && rm -rf include libs Lib/test Lib/idlelib Lib/tkinter Lib/turtledemo Lib/ensurepip Lib/lib2to3 Lib/pydoc_data \
    Lib/site-packages/pip* DLLs/_tkinter.pyd DLLs/tcl*.dll DLLs/tk*.dll tcl && find . -name __pycache__ -prune -exec rm -rf {} + )

# 2. Библиотеки сервера — колёса для Windows x64, Python 3.12
"$PY" -m pip install -q --disable-pip-version-check --target "$STAGE/python/Lib/site-packages" --platform win_amd64 \
  --python-version 3.12 --implementation cp --only-binary=:all: -r server/requirements.txt
rm -rf "$STAGE/python/Lib/site-packages/bin"

# 3. Сервер и экраны (без тестов), запуск и помощник установщика
mkdir "$STAGE/server"
cp server/*.py "$STAGE/server/"
for f in index.html app.js crm.js sync.js sync-config.js i18n-en.js styles.css sw.js version.js version.json manifest.webmanifest install.html qr-iphone.svg; do
  [ -f "$f" ] && cp "$f" "$STAGE/"
done
cp -r assets "$STAGE/"
cp deploy/windows/nsis/den.py deploy/windows/nsis/setup_den.py deploy/windows/nsis/den-start.cmd "$STAGE/"
# значок: ICO с PNG внутри (так умеют Windows Vista и новее)
"$PY" - "$STAGE/den.ico" <<'EOF'
import struct, sys
png = open('assets/icon-192.png', 'rb').read()
w, h = struct.unpack('>II', png[16:24])
open(sys.argv[1], 'wb').write(struct.pack('<HHH', 0, 1, 1) + struct.pack('<BBBBHHII', w % 256, h % 256, 0, 0, 1, 32, len(png), 22) + png)
EOF

# 4. Установщик
makensis -V2 -INPUTCHARSET UTF8 -DVERSION="$VER" -DSTAGE="$ROOT/$STAGE" -DOUTDIR="$ROOT/build" deploy/windows/nsis/den.nsi
ls -l "build/den-setup-$VER-pc.exe"
