#!/usr/bin/env bash
# ============================================================
# lab-hub — установка сервера (выполняется ОДИН раз, запускается
# автоматически из deploy.ps1 / deploy.sh)
# Ставит Docker + compose-плагин, открывает порты 80/443.
# Использование: bash server-setup.sh /opt/lab-hub
# ============================================================
set -euo pipefail
DEPLOY_PATH="${1:-/opt/lab-hub}"

echo "=== lab-hub: настройка сервера ==="

# Docker
if ! command -v docker >/dev/null 2>&1; then
  echo "--- устанавливаю Docker ---"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker 2>/dev/null || service docker start || true

# Compose-плагин (в новых установках Docker идёт в комплекте)
if ! docker compose version >/dev/null 2>&1; then
  echo "--- устанавливаю docker compose plugin ---"
  mkdir -p /usr/local/lib/docker/cli-plugins
  ARCH="$(uname -m)"; case "$ARCH" in x86_64) ARCH=x86_64;; aarch64|arm64) ARCH=aarch64;; esac
  curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$ARCH" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi

# Каталог проекта
mkdir -p "$DEPLOY_PATH"

# Фаервол (если ufw активен)
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q active; then
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
fi

echo
echo "=== Сервер готов ==="
echo "Docker: $(docker --version)"
echo "Compose: $(docker compose version --short 2>/dev/null || echo ok)"
echo "Каталог: $DEPLOY_PATH"
