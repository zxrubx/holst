#!/usr/bin/env bash
# Установка доски на чистый Ubuntu 22.04/24.04.
# Использование:  sudo bash deploy/install.sh doska.example.ru
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then echo "Использование: sudo bash deploy/install.sh ваш.домен.ru"; exit 1; fi
if [ "$(id -u)" -ne 0 ]; then echo "Запустите через sudo / от root"; exit 1; fi

APP_DIR=/opt/lesson-board
DATA_DIR=/var/lib/lesson-board
SRC="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3480}"

echo "==> Пакеты"
apt-get update -y
apt-get install -y curl ca-certificates gnupg rsync debian-keyring debian-archive-keyring apt-transport-https

echo "==> Node.js 20"
if ! command -v node >/dev/null || [ "$(node -v | sed 's/v//;s/\..*//')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Caddy (HTTPS-сертификат получит сам)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> Проверка порта $PORT"
systemctl stop lesson-board 2>/dev/null || true
if ss -ltn "( sport = :$PORT )" | grep -q LISTEN; then
  echo "ОШИБКА: порт $PORT уже занят другой программой:"; ss -ltnp "( sport = :$PORT )"
  echo "Запустите с другим портом:  sudo PORT=3590 bash deploy/install.sh $DOMAIN"; exit 1
fi

echo "==> Приложение -> $APP_DIR"
id -u board >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin board
mkdir -p "$APP_DIR" "$DATA_DIR"
rsync -a --delete --exclude node_modules --exclude data --exclude .git "$SRC/" "$APP_DIR/"
(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund)
chown -R root:root "$APP_DIR"
chown -R board:board "$DATA_DIR"
chmod 750 "$DATA_DIR"

echo "==> systemd"
cat > /etc/systemd/system/lesson-board.service <<UNIT
[Unit]
Description=Lesson board
After=network.target

[Service]
Type=simple
User=board
Group=board
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=2
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=DATA_DIR=$DATA_DIR
Environment=SECURE_COOKIE=1
Environment=SIGNUP=first
Environment=APP_NAME=Доска
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now lesson-board
systemctl restart lesson-board

echo "==> Caddyfile"
[ -f /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode zstd gzip
	request_body {
		max_size 110MB
	}
	reverse_proxy 127.0.0.1:$PORT
}
CADDY
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

echo "==> Firewall"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp; ufw allow 443/tcp
fi

echo "==> Ежедневный бэкап в /var/backups/lesson-board (хранится 14 дней)"
cat > /etc/cron.daily/lesson-board-backup <<'BK'
#!/bin/sh
mkdir -p /var/backups/lesson-board
tar -czf /var/backups/lesson-board/board-$(date +%F).tar.gz -C /var/lib lesson-board
find /var/backups/lesson-board -name 'board-*.tar.gz' -mtime +14 -delete
BK
chmod +x /etc/cron.daily/lesson-board-backup

sleep 1
if ! curl -fs "http://127.0.0.1:$PORT/api/config" | grep -q appName; then
  echo "ОШИБКА: приложение не отвечает. Лог:"; journalctl -u lesson-board -n 30 --no-pager; exit 1
fi
echo
echo "Готово! Откройте https://$DOMAIN и зарегистрируйтесь — первый зарегистрированный"
echo "пользователь станет владельцем, после этого регистрация закроется."
echo "Логи:  journalctl -u lesson-board -f     |     journalctl -u caddy -f"
