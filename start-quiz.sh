#!/bin/bash
# Quiz Times — запуск сервера квиза для macOS
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

load_node_env() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
  fi
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)" >/dev/null 2>&1 || true
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)" >/dev/null 2>&1 || true
  fi
}

find_node() {
  load_node_env
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidate
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node
  do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  # nvm: take the latest installed version
  local nvm_node
  nvm_node="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -n 1 || true)"
  if [ -n "$nvm_node" ] && [ -x "$nvm_node" ]; then
    echo "$nvm_node"
    return 0
  fi
  return 1
}

alert() {
  osascript -e "display dialog \"$1\" with title \"Quiz Times\" buttons {\"OK\"} default button \"OK\"" >/dev/null 2>&1 || true
}

clear 2>/dev/null || true
echo "========================================"
echo "          QUIZ TIMES"
echo "========================================"
echo

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  alert "На этом Mac не найден Node.js.\\n\\nСкачайте установщик с nodejs.org (кнопка LTS) и после установки снова нажмите «Запустить Quiz Times»."
  open "https://nodejs.org/ru/download"
  echo "Node.js не найден. Установите его с https://nodejs.org и запустите файл снова."
  echo
  read -r -p "Нажмите Enter, чтобы закрыть окно..."
  exit 1
fi

NPM_BIN="$(dirname "$NODE_BIN")/npm"
if [ ! -x "$NPM_BIN" ]; then
  NPM_BIN="$(command -v npm || true)"
fi

echo "Node: $NODE_BIN"
echo

if [ ! -d "$ROOT/node_modules" ]; then
  echo "Первый запуск: устанавливаю зависимости..."
  "$NPM_BIN" install --prefix "$ROOT"
  echo
fi

if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Сервер уже запущен на порту 3000."
else
  echo "Запускаю квиз..."
fi

lan_ip() {
  local ip iface
  for iface in en0 en1 bridge100 ap1; do
    ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
    if [ -n "$ip" ]; then
      echo "$ip"
      return 0
    fi
  done
  ifconfig | awk '/inet / && $2 != "127.0.0.1" { print $2; exit }'
}

PLAYER_HOST="$(lan_ip)"
if [ -n "$PLAYER_HOST" ]; then
  PLAYER_URL="http://${PLAYER_HOST}:3000/player.html"
else
  PLAYER_URL="http://localhost:3000/player.html"
fi

echo "$PLAYER_URL" | pbcopy 2>/dev/null || true

open_pages() {
  local tries=0
  until curl -sf "http://127.0.0.1:3000/" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -gt 50 ]; then
      return 1
    fi
    sleep 0.2
  done
  open "http://localhost:3000/host.html"
  return 0
}

if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  open_pages || true
else
  "$NODE_BIN" "$ROOT/server.js" &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null || true; exit 0' INT TERM
  if ! open_pages; then
    alert "Не удалось запустить квиз. Посмотрите текст в окне Терминала."
    wait "$SERVER_PID" || true
    read -r -p "Нажмите Enter, чтобы закрыть окно..."
    exit 1
  fi
fi

osascript -e "display notification \"Ссылка для игроков скопирована в буфер обмена\" with title \"Quiz Times\"" >/dev/null 2>&1 || true

echo
echo "Готово. Экран ведущего открыт в браузере."
echo
echo "Ссылка для игроков (уже скопирована):"
echo "  $PLAYER_URL"
echo
echo "Что делать:"
echo "  1. Раздайте точку доступа или подключите всех к одной Wi‑Fi сети"
echo "  2. Отправьте игрокам ссылку выше"
echo "  3. НЕ ЗАКРЫВАЙТЕ это окно, пока идёт квиз"
echo
echo "Чтобы остановить квиз: закройте это окно или нажмите Ctrl+C"
echo "========================================"
echo

if [ -n "${SERVER_PID:-}" ]; then
  wait "$SERVER_PID"
fi

# Если сервер уже был запущен раньше — держим окно, чтобы человек не потерял ссылку
read -r -p "Нажмите Enter, чтобы закрыть окно..."
