// Публичные маршруты (разделы 4, 9.3 ТЗ). Видимость: listed — всем, unlisted — по прямой
// ссылке, private — только админу (в публичном API возвращает 404).
import path from 'node:path';
import fs from 'node:fs';
import { get, all, run, now, getSettings, getSetting } from '../db.js';
import { HttpError, sendJson, rateLimit, str } from '../http.js';
import { resolveSource, streamLocalFile, streamRemote } from '../sources.js';
import { searchMaterials, suggest } from '../search.js';
import { ingestEvents, logSearch } from '../stats.js';
import { config } from '../config.js';

let treeCache = { at: 0, data: null };

export function invalidateTreeCache() { treeCache = { at: 0, data: null }; }

export function materialPublic(m) {
  return {
    id: m.id, slug: m.slug, title: m.title, description: m.description,
    kind: m.kind, mime: m.mime, size: m.size,
    source_type: m.source_type,
    mode: (JSON.parse(m.source_config || '{}').mode) || null,
    page_count: m.page_count, duration_sec: m.duration_sec,
    poster: m.poster_path ? `/api/stream/${m.id}?asset=poster` : null,
    convert_status: m.convert_status,
    allow_download: !!m.allow_download && !!getSettings().allow_download,
    visibility: m.visibility,
    views_count: m.views_count, reads_count: m.reads_count, downloads_count: m.downloads_count,
    published_at: m.published_at,
    folder_id: m.folder_id,
    tags: m.tags ? String(m.tags).split(', ').filter(Boolean) : [],
    folder_title: m.folder_title, folder_slug: m.folder_slug, folder_color: m.folder_color,
  };
}

function visibleMaterial(m, isAdmin = false) {
  if (m.status === 'deleted') return false;
  if (isAdmin) return true;
  if (m.status !== 'published') return false;
  if (m.visibility === 'private') return false;
  return true; // listed и unlisted доступны по прямой ссылке
}

function fetchMaterial(slugOrId, isAdmin = false) {
  const isNum = /^\d+$/.test(String(slugOrId));
  const m = get(
    `SELECT m.*, f.title AS folder_title, f.slug AS folder_slug, f.color AS folder_color,
      (SELECT group_concat(t.name, ', ') FROM material_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.material_id = m.id) AS tags
     FROM materials m JOIN folders f ON f.id = m.folder_id WHERE m.${isNum ? 'id' : 'slug'} = ?`,
    isNum ? +slugOrId : slugOrId
  );
  if (!m || !visibleMaterial(m, isAdmin)) throw new HttpError(404, 'Материал недоступен', 'not_found');
  return m;
}

function folderBreadcrumb(folderId) {
  const crumbs = [];
  let f = get('SELECT * FROM folders WHERE id = ? AND deleted_at IS NULL', folderId);
  while (f) {
    crumbs.unshift({ slug: f.slug, title: f.title });
    f = f.parent_id ? get('SELECT * FROM folders WHERE id = ? AND deleted_at IS NULL', f.parent_id) : null;
  }
  return crumbs;
}

