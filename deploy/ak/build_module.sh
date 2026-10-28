#!/usr/bin/env bash
# Пакет модуля для АК-Сервера, собранный на Linux (без Windows, Nuitka и GitHub):
#   bash deploy/ak/build_module.sh        →  build/ak/AK-Crm-Modul-1.0.<версия>.zip
# Внутри: свой Python 3.12 для Windows, библиотеки, сервер, экраны и crm.cmd (его запускает ядро, п. 2 ТЗ модуля).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
PY=${PYTHON:-python3}
STAGE=build/ak-stage
bash deploy/windows/stage.sh "$STAGE"
# -E: не брать PYTHON* из окружения сервера, -s: без пользовательских библиотек, -B: не писать .pyc в папку программы
printf '@echo off\r\ncd /d "%%~dp0"\r\n"%%~dp0python\\python.exe" -E -s -B "%%~dp0den.py" %%*\r\n' > "$STAGE/crm.cmd"
"$PY" deploy/ak/make_module.py "$STAGE" build/ak
