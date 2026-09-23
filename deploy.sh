#!/usr/bin/env bash
# ============================================================
# lab-hub — деплой на сервер ОДНОЙ командой (Linux/macOS/WSL)
#
#   Первый раз:   ./deploy.sh setup     # Docker на сервер + SSH-ключ без пароля
#   Деплой:       ./deploy.sh           # развернуть/обновить
#   Логи:         ./deploy.sh logs
#   Перезапуск:   ./deploy.sh restart
#   Остановить:   ./deploy.sh down
#   Бэкап:        ./deploy.sh backup
#   Забрать бэкап:./deploy.sh pull-backup
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"
CFG=.deploy.json
ACTION="${1:-deploy}"

read_cfg() {
  if [ ! -f "$CFG" ]; then
    echo "=== Первоначальная настройка (один раз) ==="
    read -rp 'IP или домен сервера: ' HOST
    read -rp 'SSH-пользователь [root]: ' USER; USER="${USER:-root}"
    read -rp 'SSH-порт [22]: ' PORT; PORT="${PORT:-22}"
    read -rp 'Каталог на сервере [/opt/lab-hub]: ' RPATH; RPATH="${RPATH:-/opt/lab-hub}"
    read -rp 'Публичный URL сайта (https://labs.site.ru или http://IP) []: ' PUBURL
    printf '{"host":"%s","user":"%s","port":%s,"path":"%s","publicUrl":"%s"}\n' \
      "$HOST" "$USER" "$PORT" "$RPATH" "$PUBURL" > "$CFG"
    echo "Сохранено в $CFG"
  fi
}

cfgval() { grep -o "\"$1\":\"[^\"]*\"" "$CFG" | cut -d'"' -f4; }
cfgport() { grep -o "\"port\":[0-9]*" "$CFG" | cut -d: -f2; }

read_cfg
HOST="$(cfgval host)"; USER="$(cfgval user)"; PORT="$(cfgport)"
RPATH="$(cfgval path)"; PUBURL="$(cfgval publicUrl)"
SSH="ssh -p $PORT $USER@$HOST"
SCP="scp -P $PORT"

ensure_key() {
  [ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 -q
}

install_key() {
  echo "=== Устанавливаю SSH-ключ (один раз введите пароль) ==="
  cat ~/.ssh/id_ed25519.pub | $SSH "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && sort -u ~/.ssh/authorized_keys -o ~/.ssh/authorized_keys"
  echo "Ключ установлен — дальше всё без пароля."
}

case "$ACTION" in
  setup)
    ensure_key
    install_key
    echo "=== Устанавливаю Docker на сервер ==="
    $SCP server-setup.sh "$USER@$HOST:/tmp/server-setup.sh"
    $SSH "sed -i 's/\r$//' /tmp/server-setup.sh && bash /tmp/server-setup.sh '$RPATH'"
    echo; echo "Сервер готов. Теперь: ./deploy.sh"
    ;;

  deploy)
    ensure_key
    if ! $SSH -o BatchMode=yes true 2>/dev/null; then install_key; fi
    echo "=== Собираю архив ==="
    ARCHIVE="/tmp/lab-hub-$(date +%s).tgz"
    tar -czf "$ARCHIVE" --exclude=./.git --exclude=./data --exclude=./.deploy.json --exclude=./node_modules --exclude=./.env .
    echo "=== Передаю на сервер ==="
    $SSH "mkdir -p '$RPATH'"
    $SCP "$ARCHIVE" "$USER@$HOST:/tmp/lab-hub.tgz"
    rm -f "$ARCHIVE"
    echo "=== Разворачиваю и запускаю ==="
    $SSH "RPATH='$RPATH' PUBURL='$PUBURL' bash -s" <<'REMOTE'
set -e
cd "$RPATH"
tar -xzf /tmp/lab-hub.tgz
rm /tmp/lab-hub.tgz
if [ ! -f .env ]; then
  cp .env.example .env
  # dd вместо бесконечного чтения /dev/urandom: tr не получает SIGPIPE (важно под pipefail)
  PASS=$(tr -dc 'a-z0-9' < <(dd if=/dev/urandom bs=4096 count=64 2>/dev/null) | head -c20 || true)
  SALT=$(tr -dc 'a-f0-9' < <(dd if=/dev/urandom bs=4096 count=64 2>/dev/null) | head -c64 || true)
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$PASS|" .env
  sed -i "s|^IP_SALT=.*|IP_SALT=$SALT|" .env
  [ -n "$PUBURL" ] && sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=$PUBURL|" .env
  echo "=== СОЗДАН .env ==="
  echo "  Админ: login=admin"
  echo "  Пароль: $PASS"
  echo "  ОБЯЗАТЕЛЬНО сохраните пароль — он показывается только один раз!"
fi
docker compose up -d --build
echo
docker compose ps
echo "=== Готово ==="
docker compose logs app --tail 15
REMOTE
    echo
    echo "Сайт: ${PUBURL:-http://$HOST}"
    echo "Админка: ${PUBURL:-http://$HOST}/admin"
    ;;

  logs)    $SSH "cd '$RPATH' && docker compose logs -f --tail=100" ;;
  down)    $SSH "cd '$RPATH' && docker compose down" ;;
  restart) $SSH "cd '$RPATH' && docker compose restart app" ;;

  backup)
    $SSH "cd '$RPATH' && docker compose exec -T app node scripts/backup.js && docker compose cp app:/data/backups /tmp/lab-hub-backups"
    echo "Бэкап создан в /tmp/lab-hub-backups на сервере"
    ;;

  pull-backup)
    $SSH "cd '$RPATH' && docker compose exec -T app node scripts/backup.js && docker compose cp app:/data/backups /tmp/lab-hub-backups"
    DEST="./backups-$HOST-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$DEST"
    $SCP -r "$USER@$HOST:/tmp/lab-hub-backups/*" "$DEST/"
    echo "Бэкап скачан в: $DEST"
    ;;

  *) echo "Неизвестное действие: $ACTION (deploy|setup|logs|down|restart|backup|pull-backup)"; exit 1 ;;
esac
