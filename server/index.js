// Точка входа lab-hub: HTTP-сервер на node:http без внешних зависимостей.
// Middleware: cookies, query, client IP, JSON-тело, сессия админа (опционально для
// публичных GET), CSRF для админ-мутаций, «закрытый режим» (Phase 2, раздел 3).
// Статика из public/, SSR-мета для SPA-роутов, /view/:slug — читалка PDF.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { get, all, run, now, getSettings } from './db.js';
import { Router, HttpError, parseCookies, readJson, sendJson, sendText, securityHeaders, clientIp, rateLimit, serializeCookie } from './http.js';
import { ensureAdminUser, getSession } from './auth.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerNoteRoutes } from './routes/notes.js';
import { noteBySlug, startVaultWatcher } from './vault.js';
import { seed } from './seed.js';
import { startCacheJanitor } from './cache.js';
import { startHealthChecker } from './health.js';
import { startStatsJanitor } from './stats.js';
import { binaryExists } from './convert.js';
import { processMaterial } from './convert.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const router = new Router();

// ——— Инициализация ———
ensureAdminUser();
if (config.seedDemo) {
  try { seed({}); } catch (e) { console.error('[lab-hub] seed error:', e.message); }
}

// Фоновые задачи: конвертация материалов в статусе processing/converting после рестарта
setTimeout(() => {
  for (const m of all("SELECT id FROM materials WHERE source_type='local' AND (convert_status='converting' OR (kind='docx' AND convert_status='none')) AND status != 'deleted'")) {
    processMaterial(m.id).catch(() => {});
  }
}, 3000);

startCacheJanitor();
startHealthChecker();
startStatsJanitor();
// Vault заметок: первичная индексация + слежение за правками, сделанными в самом Obsidian
startVaultWatcher();
// Автоочистка корзины: soft-deleted старше 30 дней удаляются безвозвратно (раздел 8.3)
setInterval(() => {
  const cutoff = now() - 30 * 86400000;
  for (const m of all('SELECT * FROM materials WHERE status = ? AND deleted_at < ?', 'deleted', cutoff)) {
    if (m.file_path) try { fs.rmSync(m.file_path, { force: true }); } catch {}
    run('DELETE FROM materials WHERE id = ?', m.id);
  }
}, 3600_000).unref();

registerPublicRoutes(router);
registerAdminRoutes(router);
registerNoteRoutes(router);

// ——— SSR-мета для публичных страниц (SEO, раздел 9.4) ———
function metaForRoute(pathname, settings) {
  const name = settings.site_name || 'Lab-Hub';
  const noindex = settings.global_noindex ? '<meta name="robots" content="noindex, nofollow">' : '';
  let title = name, description = settings.site_description || '', ogType = 'website', ogImage = '';
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'm' && parts[1]) {
    const m = get("SELECT m.*, f.title AS ft FROM materials m JOIN folders f ON f.id=m.folder_id WHERE m.slug=? AND m.status='published' AND m.visibility != 'private'", parts[1]);
    if (m) {
      title = `${m.title} — ${name}`;
      description = String(m.description || '').slice(0, 200);
      ogType = 'article';
      if (m.poster_path) ogImage = `${config.publicUrl}/api/stream/${m.id}?asset=poster`;
    }
  } else if (parts[0] === 'search') {
    title = `Поиск — ${name}`;
  } else if (parts[0] === 'notes') {
    // SSR-мета для раздела заметок (страница, граф, теги)
    if (parts[1] === 'graph') {
      title = `Граф заметок — ${name}`;
      description = 'Связи между заметками';
    } else if (parts[1] === 'tags') {
      title = `Теги заметок — ${name}`;
    } else if (parts[1] === 'tag' && parts[2]) {
      title = `#${parts[2]} — заметки ${name}`;
    } else if (parts[1]) {
      const n = noteBySlug(parts[1]);
      if (n) { title = `${n.title} — ${name}`; description = String(n.excerpt || '').slice(0, 200); ogType = 'article'; }
    } else {
      title = `Заметки — ${name}`;
      description = 'Конспекты, методички и связи между ними';
    }
  } else if (parts[0] && parts[0] !== 'admin') {
    const f = get("SELECT * FROM folders WHERE slug=? AND visibility != 'private' AND deleted_at IS NULL", parts[0]);
    if (f) { title = `${f.title} — ${name}`; description = String(f.description || '').slice(0, 200); }
  }
  const og = [
    `<meta property="og:title" content="${escAttr(title)}">`,
    `<meta property="og:description" content="${escAttr(description)}">`,
    `<meta property="og:type" content="${ogType}">`,
    ogImage ? `<meta property="og:image" content="${escAttr(ogImage)}">` : '',
  ].join('\n');
  return `<title>${escHtml(title)}</title>\n<meta name="description" content="${escAttr(description)}">\n${noindex}\n${og}`;
}
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
};

