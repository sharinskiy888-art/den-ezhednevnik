#!/usr/bin/env bash
# Откат на предыдущую версию сервера «День» (данные не трогаются: база только дополняется, старая версия её понимает).
#   sudo bash deploy/linux/rollback.sh            — на предыдущую версию
#   sudo bash deploy/linux/rollback.sh --list     — какие версии есть
# Вернуть и сами данные к копии: sudo systemctl stop den; затем команда admin restore <копия>; sudo systemctl start den
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }
CUR="$(readlink -f /opt/den/current)"
if [ "${1:-}" = "--list" ]; then ls -1dt /opt/den/releases/* | sed "s|^$CUR\$|& ← сейчас|"; exit 0; fi
TARGET="${1:-$(ls -1dt /opt/den/releases/* | grep -vx "$CUR" | head -1)}"
[ -d "$TARGET" ] || { echo "Нет предыдущей версии"; exit 1; }
ln -sfn "$TARGET" /opt/den/current.new && mv -Tf /opt/den/current.new /opt/den/current
systemctl restart den.service
PORT="$(sed -n 's/^DEN_PORT=//p' /etc/den/den.env | head -1)"; PORT="${PORT:-8787}"
for i in $(seq 1 40); do curl -fs "http://127.0.0.1:$PORT/api/health" && { echo; echo "Откат на $TARGET выполнен"; exit 0; }; sleep 0.5; done
echo "Сервер не отвечает: journalctl -u den -n 50"; exit 1
