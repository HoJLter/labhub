// Рендерер Markdown в стиле Obsidian. Без зависимостей, только node-совместимый ES-модуль.
//
// Безопасен по умолчанию: HTML из исходника ЭКРАНИРУЕТСЯ и никогда не проходит насквозь.
// Раздел заметок публичный (пишет только админ, читают все), поэтому рендерер — это граница
// безопасности, а не просто форматирование: предполагаем враждебный текст.
// Никаких eval/new Function, все URL проходят через safeUrl().

// ——— Базовое экранирование ———

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ESC_MAP[c]); }

// Плейсхолдеры готового HTML, который нельзя трогать экранированием: \u0000<номер>\u0001.
// Ограничитель с двух сторон обязателен: без него два соседних плейсхолдера слились бы в один
// («\u00001\u0000\u00002\u0000» прочитался бы как ссылка на фрагмент 12).
// Сташ общий на весь рендер, поэтому вложенные вызовы inline() не теряют свои фрагменты.
const PH_RE = /\u0000(\d+)\u0001/g;
const CTRL_RE = /[\u0000\u0001]/g;
function stashPush(ctx, html) { ctx.stash.push(html); return `\u0000${ctx.stash.length - 1}\u0001`; }

function escapePreserving(s) {
  let out = '';
  let last = 0;
  for (const m of String(s).matchAll(PH_RE)) {
    out += esc(String(s).slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + esc(String(s).slice(last));
}

/** Разворачивает плейсхолдеры. Цикл нужен для вложенных конструкций (жирный внутри ссылки и т.п.). */
function restore(html, stash) {
  let out = String(html);
  for (let i = 0; i < 50 && out.includes('\u0000'); i++) {
    const next = out.replace(PH_RE, (_, n) => stash[+n] ?? '');
    if (next === out) break;
    out = next;
  }
  return out.replace(CTRL_RE, '');
}

// ——— Frontmatter (подмножество YAML) ———

function stripComment(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += ch;
  }
  return out;
}

function scalar(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

function splitInlineArray(inner) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of inner) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parseYamlish(lines) {
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = stripComment(lines[i]);
    if (!line.trim()) { i++; continue; }
    const m = /^([A-Za-z0-9_.\-\u0400-\u04FF]+)\s*:\s*(.*)$/.exec(line);
    if (!m) { i++; continue; }
    const key = m[1];
    const val = m[2];

    if (!val.trim()) {
      // Возможен блочный массив: последующие строки вида "  - значение"
      const items = [];
      let j = i + 1;
      while (j < lines.length) {
        const im = /^\s+-\s*(.*)$/.exec(stripComment(lines[j]));
        if (!im) break;
        items.push(scalar(im[1]));
        j++;
      }
      if (items.length) { data[key] = items; i = j; continue; }
      data[key] = '';
      i++;
      continue;
    }
    if (val.trim().startsWith('[') && val.trim().endsWith(']')) {
      data[key] = splitInlineArray(val.trim().slice(1, -1)).map(scalar);
    } else {
      data[key] = scalar(val);
    }
    i++;
  }
  return data;
}

/**
 * Отделяет frontmatter от тела. Никогда не бросает: при любой непонятной структуре
 * возвращает пустой объект и исходный текст целиком.
 */
export function parseFrontmatter(src) {
  const text = String(src ?? '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return { data: {}, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') { end = i; break; }
  }
  if (end < 0) return { data: {}, body: text };
  return { data: parseYamlish(lines.slice(1, end)), body: lines.slice(end + 1).join('\n') };
}

// ——— Код-блоки и код-спаны (их содержимое не разбирается как разметка) ———

