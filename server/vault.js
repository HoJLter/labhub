// Vault заметок (раздел «как в Obsidian»).
//
// Источник истины — обычные .md-файлы в data/vault. Формат совместим с Obsidian:
// frontmatter, [[wiki-ссылки]], #теги, ![[вложения]], callouts. Поэтому ту же папку можно
// открыть в настоящем Obsidian и писать заметки там — правки подхватит fs.watch и переиндексирует.
//
// Таблицы notes / note_links / note_tags — производный индекс: он целиком перестраивается из
// файлов функцией reindexAll(), поэтому рассинхрон не страшен, достаточно переиндексации.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { get, all, run, tx, now } from './db.js';
import { slugify } from './http.js';
import { parseFrontmatter, extractWikiLinks, extractTags, renderMarkdown, slugifyHeading } from './markdown.js';

export const VAULT_DIR = config.paths.vault;
export const TRASH_DIR = path.join(VAULT_DIR, '.trash');
export const ATTACH_DIR = 'attachments';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp']);
const ASSET_EXT = new Set([...IMAGE_EXT, '.pdf', '.txt', '.csv', '.vtt', '.mp4', '.webm', '.mp3', '.ogg', '.wav']);
// Слова, которые нельзя занимать slug'ом заметки: это служебные адреса /notes/<...>
const RESERVED_SLUGS = new Set(['graph', 'tags', 'tag', 'index', 'all', 'new']);

fs.mkdirSync(VAULT_DIR, { recursive: true });
fs.mkdirSync(TRASH_DIR, { recursive: true });

// ——— Пути и защита от выхода за пределы vault ———

/** Нормализует относительный путь: убирает `..`, абсолютные корни, обратные слеши. */
export function safeRelPath(rel, { allowEmpty = false } = {}) {
  const raw = String(rel ?? '').replace(/\\/g, '/').trim();
  if (raw.includes('\0')) throw new Error('Некорректный путь');
  // Абсолютные пути и диски отвергаем явно, а не «переосмысливаем» как относительные:
  // молчаливое превращение /etc/passwd в etc/passwd внутри vault — сюрприз, который дороже отладки.
  if (raw.startsWith('/')) throw new Error('Некорректный путь');
  if (/^[A-Za-z]:/.test(raw)) throw new Error('Некорректный путь');
  const parts = raw.split('/').filter(s => s !== '' && s !== '.');
  if (parts.some(s => s === '..')) throw new Error('Некорректный путь');
  // скрытые файлы и каталоги (.obsidian, .trash и прочее) наружу не отдаём и не пишем
  if (parts.some(s => s.startsWith('.'))) throw new Error('Некорректный путь');
  const out = parts.join('/');
  if (!out && !allowEmpty) throw new Error('Пустой путь');
  return out;
}

/** Абсолютный путь внутри vault; бросает, если результат вышел за пределы каталога. */
export function absPath(rel) {
  const root = path.resolve(VAULT_DIR);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Путь вне vault');
  return abs;
}

function dirOf(p) { const i = String(p).lastIndexOf('/'); return i < 0 ? '' : String(p).slice(0, i); }
function baseOf(p) { const i = String(p).lastIndexOf('/'); return i < 0 ? String(p) : String(p).slice(i + 1); }
function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16); }

// ——— Чтение/запись файлов заметок ———

export function noteFileOf(notePath) { return notePath + '.md'; }
export function notePathOf(fileRel) { return fileRel.replace(/\.md$/i, ''); }

export function readNoteRaw(notePath) {
  const rel = safeRelPath(notePath);
  const abs = absPath(noteFileOf(rel));
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
}

/** Атомарная запись: сначала во временный файл рядом, затем rename. */
export function writeNoteRaw(notePath, content) {
  const rel = safeRelPath(notePath);
  const abs = absPath(noteFileOf(rel));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, String(content ?? ''), 'utf8');
  fs.renameSync(tmp, abs);
  return rel;
}

/** Переименование/перемещение заметки. Возвращает новый относительный путь. */
export function moveNoteRaw(fromPath, toPath) {
  const from = safeRelPath(fromPath);
  const to = safeRelPath(toPath);
  const absFrom = absPath(noteFileOf(from));
  const absTo = absPath(noteFileOf(to));
  if (!fs.existsSync(absFrom)) throw new Error('Заметка не найдена');
  if (fs.existsSync(absTo)) throw new Error('Заметка с таким путём уже существует');
  fs.mkdirSync(path.dirname(absTo), { recursive: true });
  fs.renameSync(absFrom, absTo);
  return to;
}

