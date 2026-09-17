// Дисковый LRU-кеш внешних источников (раздел 7.3 ТЗ).
// Лимит — CACHE_MAX_GB, вытеснение по last_access_at, TTL с фоновой проверкой.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { get, all, run, now } from './db.js';

function keyToPath(key) {
  const safe = crypto.createHash('sha256').update(key).digest('hex');
  const ext = path.extname(key.split('?')[0]).slice(0, 10) || '';
  return path.join(config.paths.cache, safe.slice(0, 2), safe + ext);
}

export function cacheGet(key) {
  const row = get('SELECT * FROM cache_entries WHERE key = ?', key);
  if (!row) return null;
  if (row.expires_at < now()) { cacheDelete(key); return null; }
  if (!fs.existsSync(row.path)) { run('DELETE FROM cache_entries WHERE key = ?', key); return null; }
  run('UPDATE cache_entries SET last_access_at = ? WHERE key = ?', now(), key);
  return row.path;
}

export async function cachePut(key, materialId, srcPathOrBuffer, ttlMs = config.cacheTtlMs) {
  const dest = keyToPath(key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let size;
  if (Buffer.isBuffer(srcPathOrBuffer)) {
    await fsp.writeFile(dest, srcPathOrBuffer);
    size = srcPathOrBuffer.length;
  } else {
    await fsp.copyFile(srcPathOrBuffer, dest);
    size = (await fsp.stat(dest)).size;
  }
  run(
    `INSERT INTO cache_entries(key, material_id, path, size, last_access_at, expires_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET path=excluded.path, size=excluded.size, last_access_at=excluded.last_access_at, expires_at=excluded.expires_at`,
    key, materialId ?? null, dest, size, now(), now() + ttlMs
  );
  evict();
  return dest;
}

export function cacheDelete(key) {
  const row = get('SELECT path FROM cache_entries WHERE key = ?', key);
  if (row) { try { fs.rmSync(row.path, { force: true }); } catch { /* ignore */ } }
  run('DELETE FROM cache_entries WHERE key = ?', key);
}

// LRU-вытеснение: удаляем самые давно неиспользуемые записи, пока не в лимите.
export function evict() {
  const { total } = cacheStats();
  if (total <= config.cacheMaxBytes) return;
  const rows = all('SELECT key, path, size FROM cache_entries ORDER BY last_access_at ASC LIMIT 500');
  let freed = 0;
  for (const r of rows) {
    if (total - freed <= config.cacheMaxBytes) break;
    try { fs.rmSync(r.path, { force: true }); } catch { /* ignore */ }
    run('DELETE FROM cache_entries WHERE key = ?', r.key);
    freed += r.size;
  }
}

export function cacheStats() {
  const row = get('SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS total FROM cache_entries');
  return { count: row.count, total: row.total };
}

// Фоновая чистка протухших записей
export function startCacheJanitor(intervalMs = 3600_000) {
  const t = setInterval(() => {
    const expired = all('SELECT key FROM cache_entries WHERE expires_at < ?', now());
    for (const e of expired) cacheDelete(e.key);
    evict();
  }, intervalMs);
  t.unref();
  return t;
}

export function clearCache() {
  const rows = all('SELECT key FROM cache_entries');
  for (const r of rows) cacheDelete(r.key);
}
