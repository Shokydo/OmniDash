#!/usr/bin/env bash
# OmniDash — запуск панели на Linux/macOS (аналог start.bat для Windows)
# Использование:
#   ./start.sh           обычный запуск на порту 7777
#   ./start.sh 8080      на порту 8080
#   ./start.sh dev       dev-режим (автоперезапуск при правках)
#   ./start.sh reset     сбросить демо-данные и запустить
set -e
cd "$(dirname "$0")"

PORT="${PORT:-7777}"
MODE="normal"

case "${1:-}" in
  dev) MODE="dev"; [ -n "${2:-}" ] && PORT="$2" ;;
  reset) MODE="reset" ;;
  --help|-h|help)
    echo "OmniDash — запуск панели"
    echo "  ./start.sh           запуск на порту 7777"
    echo "  ./start.sh 8080      запуск на порту 8080"
    echo "  ./start.sh dev       dev-режим"
    echo "  ./start.sh reset     сброс демо-данных и запуск"
    echo "Требуется Node.js >= 18.17. Зависимостей нет."
    exit 0
    ;;
  "") ;;
  *) PORT="$1" ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js не найден. Установите Node.js >= 18.17: https://nodejs.org" >&2
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 18 ]; then
  echo "[!] Нужен Node.js >= 18.17, найден $(node -v)" >&2
  exit 1
fi

if [ ! -d node_modules/ssh2 ]; then
  echo "Ставлю зависимости (ssh2 для SFTP) — один раз..."
  npm install --ignore-scripts --no-audit --no-fund || echo "[!] npm install не удался — панель запустится без SFTP"
  echo
fi

if [ "$MODE" = "reset" ] && [ -d data ]; then
  BAK="data-backup-$(date +%Y%m%d-%H%M%S)"
  echo "Переименовываю data -> $BAK (демо пересоздадутся при старте)"
  mv data "$BAK"
  MODE="normal"
fi

export PORT HOST="${HOST:-0.0.0.0}"
echo "OmniDash: http://localhost:$PORT  (режим: $MODE, Node $(node -v))"
echo "Вход: admin / omnidash   ·   steve / steve123   ·   mira / mira123"
echo "Остановка: Ctrl+C"
echo

if [ "$MODE" = "dev" ]; then
  exec node tools/dev.js
else
  exec node server.js
fi
