#!/usr/bin/env bash
# Сборка установщика «День» для своего ПК на Linux (без Windows, Nuitka и Inno Setup):
#   bash deploy/windows/nsis/build.sh            →  build/den-setup-<версия>-pc.exe
# Нужны: python3 с pip, makensis (apt install nsis), curl, unzip. Внутрь кладётся Python 3.12 для Windows (NuGet, пакет python)
# и библиотеки сервера (колёса win_amd64 из PyPI) — на ПК ничего скачивать не нужно.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
PY=${PYTHON:-python3}
VER=$("$PY" -c "import json;print(json.load(open('version.json'))['version'])")
STAGE=build/pc-stage
bash deploy/windows/stage.sh "$STAGE"
cp deploy/windows/nsis/setup_den.py deploy/windows/nsis/den-start.cmd "$STAGE/"
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
