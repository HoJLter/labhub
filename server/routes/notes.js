// Маршруты заметок.
//
// Публичная часть — только чтение (раздел «все могут смотреть»): список, страница заметки,
// граф, теги, вложения. Админская часть — запись: создание/правка/переименование/удаление
// .md-файлов в vault, загрузка вложений, ручная переиндексация.
// CSRF и проверка сессии для /api/admin/* выполняются общим middleware в server/index.js.
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, sendJson, sendText, str } from '../http.js';
import { audit, all } from '../db.js';
import { mimeByPath } from '../sources.js';
import {
  VAULT_DIR, absPath, safeRelPath, isAssetPath, assetExists, listAssets,
  readNoteRaw, writeNoteRaw, moveNoteRaw, trashNoteRaw, saveAttachment,
  reindexAll, noteBySlug, noteByPath, allNotes, tagCounts, notesByTag, graphData, localGraph,
  renderNote, vaultStats, notesIndex, invalidateResolver, renderPreview,
} from '../vault.js';

const MAX_NOTE_BYTES = 4 * 1024 * 1024;

/** Путь из параметра/тела запроса → нормализованный путь внутри vault (или 400). */
function notePath(v) {
  try { return safeRelPath(v); } catch (e) { throw new HttpError(400, e.message || 'Некорректный путь заметки'); }
}

