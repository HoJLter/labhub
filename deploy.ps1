# ============================================================
# lab-hub — деплой на сервер ОДНОЙ командой (Windows)
#
#   Первый раз:   .\deploy.ps1 setup     # поставит Docker на сервер, настроит SSH-ключ без пароля
#   Деплой:       .\deploy.ps1           # соберёт проект и развернёт/обновит на сервере
#   Логи:         .\deploy.ps1 logs
#   Перезапуск:   .\deploy.ps1 restart
#   Остановить:   .\deploy.ps1 down
#   Бэкап:        .\deploy.ps1 backup    # сделать бэкап на сервере
#   Забрать бэкап:.\deploy.ps1 pull-backup
#
# Конфиг сервера хранится в .deploy.json (создаётся при первом запуске).
# ============================================================
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [ValidateSet('deploy', 'setup', 'logs', 'down', 'restart', 'backup', 'pull-backup', 'init')]
  [string]$Action = 'deploy'
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$cfgPath = Join-Path $root '.deploy.json'

function Read-Cfg {
  if (-not (Test-Path $cfgPath)) {
    Write-Host ''
    Write-Host '=== Первоначальная настройка (один раз) ===' -ForegroundColor Cyan
    $h = Read-Host 'IP или домен сервера'
    $u = Read-Host 'SSH-пользователь [root]'
    if (-not $u) { $u = 'root' }
    $p = Read-Host 'SSH-порт [22]'
    if (-not $p) { $p = '22' }
    $d = Read-Host 'Каталог на сервере [/opt/lab-hub]'
    if (-not $d) { $d = '/opt/lab-hub' }
    $dom = Read-Host 'Публичный домен/URL сайта (для sitemap и ссылок, напр. https://labs.mysite.ru или http://1.2.3.4) []'
    $cfg = @{ host = $h; user = $u; port = [int]$p; path = $d; publicUrl = $dom }
    $cfg | ConvertTo-Json | Set-Content -Path $cfgPath -Encoding UTF8
    Write-Host "Сохранено в .deploy.json" -ForegroundColor Green
    return $cfg
  }
  return (Get-Content $cfgPath -Raw | ConvertFrom-Json)
}

function SshKey-Ensure {
  $key = Join-Path $env:USERPROFILE '.ssh\id_ed25519'
  if (-not (Test-Path $key)) {
    Write-Host 'Генерирую SSH-ключ…' -ForegroundColor Yellow
    ssh-keygen -t ed25519 -N '""' -f $key | Out-Null
  }
  return "$key.pub"
}

function SshKey-Install($cfg, $pubPath) {
  Write-Host ''
  Write-Host '=== Устанавливаю SSH-ключ на сервер (последний раз понадобится пароль) ===' -ForegroundColor Cyan
  $pub = Get-Content $pubPath -Raw
  $pub | ssh -p $cfg.port "$($cfg.user)@$($cfg.host)" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qxF '$($pub.Trim())' ~/.ssh/authorized_keys 2>/dev/null || echo '$($pub.Trim())' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
  if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить ключ' }
  Write-Host 'Ключ установлен — дальше всё без пароля.' -ForegroundColor Green
}

function Remote($cfg, $cmd) {
  ssh -p $cfg.port "$($cfg.user)@$($cfg.host)" $cmd
  if ($LASTEXITCODE -ne 0) { throw "Команда на сервере завершилась с ошибкой ($LASTEXITCODE): $cmd" }
}

# ——— Действия ———
$cfg = Read-Cfg

