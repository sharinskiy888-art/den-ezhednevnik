#!/usr/bin/env bash
# Обновление сервера «День»: новая версия ставится рядом, перед переключением — копия базы, после — проверка.
# Если новая версия не отвечает, сервер сам возвращается на прежнюю.   sudo bash deploy/linux/update.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
RESTART=1; [ "${1:-}" = "--no-restart" ] && RESTART=0
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$SRC/version.json")"
REL="/opt/den/releases/$VERSION-$(date +%Y%m%d%H%M%S)"
PREV="$(readlink -f /opt/den/current 2>/dev/null || true)"
PORT="$(sed -n 's/^DEN_PORT=//p' /etc/den/den.env 2>/dev/null | head -1)"; PORT="${PORT:-8787}"
run_as_den() { runuser -u den -- env DEN_ENV_FILE=/etc/den/den.env "$@"; }

echo "Версия $VERSION → $REL"
install -d -m 755 "$REL"
cp -r "$SRC/server" "$REL/"
rm -rf "$REL/server/tests" "$REL/server/__pycache__"
for f in index.html app.js crm.js sync.js sync-config.js i18n-en.js styles.css sw.js version.js version.json manifest.webmanifest install.html qr-iphone.svg; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$REL/"
done
[ -d "$SRC/assets" ] && cp -r "$SRC/assets" "$REL/"
python3 -m venv "$REL/venv"
if [ -d "$SRC/wheels" ]; then  # архив make_release.sh: библиотеки уже внутри, интернет и PyPI не нужны
  "$REL/venv/bin/pip" install -q --disable-pip-version-check --no-index --find-links "$SRC/wheels" -r "$SRC/server/requirements.txt"
else
  "$REL/venv/bin/pip" install -q --disable-pip-version-check -r "$SRC/server/requirements.txt"
fi

if [ -n "$PREV" ] && [ -d "$PREV" ] && [ -f /var/lib/den/den.db ]; then
  echo "Копия базы перед обновлением"
  (cd "$PREV" && run_as_den "$PREV/venv/bin/python" -m server.run admin backup)
fi
ln -sfn "$REL" /opt/den/current.new && mv -Tf /opt/den/current.new /opt/den/current
[ $RESTART = 1 ] || exit 0

systemctl restart den.service
for i in $(seq 1 40); do
  if curl -fs "http://127.0.0.1:$PORT/api/health" | grep -q "\"$VERSION\""; then
    echo "Обновлено до $VERSION"
    ls -1dt /opt/den/releases/* | tail -n +6 | xargs -r rm -rf  # храним 5 последних версий
    exit 0
  fi
  sleep 0.5
done
echo "Новая версия не отвечает — возвращаю прежнюю"
journalctl -u den -n 30 --no-pager || true
if [ -n "$PREV" ]; then
  ln -sfn "$PREV" /opt/den/current.new && mv -Tf /opt/den/current.new /opt/den/current
  systemctl restart den.service
  rm -rf "$REL"  # неработающая версия не должна стать целью отката
  for i in $(seq 1 40); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && { echo "Прежняя версия работает"; exit 1; }; sleep 0.5; done
  echo "Прежняя версия тоже не отвечает: journalctl -u den -n 50"
fi
exit 1