/** Имя файла при создании заметки: как в Obsidian — заголовок становится именем файла. */
function fileNameFor(title) {
  const clean = String(title || '')
    .replace(/[\\/:*?"<>|]/g, ' ')      // символы, недопустимые в именах файлов
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  if (!clean) throw new HttpError(400, 'Пустое название заметки');
  return clean;
}

// ——— Отдача вложений с Range и кешем ———
// Ассеты неизменяемы (имя файла не переиспользуется), поэтому кешируем агрессивно.
async function serveVaultAsset(req, res, rel) {
  const clean = notePath(rel);
  if (!isAssetPath(clean)) throw new HttpError(403, 'Недопустимый тип файла');
  const abs = absPath(clean);
  let stat;
  try {
    stat = await fs.promises.stat(abs);
    if (!stat.isFile()) throw new Error('not a file');
  } catch { throw new HttpError(404, 'Файл не найден'); }

  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  const headers = {
    'Content-Type': mimeByPath(abs),
    'Accept-Ranges': 'bytes',
    'Last-Modified': stat.mtime.toUTCString(),
    ETag: etag,
    'Cache-Control': 'public, max-age=3600',
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }

  const total = stat.size;
  let start = 0, end = total - 1, status = 200;
  const range = req.headers['range'];
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      if (m[1]) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(parseInt(m[2], 10), total - 1); }
      else if (m[2]) start = Math.max(0, total - parseInt(m[2], 10));
      if (start >= total || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    }
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(abs, { start, end, highWaterMark: 256 * 1024 });
  stream.on('error', () => { try { res.end(); } catch { /* ignore */ } });
  res.on('close', () => stream.destroy());
  for await (const chunk of stream) {
    if (!res.write(chunk)) await new Promise(r => res.once('drain', r));
  }
  res.end();
}

export function registerNoteRoutes(router) {
  const isAdmin = req => !!req.admin;
  const visible = n => !!n;   // noteBySlug/noteByPath сами прячут private от не-админа

  // ——— Публичный список заметок ———
  router.get('/api/notes', (req, res) => {
    const admin = isAdmin(req);
    sendJson(res, 200, {
      notes: notesIndex({ isAdmin: admin }),
      tags: tagCounts({ isAdmin: admin }),
      stats: (() => { const s = vaultStats(); return { notes: s.notes, links: s.links, broken: s.broken, tags: s.tags, orphans: s.orphans }; })(),
      vault: admin ? VAULT_DIR : undefined,
    });
  });

  // ——— Граф (глобальный) ———
  router.get('/api/notes/graph', (req, res) => {
    sendJson(res, 200, graphData({ isAdmin: isAdmin(req), includeMissing: req.query.missing !== '0' }));
  });

  // ——— Теги ———
  router.get('/api/notes/tags', (req, res) => sendJson(res, 200, { tags: tagCounts({ isAdmin: isAdmin(req) }) }));

  router.get('/api/notes/tag/:tag', (req, res) => {
    const tag = str(req.params.tag, 200);
    sendJson(res, 200, { tag, notes: notesByTag(tag, { isAdmin: isAdmin(req) }) });
  });

  // ——— Одна заметка: HTML, оглавление, ссылки, обратные ссылки ———
  router.get('/api/notes/:slug', (req, res) => {
    const admin = isAdmin(req);
    const note = noteBySlug(req.params.slug, { isAdmin: admin });
    if (!visible(note)) throw new HttpError(404, 'Заметка не найдена', 'not_found');
    sendJson(res, 200, renderNote(note, { isAdmin: admin }));
  });

  // ——— Локальный граф заметки ———
  router.get('/api/notes/:slug/graph', (req, res) => {
    const admin = isAdmin(req);
    const depth = Math.min(Math.max(parseInt(req.query.depth, 10) || 1, 1), 3);
    const data = localGraph(req.params.slug, { depth, isAdmin: admin });
    if (!data.nodes.length) throw new HttpError(404, 'Заметка не найдена', 'not_found');
    sendJson(res, 200, data);
  });

  // ——— Вложения из vault (картинки и файлы, на которые ссылаются заметки) ———
  router.get('/api/vault/asset/*', async (req, res) => serveVaultAsset(req, res, req.params['0']));
  router.add('HEAD', '/api/vault/asset/*', async (req, res) => serveVaultAsset(req, res, req.params['0']));

  // ═══════════ Админская часть (запись) ═══════════

  router.get('/api/admin/notes', (req, res) => {
    sendJson(res, 200, {
      notes: notesIndex({ isAdmin: true }),
      tags: tagCounts({ isAdmin: true }),
      stats: vaultStats(),
      assets: vaultAssets(),
    });
  });

  router.get('/api/admin/notes/raw', (req, res) => {
    const p = notePath(req.query.path);
    const content = readNoteRaw(p);
    if (content == null) throw new HttpError(404, 'Заметка не найдена', 'not_found');
    const note = noteByPath(p, { isAdmin: true });
    sendJson(res, 200, { path: p, content, note: note ? { slug: note.slug, title: note.title, hash: note.hash } : null });
  });

  // Создание новой заметки-файла
  router.post('/api/admin/notes/create', (req, res) => {
    const b = req.jsonBody || {};
    const title = str(b.title, 120).trim();
    if (!title) throw new HttpError(400, 'Укажите название заметки');
    const folder = str(b.folder, 300).replace(/^\/+|\/+$/g, '');
    const file = fileNameFor(title);
    const rel = notePath(folder ? `${folder}/${file}` : file);
    if (assetExists(rel + '.md')) throw new HttpError(409, 'Заметка с таким названием уже есть в этой папке');
    const template = b.content != null ? String(b.content) : `# ${title}\n\n`;
    writeNoteRaw(rel, template);
    reindexAll();
    invalidateResolver();
    const note = noteByPath(rel, { isAdmin: true });
    audit('admin', 'note.create', 'notes', null, { path: rel });
    sendJson(res, 200, { ok: true, path: rel, note: note ? { slug: note.slug, title: note.title } : null });
  });

  // Сохранение содержимого (существующей или новой заметки)
  router.put('/api/admin/notes', (req, res) => {
    const b = req.jsonBody || {};
    const p = notePath(b.path);
    const content = String(b.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) throw new HttpError(413, 'Заметка слишком большая');
    const existed = readNoteRaw(p) != null;
    writeNoteRaw(p, content);
    const stat = reindexAll();
    invalidateResolver();
    const note = noteByPath(p, { isAdmin: true });
    audit('admin', 'note.save', 'notes', null, { path: p, created: !existed, bytes: Buffer.byteLength(content) });
    sendJson(res, 200, {
      ok: true, path: p, created: !existed, reindexed: stat,
      note: note ? { slug: note.slug, title: note.title, hash: note.hash, tags: tagsFor(p), aliases: JSON.parse(note.aliases || '[]'), visibility: note.visibility } : null,
    });
  });

  router.post('/api/admin/notes/rename', (req, res) => {
    const b = req.jsonBody || {};
    const from = notePath(b.path);
    const toInput = str(b.to, 300).trim();
    if (!toInput) throw new HttpError(400, 'Укажите новое название');
    // Новое имя задаётся либо как имя файла, либо как путь в другой папке
    const parts = toInput.split('/').map(s => s.trim()).filter(Boolean);
    const last = fileNameFor(parts.pop() || '');
    const to = notePath([...parts, last].join('/'));
    if (from === to) return sendJson(res, 200, { ok: true, path: to, unchanged: true });
    moveNoteRaw(from, to);
    reindexAll();
    invalidateResolver();
    const note = noteByPath(to, { isAdmin: true });
    audit('admin', 'note.rename', 'notes', null, { from, to });
    sendJson(res, 200, { ok: true, path: to, note: note ? { slug: note.slug, title: note.title } : null });
  });

  // Удаление — мягкое, в .trash/ внутри vault (как это делает сам Obsidian)
  router.post('/api/admin/notes/delete', (req, res) => {
    const p = notePath((req.jsonBody || {}).path);
    trashNoteRaw(p);
    reindexAll();
    invalidateResolver();
    audit('admin', 'note.delete', 'notes', null, { path: p });
    sendJson(res, 200, { ok: true, trashed: p });
  });

  // Загрузка вложения: сырое тело запроса, имя файла — в заголовке (index.js не парсит JSON тут)
  router.post('/api/admin/notes/attach', async (req, res) => {
    const rawName = req.headers['x-file-name'] || req.query.name || 'file';
    let name = String(rawName);
    try { name = decodeURIComponent(name); } catch { /* оставляем как есть */ }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) throw new HttpError(413, 'Вложение больше 32 МБ');
      chunks.push(chunk);
    }
    if (!size) throw new HttpError(400, 'Пустой файл');
    const rel = saveAttachment(name, Buffer.concat(chunks));
    audit('admin', 'note.attach', 'notes', null, { path: rel, bytes: size });
    sendJson(res, 200, { ok: true, path: rel, url: '/api/vault/asset/' + rel.split('/').map(encodeURIComponent).join('/'), embed: `![[${rel}]]` });
  });

  // Живой предпросмотр: рендерит сервер тем же рендерером, что и публичная страница
  router.post('/api/admin/notes/preview', (req, res) => {
    const b = req.jsonBody || {};
    const content = String(b.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) throw new HttpError(413, 'Заметка слишком большая');
    const path = b.path ? notePath(b.path) : '';
    sendJson(res, 200, renderPreview(path, content));
  });

  router.post('/api/admin/notes/reindex', (req, res) => {
    const stat = reindexAll({ force: true });
    invalidateResolver();
    audit('admin', 'note.reindex', 'notes', null, stat);
    sendJson(res, 200, { ok: true, stats: { ...stat, ...vaultStats() } });
  });

  // Автодополнение [[wiki-ссылок]] и поиск по заметкам в редакторе
  router.get('/api/admin/notes/suggest', (req, res) => {
    const q = str(req.query.q, 120).toLowerCase();
    const rows = allNotes({ isAdmin: true });
    const scored = [];
    for (const n of rows) {
      const hay = [n.path, n.title, ...n.aliases].map(s => String(s).toLowerCase());
      const idx = q ? hay.findIndex(h => h.includes(q)) : 0;
      if (q && idx < 0) continue;
      // точное совпадение с началом имени — выше в списке
      scored.push({ n, rank: hay.some(h => h.startsWith(q)) ? 0 : 1 });
    }
    scored.sort((a, b) => a.rank - b.rank || a.n.title.localeCompare(b.n.title, 'ru'));
    sendJson(res, 200, { items: scored.slice(0, 25).map(s => s.n) });
  });

  // Скачивание исходного .md (админ) и служебная информация о vault
  router.get('/api/admin/notes/download', (req, res) => {
    const p = notePath(req.query.path);
    const content = readNoteRaw(p);
    if (content == null) throw new HttpError(404, 'Заметка не найдена');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(p.split('/').pop() + '.md')}`);
    sendText(res, 200, content, 'text/markdown; charset=utf-8');
  });
}

// Теги конкретной заметки (для ответа на сохранение)
function tagsFor(p) {
  return all('SELECT tag FROM note_tags WHERE path = ? ORDER BY tag', p).map(r => r.tag);
}

// Вложения, которые уже лежат в vault — их показывает панель редактора
function vaultAssets() {
  return listAssets().map(a => ({
    path: a.path,
    size: a.size,
    url: '/api/vault/asset/' + a.path.split('/').map(encodeURIComponent).join('/'),
    embed: `![[${a.path}]]`,
  }));
}

export { MAX_NOTE_BYTES };