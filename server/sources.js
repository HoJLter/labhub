// Источники контента (раздел 7 ТЗ — ключевой раздел).
// Каталог отдельно от файла: local | s3 | webdav | drive | url | embed.
// Три режима отдачи: redirect (presigned URL), proxy (Range-стрим через сервер), embed (iframe).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { cacheGet, cachePut } from './cache.js';
import { HttpError } from './http.js';

// ——— Определение типа по публичной ссылке (раздел 7.5) ———
export function detectSourceFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new HttpError(400, 'Некорректная ссылка'); }
  const h = u.hostname.toLowerCase();
  if (h.includes('youtube.com') || h === 'youtu.be' || h.includes('rutube.ru') || h.includes('vk.com') || h.includes('vkvideo.ru') || h.includes('kodik')) {
    return { source_type: 'embed', source_config: { url, mode: 'embed' }, kind: 'video' };
  }
  if (h.includes('drive.google.com')) {
    const id = u.pathname.match(/\/d\/([^/]+)/)?.[1] || u.searchParams.get('id');
    return { source_type: 'drive', source_config: { provider: 'google', fileId: id, url, mode: 'embed' }, kind: 'link' };
  }
  if (h.includes('disk.yandex') || h.includes('yadi.sk') || h.includes('dropbox.com')) {
    return { source_type: 'drive', source_config: { provider: h, url, mode: 'embed' }, kind: 'link' };
  }
  const ext = path.extname(u.pathname).toLowerCase().replace('.', '');
  const kind = KIND_BY_EXT[ext] || 'link';
  return { source_type: 'url', source_config: { url, mode: kind === 'video' ? 'redirect' : 'proxy' }, kind };
}

export const KIND_BY_EXT = {
  pdf: 'pdf',
  docx: 'docx', doc: 'docx', pptx: 'docx', xlsx: 'docx',
  mp4: 'video', webm: 'video', mkv: 'video', mov: 'video',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
};

export const MIME_BY_EXT = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  vtt: 'text/vtt', zip: 'application/zip',
};

// ——— Проверка «внешней» ссылки (HEAD, health-check раздел 7.3) ———
export async function probeUrl(url, timeoutMs = 10_000) {
  const started = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow' });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'follow', headers: { Range: 'bytes=0-0' } });
    }
    const took = Date.now() - started;
    return {
      ok: res.ok || res.status === 206,
      status: res.status,
      size: parseInt(res.headers.get('content-length') || '0', 10) || null,
      mime: res.headers.get('content-type')?.split(';')[0] || null,
      took,
    };
  } catch (e) {
    return { ok: false, status: 0, size: null, mime: null, took: Date.now() - started, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// ——— S3: AWS SigV4 presigned GET (работает с AWS, MinIO, Selectel, VK Cloud, B2) ———
export function presignS3Get(st, key, expiresSec = 900) {
  const cfg = cfgOf(st);
  if (!cfg.bucket || !cfg.accessKey || !resolveSecret(cfg.secretKey)) {
    throw new HttpError(500, 'Хранилище S3 настроено не полностью');
  }
  return presignS3GetGeneric(st, key, 'GET', expiresSec);
}

// Секреты: значение вида env:NAME читается из переменной окружения (раздел 7.1 — секреты не в БД)
function resolveSecret(v) {
  if (typeof v === 'string' && v.startsWith('env:')) return process.env[v.slice(4)] || '';
  return v || '';
}

// Нормализация config хранилища: в БД это JSON-строка, в коде удобнее объект
export function cfgOf(st) {
  if (!st) return {};
  if (typeof st.config === 'string') { try { return JSON.parse(st.config); } catch { return {}; } }
  return st.config || {};
}

// Прямая загрузка браузер → S3 через presigned PUT (раздел 7.4)
export function presignS3Put(st, key, contentType = 'application/octet-stream', expiresSec = 3600) {
  // Для MVP-надёжности подписываем PUT тем же алгоритмом с доп. заголовком content-type
  const signed = presignS3GetGeneric(st, key, 'PUT', expiresSec, { 'content-type': contentType });
  return signed;
}

function presignS3GetGeneric(st, key, method, expiresSec, extraHeaders = {}) {
  const cfg = cfgOf(st);
  const endpoint = new URL(cfg.endpoint || `https://s3.${cfg.region || 'us-east-1'}.amazonaws.com`);
  const region = cfg.region || 'us-east-1';
  const bucket = cfg.bucket;
  const accessKey = cfg.accessKey;
  const secretKey = resolveSecret(cfg.secretKey);
  const pathStyle = st.config.pathStyle !== false && !String(endpoint.hostname).startsWith('s3.');
  const canonicalUri = (pathStyle ? `/${bucket}/${key}` : `/${key}`).split('/').map(s => s ? encodeURIComponent(decodeURIComponent(s)) : s).join('/');
  const host = pathStyle ? endpoint.host : `${bucket}.${endpoint.host}`;
  const scheme = pathStyle ? endpoint.protocol : 'https:';
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const headerEntries = Object.entries({ host, ...extraHeaders }).map(([k, v]) => [k.toLowerCase(), String(v).trim()]);
  const signedHeaders = headerEntries.map(([k]) => k).sort().join(';');
  const canonicalHeaders = headerEntries.sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => `${k}:${v}\n`).join('');
  const qp = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': signedHeaders,
  });
  const canonicalQuery = [...qp.entries()].sort().map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const kDate = crypto.createHmac('sha256', 'AWS4' + secretKey).update(dateStamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update('s3').digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `${scheme}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ——— WebDAV URL с креденшелами из storages ———
export function webdavUrl(st, key) {
  const base = String(cfgOf(st).url || '').replace(/\/$/, '');
  return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
}
export function webdavHeaders(st) {
  const h = {};
  const cfg = cfgOf(st);
  const user = cfg.username;
  const pass = resolveSecret(cfg.password);
  if (user && pass) h['Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  return h;
}

// ——— Google Drive: публичный просмотр/скачивание по fileId ———
export function driveUrl(cfg, download = false) {
  if (cfg.provider === 'google' && cfg.fileId) {
    return download
      ? `https://drive.google.com/uc?export=download&id=${cfg.fileId}`
      : `https://drive.google.com/file/d/${cfg.fileId}/preview`;
  }
  return cfg.url;
}