async function serveStatic(req, res, filePath, { noCache = false } = {}) {
  // path traversal guard: файл должен лежать внутри public/ (проверка до stat)
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) return false;
  let stat;
  try {
    stat = await fsp.stat(resolved);
    if (!stat.isFile()) throw new Error('not a file');
  } catch { return false; }
  filePath = resolved;
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return true; }
  const headers = { 'Content-Type': type, 'Content-Length': stat.size, ETag: etag, 'Last-Modified': stat.mtime.toUTCString() };
  // no-cache = всегда ревалидировать по ETag (304 дёшев, зато обновления JS/CSS прилетают мгновенно)
  if (ext === '.mjs' || filePath.includes(`${path.sep}vendor${path.sep}`)) headers['Cache-Control'] = 'public, max-age=604800, immutable';
  else headers['Cache-Control'] = 'no-cache';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('error', () => res.end());
  return true;
}

async function serveIndexHtml(req, res, pathname) {
  const settings = getSettings();
  const tpl = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const html = tpl.replace('<!--META-->', metaForRoute(pathname, settings))
    .replace(/__ACCENT__/g, settings.accent_color || '#5b5bd6')
    .replace(/__SITE_NAME__/g, escHtml(settings.site_name || 'Lab-Hub'));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

async function serveViewer(req, res, slug) {
  const settings = getSettings();
  let boot = { error: 'not_found' };
  const m = get("SELECT m.*, f.title AS folder_title, f.slug AS folder_slug FROM materials m JOIN folders f ON f.id=m.folder_id WHERE m.slug = ? AND m.status='published' AND m.visibility != 'private'", slug);
  if (m) {
    boot = {
      id: m.id, slug: m.slug, title: m.title, kind: m.kind, mime: m.mime,
      convert_status: m.convert_status, allow_download: !!m.allow_download && !!settings.allow_download,
      folder: { title: m.folder_title, slug: m.folder_slug },
      streamUrl: `/api/stream/${m.id}${m.kind === 'docx' && m.convert_status === 'ready' ? '?v=converted' : ''}`,
      downloadUrl: m.allow_download && settings.allow_download ? `/api/download/${m.id}` : null,
      embedUrl: null,
    };
    if (m.source_type === 'embed') {
      const { embeddableUrl } = await import('./sources.js');
      boot.embedUrl = embeddableUrl(JSON.parse(m.source_config || '{}'));
    }
  }
  const tpl = await fsp.readFile(path.join(PUBLIC_DIR, 'view.html'), 'utf8');
  const html = tpl.replace('<!--META-->', metaForRoute('/m/' + slug, settings))
    .replace('__BOOTSTRAP__', JSON.stringify(boot).replace(/</g, '\\u003c'))
    .replace(/__ACCENT__/g, settings.accent_color || '#5b5bd6');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

// ——— Сервер ———
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  req.ip = clientIp(req);
  req.secure = req.headers['x-forwarded-proto'] === 'https';
  req.cookies = parseCookies(req.headers.cookie);
  req.query = Object.fromEntries(url.searchParams.entries());
  securityHeaders(req, res, { allowFrame: pathname.startsWith('/m/') || pathname.startsWith('/view/') });

  try {
    // «Закрытый режим» Phase 2 (раздел 3): middleware готов, включается настройкой
    const settings = getSettings();
    if (settings.closed_mode && !pathname.startsWith('/admin') && !pathname.startsWith('/api/admin')) {
      const code = req.cookies['lh_invite'];
      if (code !== String(settings.invite_code || '')) {
        if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'closed_mode', message: 'Сайт работает в закрытом режиме — требуется инвайт-код' });
        const tpl = await fsp.readFile(path.join(PUBLIC_DIR, 'invite.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(tpl.replace(/__ACCENT__/g, settings.accent_color || '#5b5bd6').replace(/__SITE_NAME__/g, escHtml(settings.site_name || 'Lab-Hub')));
      }
    }

    // Сессия админа (нужна и публичным GET — админ видит private/unlisted)
    const session = getSession(req);
    req.admin = session || null;

    if (pathname.startsWith('/api/')) {
      const isAdminApi = pathname.startsWith('/api/admin/');
      // CSRF для всех мутирующих админ-запросов кроме login
      if (isAdminApi && req.method !== 'GET' && !pathname.endsWith('/login') && !session) {
        throw new HttpError(401, 'Требуется вход', 'unauthorized');
      }
      if (isAdminApi && req.method !== 'GET' && !pathname.endsWith('/login')) {
        const token = req.headers['x-csrf-token'];
        if (!session || !token || token !== session.csrf) throw new HttpError(403, 'Недействительный CSRF-токен', 'csrf');
      }
      if (isAdminApi && req.method === 'GET' && !pathname.endsWith('/login') && !session) {
        throw new HttpError(401, 'Требуется вход', 'unauthorized');
      }
      // JSON-тело (кроме raw-upload)
      const isRawUpload = pathname === '/api/admin/upload' || pathname === '/api/admin/notes/attach';
      if (!isRawUpload && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        req.jsonBody = await readJson(req, 20 * 1024 * 1024);
      }
      const { handler, params } = router.match(req.method, pathname);
      req.params = params;
      await handler(req, res);
      return;
    }

    // Читалка PDF/DOCX — отдельный route (раздел 5)
    const viewMatch = /^\/view\/([^/]+)$/.exec(pathname);
    if (viewMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      return await serveViewer(req, res, viewMatch[1]);
    }

    // Не-API маршруты из роутера (sitemap.xml, robots.txt, invite)
    if (pathname === '/sitemap.xml' || pathname === '/robots.txt' || pathname === '/api/invite') {
      try {
        const { handler, params } = router.match(req.method, pathname);
        req.params = params;
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) req.jsonBody = await readJson(req, 1024 * 1024);
        await handler(req, res);
        return;
      } catch { /* fallthrough к статике/SPA */ }
    }

    if (pathname === '/admin' || pathname === '/admin/') {
      return await serveStatic(req, res, path.join(PUBLIC_DIR, 'admin.html'));
    }

    // Статика из public/ (GET/HEAD)
    if (req.method === 'GET' || req.method === 'HEAD') {
      const candidate = path.join(PUBLIC_DIR, pathname);
      if (pathname !== '/' && await serveStatic(req, res, candidate)) return;

      // SPA-роуты: главная, папка, материал, поиск, приватность, заметки → index.html с SSR-метой
      const isSpaRoute = pathname === '/' || /^\/(m|search|privacy|folder|notes)\/?/.test(pathname) ||
        !!get("SELECT id FROM folders WHERE slug = ? AND visibility != 'private' AND deleted_at IS NULL", pathname.split('/')[1] || '');
      if (isSpaRoute) return await serveIndexHtml(req, res, pathname);
    }

    // 404
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not_found', message: 'Не найдено' });
    if (req.method === 'GET' && (await serveStatic(req, res, path.join(PUBLIC_DIR, '404.html')))) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(`[lab-hub] ${req.method} ${pathname}:`, e);
    if (!res.headersSent) {
      if (pathname.startsWith('/api/')) sendJson(res, status, { error: e.code || 'error', message: status === 500 ? 'Внутренняя ошибка сервера' : e.message });
      else { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(String(status)); }
    } else {
      try { res.end(); } catch {}
    }
  } finally {
    const ms = Date.now() - started;
    if (ms > 3000 && !pathname.startsWith('/api/stream')) console.warn(`[lab-hub] slow: ${req.method} ${pathname} ${ms}ms`);
  }
});

// POST /api/invite — проверка инвайт-кода закрытого режима
router.post('/api/invite', (req, res) => {
  const settings = getSettings();
  const code = String(req.jsonBody?.code || '');
  if (!settings.closed_mode || !code || code !== String(settings.invite_code || '')) {
    throw new HttpError(403, 'Неверный инвайт-код');
  }
  res.setHeader('Set-Cookie', serializeCookie('lh_invite', code, { maxAge: 30 * 86400000, secure: req.secure }));
  sendJson(res, 200, { ok: true });
});

server.listen(config.port, config.host, async () => {
  const lo = await binaryExists(config.libreoffice);
  const ff = await binaryExists(config.ffmpeg);
  console.log(`[lab-hub] запущен: ${config.publicUrl}  (admin: /admin, логин ${config.adminBootstrap.login})`);
  console.log(`[lab-hub] LibreOffice: ${lo ? 'доступен (DOCX→PDF работает)' : 'НЕ найден — DOCX только для скачивания'}`);
  console.log(`[lab-hub] ffmpeg: ${ff ? 'доступен (постеры/длительность видео)' : 'НЕ найден — постеры не генерируются'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[lab-hub] ${sig} — завершение`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
