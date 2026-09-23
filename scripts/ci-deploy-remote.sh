#!/usr/bin/env bash
# ============================================================
# lab-hub — серверная часть CD: запускается из GitHub Actions по SSH.
# Файлы (docker-compose.prod.yml, Caddyfile, .env.example, этот скрипт)
# заранее скопированы в /tmp. Образ приложения уже лежит в GHCR.
#
# Переменные окружения:
#   IMAGE        — образ для запуска, напр. ghcr.io/user/lab-hub:main (обязательно)
#   DEPLOY_PATH  — рабочий каталог (по умолчанию /opt/lab-hub)
#   HTTP_PORT    — хостовый порт для :80 Caddy (по умолчанию 80)
#   GHCR_USER    — логин GitHub       } нужны, только если пакет
#   GHCR_PAT     — PAT с read:packages } в GHCR приватный
#   COMMIT_SHA   — для журнала деплоя (необязательно)
# ============================================================
set -euo pipefail

IMAGE="${IMAGE:?IMAGE не задан}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/lab-hub}"
mkdir -p "$DEPLOY_PATH"
cd "$DEPLOY_PATH"

# --- Рабочие файлы -------------------------------------------------
cp /tmp/docker-compose.prod.yml docker-compose.yml
cp /tmp/Caddyfile Caddyfile
cp /tmp/ci-deploy-remote.sh .   # пригодится для ручного перезапуска

# --- .env: создаём один раз, со случайными секретами --------------
# Генератор случайных строк: читаем /dev/urandom конечными порциями через dd,
# иначе tr получает SIGPIPE при закрытии head и pipefail роняет скрипт (код 141).
randstr() {  # $1 = алфавит, $2 = длина
  tr -dc "$1" < <(dd if=/dev/urandom bs=4096 count=64 2>/dev/null) | head -c "$2" || true
}

if [ ! -f .env ]; then
  cp /tmp/.env.example .env
  PASS=$(randstr 'a-z0-9' 20)
  SALT=$(randstr 'a-f0-9' 64)
  if [ -z "$PASS" ] || [ -z "$SALT" ]; then
    echo "::error::Не удалось сгенерировать случайные секреты для .env"
    exit 1
  fi
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$PASS|" .env
  sed -i "s|^IP_SALT=.*|IP_SALT=$SALT|" .env
  chmod 600 .env
  echo "=== СОЗДАН .env ==="
  echo "  Админ: login=admin"
  echo "  Пароль: $PASS"
  echo "  ОБЯЗАТЕЛЬНО сохраните пароль — он показывается только один раз!"
fi

# --- docker login в GHCR (если пакет приватный) --------------------
if [ -n "${GHCR_USER:-}" ] && [ -n "${GHCR_PAT:-}" ]; then
  echo "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
fi

# --- Тянем образ и перезапускаем -----------------------------------
COMPOSE="docker compose"
export IMAGE
export HTTP_PORT="${HTTP_PORT:-80}"

# Предпроверка хостового порта: если его занял другой сервис, compose упадёт
# с невнятным "address already in use" — лучше сказать сразу, кто виноват.
# Проверяется только HTTP-порт: 443 мы не публикуем (на сервере его может держать xray и т.п.).
check_port() {
  local port="$1"
  # ss может отсутствовать на минимальных образах — тогда пробуем netstat, иначе пропускаем
  local who=""
  if command -v ss >/dev/null 2>&1; then
    who=$(ss -ltnp "sport = :$port" 2>/dev/null | tail -n +2)
  elif command -v netstat >/dev/null 2>&1; then
    who=$(netstat -ltnp 2>/dev/null | grep ":$port ")
  fi
  if [ -n "$who" ]; then
    # наш собственный контейнер caddy на этом порту — не ошибка, compose его перезапустит
    if echo "$who" | grep -q 'docker-proxy'; then
      return 0
    fi
    echo "::error::Порт $port на сервере занят другим процессом:"
    echo "$who"
    echo "Освободите его (systemctl stop <сервис>) либо задайте секрет DEPLOY_HTTP_PORT в GitHub Actions — сайт поднимется на другом порту."
    exit 1
  fi
}
check_port "$HTTP_PORT"

$COMPOSE pull app
if ! $COMPOSE up -d; then
  echo "--- up не удался, диагностика: ---"
  $COMPOSE ps || true
  docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Status}}' || true
  exit 1
fi
$COMPOSE ps

# --- Журнал деплоя + уборка старых образов -------------------------
{
  echo "$(date -Is)  ${COMMIT_SHA:-unknown}  $IMAGE"
  # docker compose не умеет «предыдущий тег», но sha-теги в GHCR позволяют откат:
  # docker compose down && IMAGE=<registry>/<image>:sha-<старый> docker compose up -d
} >> deploy.log
tail -n 5 deploy.log

docker image prune -f >/dev/null 2>&1 || true
$COMPOSE logs app --tail 10
echo "=== Деплой завершён: $IMAGE ==="