function blankCodeSpans(line) {
  return String(line).replace(/(`+)([\s\S]*?)\1/g, mm => ' '.repeat(mm.length));
}

/** Проходит строки, отмечая, находится ли каждая внутри ``` / ~~~ блока. */
function* scanLines(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (m) {
      const marker = m[1][0];
      if (fence === marker) fence = null;
      else if (!fence) fence = marker;
      yield { line: lines[i], inFence: true, num: i + 1 };
      continue;
    }
    yield { line: lines[i], inFence: !!fence, num: i + 1 };
  }
}

// ——— Разбор wiki-ссылок ———

export function isImageName(name) {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(String(name || '').trim());
}

/** Внутренность [[...]] → { target, label, heading, block, embed }. */
export function parseWikiInner(inner, embed = false) {
  let target = String(inner ?? '').trim();
  let label = null;
  const pipe = target.indexOf('|');
  if (pipe >= 0) {
    label = target.slice(pipe + 1).trim() || null;
    target = target.slice(0, pipe);
  }
  let heading = null;
  let block = null;
  const hash = target.indexOf('#');
  if (hash >= 0) {
    const frag = target.slice(hash + 1).trim();
    target = target.slice(0, hash);
    if (frag.startsWith('^')) block = frag.slice(1) || null;
    else heading = frag || null;
  }
  return { target: target.trim(), label, heading, block, embed };
}

export function wikiLabel(link) {
  if (link.label) return link.label;
  const base = link.target || '';
  if (link.heading) return `${base}#${link.heading}`.replace(/^#/, '');
  return base;
}

/** Все [[ссылки]] и ![[вложения]] в тексте (код-блоки и код-спаны игнорируются). */
export function extractWikiLinks(body) {
  const out = [];
  for (const { line, inFence, num } of scanLines(body)) {
    if (inFence) continue;
    const clean = blankCodeSpans(line);
    const re = /(!?)\[\[([^\[\]]*?)\]\]/g;
    let m;
    while ((m = re.exec(clean))) {
      if (m.index > 0 && clean[m.index - 1] === '\\') continue;   // экранированная \[[
      const link = parseWikiInner(m[2], m[1] === '!');
      out.push({ ...link, raw: m[0], line: num });
    }
  }
  return out;
}

// ——— Теги ———

function asArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

const TAG_RE = /(^|[^\w\u0400-\u04FF#\\/&])(#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

/** Теги из текста + из frontmatter; дедупликация без учёта регистра. */
export function extractTags(body, extraTags = []) {
  const found = [];
  const push = t => {
    const clean = String(t ?? '').replace(/^#/, '').trim();
    if (clean && !/^\d+$/.test(clean)) found.push(clean);
  };

  for (const { line, inFence } of scanLines(body)) {
    if (inFence) continue;
    let l = blankCodeSpans(line);
    l = l.replace(/^\s{0,3}(#{1,6})\s/, ' ');   // ATX-заголовок — не тег
    l = l.replace(/\\#/g, ' ');
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(l))) push(m[2]);
  }
  for (const t of asArray(extraTags)) push(t);

  const seen = new Set();
  const out = [];
  for (const t of found) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// ——— Якоря заголовков ———

export function slugifyHeading(text) {
  const s = String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/[\s\u00a0]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'section';
}

// ——— Безопасные URL ———

/**
 * Пропускает только http/https/mailto и относительные адреса.
 * Из значения вырезаются все пробелы и управляющие символы — иначе `java\tscript:` и
 * `JaVaScRiPt:` проскочили бы проверку схемы.
 */
export function safeUrl(u) {
  const s = String(u ?? '').trim().replace(/[\u0000-\u0020\u007f]/g, '');
  if (!s) return null;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') return null;
    return s;
  }
  if (s.startsWith('//')) return null;     // protocol-relative — не поддерживаем
  return s;
}

// ——— Inline-разметка ———

function inline(text, ctx) {
  if (ctx.depth > 10) return escapePreserving(String(text));

  // Управляющие символы-плейсхолдеры вырезаем ТОЛЬКО из исходного текста (depth 0).
  // Во вложенных вызовах строка уже содержит готовые фрагменты, и их терять нельзя.
  let s = ctx.depth === 0 ? String(text).replace(CTRL_RE, '') : String(text);
  const nest = x => { ctx.depth++; const r = inline(x, ctx); ctx.depth--; return r; };

  // 1. Экранирование одиночных символов
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!>~=|])/g, (_, c) => stashPush(ctx, esc(c)));

  // 2. Код-спаны
  s = s.replace(/(`+)([\s\S]*?)\1/g, (_, __, code) => stashPush(ctx, `<code>${esc(String(code).trim())}</code>`));

  // 3. Картинки и ссылки markdown
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (mm, alt, url, title) => {
    const safe = safeUrl(url);
    if (!safe) return stashPush(ctx, esc(alt || url));
    return stashPush(ctx, `<img src="${esc(safe)}" alt="${esc(alt)}"${title ? ` title="${esc(title)}"` : ''} loading="lazy">`);
  });
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (mm, label, url, title) => {
    const safe = safeUrl(url);
    const inner = nest(label);
    if (!safe) return stashPush(ctx, inner);
    const ext = /^https?:/i.test(safe) ? ' rel="noopener nofollow" target="_blank"' : '';
    return stashPush(ctx, `<a href="${esc(safe)}"${title ? ` title="${esc(title)}"` : ''}${ext}>${inner}</a>`);
  });

  // 4. Wiki-ссылки и вложения ![[...]]
  s = s.replace(/(!?)\[\[([^\[\]]*?)\]\]/g, (mm, bang, inner) => {
    const link = parseWikiInner(inner, bang === '!');
    const label = wikiLabel(link);
    if (link.embed) {
      if (isImageName(link.target)) {
        const href = ctx.opts.resolveAsset ? ctx.opts.resolveAsset(link.target) : null;
        if (!href) return stashPush(ctx, `<span class="wiki-embed is-missing">${esc(mm)}</span>`);
        return stashPush(ctx, `<img src="${esc(href)}" alt="${esc(label)}" loading="lazy">`);
      }
      const html = ctx.opts.resolveTransclusion ? ctx.opts.resolveTransclusion(link) : null;
      if (!html) return stashPush(ctx, `<span class="wiki-embed is-missing">${esc(mm)}</span>`);
      return stashPush(ctx, String(html));
    }
    const href = ctx.opts.resolveWikiLink ? ctx.opts.resolveWikiLink(link) : null;
    if (!href) return stashPush(ctx, `<a class="wiki-link is-missing" data-target="${esc(link.target)}">${esc(label)}</a>`);
    return stashPush(ctx, `<a class="wiki-link" href="${esc(href)}">${esc(label)}</a>`);
  });

  // 5. Автоссылки <https://…>
  s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/g, (mm, url) => {
    const safe = safeUrl(url);
    if (!safe) return stashPush(ctx, esc(url));
    return stashPush(ctx, `<a href="${esc(safe)}" rel="noopener nofollow" target="_blank">${esc(url)}</a>`);
  });

  // 6. Сноски: [^id]
  s = s.replace(/\[\^([^\]]+)\]/g, (mm, id) => {
    let idx = ctx.footRefs.indexOf(id);
    if (idx < 0) { ctx.footRefs.push(id); idx = ctx.footRefs.length - 1; }
    return stashPush(ctx, `<sup class="footnote-ref" id="fnref-${esc(id)}"><a href="#fn-${esc(id)}">${idx + 1}</a></sup>`);
  });

  // 7. Теги #тег
  s = s.replace(TAG_RE, (mm, pre, tag) => {
    const name = tag.slice(1);
    const href = ctx.opts.resolveTag ? ctx.opts.resolveTag(name) : null;
    const inner = href
      ? `<a class="tag" href="${esc(href)}">#${esc(name)}</a>`
      : `<span class="tag">#${esc(name)}</span>`;
    return pre + stashPush(ctx, inner);
  });

  // 8. Выделения (порядок важен: от самых длинных маркеров к коротким)
  s = s.replace(/~~([\s\S]+?)~~/g, (_, x) => stashPush(ctx, `<del>${nest(x)}</del>`));
  s = s.replace(/==([\s\S]+?)==/g, (_, x) => stashPush(ctx, `<mark>${nest(x)}</mark>`));
  s = s.replace(/\*\*\*([\s\S]+?)\*\*\*/g, (_, x) => stashPush(ctx, `<strong><em>${nest(x)}</em></strong>`));
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, (_, x) => stashPush(ctx, `<strong>${nest(x)}</strong>`));
  s = s.replace(/__([\s\S]+?)__/g, (_, x) => stashPush(ctx, `<strong>${nest(x)}</strong>`));
  s = s.replace(/(^|[^*\w])\*([^*\s][\s\S]*?)\*/g, (mm, pre, x) => pre + stashPush(ctx, `<em>${nest(x)}</em>`));
  s = s.replace(/(^|[^_\w])_([^_\s][\s\S]*?)_/g, (mm, pre, x) => pre + stashPush(ctx, `<em>${nest(x)}</em>`));

  // 9. Жёсткие переносы строк
  const br = stashPush(ctx, '<br>\n');
  s = s.replace(/ {2,}\n/g, br).replace(/\\\n/g, br);

  return escapePreserving(s);
}

// ——— Блочная разметка ———

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;

function uniqueId(ctx, base) {
  let id = base;
  let n = 1;
  while (ctx.ids.has(id)) id = `${base}-${n++}`;
  ctx.ids.add(id);
  return id;
}

function heading(level, text, ctx) {
  const id = uniqueId(ctx, slugifyHeading(String(text).replace(/[*_`~]/g, '')));
  return `<h${level} id="${esc(id)}">${inline(text, ctx)}</h${level}>`;
}

function startsBlock(line) {
  if (/^\s{0,3}(#{1,6})\s/.test(line)) return true;
  if (/^\s*(`{3,}|~{3,})/.test(line)) return true;
  if (/^\s{0,3}>/.test(line)) return true;
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return true;
  if (LIST_RE.test(line)) return true;
  if (/^\[\^[^\]]+\]:/.test(line)) return true;
  return false;
}

function codeBlock(lines, i, fence) {
  const marker = fence[1][0];
  const closeRe = marker === '`' ? /^\s*`{3,}\s*$/ : /^\s*~{3,}\s*$/;
  const info = String(fence[2] || '').trim();
  const buf = [];
  let j = i + 1;
  while (j < lines.length && !closeRe.test(lines[j])) { buf.push(lines[j]); j++; }
  const lang = info.split(/\s+/)[0].replace(/[^A-Za-z0-9+#_.-]/g, '');
  const cls = lang ? ` class="language-${esc(lang)}"` : '';
  const attr = lang ? ` data-lang="${esc(lang)}"` : '';
  return { html: `<pre${attr}><code${cls}>${esc(buf.join('\n'))}</code></pre>`, next: Math.min(j + 1, lines.length) };
}

function paragraph(lines, i, ctx) {
  const buf = [];
  while (i < lines.length && lines[i].trim()) {
    if (buf.length && startsBlock(lines[i])) break;
    buf.push(lines[i]);
    i++;
  }
  return { html: `<p>${inline(buf.join('\n'), ctx)}</p>`, next: i };
}

function blockquote(lines, i, ctx) {
  const buf = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j];
    const m = /^\s{0,3}>\s?(.*)$/.exec(l);
    if (m) { buf.push(m[1]); j++; continue; }
    // ленивое продолжение: обычная строка внутри цитаты
    if (l.trim() && buf.length && !startsBlock(l)) { buf.push(l); j++; continue; }
    break;
  }
  const callout = /^\[!([A-Za-z\u0400-\u04FF]+)\]([+-])?\s*(.*)$/.exec(buf[0] || '');
  if (callout) {
    const type = callout[1].toLowerCase();
    const fold = callout[2];
    const title = (callout[3] || '').trim() || type;
    const rest = buf.slice(1);
    const hasBody = rest.join('\n').trim().length > 0;
    const body = hasBody ? blocks(rest, ctx) : '';
    const cls = `callout callout-${esc(type)}`;
    if (fold) {
      return {
        html: `<details class="${cls}" data-callout="${esc(type)}"${fold === '+' ? ' open' : ''}>` +
          `<summary class="callout-title">${esc(title)}</summary>${body}</details>`,
        next: j,
      };
    }
    return {
      html: `<div class="${cls}" data-callout="${esc(type)}"><div class="callout-title">${esc(title)}</div>${body}</div>`,
      next: j,
    };
  }
  return { html: `<blockquote>${blocks(buf, ctx)}</blockquote>`, next: j };
}

function list(lines, start, ctx) {
  const first = LIST_RE.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  let loose = false;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const nm = j < lines.length ? LIST_RE.exec(lines[j]) : null;
      if (nm && nm[1].length >= baseIndent) { loose = true; i = j; continue; }
      break;
    }
    const m = LIST_RE.exec(line);
    if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;

    const content = [m[4]];
    const indent = m[1].length + m[2].length + m[3].length;
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j >= lines.length) break;
        const nm = LIST_RE.exec(lines[j]);
        const lead = (/^[ \t]*/.exec(lines[j]) || [''])[0].length;
        const ind = nm ? nm[1].length : lead;
        if (nm && nm[1].length <= baseIndent) break;
        if (ind <= baseIndent) break;
        content.push('');
        loose = true;
        i++;
        continue;
      }
      const nm = LIST_RE.exec(l);
      if (nm && nm[1].length <= baseIndent) break;
      const lead = (/^[ \t]*/.exec(l) || [''])[0].length;
      content.push(l.slice(Math.min(lead, indent)));
      i++;
    }
    items.push({ content, ordered });
  }

  const parts = [];
  for (const it of items) {
    let task = null;
    const tm = /^\[([ xX])\]\s*/.exec(it.content[0] || '');
    if (tm) {
      task = tm[1].toLowerCase() === 'x';
      it.content[0] = it.content[0].slice(tm[0].length);
    }
    let inner = blocks(it.content, ctx);
    // В «плотном» списке первый абзац элемента не оборачивается в <p> (стандартное поведение
    // markdown) — иначе пункт с вложенным списком выглядел бы как отдельный абзац.
    if (!loose) inner = inner.replace(/^\s*<p>([\s\S]*?)<\/p>/, '$1');
    const box = task === null ? '' : `<input type="checkbox" disabled${task ? ' checked' : ''}> `;
    const cls = task === null ? '' : ' class="task-list-item"';
    parts.push(`<li${cls}>${box}${inner}</li>`);
  }

  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
  return { html: `<${tag}${startAttr}>${parts.join('')}</${tag}>`, next: i };
}

function table(lines, start, ctx) {
  const splitRow = l => String(l)
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map(c => c.replace(/\\\|/g, '|').trim());

  const head = splitRow(lines[start]);
  const alignRow = splitRow(lines[start + 1]);
  if (head.length < 2 || alignRow.length < 2) return null;
  if (!alignRow.every(c => /^:?-{1,}:?$/.test(c))) return null;

  const aligns = alignRow.map(c => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : ''));
  const cell = (tag, text, idx) => {
    const a = aligns[idx] ? ` style="text-align:${aligns[idx]}"` : '';
    return `<${tag}${a}>${inline(text, ctx)}</${tag}>`;
  };

  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    rows.push(splitRow(lines[i]));
    i++;
  }

  const thead = `<thead><tr>${head.map((h, idx) => cell('th', h, idx)).join('')}</tr></thead>`;
  const tbody = rows.length
    ? `<tbody>${rows.map(r => `<tr>${head.map((_, idx) => cell('td', r[idx] ?? '', idx)).join('')}</tr>`).join('')}</tbody>`
    : '';
  return { html: `<table>${thead}${tbody}</table>`, next: i };
}

function blocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line);
    if (fence) { const r = codeBlock(lines, i, fence); out.push(r.html); i = r.next; continue; }

    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { out.push(heading(h[1].length, h[2], ctx)); i++; continue; }

    // Setext-заголовок: строка, подчёркнутая === или ---
    if (i + 1 < lines.length && line.trim() && !LIST_RE.test(line) &&
        /^\s{0,3}(=+|-+)\s*$/.test(lines[i + 1])) {
      const lvl = lines[i + 1].trim()[0] === '=' ? 1 : 2;
      out.push(heading(lvl, line.trim(), ctx));
      i += 2;
      continue;
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (/^\s{0,3}>/.test(line)) { const r = blockquote(lines, i, ctx); out.push(r.html); i = r.next; continue; }

    const fn = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(line);
    if (fn) {
      ctx.footnotes.push({ id: fn[1].trim(), text: fn[2] });
      i++;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('-')) {
      const r = table(lines, i, ctx);
      if (r) { out.push(r.html); i = r.next; continue; }
    }

    if (LIST_RE.test(line)) { const r = list(lines, i, ctx); out.push(r.html); i = r.next; continue; }

    const r = paragraph(lines, i, ctx);
    out.push(r.html);
    i = r.next;
  }
  return out.join('\n');
}

function footnotesHtml(ctx) {
  const defs = new Map(ctx.footnotes.map(f => [f.id, f.text]));
  const ids = (ctx.footRefs.length ? ctx.footRefs : [...defs.keys()]).filter(id => defs.has(id));
  if (!ids.length) return '';
  const items = ids.map(id => {
    const num = ctx.footRefs.indexOf(id) + 1;
    const back = ctx.footRefs.includes(id) ? ` <a href="#fnref-${esc(id)}" class="footnote-back">↩</a>` : '';
    return `<li id="fn-${esc(id)}">${inline(defs.get(id), ctx)}${back}</li>`;
  });
  return `<section class="footnotes"><hr><ol>${items.join('')}</ol></section>`;
}

/**
 * Рендер markdown в HTML.
 * opts = {
 *   currentPath, resolveWikiLink(link), resolveAsset(path),
 *   resolveTransclusion(link), resolveTag(tag)
 * }
 * Все resolve* могут вернуть null — тогда выводится «битая» ссылка/заглушка.
 */
export function renderMarkdown(body, opts = {}) {
  const { body: md } = parseFrontmatter(body);
  const ctx = { opts, stash: [], ids: new Set(), footnotes: [], footRefs: [], depth: 0 };
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  let html = blocks(lines, ctx);
  if (ctx.footnotes.length) html += '\n' + footnotesHtml(ctx);
  return restore(html, ctx.stash);
}