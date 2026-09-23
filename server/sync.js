// Синхронизация vault с Obsidian Git-репозиторием
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { get, run, now, all } from './db.js';
import { reindexAll } from './vault.js';

const SYNC_TABLE_INIT = `
CREATE TABLE IF NOT EXISTS vault_sync (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

// Инициализация таблицы синхронизации
run(SYNC_TABLE_INIT);

function getSetting(key) {
  return get('SELECT value FROM vault_sync WHERE key = ?', key)?.value || null;
}

function setSetting(key, value) {
  run('INSERT OR REPLACE INTO vault_sync (key, value) VALUES (?, ?)', key, String(value));
}

// Состояние синхронизации
export function getSyncState() {
  return {
    enabled: getSetting('enabled') === 'true',
    url: getSetting('url') || '',
    interval: +(getSetting('interval') || 15),
    autoSync: getSetting('autoSync') === 'true',
    lastSync: getSetting('lastSync') || null,
    lastStatus: getSetting('lastStatus') || 'never',
    lastError: getSetting('lastError') || null,
  };
}

// Обновление настроек синхронизации
export function updateSyncSettings(settings) {
  setSetting('enabled', settings.enabled ? 'true' : 'false');
  setSetting('url', settings.url);
  setSetting('interval', String(settings.interval));
  setSetting('autoSync', settings.autoSync ? 'true' : 'false');
}

// Проверка доступности репозитория
export async function testSyncConnection(url) {
  try {
    if (!url || typeof url !== 'string' || !url.trim()) {
      return { ok: false, error: 'URL репозитория не указан' };
    }
    
    const vaultPath = config.paths?.vault;
    
    if (!vaultPath || typeof vaultPath !== 'string') {
      return { ok: false, error: 'Путь к vault не настроен' };
    }
    
    // Проверяем существование директории
    if (!fs.existsSync(vaultPath)) {
      return { ok: false, error: `Директория vault не существует: ${vaultPath}` };
    }
    
    // Проверяем, является ли vault git-репозиторием
    const isGitRepo = fs.existsSync(path.join(vaultPath, '.git'));
    
    if (!isGitRepo) {
      // Инициализируем git и добавляем remote
      execSync('git init', { cwd: vaultPath, stdio: 'pipe' });
      execSync(`git remote add origin "${url}"`, { cwd: vaultPath, stdio: 'pipe' });
    } else {
      // Проверяем существующий remote
      try {
        const remoteUrl = execSync('git remote get-url origin', { cwd: vaultPath, encoding: 'utf8' }).trim();
        if (remoteUrl !== url) {
          execSync(`git remote set-url origin "${url}"`, { cwd: vaultPath, stdio: 'pipe' });
        }
      } catch {
        execSync(`git remote add origin "${url}"`, { cwd: vaultPath, stdio: 'pipe' });
      }
    }

    // Проверяем доступность удалённого репозитория
    execSync('git ls-remote origin HEAD', { cwd: vaultPath, stdio: 'pipe', timeout: 10000 });
    
    return { ok: true, message: 'Репозиторий доступен' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Выполнение синхронизации
export async function syncVault({ force = false }) {
  const state = getSyncState();
  
  if (!state.enabled && !force) {
    throw new Error('Синхронизация отключена');
  }

  if (!state.url) {
    throw new Error('URL репозитория не указан');
  }

  const vaultPath = config.paths?.vault;
  
  if (!vaultPath || typeof vaultPath !== 'string') {
    throw new Error('Путь к vault не настроен');
  }
  
  if (!fs.existsSync(vaultPath)) {
    throw new Error(`Директория vault не существует: ${vaultPath}`);
  }
  
  try {
    // Убеждаемся, что это git-репозиторий
    const isGitRepo = fs.existsSync(path.join(vaultPath, '.git'));
    if (!isGitRepo) {
      execSync('git init', { cwd: vaultPath, stdio: 'pipe' });
      execSync(`git remote add origin "${state.url}"`, { cwd: vaultPath, stdio: 'pipe' });
    }

    // Проверяем статус репозитория
    let hasChanges = false;
    try {
      const status = execSync('git status --porcelain', { cwd: vaultPath, encoding: 'utf8' });
      hasChanges = status.trim().length > 0;
    } catch {}

    // Получаем изменения с удалённого репозитория
    try {
      execSync('git fetch origin', { cwd: vaultPath, stdio: 'pipe', timeout: 30000 });
    } catch (err) {
      throw new Error(`Ошибка при получении изменений: ${err.message}`);
    }

    // Проверяем, есть ли коммиты
    let hasCommits = false;
    try {
      execSync('git rev-parse HEAD', { cwd: vaultPath, stdio: 'pipe' });
      hasCommits = true;
    } catch {}

    let pulled = 0;
    let pushed = 0;

    if (hasCommits) {
      // Получаем количество входящих изменений
      try {
        const incoming = execSync('git rev-list HEAD..origin/main --count 2>/dev/null || git rev-list HEAD..origin/master --count', 
          { cwd: vaultPath, encoding: 'utf8' }).trim();
        pulled = +incoming || 0;
      } catch {}

      // Стягиваем изменения
      if (pulled > 0) {
        try {
          execSync('git pull origin main 2>/dev/null || git pull origin master', 
            { cwd: vaultPath, stdio: 'pipe', timeout: 30000 });
        } catch (err) {
          throw new Error(`Ошибка при слиянии: ${err.message}`);
        }
      }
    } else {
      // Первая синхронизация — пытаемся получить данные
      try {
        execSync('git pull origin main 2>/dev/null || git pull origin master', 
          { cwd: vaultPath, stdio: 'pipe', timeout: 30000 });
        pulled = 1; // Условно считаем первый pull как изменение
      } catch (err) {
        // Если remote пустой, это нормально — продолжаем
        if (!err.message.includes('couldn\'t find remote ref')) {
          throw new Error(`Ошибка при первой синхронизации: ${err.message}`);
        }
      }
    }

    // Коммитим локальные изменения, если они есть
    if (hasChanges) {
      try {
        execSync('git add .', { cwd: vaultPath, stdio: 'pipe' });
        execSync(`git -c user.name="Lab-Hub" -c user.email="sync@lab-hub.local" commit -m "Auto-sync from Lab-Hub at ${new Date().toISOString()}"`, 
          { cwd: vaultPath, stdio: 'pipe' });
        pushed = 1;
      } catch (err) {
        // Игнорируем ошибку "nothing to commit"
        if (!err.message.includes('nothing to commit')) {
          throw new Error(`Ошибка при коммите: ${err.message}`);
        }
      }
    }

    // Отправляем изменения
    if (pushed > 0 || hasChanges) {
      try {
        execSync('git push origin HEAD:main 2>/dev/null || git push origin HEAD:master', 
          { cwd: vaultPath, stdio: 'pipe', timeout: 30000 });
      } catch (err) {
        throw new Error(`Ошибка при отправке: ${err.message}`);
      }
    }

    // Переиндексируем vault после синхронизации
    if (pulled > 0) {
      reindexAll({ force: true });
    }

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

// Автосинхронизация по расписанию
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
    // Первая синхронизация через 10 секунд после старта
    setTimeout(() => {
      syncVault({ force: false })
        .then(() => console.log('[sync] Первичная синхронизация выполнена'))
        .catch(err => console.error('[sync] Ошибка первичной синхронизации:', err.message));
    }, 10000);
  }
}, 5000);

// Пересоздаём таймер при изменении настроек
export function restartAutoSync() {
  startAutoSync();
}
