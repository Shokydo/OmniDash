#!/usr/bin/env bash
# ============================================================
#  OmniDash — автоустановка на Ubuntu 24.04 / 24.10 (и Debian)
#  Ставит Node.js >= 18.17, git, python3, клонирует репозиторий
#  и готовит запуск. Зависимостей у панели нет — npm install
#  для запуска НЕ нужен.
#
#  Использование (внутри ВМ):
#    chmod +x install-ubuntu.sh
#    ./install-ubuntu.sh
#  или одной строкой без клонирования:
#    curl -fsSL https://raw.githubusercontent.com/Shokydo/OmniDash/main/install-ubuntu.sh | bash
#
#  После установки:
#    cd ~/OmniDash && ./start.sh
# ============================================================
set -e

REPO_URL="https://github.com/Shokydo/OmniDash.git"
REPO_DIR="$HOME/OmniDash"
PORT="${PORT:-7777}"

echo "============================================================"
echo "  OmniDash — установка на Ubuntu"
echo "============================================================"
echo

# --- 0. Где мы находимся? ---
if [ -f "server.js" ] && [ -f "package.json" ] && [ -d "public" ]; then
  REPO_DIR="$(pwd)"
  echo "[*] Уже внутри репозитория: $REPO_DIR"
else
  echo "[*] Репозиторий будет в: $REPO_DIR"
fi
echo

# --- 1. Базовые пакеты ---
echo "[1/5] Обновляю список пакетов и ставлю git/curl/python3..."
sudo apt update
sudo apt install -y git curl ca-certificates gnupg python3
echo

# --- 2. Node.js >= 18.17 ---
echo "[2/5] Проверяю Node.js..."
NEED_NODE=0
if command -v node >/dev/null 2>&1; then
  VER=$(node -v)
  MAJOR=$(node -p "process.versions.node.split('.')[0]")
  echo "    Найден: $VER"
  if [ "$MAJOR" -lt 18 ]; then
    echo "    [!] Слишком старая версия, переустанавливаю на LTS..."
    NEED_NODE=1
  else
    echo "    OK: версия подходит (>= 18.17)"
  fi
else
  echo "    Node.js не найден — ставлю LTS через NodeSource..."
  NEED_NODE=1
fi

if [ "$NEED_NODE" = "1" ]; then
  # NodeSource 22 LTS (поддерживает Ubuntu 24.04/24.10)
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
  echo "    Установлен: $(node -v) / npm $(npm -v)"
fi
echo

# --- 3. Репозиторий ---
echo "[3/5] Репозиторий..."
if [ -d "$REPO_DIR/.git" ]; then
  echo "    Уже есть — обновляю (git pull)..."
  git -C "$REPO_DIR" pull --ff-only || echo "    [!] pull не удался (есть локальные изменения?) — продолжаю с текущей копией"
elif [ -f "$REPO_DIR/server.js" ]; then
  echo "    Папка уже есть, .git нет — использую как есть"
else
  git clone "$REPO_URL" "$REPO_DIR"
  echo "    Склонировано в $REPO_DIR"
fi
cd "$REPO_DIR"
chmod +x start.sh install-ubuntu.sh 2>/dev/null || true
echo "    Ставлю зависимости (ssh2 для SFTP)..."
npm install --ignore-scripts --no-audit --no-fund || echo "    [!] npm install не удался — выполните вручную: npm install"
echo

# --- 4. Проверка ---
echo "[4/5] Проверка файлов..."
for f in server.js package.json public/index.html tools/dev.js; do
  if [ -f "$f" ]; then echo "    OK  $f"; else echo "    [!] Нет $f"; fi
done
echo "    Node: $(node -v) | Python: $(python3 --version 2>&1)"
echo

# --- 5. Брандмауэр (ufw, если включён) ---
echo "[5/5] Брандмауэр..."
if command -v ufw >/dev/null 2>&1; then
  if sudo ufw status | grep -q "Status: active"; then
    sudo ufw allow "$PORT/tcp" comment "OmniDash" || true
    echo "    Открыт порт $PORT в ufw"
  else
    echo "    ufw выключен — ничего делать не нужно"
  fi
else
  echo "    ufw не установлен — пропускаю"
fi
echo

# --- IP машины для доступа с хоста ---
VM_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$VM_IP" ] && VM_IP="<IP_ВМ>"

echo "============================================================"
echo "  Готово! Запуск:"
echo
echo "    cd $REPO_DIR"
echo "    ./start.sh              # обычный запуск, порт $PORT"
echo "    ./start.sh dev          # dev-режим (автоперезапуск при правках)"
echo "    ./start.sh 8080         # другой порт"
echo
echo "  Открыть в браузере (с хоста, где стоит ВМ):"
echo "    http://$VM_IP:$PORT"
echo "    или если ВМ за NAT — см. ниже про проброс порта / SSH-туннель"
echo
echo "  Логины по умолчанию:"
echo "    admin / omnidash   — администратор"
echo "    steve / steve123   — пользователь"
echo "    mira  / mira123    — пользователь"
echo
echo "  Остановка: Ctrl+C. Данные: $REPO_DIR/data"
echo "  Сброс демо: ./start.sh reset"
echo "============================================================"
echo
echo "  [!] Не открывается с хоста? Варианты:"
echo "      1) Сеть ВМ: Bridged (мост) — IP из той же подсети, открой http://IP:7777"
echo "      2) NAT + проброс: VirtualBox/VMware → Port Forwarding 7777 -> IP_ВМ:7777"
echo "      3) SSH-туннель с хоста:  ssh -L 7777:localhost:7777 <user>@<IP_ВМ>"
echo "         и открой http://localhost:7777"
echo "      4) Внутри ВМ: curl http://localhost:7777/healthz  (проверка, что панель жива)"
echo
