#!/usr/bin/env bash
# Папка программы «День» для Windows, собранная на Linux: Python 3.12 для Windows (NuGet, пакет python, без тестов,
# IDLE, tkinter и pip) + библиотеки сервера (колёса win_amd64 из PyPI) + сервер и экраны + den.py.
# Компилятор и Windows не нужны; на целевом компьютере ничего не скачивается.
#   bash deploy/windows/stage.sh <папка>        (PYTHON= — python3 с pip для скачивания колёс)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
PY=${PYTHON:-python3}
PYVER=3.12.7
STAGE=$1
CACHE=build/win-cache
rm -rf "$STAGE" && mkdir -p "$STAGE" "$CACHE"
[ -s "$CACHE/python-$PYVER.nupkg" ] || curl -fsSL -o "$CACHE/python-$PYVER.nupkg" "https://api.nuget.org/v3-flatcontainer/python/$PYVER/python.$PYVER.nupkg"
rm -rf "$CACHE/nupkg" && mkdir "$CACHE/nupkg" && unzip -q "$CACHE/python-$PYVER.nupkg" 'tools/*' -d "$CACHE/nupkg"
cp -r "$CACHE/nupkg/tools" "$STAGE/python"
( cd "$STAGE/python" && rm -rf include libs Lib/test Lib/idlelib Lib/tkinter Lib/turtledemo Lib/ensurepip Lib/lib2to3 Lib/pydoc_data \
    Lib/site-packages/pip* DLLs/_tkinter.pyd DLLs/tcl*.dll DLLs/tk*.dll tcl && find . -name __pycache__ -prune -exec rm -rf {} + )
"$PY" -m pip install -q --disable-pip-version-check --target "$STAGE/python/Lib/site-packages" --platform win_amd64 \
  --python-version 3.12 --implementation cp --only-binary=:all: -r server/requirements.txt
rm -rf "$STAGE/python/Lib/site-packages/bin"
find "$STAGE/python" -name __pycache__ -prune -exec rm -rf {} +
mkdir "$STAGE/server"
cp server/*.py "$STAGE/server/"
for f in index.html app.js crm.js sync.js sync-config.js i18n-en.js styles.css sw.js version.js version.json manifest.webmanifest manifest-worker.webmanifest install.html qr-iphone.svg; do
  [ -f "$f" ] && cp "$f" "$STAGE/"
done
cp -r assets "$STAGE/"
cp deploy/windows/nsis/den.py "$STAGE/"
