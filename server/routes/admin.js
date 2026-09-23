// Админские маршруты /api/admin/* (раздел 8 ТЗ). Все мутации — под сессией и CSRF-токеном
// (проверяется middleware в index.js), действия пишутся в audit_log.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { get, all, run, tx, now, audit, getSettings, setSetting } from '../db.js';
import { HttpError, sendJson, str, slugify, rateLimit, serializeCookie, clientIp } from '../http.js';
import { config } from '../config.js';
import { attemptLogin, destroySession, requireAdmin, changePassword, verifyPassword, generateTotpSecret, verifyTotp, totpNow } from '../auth.js';
import { detectSourceFromUrl, probeUrl, testStorage, presignS3Get, presignS3Put, KIND_BY_EXT, MIME_BY_EXT } from '../sources.js';
import { processMaterial, sniffMime, sha256File, pdfPageCount } from '../convert.js';
import { invalidateTreeCache, materialPublic } from './public.js';
import { overview, topMaterials, topFolders, materialStats, searchStats, techStats, exportCsv, deadMaterials, surgeFolders } from '../stats.js';
import { cacheStats, clearCache } from '../cache.js';
import { runHealthCheckAll, checkMaterialHealth } from '../health.js';
import { syncVault, getSyncState, updateSyncSettings, testSyncConnection, restartAutoSync } from '../sync.js';

