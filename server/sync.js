// Синхронизация vault с Obsidian Git-репозиторием.
// Приватные HTTPS-репозитории требуют токен (PAT): он хранится в таблице vault_sync
// и подставляется в git-команды на лету через -c url.<auth>.insteadOf=<url> —
// в .git/config не попадает и в journal деплоя не печатается.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { get, run } from './db.js';
import { reindexAll } from './vault.js';

const SYNC_TABLE_INIT = `
CREATE TABLE IF NOT EXISTS vault_sync (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

run(SYNC_TABLE_INIT);

function getSetting(key) {
  return get('SELECT value FROM vault_sync WHERE key = ?', key)?.value || null;
}

function setSetting(key, value) {
  run('INSERT OR REPLACE INTO vault_sync (key, value) VALUES (?, ?)', key, String(value));
}

// Git без интерактивных запросов: на сервере нет терминала, и вместо невнятного
// «could not read Username» команда сразу падает с внятной ошибкой.
// LC_ALL=C — чтобы сообщения git были на английском и парсились friendlyGitError.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

// ——— URL и токен ———

function normalizeRepoUrl(raw) {
  const u = String(raw || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('URL репозитория не указан');
  // SSH scp-стиль: git@github.com:user/repo(.git)
  if (/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(u)) return u;
  if (/^https?:\/\/[\w.-]+(:\d+)?\/[\w./-]+$/i.test(u)) return u;
  throw new Error('Некорректный URL: ожидается https://github.com/user/repo или git@github.com:user/repo');
}

function sanitizeToken(t) {
  const s = String(t || '').trim();
  // GitHub PAT: alnum + _; допускаем также - и . на случай других хостингов.
  // Никаких кавычек/пробелов/$ — значение попадёт в командную строку git.
  if (s && !/^[\w.-]+$/.test(s)) throw new Error('Токен содержит недопустимые символы');
  return s;
}

// URL со встроенными учётными данными (GitHub принимает любое имя + PAT)
function authUrl(url, token) {
  if (!token || !/^https?:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    if (u.username || u.password) return url; // креды уже в URL — не мешаем
    u.username = 'x-access-token';
    u.password = token;
    return u.toString();
  } catch { return url; }
}

// Префикс для сетевых git-команд: подменяет URL репозитория на аутентифицированный
// только на время команды (remote в .git/config остаётся «чистым»).
function authPrefix(url, token) {
  if (!token || !/^https?:\/\//i.test(url)) return '';
  return `-c url."${authUrl(url, token)}".insteadOf="${url}" `;
}

// ——— Понятные ошибки вместо «Command failed: git ...» ———

function friendlyGitError(err) {
  const raw = [err?.stderr?.toString?.() || '', err?.message || ''].join(' ');
  if (/timed?\s?out|ETIMEDOUT/i.test(raw)) return 'Таймаут соединения — проверьте, что серверу доступен github.com';
  if (/could not read (Username|Password)|No such device or address|terminal prompts disabled/i.test(raw))
    return 'Репозиторий приватный (или URL неверный): git запросил учётные данные. Сохраните токен доступа (PAT) в настройках синхронизации и повторите';
  if (/Authentication failed|Invalid username or password|invalid credentials|bad credentials/i.test(raw))
    return 'Доступ запрещён: токен недействителен или не имеет прав на этот репозиторий';
  if (/Repository not found|not found/i.test(raw))
    return 'Репозиторий не найден — приватные репозитории без токена выглядят именно так';
  if (/Could not resolve host|ENOTFOUND|Name or service not known/i.test(raw))
    return 'Хост не найден (DNS): проверьте URL и исходящий интернет на сервере';
  if (/Permission denied \(publickey/i.test(raw))
    return 'SSH-доступ запрещён: на сервере нет нужного ключа. Проще использовать HTTPS + токен';
  const tail = String(err?.message || 'неизвестная ошибка').replace(/^Command failed:[^\n]*\n?/, '').trim();
  return tail || 'неизвестная ошибка';
}

function git(args, opts = {}) {
  return execSync(`git ${args}`, { stdio: 'pipe', env: GIT_ENV, ...opts });
}

// ——— Состояние и настройки ———

export function getSyncState() {
  return {
    enabled: getSetting('enabled') === 'true',
    url: getSetting('url') || '',
    interval: +(getSetting('interval') || 15),
    autoSync: getSetting('autoSync') === 'true',
    hasToken: !!getSetting('token'),
    lastSync: getSetting('lastSync') || null,
    lastStatus: getSetting('lastStatus') || 'never',
    lastError: getSetting('lastError') || null,
  };
}

export function updateSyncSettings(settings) {
  const url = normalizeRepoUrl(settings.url); // бросает понятную ошибку на мусоре
  setSetting('enabled', settings.enabled ? 'true' : 'false');
  setSetting('url', url);
  setSetting('interval', String(settings.interval));
  setSetting('autoSync', settings.autoSync ? 'true' : 'false');
  // token: undefined/null — не трогать сохранённый; '' — стереть; иначе — записать
  if (settings.token !== undefined && settings.token !== null) {
    setSetting('token', sanitizeToken(settings.token));
  }
}

// ——— Проверка доступности (ничего не меняет в vault) ———

export async function testSyncConnection(url, token = null) {
  try {
    const normalized = normalizeRepoUrl(url);
    const t = sanitizeToken(token && String(token).trim() ? token : getSetting('token'));
    // ls-remote не требует локального репозитория — выполняем во временном каталоге,
    // чтобы «проверка подключения» не трогала git-конфиг vault.
    execSync(`git ls-remote "${authUrl(normalized, t)}" HEAD`, {
      cwd: os.tmpdir(), stdio: 'pipe', timeout: 20000, env: GIT_ENV,
    });
    return { ok: true, message: 'Репозиторий доступен' };
  } catch (err) {
    return { ok: false, error: friendlyGitError(err) };
  }
}

// ——— Репозиторий vault: init + актуальный origin ———

function ensureRepo(vaultPath, url) {
  if (!fs.existsSync(path.join(vaultPath, '.git'))) {
    git('init', { cwd: vaultPath });
    git(`remote add origin "${url}"`, { cwd: vaultPath });
    return;
  }
  let cur = '';
  try {
    cur = execSync('git remote get-url origin', { cwd: vaultPath, encoding: 'utf8', env: GIT_ENV }).trim();
  } catch { /* origin не настроен */ }
  if (!cur) git(`remote add origin "${url}"`, { cwd: vaultPath });
  else if (cur !== url) git(`remote set-url origin "${url}"`, { cwd: vaultPath });
}

// ——— Выполнение синхронизации ———

export async function syncVault({ force = false }) {
  const state = getSyncState();

  if (!state.enabled && !force) throw new Error('Синхронизация отключена');
  if (!state.url) throw new Error('URL репозитория не указан');

  const vaultPath = config.paths?.vault;
  if (!vaultPath || typeof vaultPath !== 'string') throw new Error('Путь к vault не настроен');
  if (!fs.existsSync(vaultPath)) throw new Error(`Директория vault не существует: ${vaultPath}`);

  let url;
  try { url = normalizeRepoUrl(state.url); } catch (e) { throw new Error(e.message); }
  const token = getSetting('token');
  const A = authPrefix(url, token); // подстановка credentials для сетевых команд

  try {
    ensureRepo(vaultPath, url);

    // Локальные изменения (файлы, положенные в vault напрямую)
    let hasChanges = false;
    try {
      const status = execSync('git status --porcelain', { cwd: vaultPath, encoding: 'utf8', env: GIT_ENV });
      hasChanges = status.trim().length > 0;
    } catch { /* не критично */ }

    // Получаем изменения с удалённого репозитория
    try {
      git(`${A}fetch origin`, { cwd: vaultPath, timeout: 30000 });
    } catch (err) {
      throw new Error(friendlyGitError(err));
    }

    let hasCommits = false;
    try { git('rev-parse HEAD', { cwd: vaultPath }); hasCommits = true; } catch { /* пустой репозиторий */ }

    let pulled = 0;
    let pushed = 0;

    if (hasCommits) {
      try {
        const incoming = execSync('git rev-list HEAD..origin/main --count 2>/dev/null || git rev-list HEAD..origin/master --count',
          { cwd: vaultPath, encoding: 'utf8', env: GIT_ENV }).trim();
        pulled = +incoming || 0;
      } catch { /* ветка ещё не определена */ }

      if (pulled > 0) {
        try {
          git(`${A}pull origin main 2>/dev/null || git ${A}pull origin master`, { cwd: vaultPath, timeout: 60000 });
        } catch (err) {
          throw new Error(`Ошибка при слиянии: ${friendlyGitError(err)}`);
        }
      }
    } else {
      // Первая синхронизация — пытаемся получить данные
      try {
        git(`${A}pull origin main 2>/dev/null || git ${A}pull origin master`, { cwd: vaultPath, timeout: 60000 });
        pulled = 1; // условно считаем первый pull как изменение
      } catch (err) {
        // Пустой remote — нормально; всё остальное — внятная ошибка
        if (!/couldn't find remote ref|not found/i.test(String(err.message))) {
          throw new Error(`Ошибка при первой синхронизации: ${friendlyGitError(err)}`);
        }
      }
    }

    // Коммитим локальные изменения, если они есть
    if (hasChanges) {
      try {
        git('add .', { cwd: vaultPath });
        git(`-c user.name="Lab-Hub" -c user.email="sync@lab-hub.local" commit -m "Auto-sync from Lab-Hub at ${new Date().toISOString()}"`,
          { cwd: vaultPath });
        pushed = 1;
      } catch (err) {
        if (!/nothing to commit/i.test(String(err.message))) {
          throw new Error(`Ошибка при коммите: ${friendlyGitError(err)}`);
        }
      }
    }

    // Отправляем изменения
    if (pushed > 0) {
      try {
        git(`${A}push origin HEAD:main 2>/dev/null || git ${A}push origin HEAD:master`, { cwd: vaultPath, timeout: 30000 });
      } catch (err) {
        throw new Error(`Ошибка при отправке: ${friendlyGitError(err)}`);
      }
    }

    if (pulled > 0) reindexAll({ force: true });

    setSetting('lastSync', new Date().toISOString());
    setSetting('lastStatus', 'success');
    setSetting('lastError', '');

    return {
      pulled,
      pushed,
      message: `Синхронизация завершена: получено ${pulled}, отправлено ${pushed}`,
    };
  } catch (err) {
    setSetting('lastStatus', 'error');
    setSetting('lastError', err.message);
    throw err;
  }
}

// ——— Автосинхронизация по расписанию ———

let syncTimer = null;

function startAutoSync() {
  if (syncTimer) clearInterval(syncTimer);

  const state = getSyncState();
  if (!state.enabled || !state.autoSync) return;

  const intervalMs = state.interval * 60 * 1000;

  syncTimer = setInterval(() => {
    const currentState = getSyncState();
    if (currentState.enabled && currentState.autoSync) {
      syncVault({ force: false })
        .then(() => console.log('[sync] Автосинхронизация выполнена'))
        .catch(err => console.error('[sync] Ошибка автосинхронизации:', err.message));
    }
  }, intervalMs);

  syncTimer.unref();
}

// Запуск автосинхронизации при старте сервера
setTimeout(() => {
  const state = getSyncState();
  if (state.enabled && state.autoSync) {
    startAutoSync();
    setTimeout(() => {
      syncVault({ force: false })
        .then(() => console.log('[sync] Первичная синхронизация выполнена'))
        .catch(err => console.error('[sync] Ошибка первичной синхронизации:', err.message));
    }, 10000);
  }
}, 5000);

export function restartAutoSync() {
  startAutoSync();
}