/** Мягкое удаление — в .trash/ внутри vault (так делает и сам Obsidian). */
export function trashNoteRaw(notePath) {
  const rel = safeRelPath(notePath);
  const abs = absPath(noteFileOf(rel));
  if (!fs.existsSync(abs)) throw new Error('Заметка не найдена');
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const flat = rel.replace(/\//g, '__');
  fs.renameSync(abs, path.join(TRASH_DIR, `${flat}.${stamp}.md`));
  return rel;
}

/** Список .md-файлов vault (без скрытых каталогов). */
export function listNoteFiles() {
  const out = [];
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
      const st = fs.statSync(abs);
      out.push({
        rel: path.relative(VAULT_DIR, abs).split(path.sep).join('/'),
        mtime: Math.floor(st.mtimeMs),
        size: st.size,
      });
    }
  };
  walk(VAULT_DIR);
  return out;
}

/** Список файлов-вложений (картинки и прочее, что можно отдать публично). */
export function listAssets() {
  const out = [];
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.isFile()) continue;
      if (!ASSET_EXT.has(path.extname(e.name).toLowerCase())) continue;
      const st = fs.statSync(abs);
      out.push({
        path: path.relative(VAULT_DIR, abs).split(path.sep).join('/'),
        size: st.size,
        mtime: Math.floor(st.mtimeMs),
      });
    }
  };
  walk(VAULT_DIR);
  return out;
}

export function isImagePath(p) { return IMAGE_EXT.has(path.extname(String(p)).toLowerCase()); }
export function isAssetPath(p) { return ASSET_EXT.has(path.extname(String(p)).toLowerCase()); }

/** Есть ли такой файл во vault (используется резолвером вложений). */
export function assetExists(rel) {
  try {
    const abs = absPath(safeRelPath(rel));
    return fs.existsSync(abs) && fs.statSync(abs).isFile();
  } catch { return false; }
}

export function assetUrl(rel) {
  return '/api/vault/asset/' + String(rel).split('/').map(encodeURIComponent).join('/');
}

