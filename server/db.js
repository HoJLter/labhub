// Слой данных lab-hub: SQLite (node:sqlite) в WAL-режиме.
// Схема соответствует разделу 9.2 ТЗ (адаптирована под SQLite: партиционирование events
// не требуется — ретенция обеспечивается фоновой чисткой, агрегаты живут в daily_stats).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

fs.mkdirSync(config.paths.data, { recursive: true });
fs.mkdirSync(config.paths.files, { recursive: true });
fs.mkdirSync(config.paths.posters, { recursive: true });
fs.mkdirSync(config.paths.cache, { recursive: true });
fs.mkdirSync(config.paths.backups, { recursive: true });

export const db = new DatabaseSync(config.paths.db);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  csrf TEXT NOT NULL,
  ua TEXT DEFAULT '',
  ip_hash TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT 'book',
  color TEXT NOT NULL DEFAULT '#5b5bd6',
  position INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'listed',   -- listed | unlisted | private
  default_storage_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL REFERENCES folders(id),
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,                          -- pdf | docx | video | image | link
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL DEFAULT 'local',   -- local | s3 | webdav | drive | url | embed
  source_config TEXT NOT NULL DEFAULT '{}',
  storage_id INTEGER,
  checksum TEXT,
  page_count INTEGER,
  duration_sec REAL,
  poster_path TEXT,
  file_path TEXT,
  converted_path TEXT,
  convert_status TEXT NOT NULL DEFAULT 'none', -- none | converting | ready | error
  status TEXT NOT NULL DEFAULT 'processing',   -- processing | published | hidden | deleted
  visibility TEXT NOT NULL DEFAULT 'listed',   -- listed | unlisted | private
  allow_download INTEGER NOT NULL DEFAULT 1,
  noindex INTEGER NOT NULL DEFAULT 0,
  views_count INTEGER NOT NULL DEFAULT 0,
  reads_count INTEGER NOT NULL DEFAULT 0,
  downloads_count INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS material_tags (
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (material_id, tag_id)
);

CREATE TABLE IF NOT EXISTS storages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,                          -- local | s3 | webdav | url
  config TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  health_status TEXT NOT NULL DEFAULT 'unknown', -- ok | slow | broken | unknown
  last_check_at INTEGER
);

