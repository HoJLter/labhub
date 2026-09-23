// Обработка файлов при публикации (раздел 6 ТЗ):
// — постер видео через ffmpeg; — число страниц PDF; — длительность видео.
// Конвертация DOCX→PDF удалена: DOCX доступен только для скачивания.
// Если ffmpeg нет (вне Docker), статусы честно помечаются, оригиналы доступны для скачивания.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { run, get } from './db.js';

export async function binaryExists(cmd) {
  return new Promise(resolve => {
    // DEP0190: с shell:true не передаём массив args — склеиваем строкой (cmd контролируется нами)
    const p = process.platform === 'win32'
      ? spawn(`${cmd} --version`, { stdio: 'ignore', shell: true })
      : spawn(cmd, ['--version'], { stdio: 'ignore' });
    const t = setTimeout(() => { try { p.kill(); } catch {} resolve(false); }, 4000);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', code => { clearTimeout(t); resolve(code === 0); });
  });
}

// ——— Число страниц PDF (парсинг /Count у последней страницы дерева Pages) ———
export async function pdfPageCount(filePath) {
  try {
    const buf = await fsp.readFile(filePath);
    const s = buf.toString('latin1');
    let max = 0;
    const re = /\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g;
    let m;
    while ((m = re.exec(s)) !== null) max = Math.max(max, parseInt(m[1], 10));
    if (max === 0) {
      const re2 = /\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages/g;
      while ((m = re2.exec(s)) !== null) max = Math.max(max, parseInt(m[1], 10));
    }
    return max || null;
  } catch { return null; }
}

// ——— Длительность видео через ffprobe/ffmpeg ———
export async function videoDuration(filePath) {
  return new Promise(resolve => {
    const p = spawn(config.ffmpeg, ['-i', filePath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let out = '';
    p.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => { try { p.kill(); } catch {} resolve(null); }, 15_000);
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', () => {
      clearTimeout(t);
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
      resolve(m ? Math.round((+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])) * 10) / 10 : null);
    });
  });
}

// ——— Постер видео (кадр на 1-й секунде) ———
export async function makeVideoPoster(filePath, materialId) {
  const dest = path.join(config.paths.posters, `${materialId}.jpg`);
  return new Promise(resolve => {
    const p = spawn(config.ffmpeg, ['-y', '-ss', '1', '-i', filePath, '-frames:v', '1', '-q:v', '3', dest],
      { stdio: 'ignore' });
    const t = setTimeout(() => { try { p.kill(); } catch {} resolve(null); }, 30_000);
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', code => {
      clearTimeout(t);
      resolve(code === 0 && fs.existsSync(dest) ? dest : null);
    });
  });
}

// ——— Магические байты: проверка реального типа файла (раздел 7.4) ———
export function sniffMime(buf, fallbackExt = '') {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (/M4V|mp4|isom|iso2|avc1|dash/.test(brand)) return 'video/mp4';
    if (/webm/.test(brand)) return 'video/webm';
    return 'video/mp4';
  }
  if (buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    // zip-контейнер: уточняем по расширению (OOXML)
    const ext = fallbackExt.toLowerCase();
    if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (ext === 'pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    return 'application/zip';
  }
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0xb2, 0x81]))) return 'video/webm';
  return null;
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// ——— Фоновая обработка опубликованного материала ———
export async function processMaterial(materialId) {
  const m = get('SELECT * FROM materials WHERE id = ?', materialId);
  if (!m) return;
  if (m.kind === 'pdf' && m.source_type === 'local' && m.file_path) {
    const pages = m.page_count ?? await pdfPageCount(m.file_path);
    if (pages) run('UPDATE materials SET page_count = ? WHERE id = ?', pages, materialId);
  }
  if (m.kind === 'video' && m.source_type === 'local' && m.file_path) {
    (async () => {
      const dur = m.duration_sec ?? await videoDuration(m.file_path);
      const poster = m.poster_path ?? await makeVideoPoster(m.file_path, materialId);
      run('UPDATE materials SET duration_sec = COALESCE(duration_sec, ?), poster_path = COALESCE(poster_path, ?) WHERE id = ?',
        dur, poster, materialId);
    })().catch(() => {});
  }
}