switch ($Action) {
  'setup' {
    $pub = SshKey-Ensure
    SshKey-Install $cfg $pub
    Write-Host '=== Устанавливаю Docker на сервер ===' -ForegroundColor Cyan
    scp -P $cfg.port (Join-Path $root 'server-setup.sh') "$($cfg.user)@$($cfg.host):/tmp/server-setup.sh"
    Remote $cfg "sed -i 's/\r$//' /tmp/server-setup.sh && bash /tmp/server-setup.sh '$($cfg.path)'"
    Write-Host ''
    Write-Host 'Сервер готов. Теперь: .\deploy.ps1' -ForegroundColor Green
  }

  'deploy' {
    $pub = SshKey-Ensure
    # Проверка доступа без пароля; если не настроен — предложим setup
    ssh -p $cfg.port -o BatchMode=yes "$($cfg.user)@$($cfg.host)" 'true' 2>$null
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'SSH без пароля не настроен — устанавливаю ключ (понадобится пароль один раз)…' -ForegroundColor Yellow
      SshKey-Install $cfg $pub
    }

    Write-Host '=== Собираю архив проекта ===' -ForegroundColor Cyan
    $archive = Join-Path $env:TEMP "lab-hub-$(Get-Date -Format yyyyMMddHHmmss).tgz"
    Push-Location $root
    tar -czf $archive --exclude=./.git --exclude=./data --exclude=./.deploy.json --exclude=./node_modules --exclude=./.env .
    Pop-Location
    if ($LASTEXITCODE -ne 0) { throw 'tar не смог собрать архив' }
    $size = [math]::Round((Get-Item $archive).Length / 1KB)
    Write-Host "Архив: $([System.IO.Path]::GetFileName($archive)) ($size КБ)"

    Write-Host '=== Передаю на сервер ===' -ForegroundColor Cyan
    Remote $cfg "mkdir -p '$($cfg.path)'"
    scp -P $cfg.port $archive "$($cfg.user)@$($cfg.host):/tmp/lab-hub.tgz"

    Write-Host '=== Разворачиваю и запускаю ===' -ForegroundColor Cyan
    $remoteScript = @"
set -e
cd '$($cfg.path)'
tar -xzf /tmp/lab-hub.tgz
rm /tmp/lab-hub.tgz
if [ ! -f .env ]; then
  cp .env.example .env
  PASS=`$(tr -dc 'a-z0-9' < /dev/urandom | head -c20)
  SALT=`$(tr -dc 'a-f0-9' < /dev/urandom | head -c64)
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=`$PASS|" .env
  sed -i "s|^IP_SALT=.*|IP_SALT=`$SALT|" .env
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=$($cfg.publicUrl)|" .env
  echo "=== СОЗДАН .env ==="
  echo "  Админ: login=admin"
  echo "  Пароль: `$PASS"
  echo "  ОБЯЗАТЕЛЬНО сохраните пароль — он показывается только один раз!"
fi
docker compose up -d --build
echo
docker compose ps
echo
echo "=== Готово ==="
docker compose logs app --tail 15
"@
    $remoteScript | ssh -p $cfg.port "$($cfg.user)@$($cfg.host)" 'bash -s'
    Remove-Item $archive -Force

    Write-Host ''
    $url = if ($cfg.publicUrl) { $cfg.publicUrl } else { "http://$($cfg.host)" }
    Write-Host "Сайт: $url" -ForegroundColor Green
    Write-Host "Админка: $url/admin" -ForegroundColor Green
  }

  'logs' { Remote $cfg "cd '$($cfg.path)' && docker compose logs -f --tail=100" }
  'down' { Remote $cfg "cd '$($cfg.path)' && docker compose down"; Write-Host 'Остановлено.' }
  'restart' { Remote $cfg "cd '$($cfg.path)' && docker compose restart app"; Write-Host 'Перезапущено.' }

  'backup' {
    Remote $cfg "cd '$($cfg.path)' && docker compose exec -T app node scripts/backup.js && docker compose cp app:/data/backups /tmp/lab-hub-backups"
    Write-Host 'Бэкап создан в /tmp/lab-hub-backups на сервере' -ForegroundColor Green
  }

  'pull-backup' {
    Remote $cfg "cd '$($cfg.path)' && docker compose exec -T app node scripts/backup.js && docker compose cp app:/data/backups /tmp/lab-hub-backups"
    $dest = Join-Path $root "backups-$($cfg.host)-$(Get-Date -Format yyyyMMdd-HHmmss)"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    scp -P $cfg.port -r "$($cfg.user)@$($cfg.host):/tmp/lab-hub-backups/*" $dest
    Write-Host "Бэкап скачан в: $dest" -ForegroundColor Green
  }

  'init' {
    if (Test-Path $cfgPath) { Remove-Item $cfgPath; Write-Host '.deploy.json удалён — при следующем запуске спросит заново.' }
    else { Read-Cfg | Out-Null }
  }
}