CREATE TABLE IF NOT EXISTS link_health (
  material_id INTEGER PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
  status TEXT NOT NULL,                        -- ok | slow | broken
  http_code INTEGER,
  checked_at INTEGER NOT NULL,
  error_msg TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cache_entries (
  key TEXT PRIMARY KEY,
  material_id INTEGER,
  path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  last_access_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  ua TEXT DEFAULT '',
  device TEXT DEFAULT 'desktop',
  referrer TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,                          -- pageview | reader_open | download | page_change | video_progress | search | material_view
  visitor_id TEXT,
  material_id INTEGER,
  folder_id INTEGER,
  query TEXT,
  value REAL,
  meta TEXT DEFAULT '{}',
  ip_hash TEXT DEFAULT '',
  device TEXT DEFAULT 'desktop',
  referrer TEXT DEFAULT '',
  bot INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_stats (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  dim TEXT NOT NULL DEFAULT 'all',
  value REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, dim)
);

CREATE TABLE IF NOT EXISTS search_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  results_count INTEGER NOT NULL DEFAULT 0,
  visitor_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL DEFAULT 'admin',
  action TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  entity_id INTEGER,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS salts (
  day TEXT PRIMARY KEY,
  salt TEXT NOT NULL
);

-- ——— Заметки (раздел «как в Obsidian») ———
-- Источник истины — .md-файлы в data/vault, эти таблицы лишь производный индекс:
-- их можно в любой момент перестроить из файлов (см. reindexAll в server/vault.js).
CREATE TABLE IF NOT EXISTS notes (
  path TEXT PRIMARY KEY,                       -- путь без расширения, '/'-разделители
  slug TEXT UNIQUE NOT NULL,                   -- стабильный URL-идентификатор
  file TEXT NOT NULL,                          -- путь файла относительно vault, с расширением
  title TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '[]',          -- JSON-массив (frontmatter aliases)
  frontmatter TEXT NOT NULL DEFAULT '{}',      -- JSON всего frontmatter
  excerpt TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL DEFAULT '',               -- sha1 содержимого: детект правок и переименований
  visibility TEXT NOT NULL DEFAULT 'listed',   -- listed | unlisted | private (из frontmatter)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS note_links (
  source_path TEXT NOT NULL,
  target_raw TEXT NOT NULL,                    -- как написано в тексте: [[вот_так]]
  target_path TEXT,                            -- разрешённый путь заметки, NULL если ссылка «битая»
  embed INTEGER NOT NULL DEFAULT 0,
  heading TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (source_path, target_raw, heading)
);

CREATE TABLE IF NOT EXISTS note_tags (
  path TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (path, tag)
);

CREATE INDEX IF NOT EXISTS idx_materials_folder   ON materials(folder_id, status);
CREATE INDEX IF NOT EXISTS idx_materials_pub      ON materials(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_materials_checksum ON materials(checksum);
CREATE INDEX IF NOT EXISTS idx_events_material    ON events(material_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts          ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_visitor     ON events(visitor_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent     ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_search_created     ON search_queries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_note_links_target  ON note_links(target_path);
CREATE INDEX IF NOT EXISTS idx_note_links_source  ON note_links(source_path);
CREATE INDEX IF NOT EXISTS idx_note_tags_tag      ON note_tags(tag);
`);

// ——— Миграции ———
{
  const cols = db.prepare("SELECT name FROM pragma_table_info('folders')").all().map(c => c.name);
  if (!cols.includes('deleted_at')) {
    db.exec('ALTER TABLE folders ADD COLUMN deleted_at INTEGER');
  }
}

// ——— Пользовательские функции SQL ———
// SQLite lower() не приводит кириллицу — регистрируем unicode-aware lower для поиска.
db.function('loweru', s => (s == null ? '' : String(s).toLowerCase()));

// ——— Тонкие хелперы ———

export const now = () => Date.now();

export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}
export function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}
export function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

// ——— Настройки (key/value, раздел 8.5) ———

const DEFAULT_SETTINGS = {
  site_name: 'Lab-Hub',
  site_description: 'Хранилище лабораторных, практических работ и методичек',
  footer_note: 'Материалы предоставлены в учебных целях',
  accent_color: '#5b5bd6',
  default_theme: 'system',
  allow_download: true,
  public_search: true,
  global_noindex: true,          // рекомендация ТЗ раздел 13: каталог вуза по умолчанию не индексируем
  max_upload_mb: 2048,
  allowed_ext: ['pdf', 'docx', 'doc', 'pptx', 'xlsx', 'mp4', 'webm', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'vtt', 'zip'],
  closed_mode: false,            // Phase 2: закрытый режим по инвайт-коду (middleware готов, см. server/http.js)
  invite_code: '',
};

export function getSettings() {
  const rows = all('SELECT key, value FROM settings');
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}

export function getSetting(key) {
  return getSettings()[key];
}

export function setSetting(key, value) {
  run(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value)
  );
}

// ——— Соль дня для HMAC(ip) с ежедневной ротацией (раздел 8.4, приватность) ———

export function getDaySalt(dayMs = now()) {
  const day = new Date(dayMs).toISOString().slice(0, 10);
  let row = get('SELECT salt FROM salts WHERE day = ?', day);
  if (!row) {
    const salt = crypto.randomBytes(32).toString('hex');
    run('INSERT OR IGNORE INTO salts(day, salt) VALUES(?, ?)', day, salt);
    row = get('SELECT salt FROM salts WHERE day = ?', day);
  }
  // Ретенция солей — 2 дня (старые бессмысленны: ip_hash за прошлые дни не декодируется by design)
  run('DELETE FROM salts WHERE day < ?', new Date(dayMs - 2 * 86400000).toISOString().slice(0, 10));
  return row.salt;
}

export function hashIp(ip) {
  return crypto.createHmac('sha256', config.ipSaltBase + ':' + getDaySalt()).update(ip || '').digest('hex').slice(0, 32);
}

// ——— Audit log (раздел 8/9.4) ———

export function audit(actor, action, entity, entityId, payload = {}) {
  run(
    'INSERT INTO audit_log(actor, action, entity, entity_id, payload, created_at) VALUES(?,?,?,?,?,?)',
    actor, action, entity, entityId ?? null, JSON.stringify(payload), now()
  );
}

// ——— Ретенция сырых событий: 12 месяцев (раздел 8.4) ———

export function applyRetention() {
  const cutoff = now() - config.retentionEventsMonths * 30 * 86400000;
  run('DELETE FROM events WHERE ts < ?', cutoff);
}
