#!/usr/bin/env bash
# Установка сервера «День» на VPS (Ubuntu 22.04+/Debian 12+): служба systemd, nginx, HTTPS от Let's Encrypt.
#   sudo bash deploy/linux/install.sh --domain den.example.ru --email you@mail.ru
#   sudo bash deploy/linux/install.sh --no-tls            (проверка без домена: только http://127.0.0.1)
# Запускать из папки с кодом (корень репозитория). Повторный запуск безопасен: секрет и данные не трогаются.
set -euo pipefail
DOMAIN=""; EMAIL=""; TLS=1; PORT=8787
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --no-tls) TLS=0; shift ;;
    *) echo "Неизвестный параметр: $1"; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }
[ $TLS = 0 ] || { [ -n "$DOMAIN" ] && [ -n "$EMAIL" ]; } || { echo "Нужны --domain и --email (или --no-tls для проверки)"; exit 2; }
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$SRC/server/main.py" ] || { echo "Не найден код сервера рядом со скриптом"; exit 1; }

echo "1/6 Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-venv nginx >/dev/null
[ $TLS = 0 ] || apt-get install -y -qq certbot python3-certbot-nginx >/dev/null

echo "2/6 Пользователь и папки"
id den >/dev/null 2>&1 || useradd --system --home /var/lib/den --shell /usr/sbin/nologin den
install -d -o den -g den -m 700 /var/lib/den
install -d -o root -g den -m 750 /etc/den
install -d -m 755 /opt/den/releases

echo "3/6 Настройки (/etc/den/den.env)"
if [ ! -f /etc/den/den.env ]; then
  SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
  ORIGINS="https://sharinskiy888-art.github.io"; [ -n "$DOMAIN" ] && ORIGINS="$ORIGINS,https://$DOMAIN"
  cat > /etc/den/den.env <<CONF
# Секреты и настройки сервера «День». Не копировать в архивы и чаты.
DEN_SECRET=$SECRET
DEN_DATA_DIR=/var/lib/den
DEN_HOST=127.0.0.1
DEN_PORT=$PORT
DEN_TRUSTED_PROXY=127.0.0.1
DEN_ALLOWED_ORIGINS=$ORIGINS
DEN_PUBLIC_URL=${DOMAIN:+https://$DOMAIN}
CONF
  chown root:den /etc/den/den.env; chmod 640 /etc/den/den.env
fi

echo "4/6 Программа и служба"
bash "$SRC/deploy/linux/update.sh" --no-restart
cat > /etc/systemd/system/den.service <<'UNIT'
[Unit]
Description=Сервер «День»
After=network-online.target
Wants=network-online.target

[Service]
User=den
Group=den
Environment=DEN_ENV_FILE=/etc/den/den.env
Environment=DEN_STATIC_DIR=/opt/den/current
WorkingDirectory=/opt/den/current
ExecStart=/opt/den/current/venv/bin/python -m server.run
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/den

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now den.service >/dev/null
systemctl restart den.service

echo "5/6 nginx"
SERVER_NAME="${DOMAIN:-_}"
cat > /etc/nginx/sites-available/den <<NGINX
server {
    listen 80;
    server_name $SERVER_NAME;
    client_max_body_size 40m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/den /etc/nginx/sites-enabled/den
rm -f /etc/nginx/sites-enabled/default
nginx -t -q && systemctl reload nginx
if [ $TLS = 1 ]; then
  certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive --redirect
  systemctl enable --now certbot.timer >/dev/null 2>&1 || true  # сертификат продлевается сам
fi

echo "6/6 Проверка"
for i in $(seq 1 40); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.5; done
curl -fs "http://127.0.0.1:$PORT/api/health" || { echo "Сервер не отвечает: journalctl -u den -n 50"; exit 1; }
echo
echo "Готово. Первый администратор:  sudo bash deploy/linux/admin.sh add <email> <пароль> admin"
[ $TLS = 1 ] && echo "Адрес: https://$DOMAIN"
