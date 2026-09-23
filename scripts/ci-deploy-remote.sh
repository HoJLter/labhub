#!/usr/bin/env bash
# ============================================================
# lab-hub — серверная часть CD: запускается из GitHub Actions по SSH.
# Файлы (docker-compose.prod.yml, Caddyfile, .env.example, этот скрипт)
# заранее скопированы в /tmp. Образ приложения уже лежит в GHCR.
#
# Переменные окружения:
#   IMAGE        — образ для запуска, напр. ghcr.io/user/lab-hub:main (обязательно)
#   DEPLOY_PATH  — рабочий каталог (по умолчанию /opt/lab-hub)
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

$COMPOSE pull app
$COMPOSE up -d
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