/** Сохраняет вложение из админки: в папку attachments/ внутри vault, не перетирая существующие. */
export function saveAttachment(fileName, buffer) {
  const clean = String(fileName || 'file').replace(/[\\/]/g, '_').replace(/[\0<>:"|?*\u0000-\u001f]/g, '_').trim() || 'file';
  const ext = path.extname(clean).toLowerCase();
  if (!ASSET_EXT.has(ext)) throw new Error(`Недопустимый тип вложения (${ext || 'без расширения'})`);
  const stem = path.basename(clean, ext).slice(0, 80) || 'file';
  let rel = `${ATTACH_DIR}/${stem}${ext}`;
  let i = 1;
  while (assetExists(rel)) rel = `${ATTACH_DIR}/${stem}-${i++}${ext}`;
  const abs = absPath(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return rel;
}

// ——— Разбор заметки (используется и индексатором, и рендером) ———

function asList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

function firstHeading(body) {
  const m = /^#{1,3}\s+(.+)$/m.exec(body);
  return m ? m[1].trim() : '';
}

/** Черновой «текст» для списков и мета-описаний: без разметки, ссылок и картинок. */
function makeExcerpt(body, limit = 260) {
  const text = String(body)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[\[[^\]]*\]\]/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, t, l) => l || t)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[>*_~`=]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? text.slice(0, limit - 1).trimEnd() + '…' : text;
}

/** Разбирает исходник заметки в набор полей индекса. */
export function parseNote(raw, notePath) {
  const { data, body } = parseFrontmatter(raw);
  const fmTitle = data.title != null ? String(data.title).trim() : '';
  const fmTags = [...asList(data.tags), ...asList(data.tag)];
  const visibility = ['listed', 'unlisted', 'private'].includes(String(data.visibility))
    ? String(data.visibility)
    : (data.private === true ? 'private' : 'listed');
  return {
    notePath,
    body,
    frontmatter: data,
    title: fmTitle || firstHeading(body) || baseOf(notePath),
    aliases: asList(data.aliases ?? data.alias),
    tags: extractTags(body, fmTags),
    visibility,
    excerpt: makeExcerpt(body),
    wordCount: body.split(/\s+/).filter(Boolean).length,
  };
}

// ——— Разрешение имён заметок (как в Obsidian: по имени файла, пути или alias) ———

let resolverCache = null;
export function invalidateResolver() { resolverCache = null; }

function buildResolver() {
  const byName = new Map(); // ключ в нижнем регистре → [{ path, slug, aliases }]
  const add = (key, note) => {
    const k = String(key).toLowerCase();
    if (!k) return;
    const list = byName.get(k) || [];
    if (!list.some(n => n.path === note.path)) list.push(note);
    byName.set(k, list);
  };
  for (const n of all('SELECT path, slug, aliases FROM notes')) {
    const note = { path: n.path, slug: n.slug, aliases: JSON.parse(n.aliases || '[]') };
    add(n.path, note);
    add(baseOf(n.path), note);
    for (const a of note.aliases) add(a, note);
  }
  return (target, fromPath = '') => {
    // Ссылка с «/» трактуется как путь (от корня vault или от текущего каталога)
    const t = String(target || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!t) return null;
    const candidates = byName.get(t.toLowerCase()) || [];
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];
    // Obsidian предпочитает заметку из того же каталога, затем с самым коротким путём
    const dir = dirOf(fromPath);
    const sameDir = candidates.filter(n => dirOf(n.path) === dir);
    const pool = sameDir.length ? sameDir : candidates;
    return [...pool].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))[0];
  };
}

function resolver() {
  if (!resolverCache) resolverCache = buildResolver();
  return resolverCache;
}

/** Разрешает имя цели в заметку. Возвращает { path, slug } или null. */
export function resolveTarget(target, fromPath = '') {
  return resolver()(target, fromPath);
}

function uniqueSlug(base, notePath) {
  let s = slugify(base);
  if (RESERVED_SLUGS.has(s)) s = `${s}-z`;
  let cand = s;
  let i = 2;
  for (;;) {
    const row = get('SELECT path FROM notes WHERE slug = ?', cand);
    if (!row || row.path === notePath) return cand;
    cand = `${s}-${i++}`;
  }
}

// ——— Индексация ———

function upsertNoteRow(file) {
  const raw = fs.readFileSync(absPath(file.rel), 'utf8');
  const parsed = parseNote(raw, file.path);
  const hash = sha1(raw);
  const prev = get('SELECT * FROM notes WHERE path = ?', file.path);
  const slug = prev ? prev.slug : uniqueSlug(file.path, file.path);
  const aliasesJson = JSON.stringify(parsed.aliases);
  // Смена alias'ов влияет на разрешение ссылок во ВСЕХ заметках, поэтому помечаем это отдельно
  const aliasesChanged = !prev || prev.aliases !== aliasesJson;

  run(
    `INSERT INTO notes(path, slug, file, title, aliases, frontmatter, excerpt, word_count, size, mtime, hash, visibility, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(path) DO UPDATE SET
       file=excluded.file, title=excluded.title, aliases=excluded.aliases, frontmatter=excluded.frontmatter,
       excerpt=excluded.excerpt, word_count=excluded.word_count, size=excluded.size, mtime=excluded.mtime,
       hash=excluded.hash, visibility=excluded.visibility, updated_at=excluded.updated_at`,
    file.path, slug, file.rel, parsed.title, aliasesJson, JSON.stringify(parsed.frontmatter || {}),
    parsed.excerpt, parsed.wordCount, file.size, file.mtime, hash, parsed.visibility, now(), now()
  );

  run('DELETE FROM note_tags WHERE path = ?', file.path);
  for (const tag of parsed.tags) run('INSERT OR IGNORE INTO note_tags(path, tag) VALUES(?,?)', file.path, tag);

  indexLinksFor(file.path, parsed.body);

  return { hash, aliasesChanged, prevHash: prev ? prev.hash : null };
}

/** Переиндексация ссылок одной заметки. */
function indexLinksFor(notePath, body) {
  run('DELETE FROM note_links WHERE source_path = ?', notePath);
  const links = extractWikiLinks(body);
  const seen = new Set();
  for (const l of links) {
    const target = l.target ? resolveTarget(l.target, notePath) : { path: notePath };
    const key = `${l.target}\u0000${l.heading || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    run(
      'INSERT OR IGNORE INTO note_links(source_path, target_raw, target_path, embed, heading) VALUES(?,?,?,?,?)',
      notePath, l.target, target ? target.path : null, l.embed ? 1 : 0, l.heading || ''
    );
  }
  return links.length;
}

function dropNote(notePath) {
  run('DELETE FROM note_links WHERE source_path = ?', notePath);
  run('DELETE FROM note_tags WHERE path = ?', notePath);
  run('DELETE FROM notes WHERE path = ?', notePath);
}

/**
 * Полная инкрементальная переиндексация: читает каталог, обновляет только изменившиеся файлы,
 * ловит переименования (по хешу содержимого) и удаления.
 */
export function reindexAll({ force = false } = {}) {
  const stat = { scanned: 0, updated: 0, added: 0, renamed: 0, removed: 0, links: 0 };
  const existing = new Map(all('SELECT path, slug, hash, aliases, mtime, size FROM notes').map(n => [n.path, n]));
  const files = listNoteFiles();
  stat.scanned = files.length;

  const seen = new Set();
  const pending = [];
  for (const f of files) {
    const p = notePathOf(f.rel);
    seen.add(p);
    const prev = existing.get(p);
    if (!force && prev && prev.mtime === f.mtime && prev.size === f.size) continue;
    pending.push({ ...f, path: p, prev: prev || null });
  }

  const removed = [...existing.values()].filter(n => !seen.has(n.path));
  const freshFiles = pending.filter(f => !f.prev);
  let structureChanged = removed.length > 0 || freshFiles.length > 0;

  tx(() => {
    // 1. Переименования: удалённая заметка и новый файл с тем же содержимым — это одна заметка.
    //    Slug при этом сохраняется, чтобы не ломать внешние ссылки на заметку.
    for (const f of freshFiles) {
      if (!removed.length) break;
      let hash;
      try { hash = sha1(fs.readFileSync(absPath(f.rel), 'utf8')); } catch { continue; }
      const idx = removed.findIndex(n => n.hash === hash);
      if (idx < 0) continue;
      const old = removed.splice(idx, 1)[0];
      run('UPDATE notes SET path = ?, file = ?, mtime = ?, size = ? WHERE path = ?', f.path, f.rel, f.mtime, f.size, old.path);
      run('UPDATE note_links SET source_path = ? WHERE source_path = ?', f.path, old.path);
      run('UPDATE note_tags SET path = ? WHERE path = ?', f.path, old.path);
      f.prev = { ...old, path: f.path };
      stat.renamed++;
    }

    // 2. Удаления
    for (const n of removed) { dropNote(n.path); stat.removed++; }

    // 3. Обновление изменившихся файлов
    for (const f of pending) {
      try {
        const r = upsertNoteRow(f);
        stat.links += 1;
        if (f.prev) stat.updated++; else stat.added++;
        // alias'ы участвуют в разрешении ссылок — их смена требует полного пересчёта
        if (r.aliasesChanged) structureChanged = true;
      } catch (e) {
        console.error(`[vault] не удалось проиндексировать ${f.rel}: ${e.message}`);
      }
    }

    // 4. Если набор заметок или alias'ы изменились — переразрешаем ссылки во всём vault
    if (structureChanged) {
      invalidateResolver();
      for (const n of all('SELECT path, file FROM notes')) {
        try {
          const raw = fs.readFileSync(absPath(n.file), 'utf8');
          const { body } = parseFrontmatter(raw);
          indexLinksFor(n.path, body);
        } catch { /* файл мог исчезнуть между сканами — подхватит следующий проход */ }
      }
    }
  });

  invalidateResolver();
  return stat;
}

// ——— Фоновое отслеживание изменений (правки в самом Obsidian) ———

let watchTimer = null;
let watcher = null;
let pollTimer = null;

function scheduleReindex(reason) {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    watchTimer = null;
    try {
      const s = reindexAll();
      if (s.added || s.updated || s.removed || s.renamed) {
        console.log(`[vault] переиндексация (${reason}): +${s.added} ~${s.updated} -${s.removed} ⇄${s.renamed}`);
      }
    } catch (e) {
      console.error('[vault] ошибка переиндексации:', e.message);
    }
  }, 500);
  if (watchTimer.unref) watchTimer.unref();
}