export function registerAdminRoutes(router) {
  // ——— Авторизация ———
  router.post('/api/admin/login', async (req, res) => {
    const key = 'login:' + (req.ip || 'x');
    if (!rateLimit(key, 10, 60_000)) throw new HttpError(429, 'Слишком много попыток входа. Подождите минуту.');
    const { login, password, totp } = req.jsonBody || {};
    const r = attemptLogin(str(login, 100), String(password || ''), str(totp, 10), req);
    if (r.needs2fa) return sendJson(res, 200, { needs2fa: true });
    const cookie = serializeCookie('lh_session', r.session.id, {
      maxAge: config.sessionTtlMs, secure: req.secure,
    });
    sendJson(res, 200, { ok: true, csrf: r.session.csrf }, { 'Set-Cookie': cookie });
  });

  router.post('/api/admin/logout', (req, res) => {
    destroySession(req, res);
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/admin/me', (req, res) => {
    const s = requireAdmin(req);
    const u = get('SELECT id, login, last_login_at, totp_secret FROM admin_users WHERE id = ?', s.user_id);
    sendJson(res, 200, { login: u.login, csrf: s.csrf, twoFactor: !!u.totp_secret, lastLogin: u.last_login_at });
  });

  // ——— Дашборд (раздел 8.1) ———
  router.get('/api/admin/dashboard', (req, res) => {
    requireAdmin(req);
    const ov = overview(30);
    let disk = { free: null, total: null, usedRatio: null };
    try {
      const st = fs.statfsSync(config.paths.data);
      disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize, usedRatio: 1 - (st.bavail * st.bsize) / (st.blocks * st.bsize || 1) };
    } catch { /* Windows без statfs — оставим null */ }
    const cache = cacheStats();
    const filesSize = get("SELECT COALESCE(SUM(size),0) AS s FROM materials WHERE source_type='local' AND status != 'deleted'").s;
    const alerts = {
      brokenLinks: all(`SELECT m.id, m.title, m.slug, lh.status, lh.error_msg FROM link_health lh JOIN materials m ON m.id=lh.material_id WHERE lh.status='broken' AND m.status!='deleted' LIMIT 10`),
      diskWarning: disk.usedRatio != null && disk.usedRatio > config.diskWarnRatio,
      deadMaterials: deadMaterials(90).slice(0, 10),
      surges: surgeFolders(7),
    };
    sendJson(res, 200, {
      overview: ov,
      topMaterials: topMaterials(30, 5),
      topFolders: topFolders(30, 5),
      system: { disk, cache, filesSize, storages: all('SELECT id, name, type, health_status, last_check_at FROM storages') },
      alerts,
      recentAudit: all('SELECT actor, action, entity, entity_id, created_at FROM audit_log ORDER BY id DESC LIMIT 12'),
      recentMaterials: all(`SELECT id, title, slug, kind, status, published_at FROM materials WHERE status != 'deleted' ORDER BY id DESC LIMIT 8`),
      counts: {
        materials: get("SELECT COUNT(*) c FROM materials WHERE status != 'deleted'").c,
        folders: get('SELECT COUNT(*) c FROM folders').c,
        trash: get("SELECT COUNT(*) c FROM materials WHERE status = 'deleted'").c,
      },
    });
  });

  // ——— Папки (раздел 8.2) ———
  router.get('/api/admin/folders', (req, res) => {
    requireAdmin(req);
    sendJson(res, 200, {
      folders: all(`SELECT f.*, (SELECT COUNT(*) FROM materials m WHERE m.folder_id=f.id AND m.status!='deleted') AS material_count FROM folders f WHERE f.deleted_at IS NULL ORDER BY f.position, f.title`),
      storages: all('SELECT id, name, type, is_default FROM storages'),
    });
  });

  function uniqueSlug(base, table, excludeId = null) {
    let slug = slugify(base), i = 2;
    while (get(`SELECT id FROM ${table} WHERE slug = ?${excludeId ? ' AND id != ?' : ''}`, ...(excludeId ? [slug, excludeId] : [slug]))) {
      slug = `${slugify(base)}-${i++}`;
    }
    return slug;
  }

  router.post('/api/admin/folders', (req, res) => {
    const s = requireAdmin(req);
    const b = req.jsonBody || {};
    const title = str(b.title, 200);
    if (!title) throw new HttpError(400, 'Название обязательно');
    const parentId = b.parent_id ? +b.parent_id : null;
    if (parentId && !get('SELECT id FROM folders WHERE id = ?', parentId)) throw new HttpError(400, 'Родительская папка не найдена');
    const slug = b.slug ? uniqueSlug(b.slug, 'folders') : uniqueSlug(title, 'folders');
    const pos = get('SELECT COALESCE(MAX(position),0)+1 AS p FROM folders WHERE parent_id IS ?', parentId)?.p ?? 0;
    const r = run('INSERT INTO folders(parent_id, slug, title, description, icon, color, position, visibility, default_storage_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      parentId, slug, title, str(b.description, 5000), str(b.icon, 40, 'book'), str(b.color, 20, '#5b5bd6'), pos,
      ['listed', 'unlisted', 'private'].includes(b.visibility) ? b.visibility : 'listed',
      b.default_storage_id ? +b.default_storage_id : null, now(), now());
    audit(s.user_id ? 'admin' : 'system', 'folder.create', 'folders', Number(r.lastInsertRowid), { title, slug });
    invalidateTreeCache();
    sendJson(res, 201, { ok: true, id: Number(r.lastInsertRowid), slug });
  });

  router.patch('/api/admin/folders/:id', (req, res) => {
    const s = requireAdmin(req);
    const f = get('SELECT * FROM folders WHERE id = ?', +req.params.id);
    if (!f) throw new HttpError(404, 'Папка не найдена');
    const b = req.jsonBody || {};
    const patch = {};
    for (const k of ['title', 'description', 'icon', 'color', 'visibility', 'position']) {
      if (b[k] !== undefined) patch[k] = ['title', 'description', 'icon', 'color', 'visibility'].includes(k) ? String(b[k]).slice(0, k === 'description' ? 5000 : 200) : +b[k] || 0;
    }
    if (b.parent_id !== undefined) {
      const pid = b.parent_id ? +b.parent_id : null;
      if (pid === f.id) throw new HttpError(400, 'Нельзя переместить папку в саму себя');
      if (pid) {
        // проверка цикла: pid не должен быть потомком f
        let cur = get('SELECT * FROM folders WHERE id = ?', pid);
        while (cur) {
          if (cur.id === f.id) throw new HttpError(400, 'Нельзя переместить папку в её потомка');
          cur = cur.parent_id ? get('SELECT * FROM folders WHERE id = ?', cur.parent_id) : null;
        }
      }
      patch.parent_id = pid;
    }
    if (b.default_storage_id !== undefined) patch.default_storage_id = b.default_storage_id ? +b.default_storage_id : null;
    if (b.slug) patch.slug = uniqueSlug(b.slug, 'folders', f.id);
    const keys = Object.keys(patch);
    if (keys.length) {
      run(`UPDATE folders SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=? WHERE id=?`, ...keys.map(k => patch[k]), now(), f.id);
      audit('admin', 'folder.update', 'folders', f.id, patch);
      invalidateTreeCache();
    }
    sendJson(res, 200, { ok: true, folder: get('SELECT * FROM folders WHERE id = ?', f.id) });
  });

  router.delete('/api/admin/folders/:id', (req, res) => {
    const s = requireAdmin(req);
    const f = get('SELECT * FROM folders WHERE id = ?', +req.params.id);
    if (!f) throw new HttpError(404, 'Папка не найдена');
    const childCount = get('SELECT COUNT(*) c FROM folders WHERE parent_id = ?', f.id).c;
    const matCount = get("SELECT COUNT(*) c FROM materials WHERE folder_id = ? AND status != 'deleted'", f.id).c;
    const force = req.query.force === '1';
    if ((childCount || matCount) && !force) {
      return sendJson(res, 409, { ok: false, error: 'not_empty', childCount, matCount, message: 'В папке есть содержимое. Переместите его или удалите принудительно.' });
    }
    if (force) {
      // Tombstone: материалы — в корзину, папка и потомки помечаются удалёнными
      // (строки остаются, чтобы не ломать FK у материалов в корзине)
      tx(() => {
        const killTree = fid => {
          for (const m of all('SELECT id FROM materials WHERE folder_id = ?', fid)) softDeleteMaterial(m.id);
          run('UPDATE folders SET deleted_at = ?, updated_at = ? WHERE id = ?', now(), now(), fid);
          for (const c of all('SELECT id FROM folders WHERE parent_id = ? AND deleted_at IS NULL', fid)) killTree(c.id);
        };
        killTree(f.id);
      });
    } else {
      run('UPDATE folders SET deleted_at = ?, updated_at = ? WHERE id = ?', now(), now(), f.id);
    }
    audit('admin', 'folder.delete', 'folders', f.id, { title: f.title, force });
    invalidateTreeCache();
    sendJson(res, 200, { ok: true });
  });

  // ——— Материалы (раздел 8.3) ———
  router.get('/api/admin/materials', (req, res) => {
    requireAdmin(req);
    const q = req.query;
    const where = [];
    const params = [];
    if (q.status === 'deleted') { where.push("m.status = 'deleted'"); }
    else if (q.status) { where.push('m.status = ?'); params.push(q.status); }
    else where.push("m.status != 'deleted'");
    if (q.folder_id) { where.push('(m.folder_id = ? OR m.folder_id IN (SELECT id FROM folders WHERE parent_id = ?))'); params.push(+q.folder_id, +q.folder_id); }
    if (q.kind) { where.push('m.kind = ?'); params.push(q.kind); }
    if (q.source_type) { where.push('m.source_type = ?'); params.push(q.source_type); }
    if (q.q) { where.push('(loweru(m.title) LIKE ? OR loweru(m.description) LIKE ?)'); params.push(`%${String(q.q).toLowerCase()}%`, `%${String(q.q).toLowerCase()}%`); }
    const sortMap = { date: 'm.published_at', title: 'm.title', size: 'm.size', views: 'm.views_count', kind: 'm.kind' };
    const sortCol = sortMap[q.sort] || 'm.published_at';
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
    const page = Math.max(1, +q.page || 1), perPage = Math.min(100, +q.per_page || 25);
    const total = get(`SELECT COUNT(*) c FROM materials m WHERE ${where.join(' AND ')}`, ...params).c;
    const rows = all(
      `SELECT m.*, f.title AS folder_title, f.slug AS folder_slug, f.color AS folder_color,
        (SELECT group_concat(t.name, ', ') FROM material_tags mt JOIN tags t ON t.id=mt.tag_id WHERE mt.material_id=m.id) AS tags,
        lh.status AS link_status
       FROM materials m JOIN folders f ON f.id=m.folder_id
       LEFT JOIN link_health lh ON lh.material_id = m.id
       WHERE ${where.join(' AND ')} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`,
      ...params, perPage, (page - 1) * perPage);
    sendJson(res, 200, { materials: rows.map(materialPublic).map((mp, i) => ({ ...mp, status: rows[i].status, link_status: rows[i].link_status, convert_status: rows[i].convert_status, source_type: rows[i].source_type, storage_id: rows[i].storage_id, file_path: rows[i].file_path ? path.basename(rows[i].file_path) : null })), total, page, perPage });
  });

  router.get('/api/admin/materials/:id', (req, res) => {
    requireAdmin(req);
    const m = get(`SELECT m.*, f.title AS folder_title,
      (SELECT group_concat(t.name, ', ') FROM material_tags mt JOIN tags t ON t.id=mt.tag_id WHERE mt.material_id=m.id) AS tags
      FROM materials m JOIN folders f ON f.id=m.folder_id WHERE m.id = ?`, +req.params.id);
    if (!m) throw new HttpError(404, 'Материал не найден');
    const health = get('SELECT * FROM link_health WHERE material_id = ?', m.id);
    sendJson(res, 200, { material: { ...materialPublic(m), status: m.status, source_config: JSON.parse(m.source_config || '{}'), file_name: m.file_path ? path.basename(m.file_path) : null, checksum: m.checksum }, health, stats: materialStats(m.id, 90) });
  });

  router.patch('/api/admin/materials/:id', (req, res) => {
    requireAdmin(req);
    const m = get('SELECT * FROM materials WHERE id = ?', +req.params.id);
    if (!m) throw new HttpError(404, 'Материал не найден');
    const b = req.jsonBody || {};
    const patch = {};
    for (const k of ['title', 'description', 'visibility', 'status', 'kind']) if (b[k] !== undefined) patch[k] = String(b[k]).slice(0, k === 'description' ? 10000 : 200);
    for (const k of ['allow_download', 'noindex']) if (b[k] !== undefined) patch[k] = b[k] ? 1 : 0;
    if (b.folder_id !== undefined && get('SELECT id FROM folders WHERE id = ?', +b.folder_id)) patch.folder_id = +b.folder_id;
    if (b.slug) patch.slug = uniqueSlug(b.slug, 'materials', m.id);
    if (b.status === 'published' && !m.published_at) patch.published_at = now();
    if (b.source_config) patch.source_config = JSON.stringify(b.source_config);
    if (b.tags !== undefined) patch.__tags = b.tags;
    const keys = Object.keys(patch).filter(k => !k.startsWith('__'));
    if (keys.length) run(`UPDATE materials SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=? WHERE id=?`, ...keys.map(k => patch[k]), now(), m.id);
    if (patch.__tags) setTags(m.id, patch.__tags);
    audit('admin', 'material.update', 'materials', m.id, { ...patch, __tags: undefined });
    invalidateTreeCache();
    sendJson(res, 200, { ok: true, material: get('SELECT * FROM materials WHERE id = ?', m.id) });
  });

  function setTags(materialId, tags) {
    run('DELETE FROM material_tags WHERE material_id = ?', materialId);
    for (const t of new Set(tags.map(x => str(x, 50).toLowerCase()).filter(Boolean))) {
      run('INSERT OR IGNORE INTO tags(name) VALUES(?)', t);
      const tagId = get('SELECT id FROM tags WHERE name = ?', t).id;
      run('INSERT OR IGNORE INTO material_tags(material_id, tag_id) VALUES(?,?)', materialId, tagId);
    }
  }

  function softDeleteMaterial(id) {
    run("UPDATE materials SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?", now(), now(), id);
  }

  router.delete('/api/admin/materials/:id', (req, res) => {
    requireAdmin(req);
    const m = get('SELECT * FROM materials WHERE id = ?', +req.params.id);
    if (!m) throw new HttpError(404, 'Материал не найден');
    if (req.query.purge === '1') {
      // Безвозвратное удаление (из корзины)
      if (m.file_path) try { fs.rmSync(m.file_path, { force: true }); } catch {}
      if (m.poster_path) try { fs.rmSync(m.poster_path, { force: true }); } catch {}
      if (m.converted_path) try { fs.rmSync(path.dirname(m.converted_path), { recursive: true, force: true }); } catch {}
      run('DELETE FROM materials WHERE id = ?', m.id);
      audit('admin', 'material.purge', 'materials', m.id, { title: m.title });
    } else {
      softDeleteMaterial(m.id);
      audit('admin', 'material.soft_delete', 'materials', m.id, { title: m.title });
    }
    invalidateTreeCache();
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/admin/materials/:id/restore', (req, res) => {
    requireAdmin(req);
    const m = get('SELECT * FROM materials WHERE id = ?', +req.params.id);
    if (!m) throw new HttpError(404, 'Материал не найден');
    run("UPDATE materials SET status = 'published', deleted_at = NULL, updated_at = ? WHERE id = ?", now(), m.id);
    audit('admin', 'material.restore', 'materials', m.id, { title: m.title });
    invalidateTreeCache();
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/admin/materials/:id/stats', (req, res) => {
    requireAdmin(req);
    sendJson(res, 200, materialStats(+req.params.id, 90));
  });

  // Массовые операции (раздел 8.2/8.3)
  router.post('/api/admin/materials/bulk', (req, res) => {
    requireAdmin(req);
    const { ids, action, payload } = req.jsonBody || {};
    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'Пустой список');
    const idList = ids.map(x => +x).filter(Number.isFinite);
    let done = 0;
    tx(() => {
      for (const id of idList) {
        if (!get('SELECT id FROM materials WHERE id = ?', id)) continue;
        if (action === 'move' && payload?.folder_id && get('SELECT id FROM folders WHERE id = ?', +payload.folder_id)) {
          run('UPDATE materials SET folder_id = ?, updated_at = ? WHERE id = ?', +payload.folder_id, now(), id);
        } else if (action === 'unpublish') run("UPDATE materials SET status = 'hidden', updated_at = ? WHERE id = ?", now(), id);
        else if (action === 'publish') run("UPDATE materials SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?", now(), now(), id);
        else if (action === 'delete') softDeleteMaterial(id);
        else if (action === 'restore') run("UPDATE materials SET status='published', deleted_at=NULL, updated_at=? WHERE id=?", now(), id);
        else if (action === 'add_tags' && Array.isArray(payload?.tags)) {
          for (const t of payload.tags.map(x => str(x, 50).toLowerCase()).filter(Boolean)) {
            run('INSERT OR IGNORE INTO tags(name) VALUES(?)', t);
            run('INSERT OR IGNORE INTO material_tags(material_id, tag_id) VALUES(?,?)', id, get('SELECT id FROM tags WHERE name = ?', t).id);
          }
        } else continue;
        done++;
      }
    });
    audit('admin', 'material.bulk', 'materials', null, { action, count: done });
    invalidateTreeCache();
    sendJson(res, 200, { ok: true, done });
  });

  // ——— Загрузка файлов (раздел 7.4): PUT raw-body с потоковой записью ———
  router.put('/api/admin/upload', async (req, res) => {
    requireAdmin(req);
    const folderId = +req.query.folder_id;
    const folder = get('SELECT * FROM folders WHERE id = ?', folderId);
    if (!folder) throw new HttpError(400, 'Папка не найдена');
    const fileName = str(req.query.filename || req.headers['x-filename'] || 'upload.bin', 250);
    const ext = path.extname(fileName).toLowerCase().replace('.', '');
    const settings = getSettings();
    const maxBytes = Math.min(config.maxUploadBytes, (settings.max_upload_mb || 2048) * 1024 * 1024);
    if (!settings.allowed_ext.includes(ext)) throw new HttpError(400, `Расширение .${ext} не разрешено. Допустимые: ${settings.allowed_ext.join(', ')}`);

    // потоковая запись на диск без загрузки в память + контроль лимита
    const tmp = path.join(config.paths.files, `.upload-${crypto.randomBytes(6).toString('hex')}.part`);
    const out = fs.createWriteStream(tmp);
    const hash = crypto.createHash('sha256');
    let head = null, size = 0, aborted = false;
    try {
      for await (const chunk of req) {
        if (!head) head = Buffer.from(chunk.subarray(0, 16));
        size += chunk.length;
        if (size > maxBytes) { aborted = true; break; }
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
      }
    } finally { out.end(); await new Promise(r => out.once('close', r)); }
    if (aborted) { fs.rmSync(tmp, { force: true }); throw new HttpError(413, `Файл больше лимита (${Math.round(maxBytes / 1048576)} МБ)`); }
    if (size === 0) { fs.rmSync(tmp, { force: true }); throw new HttpError(400, 'Пустой файл'); }

    // Проверка MIME по magic bytes (раздел 7.4)
    const sniffed = sniffMime(head || Buffer.alloc(0), ext);
    const expectedMime = MIME_BY_EXT[ext];
    if (sniffed && expectedMime && sniffed !== expectedMime && !(sniffed === 'application/zip' && ['docx', 'pptx', 'xlsx'].includes(ext))) {
      fs.rmSync(tmp, { force: true });
      throw new HttpError(400, `Содержимое файла (${sniffed}) не соответствует расширению .${ext}`);
    }
    const checksum = hash.digest('hex');

    // Дедупликация по checksum
    const dup = get("SELECT id, title FROM materials WHERE checksum = ? AND status != 'deleted'", checksum);

    const kind = KIND_BY_EXT[ext] || 'link';
    const title = str(req.query.title, 300) || path.basename(fileName, path.extname(fileName)).replace(/[_-]+/g, ' ').trim();
    const slug = uniqueSlug(title, 'materials');
    // Дедупликация по checksum (раздел 7.4): тот же файл не занимает место повторно
    let dest;
    if (dup) {
      const dupRow = get('SELECT file_path FROM materials WHERE id = ?', dup.id);
      dest = dupRow?.file_path || path.join(config.paths.files, `${slug}.${ext}`);
      if (dupRow?.file_path) fs.rmSync(tmp, { force: true });
      else fs.renameSync(tmp, dest);
    } else {
      dest = path.join(config.paths.files, `${slug}.${ext}`);
      fs.renameSync(tmp, dest);
    }
    const pageCount = kind === 'pdf' ? await pdfPageCount(dest) : null;

    const r = run(
      `INSERT INTO materials(folder_id, slug, title, description, kind, mime, size, source_type, source_config, storage_id,
        checksum, page_count, status, visibility, published_at, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      folderId, slug, title, str(req.query.description, 10000), kind, sniffed || expectedMime || 'application/octet-stream',
      size, 'local', JSON.stringify({ mode: 'proxy' }), folder.default_storage_id ?? get('SELECT id FROM storages WHERE is_default=1')?.id ?? null,
      checksum, pageCount, 'published', 'listed', now(), now(), now());
    const id = Number(r.lastInsertRowid);
    run('UPDATE materials SET file_path = ? WHERE id = ?', dest, id);
    if (req.query.tags) setTags(id, String(req.query.tags).split(',').map(s => s.trim()).filter(Boolean));
    audit('admin', 'material.upload', 'materials', id, { title, size, checksum, duplicateOf: dup?.id ?? null });
    invalidateTreeCache();
    processMaterial(id).catch(() => {});
    sendJson(res, 201, { ok: true, id, slug, size, checksum, duplicateOf: dup ? { id: dup.id, title: dup.title } : null });
  });

  // ——— Внешний источник (раздел 7.5): вставил ссылку → определили тип, проверили, вытянули размер/MIME ———
  router.post('/api/admin/materials/attach-external', async (req, res) => {
    requireAdmin(req);
    const b = req.jsonBody || {};
    const url = str(b.url, 2000);
    if (!url) throw new HttpError(400, 'Укажите ссылку');
    const folder = get('SELECT * FROM folders WHERE id = ?', +b.folder_id);
    if (!folder) throw new HttpError(400, 'Папка не найдена');

    const detected = detectSourceFromUrl(url);
    let probe = { ok: true };
    if (detected.source_type === 'url') {
      probe = await probeUrl(url);
      if (!probe.ok) throw new HttpError(400, `Источник недоступен (HTTP ${probe.status || '—'}): ${probe.error || ''}`);
    }
    const kind = b.kind || (probe.mime && probe.mime.startsWith('video/') ? 'video' : detected.kind) || 'link';
    const extGuess = kind === 'pdf' ? 'pdf' : kind === 'video' ? 'mp4' : '';
    const title = str(b.title, 300) || decodeURIComponent(path.basename(new URL(url).pathname, `.${extGuess}`)).replace(/[_-]+/g, ' ').trim() || 'Внешний материал';
    const slug = uniqueSlug(title, 'materials');
    const sourceConfig = { ...(b.source_config || {}), ...detected.source_config, url: detected.source_config?.url || url };
    if (b.mode) sourceConfig.mode = b.mode;
    const r = run(
      `INSERT INTO materials(folder_id, slug, title, description, kind, mime, size, source_type, source_config, storage_id,
        status, visibility, published_at, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      folder.id, slug, title, str(b.description, 10000), kind, probe.mime || MIME_BY_EXT[extGuess] || 'application/octet-stream',
      probe.size || 0, detected.source_type, JSON.stringify(sourceConfig), folder.default_storage_id ?? null,
      b.status === 'hidden' ? 'hidden' : 'published', b.visibility || 'listed', now(), now(), now());
    const id = Number(r.lastInsertRowid);
    if (b.tags) setTags(id, b.tags);
    audit('admin', 'material.attach_external', 'materials', id, { url, source_type: detected.source_type });
    invalidateTreeCache();
    checkMaterialHealth(id).catch(() => {});
    sendJson(res, 201, { ok: true, id, slug, source_type: detected.source_type, kind, size: probe.size, mime: probe.mime });
  });

  // Прямая загрузка в S3: presigned PUT (раздел 7.4)
  router.post('/api/admin/s3/presign-put', (req, res) => {
    requireAdmin(req);
    const { storage_id, filename, content_type } = req.jsonBody || {};
    const st = get('SELECT * FROM storages WHERE id = ? AND type = ?', +storage_id, 's3');
    if (!st) throw new HttpError(404, 'S3-хранилище не найдено');
    const key = `uploads/${now()}-${slugify(filename || 'file')}`;
    const url = presignS3Put(st, key, content_type || 'application/octet-stream');
    sendJson(res, 200, { url, key });
  });

  // ——— Хранилища (раздел 7.5) ———
  router.get('/api/admin/storages', (req, res) => {
    requireAdmin(req);
    const rows = all('SELECT * FROM storages ORDER BY is_default DESC, name').map(s => ({
      ...s,
      config: (() => { const c = JSON.parse(s.config || '{}'); if (c.secretKey) c.secretKey = c.secretKey.startsWith('env:') ? c.secretKey : '••••'; if (c.password) c.password = c.password.startsWith('env:') ? c.password : '••••'; return c; })(),
      material_count: get('SELECT COUNT(*) c FROM materials WHERE storage_id = ? AND status != ?', s.id, 'deleted').c,
    }));
    sendJson(res, 200, { storages: rows });
  });

  router.post('/api/admin/storages', (req, res) => {
    requireAdmin(req);
    const b = req.jsonBody || {};
    const name = str(b.name, 100);
    if (!name || !['local', 's3', 'webdav', 'url'].includes(b.type)) throw new HttpError(400, 'Некорректные данные хранилища');
    if (get('SELECT id FROM storages WHERE name = ?', name)) throw new HttpError(409, 'Хранилище с таким названием уже есть');
    const cfg = sanitizeStorageConfig(b.config || {});
    const r = run('INSERT INTO storages(name, type, config, is_default, health_status) VALUES(?,?,?,?,?)',
      name, b.type, JSON.stringify(cfg), b.is_default ? 1 : 0, 'unknown');
    if (b.is_default) run('UPDATE storages SET is_default = 0 WHERE id != ?', Number(r.lastInsertRowid));
    audit('admin', 'storage.create', 'storages', Number(r.lastInsertRowid), { name, type: b.type });
    sendJson(res, 201, { ok: true, id: Number(r.lastInsertRowid) });
  });

  router.patch('/api/admin/storages/:id', (req, res) => {
    requireAdmin(req);
    const st = get('SELECT * FROM storages WHERE id = ?', +req.params.id);
    if (!st) throw new HttpError(404, 'Хранилище не найдено');
    const b = req.jsonBody || {};
    const cfg = b.config ? sanitizeStorageConfig(b.config, JSON.parse(st.config || '{}')) : undefined;
    run('UPDATE storages SET name=?, config=?, is_default=? WHERE id=?',
      b.name ? str(b.name, 100) : st.name,
      cfg ? JSON.stringify(cfg) : st.config,
      b.is_default !== undefined ? (b.is_default ? 1 : 0) : st.is_default, st.id);
    if (b.is_default) run('UPDATE storages SET is_default = 0 WHERE id != ?', st.id);
    audit('admin', 'storage.update', 'storages', st.id, { name: b.name });
    sendJson(res, 200, { ok: true });
  });

  router.delete('/api/admin/storages/:id', (req, res) => {
    requireAdmin(req);
    const st = get('SELECT * FROM storages WHERE id = ?', +req.params.id);
    if (!st) throw new HttpError(404, 'Хранилище не найдено');
    const used = get("SELECT COUNT(*) c FROM materials WHERE storage_id = ? AND status != 'deleted'", st.id).c;
    if (used) throw new HttpError(409, `Хранилище используется ${used} материалами — сначала перепривяжите их`);
    run('DELETE FROM storages WHERE id = ?', st.id);
    audit('admin', 'storage.delete', 'storages', st.id, { name: st.name });
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/admin/storages/:id/test', async (req, res) => {
    requireAdmin(req);
    const st = get('SELECT * FROM storages WHERE id = ?', +req.params.id);
    if (!st) throw new HttpError(404, 'Хранилище не найдено');
    const r = await testStorage(st);
    run('UPDATE storages SET health_status = ?, last_check_at = ? WHERE id = ?', r.ok ? 'ok' : 'broken', now(), st.id);
    sendJson(res, 200, r);
  });

  // Ручной health-check всех внешних ссылок (раздел 7.3)
  router.post('/api/admin/health-check', async (req, res) => {
    requireAdmin(req);
    const r = await runHealthCheckAll();
    audit('admin', 'health.check', 'materials', null, r);
    sendJson(res, 200, r);
  });

  function sanitizeStorageConfig(cfg, prev = {}) {
    const out = {};
    for (const k of ['endpoint', 'region', 'bucket', 'accessKey', 'secretKey', 'pathStyle', 'url', 'username', 'password', 'dir', 'testKey', 'mode']) {
      if (cfg[k] === undefined) { if (prev[k] !== undefined) out[k] = prev[k]; continue; }
      // «••••» — маска из GET: оставляем прежнее значение
      if (cfg[k] === '••••' && prev[k] !== undefined) { out[k] = prev[k]; continue; }
      out[k] = cfg[k];
    }
    return out;
  }

  // ——— Статистика (раздел 8.4) ———
  router.get('/api/admin/stats/overview', (req, res) => {
    requireAdmin(req);
    const days = Math.min(365, Math.max(1, +req.query.days || 30));
    sendJson(res, 200, overview(days));
  });
  router.get('/api/admin/stats/top', (req, res) => {
    requireAdmin(req);
    const days = Math.min(365, +req.query.days || 30);
    sendJson(res, 200, { materials: topMaterials(days, 20), folders: topFolders(days, 20) });
  });
  router.get('/api/admin/stats/search', (req, res) => {
    requireAdmin(req);
    sendJson(res, 200, searchStats(Math.min(365, +req.query.days || 30), 30));
  });
  router.get('/api/admin/stats/tech', (req, res) => {
    requireAdmin(req);
    sendJson(res, 200, techStats(Math.min(365, +req.query.days || 30)));
  });
  router.get('/api/admin/stats/export.csv', (req, res) => {
    requireAdmin(req);
    const csv = exportCsv(Math.min(365, +req.query.days || 90));
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="lab-hub-stats-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    res.end('\uFEFF' + csv); // BOM для Excel
  });

  // ——— Корзина и журнал (раздел 10, экран 15) ———
  router.get('/api/admin/trash', (req, res) => {
    requireAdmin(req);
    sendJson(res, 200, {
      items: all(`SELECT m.id, m.title, m.slug, m.kind, m.deleted_at, f.title AS folder_title
                  FROM materials m JOIN folders f ON f.id=m.folder_id WHERE m.status='deleted' ORDER BY m.deleted_at DESC LIMIT 200`),
      purgeAfterDays: 30,
    });
  });
  router.get('/api/admin/audit', (req, res) => {
    requireAdmin(req);
    sendJson(res, 200, { items: all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300') });
  });

  // ——— Настройки (раздел 8.5) ———
  router.get('/api/admin/settings', (req, res) => {
    requireAdmin(req);
    const u = get('SELECT login, totp_secret, last_login_at FROM admin_users LIMIT 1');
    sendJson(res, 200, {
      settings: getSettings(),
      account: { login: u?.login, twoFactor: !!u?.totp_secret, lastLogin: u?.last_login_at },
      sessions: all('SELECT id, ua, created_at, expires_at FROM sessions ORDER BY created_at DESC LIMIT 20'),
    });
  });

  router.put('/api/admin/settings', (req, res) => {
    requireAdmin(req);
    const b = req.jsonBody || {};
    const allowed = ['site_name', 'site_description', 'footer_note', 'accent_color', 'default_theme', 'allow_download', 'public_search', 'global_noindex', 'max_upload_mb', 'closed_mode', 'invite_code', 'allowed_ext'];
    const changed = [];
    for (const k of allowed) {
      if (b[k] === undefined) continue;
      setSetting(k, b[k]);
      changed.push(k);
    }
    if (changed.includes('accent_color') && !/^#[0-9a-fA-F]{6}$/.test(String(getSettings().accent_color || ''))) {
      setSetting('accent_color', '#5b5bd6');
    }
    audit('admin', 'settings.update', 'settings', null, { changed });
    sendJson(res, 200, { ok: true, settings: getSettings() });
  });

  // ——— Учётка: пароль, 2FA, сессии ———
  router.post('/api/admin/account/password', (req, res) => {
    const s = requireAdmin(req);
    const { oldPassword, newPassword } = req.jsonBody || {};
    changePassword(s.user_id, String(oldPassword || ''), String(newPassword || ''), s.id);
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/admin/account/2fa/setup', (req, res) => {
    const s = requireAdmin(req);
    const u = get('SELECT * FROM admin_users WHERE id = ?', s.user_id);
    if (u.totp_secret) throw new HttpError(400, '2FA уже включена');
    const secret = generateTotpSecret();
    run('UPDATE admin_users SET totp_secret = ? WHERE id = ?', 'pending:' + secret, u.id);
    sendJson(res, 200, {
      secret,
      otpauth: `otpauth://totp/LabHub:${u.login}?secret=${secret}&issuer=LabHub&period=30&digits=6`,
      currentCode: totpNow(secret), // для быстрой проверки в демо
    });
  });

  router.post('/api/admin/account/2fa/confirm', (req, res) => {
    const s = requireAdmin(req);
    const u = get('SELECT * FROM admin_users WHERE id = ?', s.user_id);
    if (!u.totp_secret?.startsWith('pending:')) throw new HttpError(400, 'Сначала запросите настройку 2FA');
    const secret = u.totp_secret.slice(8);
    if (!verifyTotp(secret, String(req.jsonBody?.code || ''))) throw new HttpError(400, 'Неверный код — проверьте время на устройстве');
    run('UPDATE admin_users SET totp_secret = ? WHERE id = ?', secret, u.id);
    audit('admin', 'account.2fa_enabled', 'admin_users', u.id, {});
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/admin/account/2fa/disable', (req, res) => {
    const s = requireAdmin(req);
    const u = get('SELECT * FROM admin_users WHERE id = ?', s.user_id);
    if (!u.totp_secret) throw new HttpError(400, '2FA не включена');
    if (!verifyPassword(String(req.jsonBody?.password || ''), u.password_hash)) throw new HttpError(400, 'Неверный пароль');
    run('UPDATE admin_users SET totp_secret = NULL WHERE id = ?', u.id);
    audit('admin', 'account.2fa_disabled', 'admin_users', u.id, {});
    sendJson(res, 200, { ok: true });
  });

  router.delete('/api/admin/account/sessions/:id', (req, res) => {
    const s = requireAdmin(req);
    if (req.params.id === s.id) throw new HttpError(400, 'Нельзя завершить текущую сессию');
    run('DELETE FROM sessions WHERE id = ? AND user_id = ?', str(req.params.id, 100), s.user_id);
    sendJson(res, 200, { ok: true });
  });

  // ——— Экспорт/импорт конфигурации каталога (раздел 8.5) ———
  router.get('/api/admin/export/catalog', (req, res) => {
    requireAdmin(req);
    const data = {
      version: 1, exported_at: new Date().toISOString(),
      folders: all('SELECT * FROM folders'),
      materials: all('SELECT * FROM materials').map(m => ({ ...m, file_path: m.file_path ? path.basename(m.file_path) : null })),
      tags: all('SELECT * FROM tags'),
      material_tags: all('SELECT * FROM material_tags'),
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="lab-hub-catalog-${new Date().toISOString().slice(0, 10)}.json"` });
    res.end(JSON.stringify(data, null, 2));
  });

  router.post('/api/admin/import/catalog', (req, res) => {
    requireAdmin(req);
    const data = req.jsonBody;
    if (!data || !Array.isArray(data.folders)) throw new HttpError(400, 'Некорректный файл каталога');
    let folders = 0, materials = 0;
    tx(() => {
      for (const f of data.folders) {
        run(`INSERT OR REPLACE INTO folders(id, parent_id, slug, title, description, icon, color, position, visibility, created_at, updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)`, f.id, f.parent_id, f.slug, f.title, f.description || '', f.icon || 'book', f.color || '#5b5bd6', f.position || 0, f.visibility || 'listed', f.created_at || now(), now());
        folders++;
      }
      for (const m of data.materials) {
        run(`INSERT OR REPLACE INTO materials(id, folder_id, slug, title, description, kind, mime, size, source_type, source_config, storage_id, checksum, page_count, duration_sec, poster_path, file_path, converted_path, convert_status, status, visibility, allow_download, noindex, views_count, reads_count, downloads_count, published_at, created_at, updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          m.id, m.folder_id, m.slug, m.title, m.description || '', m.kind, m.mime || '', m.size || 0, m.source_type || 'local', m.source_config || '{}', m.storage_id, m.checksum, m.page_count, m.duration_sec, m.poster_path, null, null, m.convert_status || 'none', m.status || 'published', m.visibility || 'listed', m.allow_download ?? 1, m.noindex ?? 0, m.views_count || 0, m.reads_count || 0, m.downloads_count || 0, m.published_at, m.created_at || now(), now());
        materials++;
      }
    });
    audit('admin', 'catalog.import', 'folders', null, { folders, materials });
    invalidateTreeCache();
    sendJson(res, 200, { ok: true, folders, materials, note: 'Файлы материалов не импортируются — только метаданные' });
  });

  // ——— Кеш ———
  router.post('/api/admin/cache/clear', (req, res) => {
    requireAdmin(req);
    clearCache();
    audit('admin', 'cache.clear', 'settings', null, {});
    sendJson(res, 200, { ok: true });
  });

  // ——— Синхронизация vault с Obsidian Git-репозиторием ———
  router.get('/api/admin/vault/sync/state', (req, res) => {
    requireAdmin(req);
    sendJson(res, 200, getSyncState());
  });

  router.post('/api/admin/vault/sync/test', async (req, res) => {
    requireAdmin(req);
    const { url } = req.jsonBody || {};
    if (!url) throw new HttpError(400, 'Укажите URL репозитория');
    const result = await testSyncConnection(String(url));
    sendJson(res, 200, result);
  });

  router.post('/api/admin/vault/sync/settings', (req, res) => {
    requireAdmin(req);
    const b = req.jsonBody || {};
    const settings = {
      enabled: !!b.enabled,
      url: String(b.url || '').trim(),
      interval: Math.max(1, Math.min(1440, +(b.interval || 15))),
      autoSync: !!b.autoSync,
    };
    updateSyncSettings(settings);
    restartAutoSync();
    audit('admin', 'vault_sync.settings', 'vault', null, settings);
    sendJson(res, 200, { ok: true, settings });
  });

  router.post('/api/admin/vault/sync/now', async (req, res) => {
    requireAdmin(req);
    try {
      const result = await syncVault({ force: true });
      audit('admin', 'vault_sync.manual', 'vault', null, result);
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      throw new HttpError(500, err.message);
    }
  });
}
