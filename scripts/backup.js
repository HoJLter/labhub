// Ночной бэкап: SQLite через backup API + tar каталога файлов (раздел 9.4 ТЗ).
// Запуск: node scripts/backup.js  (в docker-compose — отдельный сервис nightly)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const DATA = process.env.DATA_DIR || path.resolve(import.meta.dirname, '..', 'data');
const BACKUPS = path.join(DATA, 'backups');
const KEEP = parseInt(process.env.BACKUP_KEEP || '7', 10);
fs.mkdirSync(BACKUPS, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dbPath = path.join(DATA, 'lab-hub.sqlite');
const dbOut = path.join(BACKUPS, `db-${stamp}.sqlite`);

// 1. Консистентная копия БД (SQLite backup API)
if (fs.existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);
  db.close();
  console.log(`[backup] БД: ${dbOut} (${(fs.statSync(dbOut).size / 1048576).toFixed(1)} МБ)`);
}

// 2. Каталог файлов (tar, если доступен; иначе zip-фолбэк не делаем — rsync на хосте)
const filesDir = path.join(DATA, 'files');
const tarOut = path.join(BACKUPS, `files-${stamp}.tar`);
if (fs.existsSync(filesDir)) {
  const r = spawnSync('tar', ['-cf', tarOut, '-C', DATA, 'files'], { stdio: 'inherit' });
  if (r.status === 0) console.log(`[backup] Файлы: ${tarOut}`);
  else console.warn('[backup] tar недоступен — скопируйте каталог files/ вручную (rsync)');
}

// 3. Ротация: храним KEEP последних
const list = fs.readdirSync(BACKUPS).filter(f => /^(db|files)-/.test(f)).sort();
const groups = new Map();
for (const f of list) {
  const g = f.slice(0, f.indexOf('-'));
  groups.set(g, [...(groups.get(g) || []), f]);
}
for (const files of groups.values()) {
  while (files.length > KEEP) fs.rmSync(path.join(BACKUPS, files.shift()), { force: true });
}
console.log('[backup] готово');