export function registerPublicRoutes(router) {
  // ——— Дерево папок одним запросом (раздел 4.2), кешируется ———
  router.get('/api/folders/tree', (req, res) => {
    const isAdmin = req.admin;
    if (!isAdmin && treeCache.data && now() - treeCache.at < 60_000) {
      return sendJson(res, 200, treeCache.data);
    }
    const folders = all(`SELECT f.*, (
        SELECT COUNT(*) FROM materials m WHERE m.folder_id = f.id AND m.status = 'published'
          AND (${isAdmin ? '1=1' : "m.visibility = 'listed'"})
      ) AS material_count
      FROM folders f WHERE f.deleted_at IS NULL AND ${isAdmin ? '1=1' : "f.visibility != 'private'"} ORDER BY f.position, f.title`);
    // Вложенный подсчёт (папка + все подпапки)
    const byId = new Map(folders.map(f => [f.id, { ...f, children: [], total_count: f.material_count }]));
    const roots = [];
    for (const f of byId.values()) {
      if (f.parent_id && byId.has(f.parent_id)) byId.get(f.parent_id).children.push(f);
      else roots.push(f);
    }
    (function rollUp(list) {
      for (const f of list) {
        f.children.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title, 'ru'));
        rollUp(f.children);
        f.total_count = f.material_count + f.children.reduce((s, c) => s + c.total_count, 0);
      }
    })(roots);
    const data = { folders: roots };
    if (!isAdmin) treeCache = { at: now(), data };
    sendJson(res, 200, data);
  });

  // ——— Страница папки (раздел 4.3) ———
  router.get('/api/folders/:slug', (req, res) => {
    const isAdmin = !!req.admin;
    const f = get('SELECT * FROM folders WHERE slug = ? AND deleted_at IS NULL', req.params.slug);
    if (!f || (!isAdmin && f.visibility === 'private')) throw new HttpError(404, 'Папка не найдена', 'not_found');
    const vis = isAdmin ? '' : `AND m.visibility = 'listed' AND m.status = 'published'`;
    const materials = all(
      `SELECT m.*, (SELECT group_concat(t.name, ', ') FROM material_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.material_id = m.id) AS tags
       FROM materials m WHERE m.folder_id = ? AND m.status != 'deleted' ${vis} ORDER BY m.published_at DESC`, f.id);
    const children = all(`SELECT * FROM folders WHERE parent_id = ? AND deleted_at IS NULL AND ${isAdmin ? '1=1' : "visibility != 'private'"} ORDER BY position, title`, f.id);
    sendJson(res, 200, {
      folder: f,
      breadcrumb: folderBreadcrumb(f.id),
      children,
      materials: materials.map(materialPublic),
    });
  });

  // ——— Карточка материала (раздел 4.4) + похожие ———
  router.get('/api/materials/:slug', (req, res) => {
    const isAdmin = !!req.admin;
    const m = fetchMaterial(req.params.slug, isAdmin);
    const related = all(
      `SELECT m.*, f.title AS folder_title, f.slug AS folder_slug, f.color AS folder_color,
        (SELECT group_concat(t.name, ', ') FROM material_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.material_id = m.id) AS tags
       FROM materials m JOIN folders f ON f.id = m.folder_id
       WHERE m.folder_id = ? AND m.id != ? AND m.status = 'published' AND m.visibility = 'listed'
       ORDER BY m.published_at DESC LIMIT 4`, m.folder_id, m.id);
    sendJson(res, 200, {
      material: materialPublic(m),
      breadcrumb: folderBreadcrumb(m.folder_id),
      related: related.map(materialPublic),
      streamUrl: `/api/stream/${m.id}`,
      viewerUrl: (m.kind === 'pdf' || (m.kind === 'docx' && m.convert_status === 'ready')) ? `/view/${m.slug}` : null,
    });
  });

  // ——— Поиск (раздел 4.5) с логированием запросов ———
  router.get('/api/search', (req, res) => {
    if (!getSettings().public_search) throw new HttpError(403, 'Поиск отключён');
    const q = str(req.query.q || '', 200);
    if (!q) return sendJson(res, 200, { query: q, results: [], suggestions: [] });
    const key = req.ip || 'anon';
    if (!rateLimit('search:' + key, 60, 60_000)) throw new HttpError(429, 'Слишком много запросов');
    const results = searchMaterials(q, { limit: 30, includeUnlisted: false });
    logSearch(q, results.length, req.cookies?.['lh_visitor']);
    sendJson(res, 200, { query: q, results: results.map(materialPublic), suggestions: suggest(q, 8) });
  });

  // ——— Поток файла с Range (раздел 5, 6.2, 7.2) ———
  const streamHandler = async (req, res, { attachment = false } = {}) => {
    const isAdmin = !!req.admin;
    const m = fetchMaterial(req.params.id, isAdmin);
    // постер/превью — отдельный ассет
    if (req.query.asset === 'poster') {
      if (!m.poster_path || !fs.existsSync(m.poster_path)) throw new HttpError(404, 'Постер не найден');
      return streamLocalFile(req, res, m.poster_path, { contentTypeHint: 'image/png' });
    }
    // конвертированный DOCX→PDF для читалки
    const wantConverted = req.query.v === 'converted';
    const storage = m.storage_id ? get('SELECT * FROM storages WHERE id = ?', m.storage_id) : null;
    const source = resolveSource(m, storage, { attachment, wantConverted });

    if (source.type === 'redirect') {
      res.writeHead(302, { Location: source.url, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (source.type === 'embed') {
      return sendJson(res, 200, { embed: source.url });
    }
    if (source.type === 'remote') {
      source.materialId = m.id;
      return streamRemote(req, res, source, {
        contentTypeHint: wantConverted ? 'application/pdf' : m.mime,
      });
    }
    // local file
    const contentType = wantConverted ? 'application/pdf' : m.mime;
    return streamLocalFile(req, res, source.path, {
      contentTypeHint: contentType,
      attachment,
      fileName: `${m.title}${path.extname(source.path) || ''}`,
    });
  };

  router.get('/api/stream/:id', (req, res) => streamHandler(req, res, { attachment: false }));
  router.add('HEAD', '/api/stream/:id', (req, res) => streamHandler(req, res, { attachment: false }));

  router.get('/api/download/:id', async (req, res) => {
    const isAdmin = !!req.admin;
    const m = fetchMaterial(req.params.id, isAdmin);
    const settings = getSettings();
    if (!m.allow_download || !settings.allow_download) throw new HttpError(403, 'Скачивание этого материала запрещено');
    run('UPDATE materials SET downloads_count = downloads_count + 1 WHERE id = ?', m.id);
    return streamHandler(req, res, { attachment: true });
  });

  // ——— Приём событий аналитики батчами (раздел 8.4) ———
  router.post('/api/events', async (req, res) => {
    const key = req.ip || 'anon';
    if (!rateLimit('events:' + key, config.eventsRatePerMin)) {
      return sendJson(res, 429, { ok: false, error: 'rate limit' });
    }
    const batch = req.jsonBody;
    const r = ingestEvents(req, batch);
    const cookies = [];
    if (r.setCookie) {
      cookies.push(`lh_visitor=${r.visitorId}; Max-Age=${Math.floor(config.visitorTtlMs / 1000)}; Path=/; SameSite=Lax${req.secure ? '; Secure' : ''}`);
    }
    sendJson(res, 200, { ok: true }, cookies.length ? { 'Set-Cookie': cookies } : {});
  });

  // —─── sitemap.xml / robots.txt (раздел 9.4 SEO) —───
  router.get('/sitemap.xml', (req, res) => {
    const settings = getSettings();
    const base = settings.global_noindex ? null : config.publicUrl;
    const urls = [];
    if (base) {
      urls.push(`${base}/`);
      for (const f of all("SELECT slug FROM folders WHERE visibility = 'listed' AND deleted_at IS NULL")) urls.push(`${base}/${f.slug}`);
      for (const m of all("SELECT slug FROM materials WHERE status='published' AND visibility='listed' AND noindex=0")) urls.push(`${base}/m/${m.slug}`);
      for (const n of all("SELECT slug FROM notes WHERE visibility = 'listed'")) urls.push(`${base}/notes/${n.slug}`);
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${u}</loc></url>`).join('\n')}\n</urlset>`;
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(xml);
  });

  router.get('/robots.txt', (req, res) => {
    const noindex = !!getSettings().global_noindex;
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(noindex
      ? 'User-agent: *\nDisallow: /\n'
      : `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: ${config.publicUrl}/sitemap.xml\n`);
  });

  // ——— Настройки сайта для фронтенда (публичная часть) ———
  router.get('/api/site', (req, res) => {
    const s = getSettings();
    sendJson(res, 200, {
      site_name: s.site_name,
      site_description: s.site_description,
      footer_note: s.footer_note,
      accent_color: s.accent_color,
      default_theme: s.default_theme,
      allow_download: !!s.allow_download,
      public_search: !!s.public_search,
      closed_mode: !!s.closed_mode,
    });
  });

  return { fetchMaterial, materialPublic, folderBreadcrumb, visibleMaterial };
}