// ——— Единая точка: физическое расположение материала ———
// Возвращает один из:
//  { type: 'file', path, size? }                       — локальный файл (стримим с Range)
//  { type: 'remote', url, headers, cacheable, cacheKey } — прокси-стрим с Range
//  { type: 'redirect', url }                            — 302 на источник (presigned)
//  { type: 'embed', url }                               — iframe на странице материала
export function resolveSource(material, storage, { attachment = false } = {}) {
  const cfg = JSON.parse(material.source_config || '{}');
  const mode = cfg.mode || defaultMode(material);

  // Локальный файл
  if (material.source_type === 'local') {
    const p = material.file_path;
    if (!p || !fs.existsSync(p)) throw new HttpError(404, 'Файл не найден на диске', 'file_missing');
    return { type: 'file', path: p, size: material.size };
  }

  if (material.source_type === 'embed') {
    return { type: 'embed', url: embeddableUrl(cfg) };
  }

  if (material.source_type === 'drive') {
    if (mode === 'embed') return { type: 'embed', url: driveUrl(cfg, false) };
    return { type: 'redirect', url: driveUrl(cfg, true) };
  }

  if (material.source_type === 's3' && storage) {
    const url = presignS3Get(storage, cfg.key || material.slug, 900);
    if (mode === 'redirect') return { type: 'redirect', url };
    return { type: 'remote', url, headers: {}, cacheable: material.kind !== 'video', cacheKey: `s3:${storage.id}:${cfg.key}` };
  }

  if (material.source_type === 'webdav' && storage) {
    const url = webdavUrl(storage, cfg.key || material.slug);
    if (mode === 'redirect') return { type: 'redirect', url };
    return { type: 'remote', url, headers: webdavHeaders(storage), cacheable: material.kind !== 'video', cacheKey: `webdav:${storage.id}:${cfg.key}` };
  }

  if (material.source_type === 'url') {
    if (mode === 'redirect') return { type: 'redirect', url: cfg.url };
    return { type: 'remote', url: cfg.url, headers: {}, cacheable: material.kind !== 'video' && cfg.cache !== false, cacheKey: `url:${cfg.url}` };
  }

  throw new HttpError(500, 'Неподдерживаемый тип источника', 'bad_source');
}

export function defaultMode(material) {
  // Правило по умолчанию из раздела 7.2
  if (material.kind === 'video') return 'redirect';
  return 'proxy';
}

export function embeddableUrl(cfg) {
  const url = cfg.url || '';
  try {
    const u = new URL(url);
    const h = u.hostname.replace('www.', '');
    if (h === 'youtube.com') return `https://www.youtube.com/embed/${u.searchParams.get('v') || ''}`;
    if (h === 'youtu.be') return `https://www.youtube.com/embed${u.pathname}`;
    if (h === 'rutube.ru') return `https://rutube.ru/play/embed/${u.pathname.split('/').filter(Boolean).pop()}`;
    if (h.includes('vk.com') || h.includes('vkvideo.ru')) {
      const oid = u.searchParams.get('oid') || u.pathname.match(/video(-?\d+)_/)?.[1];
      const id = u.searchParams.get('id') || u.pathname.match(/video-?\d+_(\d+)/)?.[1];
      return oid && id ? `https://vk.com/video_ext.php?oid=${oid}&id=${id}` : url;
    }
  } catch { /* fallthrough */ }
  return url;
}

