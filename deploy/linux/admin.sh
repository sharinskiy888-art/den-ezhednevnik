#!/usr/bin/env bash
# Команды администратора на VPS:  sudo bash deploy/linux/admin.sh users | add … | reconcile | backups | …
# (полный список — без параметров). Для restore сервер сначала останавливается и потом запускается сам.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }
cd /opt/den/current
run() { runuser -u den -- env DEN_ENV_FILE=/etc/den/den.env /opt/den/current/venv/bin/python -m server.run admin "$@"; }
if [ "${1:-}" = "restore" ]; then systemctl stop den.service; trap 'systemctl start den.service' EXIT; fi
run "$@"
