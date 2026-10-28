#!/usr/bin/env bash
# Архив сервера «День» для установки без GitHub и без интернета для библиотек Python:
# код, экраны, скрипты установки и готовые библиотеки (wheels) для Ubuntu 22.04 / 24.04, x86_64 и ARM.
#   bash deploy/linux/make_release.sh            → build/den-server-<версия>.tar.gz
# На VPS: scp архив → tar xzf den-server-N.tar.gz → cd den-server-N → sudo bash deploy/linux/install.sh ...
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/version.json")"
NAME="den-server-$VERSION"
OUT="$ROOT/build/$NAME"
rm -rf "$OUT"; mkdir -p "$OUT/wheels"
cp -r "$ROOT/server" "$ROOT/deploy" "$OUT/"
rm -rf "$OUT/server/tests" "$OUT/server/__pycache__" "$OUT/deploy/windows"
for f in index.html app.js crm.js sync.js sync-config.js i18n-en.js styles.css sw.js version.js version.json manifest.webmanifest install.html qr-iphone.svg CHANGELOG.md; do
  [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$OUT/"
done
cp -r "$ROOT/assets" "$OUT/"
# Python 3.10 — Ubuntu 22.04, 3.12 — Ubuntu 24.04; x86_64 и aarch64 (ARM-серверы). Только готовые пакеты, без сборки.
for py in 3.10 3.12; do
  for arch in x86_64 aarch64; do
    python3 -m pip download -q --disable-pip-version-check --only-binary=:all: --python-version "$py" \
      --platform "manylinux2014_$arch" --platform "manylinux_2_17_$arch" -d "$OUT/wheels" -r "$ROOT/server/requirements.txt"
  done
done
tar -C "$ROOT/build" -czf "$ROOT/build/$NAME.tar.gz" "$NAME"
echo "$ROOT/build/$NAME.tar.gz"