// ——— Прокси-стрим с поддержкой Range и дисковым кешем (разделы 7.2, 7.3) ———
export async function streamRemote(req, res, source, { headOnly = false, contentTypeHint = '' } = {}) {
  // Кеш: если файл уже скачан — отдаём как локальный
  if (source.cacheable) {
    const cached = cacheGet(source.cacheKey);
    if (cached) return streamLocalFile(req, res, cached, { contentTypeHint, headOnly });
  }
  const headers = { ...(source.headers || {}) };
  const range = req.headers['range'];
  if (range) headers['Range'] = range;
  const upstream = await fetch(source.url, { headers, redirect: 'follow' });
  if (!upstream.ok && upstream.status !== 206) {
    // Crowd-friendly: источник отвалился, но есть кеш — отдаём из кеша (раздел 7.3)
    const cached = source.cacheable ? cacheGet(source.cacheKey) : null;
    if (cached) return streamLocalFile(req, res, cached, { contentTypeHint, headOnly });
    throw new HttpError(502, 'Внешний источник недоступен', 'upstream');
  }
  const outHeaders = {
    'Content-Type': upstream.headers.get('content-type') || contentTypeHint || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const cl = upstream.headers.get('content-length');
  if (cl) outHeaders['Content-Length'] = cl;
  const cr = upstream.headers.get('content-range');
  if (cr) outHeaders['Content-Range'] = cr;
  res.writeHead(upstream.status, outHeaders);
  if (headOnly || req.method === 'HEAD') { res.end(); return; }

  const canCacheWhole = source.cacheable && !range && cl && parseInt(cl, 10) <= 64 * 1024 * 1024;
  const chunks = canCacheWhole ? [] : null;
  try {
    for await (const chunk of upstream.body) {
      if (chunks) chunks.push(chunk);
      if (!res.write(chunk)) await new Promise(r => res.once('drain', r));
    }
    res.end();
    if (chunks) await cachePut(source.cacheKey, source.materialId ?? null, Buffer.concat(chunks));
  } catch (e) {
    try { res.end(); } catch { /* ignore */ }
  }
}

// ——— Стрим локального файла с Range (206 Partial Content) ———
export async function streamLocalFile(req, res, filePath, { contentTypeHint = '', attachment = false, fileName = '', headOnly = false } = {}) {
  const stat = await fsp.stat(filePath);
  const type = contentTypeHint || mimeByPath(filePath);
  const total = stat.size;
  const baseHeaders = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': 'no-store',
  };
  if (attachment) {
    baseHeaders['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(fileName || path.basename(filePath))}`;
  }
  const range = req.headers['range'];
  let start = 0, end = total - 1, status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      if (m[1]) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(parseInt(m[2], 10), total - 1); }
      else if (m[2]) { start = Math.max(0, total - parseInt(m[2], 10)); } // suffix range
      if (start >= total || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      status = 206;
      baseHeaders['Content-Range'] = `bytes ${start}-${end}/${total}`;
    }
  }
  const len = end - start + 1;
  baseHeaders['Content-Length'] = len;
  res.writeHead(status, baseHeaders);
  if (headOnly || req.method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(filePath, { start, end, highWaterMark: 256 * 1024 });
  stream.on('error', () => { try { res.end(); } catch { /* ignore */ } });
  res.on('close', () => stream.destroy());
  for await (const chunk of stream) {
    if (!res.write(chunk)) await new Promise(r => res.once('drain', r));
  }
  res.end();
}

export function mimeByPath(p) {
  const ext = path.extname(p).toLowerCase().replace('.', '');
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// ——— Тест соединения с хранилищем (раздел 7.5, кнопка «Тест») ———
export async function testStorage(st) {
  const started = Date.now();
  try {
    if (st.type === 'local') {
      const dir = cfgOf(st).dir || config.paths.files;
      await fsp.access(dir);
      return { ok: true, detail: `Каталог доступен: ${dir}`, took: Date.now() - started };
    }
    if (st.type === 's3') {
      const url = presignS3Get(st, cfgOf(st).testKey || '', 60);
      const r = await fetch(new URL(url).origin, { method: 'HEAD' });
      // Любой ответ от эндпоинта (даже 403 на корень) означает, что сеть и endpoint живы
      return { ok: r.status < 500, detail: `HTTP ${r.status} от ${new URL(url).host}`, took: Date.now() - started };
    }
    if (st.type === 'webdav') {
      const cfg = cfgOf(st);
      const r = await fetch(String(cfg.url).replace(/\/$/, ''), { method: 'PROPFIND', headers: { ...webdavHeaders(st), Depth: '0' }, signal: AbortSignal.timeout(10_000) });
      return { ok: r.ok || r.status === 207, detail: `HTTP ${r.status}`, took: Date.now() - started };
    }
    return { ok: false, detail: 'Неизвестный тип хранилища' };
  } catch (e) {
    return { ok: false, detail: String(e.message || e), took: Date.now() - started };
  }
}
