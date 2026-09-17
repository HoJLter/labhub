// Генератор настоящих многостраничных PDF с кириллицей (для демо-материалов).
// Кириллица — через /Encoding /Differences с uni-именами глифов (поддерживается PDF.js и Acrobat).
import zlib from 'node:zlib';

const CYR_UPPER = 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ';
const CYR_LOWER = 'абвгдежзийклмнопрстуфхцчшщъыьэюя';

function buildEncodingDiff() {
  // codes 128..159 → А-Я, 160..191 → а-я, 192 → Ё, 193 → ё
  const parts = [];
  let code = 128;
  for (const ch of CYR_UPPER) parts.push(`${code++} /uni04${hex(ch)}`);
  for (const ch of CYR_LOWER) parts.push(`${code++} /uni04${hex(ch)}`);
  parts.push(`${code++} /uni0401`);
  parts.push(`${code++} /uni0451`);
  return parts.join(' ');
}
function hex(ch) {
  return ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
}

const CYR_CODE = (() => {
  const m = new Map();
  let code = 128;
  for (const ch of CYR_UPPER) m.set(ch, code++);
  for (const ch of CYR_LOWER) m.set(ch, code++);
  m.set('Ё', 192); m.set('ё', 193);
  return m;
})();

function encodeText(s) {
  const bytes = [];
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') { bytes.push(0x5c, cp); continue; }
    if (cp >= 32 && cp <= 126) { bytes.push(cp); continue; }
    if (CYR_CODE.has(ch)) { bytes.push(CYR_CODE.get(ch)); continue; }
    bytes.push(0x20); // неизвестный символ → пробел
  }
  return Buffer.from(bytes);
}

// Приблизительная ширина символа Helvetica (в тысячных em) для переносов строк
const AVG_W = { default: 556, ru: 556, ' ': 278 };
function textWidth(s, size) {
  let w = 0;
  for (const ch of s) w += (ch === ' ' ? AVG_W[' '] : AVG_W.default) / 1000 * size;
  return w;
}

function wrap(text, size, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (textWidth(test, size) > maxWidth && cur) { lines.push(cur); cur = w; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * pages: [{ title?, lines: string[], accent?: [r,g,b] }]
 * opts: { author, subject }
 */
export function generatePdf(pages, opts = {}) {
  const PW = 595.28, PH = 841.89; // A4
  const accent = opts.accent || [0.36, 0.36, 0.84];
  const [ar, ag, ab] = accent;

  const objects = []; // 1-based
  const add = body => { objects.push(body); return objects.length; };

  // Content streams per page
  const contentIds = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const ops = [];
    // фон шапки
    ops.push(`q ${ar.toFixed(3)} ${ag.toFixed(3)} ${ab.toFixed(3)} rg 0 ${PH - 90} ${PW} 90 re f Q`);
    ops.push(`q 1 1 1 rg 40 ${PH - 58} BT /F2 20 Tf (${esc(p.title || opts.subject || 'Материал')}) Tj ET Q`.replace(/\(([^\)]*)\)/, m => m));
    // заголовок на плашке — нужно кодировать кириллицу: построим отдельно
    ops.pop();
    ops.push(colorText(p.title || opts.subject || 'Материал', 'F2', 20, 40, PH - 58, [1, 1, 1]));
    ops.push(colorText(`${opts.subject || ''}`, 'F1', 11, 40, PH - 78, [0.85, 0.85, 0.95]));
    // тело
    let y = PH - 140;
    const acc = p.accent || accent;
    for (const rawLine of p.lines) {
      if (rawLine === '') { y -= 10; continue; }
      if (rawLine.startsWith('## ')) {
        y -= 8;
        ops.push(colorText(rawLine.slice(3), 'F2', 14, 40, y, acc));
        y -= 22;
        continue;
      }
      if (rawLine.startsWith('- ')) {
        const lines = wrap('•  ' + rawLine.slice(2), 11, PW - 90);
        for (const l of lines) { ops.push(colorText(l, 'F1', 11, 48, y, [0.12, 0.13, 0.16])); y -= 16; }
        continue;
      }
      const lines = wrap(rawLine, 11, PW - 80);
      for (const l of lines) { ops.push(colorText(l, 'F1', 11, 40, y, [0.12, 0.13, 0.16])); y -= 16; }
      y -= 4;
      if (y < 70) { // новая страница при переполнении — редко, генератор контролирует объём
        y = 70;
      }
    }
    // колонтитул
    ops.push(`q ${accent[0]} ${accent[1]} ${accent[2]} rg 0 44 ${PW} 1.5 re f Q`);
    ops.push(colorText(`${opts.subject || 'Lab-Hub'} — стр. ${i + 1} из ${pages.length}`, 'F1', 9, 40, 30, [0.5, 0.52, 0.58]));
    contentIds.push(add({ stream: ops.join('\n') }));
  }

  // Pages & Page objects
  const pagesObjNum = 2;
  const font1 = 3, font2 = 4;
  const pageIds = [];
  for (let i = 0; i < pages.length; i++) {
    pageIds.push(4 + i + 1); // reserve: page objects start after fonts (5..)
  }
  // Собираем финальный PDF вручную (нумерация объектов фиксирована):
  // 1 Catalog, 2 Pages, 3 F1, 4 F2, 5..(4+N) Pages, then contents
  const n = pages.length;
  const out = [];
  const offsets = [];
  let buf = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1');

  function pushObj(num, body) {
    const s = Buffer.from(`${num} 0 obj\n`, 'latin1');
    offsets[num] = buf.length;
    buf = Buffer.concat([buf, s, body, Buffer.from(`\nendobj\n`, 'latin1')]);
  }

  const kids = [];
  for (let i = 0; i < n; i++) kids.push(`${5 + i} 0 R`);
  pushObj(1, Buffer.from(`<< /Type /Catalog /Pages 2 0 R >>`, 'latin1'));
  pushObj(2, Buffer.from(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`, 'latin1'));
  const diff = buildEncodingDiff();
  pushObj(3, Buffer.from(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /Differences [${diff}] >> >>`, 'latin1'));
  pushObj(4, Buffer.from(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding << /Type /Encoding /Differences [${diff}] >> >>`, 'latin1'));
  for (let i = 0; i < n; i++) {
    const contentNum = 5 + n + i;
    pushObj(5 + i, Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>`, 'latin1'));
  }
  for (let i = 0; i < n; i++) {
    const streamBuf = Buffer.from(objects[i].stream, 'latin1');
    const compressed = zlib.deflateSync(streamBuf);
    pushObj(5 + n + i, Buffer.concat([
      Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      compressed,
      Buffer.from(`\nendstream`, 'latin1'),
    ]));
  }

  const xrefPos = buf.length;
  const total = 4 + 2 * n;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) {
    xref += String(offsets[i] || 0).padStart(10, '0') + ' 00000 n \n';
  }
  xref += `trailer\n<< /Size ${total + 1} /Root 1 0 R /Info << /Producer (lab-hub) /Title (${opts.subject || 'material'}) >> >>\nstartxref\n${xrefPos}\n%%EOF`;
  buf = Buffer.concat([buf, Buffer.from(xref, 'latin1')]);
  return buf;
}

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function colorText(text, font, size, x, y, rgb) {
  const enc = encodeText(text);
  const pre = Buffer.from(`q ${rgb.map(v => v.toFixed(3)).join(' ')} rg BT /${font} ${size} Tf ${x} ${y} Td (`, 'latin1');
  const post = Buffer.from(`) Tj ET Q`, 'latin1');
  return Buffer.concat([pre, enc, post]).toString('latin1');
}
