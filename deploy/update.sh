#!/usr/bin/env bash
# Обновление после git pull:  sudo bash deploy/update.sh
set -euo pipefail
APP_DIR=/opt/lesson-board
SRC="$(cd "$(dirname "$0")/.." && pwd)"
rsync -a --delete --exclude node_modules --exclude data --exclude .git "$SRC/" "$APP_DIR/"
(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund)
systemctl restart lesson-board
echo "Обновлено."