export function startVaultWatcher() {
  reindexAll();
  try {
    watcher = fs.watch(VAULT_DIR, { recursive: true }, (_ev, name) => {
      const n = String(name || '');
      if (n.includes('.tmp-')) return;                 // наши же временные файлы
      if (n.split(/[\\/]/).some(p => p.startsWith('.'))) return;  // .trash, .obsidian
      if (n && !n.toLowerCase().endsWith('.md')) return;          // вложения не влияют на индекс
      scheduleReindex('fs.watch');
    });
    watcher.on('error', err => {
      console.warn('[vault] fs.watch недоступен, перехожу на периодический опрос:', err.message);
      try { watcher.close(); } catch { }
      watcher = null;
      startPolling();
    });
  } catch (e) {
    console.warn('[vault] fs.watch недоступен, перехожу на периодический опрос:', e.message);
    startPolling();
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => scheduleReindex('poll'), 15_000);
  if (pollTimer.unref) pollTimer.unref();
}

export function stopVaultWatcher() {
  if (watcher) { try { watcher.close(); } catch { } watcher = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
}

// ——— Чтение для API ———

export function noteBySlug(slug, { isAdmin = false } = {}) {
  const n = get('SELECT * FROM notes WHERE slug = ?', String(slug));
  if (!n) return null;
  if (!isAdmin && n.visibility === 'private') return null;
  return n;
}

export function noteByPath(notePath, { isAdmin = false } = {}) {
  const n = get('SELECT * FROM notes WHERE path = ?', String(notePath));
  if (!n) return null;
  if (!isAdmin && n.visibility === 'private') return null;
  return n;
}

function publicNote(n) {
  return {
    path: n.path,
    slug: n.slug,
    title: n.title,
    excerpt: n.excerpt,
    aliases: JSON.parse(n.aliases || '[]'),
    tags: tagsOf(n.path),
    word_count: n.word_count,
    updated_at: n.updated_at,
    folder: dirOf(n.path),
    visibility: n.visibility,
  };
}

function tagsOf(notePath) {
  return all('SELECT tag FROM note_tags WHERE path = ? ORDER BY tag', notePath).map(r => r.tag);
}

export function allNotes({ isAdmin = false } = {}) {
  const rows = isAdmin
    ? all('SELECT * FROM notes ORDER BY path')
    : all("SELECT * FROM notes WHERE visibility != 'private' ORDER BY path");
  return rows.map(publicNote);
}

export function tagCounts({ isAdmin = false } = {}) {
  const rows = isAdmin
    ? all(`SELECT t.tag, COUNT(*) AS count FROM note_tags t JOIN notes n ON n.path = t.path GROUP BY t.tag ORDER BY count DESC, t.tag`)
    : all(`SELECT t.tag, COUNT(*) AS count FROM note_tags t JOIN notes n ON n.path = t.path WHERE n.visibility != 'private' GROUP BY t.tag ORDER BY count DESC, t.tag`);
  return rows;
}

export function notesByTag(tag, { isAdmin = false } = {}) {
  const rows = isAdmin
    ? all(`SELECT n.* FROM notes n JOIN note_tags t ON t.path = n.path WHERE t.tag = ? ORDER BY n.title`, tag)
    : all(`SELECT n.* FROM notes n JOIN note_tags t ON t.path = n.path WHERE t.tag = ? AND n.visibility != 'private' ORDER BY n.title`, tag);
  return rows.map(publicNote);
}

// ——— Граф связей ———

/**
 * Данные для графа. Узлы — заметки, рёбра — разрешённые [[ссылки]].
 * Битой ссылке соответствует узел с missing:true — так же, как «неразрешённые ссылки» в Obsidian.
 */
export function graphData({ isAdmin = false, includeMissing = true } = {}) {
  const notes = isAdmin
    ? all('SELECT path, slug, title FROM notes')
    : all("SELECT path, slug, title FROM notes WHERE visibility != 'private'");
  const byPath = new Map(notes.map(n => [n.path, n]));

  const edges = [];
  const degree = new Map();
  const missing = new Map();
  for (const l of all('SELECT source_path, target_raw, target_path FROM note_links')) {
    if (!byPath.has(l.source_path)) continue;              // источник скрыт/удалён
    let targetPath = l.target_path;
    if (!targetPath || !byPath.has(targetPath)) {
      if (!includeMissing || !l.target_raw) continue;
      targetPath = `missing:${l.target_raw}`;              // узел-заглушка для битой ссылки
      if (!missing.has(targetPath)) missing.set(targetPath, { path: targetPath, slug: null, title: l.target_raw, missing: true });
    }
    if (targetPath === l.source_path) continue;            // ссылка на себя граф не украшает
    edges.push({ source: l.source_path, target: targetPath });
    degree.set(l.source_path, (degree.get(l.source_path) || 0) + 1);
    degree.set(targetPath, (degree.get(targetPath) || 0) + 1);
  }

  const nodes = [...byPath.values(), ...missing.values()].map(n => ({
    path: n.path,
    slug: n.slug,
    title: n.title,
    degree: degree.get(n.path) || 0,
    missing: !!n.missing,
    tags: n.missing ? [] : tagsOf(n.path).slice(0, 6),
  }));
  // Дубли рёбер (разные ссылки на одну заметку) на графе не нужны
  const uniq = new Map();
  for (const e of edges) uniq.set(`${e.source}\u0000${e.target}`, e);
  return { nodes, edges: [...uniq.values()] };
}

/** Локальный граф: заметка и её соседи в пределах depth шагов. */
export function localGraph(slug, { depth = 1, isAdmin = false } = {}) {
  const full = graphData({ isAdmin });
  const start = noteBySlug(slug, { isAdmin });
  if (!start) return { nodes: [], edges: [] };
  const adj = new Map();
  for (const e of full.edges) {
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    if (!adj.has(e.target)) adj.set(e.target, new Set());
    adj.get(e.source).add(e.target);
    adj.get(e.target).add(e.source);
  }
  const keep = new Set([start.path]);
  let frontier = [start.path];
  for (let d = 0; d < Math.min(Math.max(depth, 1), 3); d++) {
    const next = [];
    for (const p of frontier) {
      for (const n of adj.get(p) || []) {
        if (keep.has(n)) continue;
        keep.add(n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return {
    nodes: full.nodes.filter(n => keep.has(n.path)),
    edges: full.edges.filter(e => keep.has(e.source) && keep.has(e.target)),
  };
}

// ——— Рендер заметки в HTML (единая точка для SSR и API) ———

const renderCache = new Map(); // key: path:hash → { html, headings }

function resolveAssetFor(notePath) {
  return rel => {
    if (!rel) return null;
    // ![[img.png]] — Obsidian ищет по имени файла в любом месте vault
    const raw = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
    if (assetExists(raw)) return assetUrl(raw);
    const name = baseOf(raw).toLowerCase();
    const hit = listAssets().find(a => baseOf(a.path).toLowerCase() === name);
    return hit ? assetUrl(hit.path) : null;
  };
}

function renderBody(raw, notePath, { depth = 0, seen = new Set() } = {}) {
  const { body } = parseFrontmatter(raw);
  const opts = {
    currentPath: notePath,
    resolveWikiLink: link => {
      const t = link.target ? resolveTarget(link.target, notePath) : { slug: null, path: notePath };
      if (link.target && !t) return null;
      const target = t || { slug: noteByPath(notePath)?.slug };
      if (!target || !target.slug) return null;
      return `/notes/${target.slug}` + (link.heading ? `#${slugifyHeading(link.heading)}` : '');
    },
    resolveTag: tag => `/notes/tag/${encodeURIComponent(tag)}`,
    resolveAsset: resolveAssetFor(notePath),
    resolveTransclusion: link => {
      // ![[Заметка]] — вставляем содержимое цели (без рекурсии глубже второго уровня и без циклов)
      if (!link.target || depth >= 2) return null;
      const t = resolveTarget(link.target, notePath);
      if (!t || seen.has(t.path)) return null;
      let targetRaw;
      try {
        const file = get('SELECT file FROM notes WHERE path = ?', t.path);
        if (!file) return null;
        targetRaw = fs.readFileSync(absPath(file.file), 'utf8');
      } catch { return null; }
      const inner = renderBody(targetRaw, t.path, { depth: depth + 1, seen: new Set([...seen, t.path]) });
      return `<div class="transclusion" data-from="${t.path}">${inner.html}</div>`;
    },
  };
  const html = renderMarkdown(body, opts);
  const headings = [];
  for (const m of html.matchAll(/<h([1-6])\s+id="([^"]*)"[^>]*>([\s\S]*?)<\/h\1>/g)) {
    headings.push({ level: +m[1], id: m[2], text: m[3].replace(/<[^>]+>/g, '').trim() });
  }
  return { html, headings, body };
}

/**
 * Готовит заметку к отдаче: HTML, оглавление, исходящие и обратные ссылки, теги.
 * Результат кешируется по (путь + хеш), чтобы не рендерить одно и то же на каждый запрос.
 */
export function renderNote(note, { isAdmin = false } = {}) {
  const cacheKey = `${note.path}:${note.hash}`;
  let cached = renderCache.get(cacheKey);
  if (!cached) {
    const raw = readNoteRaw(note.path) ?? '';
    const { html, headings } = renderBody(raw, note.path);
    cached = { html, headings };
    renderCache.set(cacheKey, cached);
    if (renderCache.size > 200) renderCache.delete(renderCache.keys().next().value);
  }

  const outgoing = all(
    `SELECT target_raw, target_path, heading FROM note_links WHERE source_path = ? ORDER BY target_raw`,
    note.path
  ).map(l => {
    const t = l.target_path ? noteByPath(l.target_path, { isAdmin }) : null;
    return {
      title: t ? t.title : l.target_raw,
      slug: t ? t.slug : null,
      raw: l.target_raw,
      heading: l.heading || null,
      missing: !t,
    };
  });

  const backlinks = all(
    `SELECT DISTINCT n.path, n.slug, n.title, n.excerpt
     FROM note_links l JOIN notes n ON n.path = l.source_path
     WHERE l.target_path = ? AND n.visibility != 'private'
     ORDER BY n.title`,
    note.path
  ).map(n => ({ path: n.path, slug: n.slug, title: n.title, excerpt: n.excerpt }));

  return {
    note: publicNote(note),
    html: cached.html,
    headings: cached.headings,
    outgoing,
    backlinks,
    tags: tagsOf(note.path),
  };
}

/**
 * Рендер произвольного markdown в контексте заметки — для живого предпросмотра в админке.
 * Использует ровно тот же рендерер и резолверы, что и публичная страница, поэтому предпросмотр
 * не расходится с тем, что увидит читатель.
 */
export function renderPreview(notePath, content) {
  const { body } = parseFrontmatter(String(content ?? ''));
  const path = String(notePath || '').replace(/\\/g, '/').replace(/\.md$/i, '') || 'черновик';
  const { html, headings } = renderBody(body, path);
  return { html, headings };
}

/** Индекс всех заметок вместе со связями — для списков и панели автодополнения в админке. */
export function notesIndex({ isAdmin = false } = {}) {
  const notes = allNotes({ isAdmin });
  const links = new Map();
  for (const r of all('SELECT source_path, target_path FROM note_links WHERE target_path IS NOT NULL')) {
    if (!links.has(r.source_path)) links.set(r.source_path, []);
  }
  return notes.map(n => ({ ...n, outgoing: links.get(n.path)?.length || 0 }));
}

/** Сводка для админки/дашборда. */
export function vaultStats() {
  const notes = get('SELECT COUNT(*) AS c FROM notes')?.c || 0;
  const links = get('SELECT COUNT(*) AS c FROM note_links')?.c || 0;
  const broken = get('SELECT COUNT(*) AS c FROM note_links WHERE target_path IS NULL')?.c || 0;
  const tags = get('SELECT COUNT(DISTINCT tag) AS c FROM note_tags')?.c || 0;
  const orphans = get('SELECT COUNT(*) AS c FROM notes WHERE path NOT IN (SELECT source_path FROM note_links) AND path NOT IN (SELECT target_path FROM note_links WHERE target_path IS NOT NULL)')?.c || 0;
  return { notes, links, broken, tags, orphans, dir: VAULT_DIR };
}