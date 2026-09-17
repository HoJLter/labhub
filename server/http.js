// HTTP-ядро: роутер, cookies, парсинг тела, rate-limit, security-заголовки, CSRF.
import crypto from 'node:crypto';

// ——— Ошибки ———
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

// ——— Роутер ———
export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    // pattern: '/api/folders/:slug' → regexp
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '(.*)').replace(/:([A-Za-z_][\w]*)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  patch(p, h) { this.add('PATCH', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }
  match(method, pathname) {
    let pathExists = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathExists = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      if (r.keys.length === 0 && m.length > 1) params['0'] = decodeURIComponent(m[1]);
      return { handler: r.handler, params };
    }
    throw new HttpError(pathExists ? 405 : 404, pathExists ? 'Метод не поддерживается' : 'Не найдено', 'not_found');
  }
}

// ——— Cookies ———
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  let s = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge != null) s += `; Max-Age=${Math.floor(opts.maxAge / 1000)}`;
  if (opts.expires) s += `; Expires=${opts.expires.toUTCString()}`;
  s += `; Path=${opts.path || '/'}`;
  s += '; HttpOnly';
  s += '; SameSite=Lax';
  if (opts.secure) s += '; Secure';
  return s;
}

// ——— Тело запроса ———
export async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Слишком большое тело запроса');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = 2 * 1024 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'Некорректный JSON'); }
}

// ——— Отправка JSON ———
export function sendJson(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text);
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
  res.end(body);
}

// —──— Rate limiting (in-memory, скользящее окно) ————
const buckets = new Map();
export function rateLimit(key, maxPerWindow, windowMs = 60_000) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || t > b.reset) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.count++;
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (t > v.reset) buckets.delete(k);
  }
  return b.count <= maxPerWindow;
}

// ——— Клиентский IP / устройство / боты ———
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

const BOT_RE = /(bot|crawler|spider|crawling|slurp|curl|wget|python-requests|go-http-client|java\/|headless|lighthouse|monitor|check(er)?|scan)/i;
export function isBot(ua) { return BOT_RE.test(ua || ''); }

export function detectDevice(ua = '') {
  if (/tablet|ipad/i.test(ua)) return 'tablet';
  if (/mobile|iphone|ipod|android.*mobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

// ——— Security-заголовки (раздел 9.4) ———
export function securityHeaders(req, res, opts = {}) {
  const h = res.getHeaderNames ? {} : {};
  const csp = [
    "default-src 'self'",
    "script-src 'self' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    opts.allowFrame ? "frame-src https: http://localhost:*" : "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (!opts.noCache) res.setHeader('Cache-Control', 'no-cache');
  return h;
}

// ——— CSRF (double-submit): токен лежит в сессии, клиент шлёт его заголовком ———
export function newCsrfToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// ——— Валидация входных данных ———
export function str(v, maxLen = 2000, def = '') {
  if (v == null) return def;
  return String(v).slice(0, maxLen).trim();
}
export function slugify(s) {
  const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
  return String(s).toLowerCase().split('').map(ch => (ch in map ? map[ch] : ch)).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || crypto.randomBytes(3).toString('hex');
}
