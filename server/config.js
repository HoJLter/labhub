// Конфигурация lab-hub. Все значения — из env с разумными дефолтами (раздел 8.5 / 9.1 ТЗ).
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function intEnv(name, def) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}

export const config = {
  port: intEnv('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${intEnv('PORT', 3000)}`,

  paths: {
    data: process.env.DATA_DIR || path.join(ROOT, 'data'),
    db: process.env.DB_PATH || path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'lab-hub.sqlite'),
    files: path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'files'),
    posters: path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'files', 'posters'),
    cache: process.env.CACHE_DIR || path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'cache'),
    // Vault заметок: обычные .md-файлы, совместимые с Obsidian (см. server/vault.js)
    vault: process.env.VAULT_DIR || path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'vault'),
    backups: process.env.BACKUP_DIR || path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'backups'),
  },

  // Лимиты (раздел 7.4, 8.5)
  maxUploadBytes: intEnv('MAX_UPLOAD_MB', 2048) * 1024 * 1024,
  cacheMaxBytes: intEnv('CACHE_MAX_GB', 20) * 1024 * 1024 * 1024,
  cacheTtlMs: intEnv('CACHE_TTL_HOURS', 24 * 7) * 3600 * 1000,
  diskWarnRatio: 0.85,

  // Сессии и безопасность (раздел 3)
  sessionTtlMs: intEnv('SESSION_TTL_DAYS', 30) * 24 * 3600 * 1000,
  visitorTtlMs: 365 * 24 * 3600 * 1000, // cookie-идентификатор посетителя — 1 год
  loginMaxFails: intEnv('LOGIN_MAX_FAILS', 5),
  loginLockMs: intEnv('LOGIN_LOCK_MIN', 15) * 60 * 1000,
  eventsRatePerMin: intEnv('EVENTS_RATE_PER_MIN', 120),
  adminBootstrap: {
    login: process.env.ADMIN_LOGIN || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin12345',
  },
  // Соль для HMAC(ip) — суточная ротация берётся из таблицы salts; это базовая соль (раздел 8.4)
  ipSaltBase: process.env.IP_SALT || crypto.randomBytes(32).toString('hex'),

  // Фоновые задачи
  healthCheckIntervalMs: intEnv('HEALTH_CHECK_HOURS', 24) * 3600 * 1000,
  aggregationIntervalMs: 60 * 1000,
  retentionEventsMonths: 12,

  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',

  // Демо-каталог создаётся только при явном SEED_DEMO=1 или `node server/seed.js`.
  // Прод всегда стартует чистым.
  seedDemo: process.env.SEED_DEMO === '1',
};

export function dataPath(...parts) {
  return path.join(config.paths.data, ...parts);
}
