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
#   FORCE_ADMIN_SYNC=1 — принудительно выставить пароль админа в БД
#                        из ADMIN_PASSWORD файла .env и напечатать его
#                        (восстановление доступа; в CI — галка force_admin_sync
#                        при ручном запуске workflow)
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
  # Сначала генерируем секреты, и только потом создаём .env: если генерация упадёт,
  # на диске не останется .env с паролями-заглушками из примера.
  PASS=$(randstr 'a-z0-9' 20)
  SALT=$(randstr 'a-f0-9' 64)
  if [ -z "$PASS" ] || [ -z "$SALT" ]; then
    echo "::error::Не удалось сгенерировать случайные секреты для .env"
    exit 1
  fi
  cp /tmp/.env.example .env
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$PASS|" .env
  sed -i "s|^IP_SALT=.*|IP_SALT=$SALT|" .env
  chmod 600 .env
  echo "=== СОЗДАН .env ==="
  echo "  Админ: login=admin"
  echo "  Пароль: $PASS"
  echo "  ОБЯЗАТЕЛЬНО сохраните пароль — он показывается только один раз!"
elif grep -qE '^ADMIN_PASSWORD=(смените-этот-пароль|)$' .env; then
  # .env уже есть, но пароль остался заглушкой из .env.example (файл был создан
  # упавшим прогоном до подстановки) — чиним, иначе админка открывается общеизвестным паролем.
  # Окончательная смена пароля в БД — шагом sync ниже (админ уже мог создаться с заглушкой).
  PASS=$(randstr 'a-z0-9' 20)
  SALT=$(randstr 'a-f0-9' 64)
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$PASS|" .env
  grep -qE '^IP_SALT=$' .env && sed -i "s|^IP_SALT=.*|IP_SALT=$SALT|" .env
  chmod 600 .env
  NEEDS_ADMIN_SYNC=1
  echo "=== .env исправлен: пароль админа был заглушкой, сгенерирован новый ==="
fi

# Принудительная синхронизация (галка force_admin_sync при ручном запуске CI,
# либо FORCE_ADMIN_SYNC=1 вручную на сервере): берём текущий пароль из .env,
# выставляем его админу в БД и печатаем — механизм восстановления доступа.
if [ "${FORCE_ADMIN_SYNC:-0}" = "1" ] || [ "${FORCE_ADMIN_SYNC:-}" = "true" ]; then
  NEEDS_ADMIN_SYNC=1
  echo "=== FORCE_ADMIN_SYNC: пароль админа будет выставлен из .env и напечатан ==="
fi

# --- docker login в GHCR (если пакет приватный) --------------------
if [ -n "${GHCR_USER:-}" ] && [ -n "${GHCR_PAT:-}" ]; then
  echo "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
fi

# --- Тянем образ и перезапускаем -----------------------------------
COMPOSE="docker compose"
export IMAGE
export HTTP_PORT="${HTTP_PORT:-80}"

# Предпроверка хостового порта: если его занял ДРУГОЙ сервис, compose упадёт
# с невнятным "address already in use" — лучше сказать сразу, кто виноват.
# Проверяется только HTTP-порт: 443 мы не публикуем (на сервере его может держать xray и т.п.).
# docker-proxy на порту — не препятствие: это либо наш собственный caddy, либо
# чужой Docker-контейнер; в первом случае compose перезапустит его, во втором —
# ошибка up -d ниже покажет детали.
check_port() {
  local port="$1"
  # ss может отсутствовать на минимальных образах — тогда пробуем netstat, иначе пропускаем
  local who=""
  if command -v ss >/dev/null 2>&1; then
    who=$(ss -ltnp "sport = :$port" 2>/dev/null | tail -n +2)
  elif command -v netstat >/dev/null 2>&1; then
    # || true: grep без совпадений вернул бы 1, и set -e убило бы скрипт на присваивании
    who=$(netstat -ltnp 2>/dev/null | grep ":$port " || true)
  fi
  if [ -n "$who" ]; then
    # ВАЖНО: проверяем вхождение через case, а не "echo | grep -q" — при pipefail
    # ранний выход grep -q убивает echo через SIGPIPE и вся проверка ложно проваливается.
    case "$who" in
      *docker-proxy*)
        # это либо наш собственный caddy, либо чужой Docker-контейнер;
        # в первом случае compose перезапустит его, во втором — ошибку покажет up -d ниже
        echo "Порт $port держит docker-proxy (какой-то контейнер) — продолжаем, compose разберётся:"
        echo "$who"
        return 0
        ;;
    esac
    echo "::error::Порт $port на сервере занят другим процессом:"
    echo "$who"
    echo "Освободите его (systemctl stop <сервис>) либо задайте секрет DEPLOY_HTTP_PORT в GitHub Actions — сайт поднимется на другом порту."
    exit 1
  fi
}
check_port "$HTTP_PORT"

$COMPOSE pull app

# Если пароль в .env был заглушкой — админ в БД мог создаться с ней же (ensureAdminUser
# срабатывает только при пустой таблице, restart пароль не меняет). Синхронизируем:
# ставим хеш нового пароля единственному админу.
# ВАЖНО: делаем это до запуска app, пока SQLite никто не держит — иначе
# второй процесс упрётся в "database is locked".
if [ "${NEEDS_ADMIN_SYNC:-0}" = "1" ]; then
  $COMPOSE stop app 2>/dev/null || true
  echo "Синхронизация пароля админа в БД с новым значением из .env…"
  $COMPOSE run --rm --no-deps app node --input-type=module -e "
    const { hashPassword } = await import('/app/server/auth.js');
    const { db } = await import('/app/server/db.js');
    const { config } = await import('/app/server/config.js');
    const row = db.prepare('SELECT id, login FROM admin_users LIMIT 1').get();
    if (!row) { console.log('админа в БД нет — bootstrap создаст его с текущим паролем'); process.exit(0); }
    db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hashPassword(config.adminBootstrap.password), row.id);
    db.prepare('DELETE FROM sessions').run();
    console.log('пароль админа ' + row.login + ' обновлён, старые сессии сброшены');
  "
  echo "  Админ: login=admin"
  echo "  Пароль: $(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2-)"
  echo "  ОБЯЗАТЕЛЬНО сохраните пароль — он показывается только один раз!"
fi

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
