#!/usr/bin/env bash
# Откат на предыдущую версию сервера «День» (данные не трогаются: база только дополняется, старая версия её понимает).
#   sudo bash deploy/linux/rollback.sh            — на версию, установленную перед текущей
#   sudo bash deploy/linux/rollback.sh --list     — какие версии есть
# Вернуть и сами данные к копии: sudo bash deploy/linux/admin.sh restore <копия> (сервер остановится и запустится сам)
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }
CUR="$(readlink -f /opt/den/current)"
# Папки версий: <версия>-<ГГГГММДДччммсс>; порядок — по времени установки из имени, а не по дате изменения папки.
stamp() { echo "${1##*-}"; }
mapfile -t ALL < <(for d in /opt/den/releases/*/; do d="${d%/}"; echo "$(stamp "$d") $d"; done | sort | cut -d' ' -f2-)
if [ "${1:-}" = "--list" ]; then for d in "${ALL[@]}"; do [ "$d" = "$CUR" ] && echo "$d ← сейчас" || echo "$d"; done; exit 0; fi
TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  for d in "${ALL[@]}"; do [[ "$(stamp "$d")" < "$(stamp "$CUR")" ]] && TARGET="$d"; done
fi
[ -n "$TARGET" ] && [ -d "$TARGET" ] || { echo "Нет более ранней версии (список: --list)"; exit 1; }
ln -sfn "$TARGET" /opt/den/current.new && mv -Tf /opt/den/current.new /opt/den/current
systemctl restart den.service
PORT="$(sed -n 's/^DEN_PORT=//p' /etc/den/den.env | head -1)"; PORT="${PORT:-8787}"
for i in $(seq 1 40); do curl -fs "http://127.0.0.1:$PORT/api/health" && { echo; echo "Откат на $TARGET выполнен"; exit 0; }; sleep 0.5; done
echo "Сервер не отвечает: journalctl -u den -n 50"; exit 1
