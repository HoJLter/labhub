// Тесты рендерера Markdown/Obsidian (server/markdown.js).
// Запуск: node test/markdown.test.js   (ненулевой код возврата при падении)
import assert from 'node:assert/strict';
import {
  parseFrontmatter, extractWikiLinks, extractTags, slugifyHeading, renderMarkdown, safeUrl,
} from '../server/markdown.js';

let passed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}: ${e.message}`); }
}
const html = (md, opts) => renderMarkdown(md, opts || {});

// ——— Frontmatter ———
test('frontmatter: разбор простых значений', () => {
  const { data, body } = parseFrontmatter('---\ntitle: Привет\ntags: [a, b]\ncount: 3\nok: true\n---\nТекст\n');
  assert.equal(data.title, 'Привет');
  assert.deepEqual(data.tags, ['a', 'b']);
  assert.equal(data.count, 3);
  assert.equal(data.ok, true);
  assert.equal(body.trim(), 'Текст');
});

test('frontmatter: блочный массив и комментарии', () => {
  const { data } = parseFrontmatter('---\ntags:\n  - методичка\n  - бжд # комментарий\n---\nx');
  assert.deepEqual(data.tags, ['методичка', 'бжд']);
});

test('frontmatter: отсутствует', () => {
  const { data, body } = parseFrontmatter('# Заголовок\nтекст');
  assert.deepEqual(data, {});
  assert.equal(body, '# Заголовок\nтекст');
});

test('frontmatter: незакрытый блок не ломает разбор', () => {
  const { data, body } = parseFrontmatter('---\ntitle: x\nтекст без закрытия');
  assert.deepEqual(data, {});
  assert.match(body, /title: x/);
});

test('frontmatter: CRLF и BOM', () => {
  const { data, body } = parseFrontmatter('\uFEFF---\r\ntitle: CRLF\r\n---\r\nТело\r\n');
  assert.equal(data.title, 'CRLF');
  assert.match(body, /Тело/);
});

test('frontmatter: кавычки в значениях не режутся комментарием', () => {
  const { data } = parseFrontmatter('---\ntitle: "a # b"\n---\nx');
  assert.equal(data.title, 'a # b');
});

// ——— Wiki-ссылки ———
test('wiki: все формы', () => {
  const links = extractWikiLinks('[[Заметка]] [[Цель|Подпись]] [[Цель#Часть]] [[Цель#Часть|П]] [[#Тут]] ![[Вложение.png]]');
  assert.equal(links.length, 6);
  assert.deepEqual({ t: links[0].target, l: links[0].label, e: links[0].embed }, { t: 'Заметка', l: null, e: false });
  assert.deepEqual({ t: links[1].target, l: links[1].label }, { t: 'Цель', l: 'Подпись' });
  assert.deepEqual({ t: links[2].target, h: links[2].heading }, { t: 'Цель', h: 'Часть' });
  assert.deepEqual({ t: links[3].target, l: links[3].label, h: links[3].heading }, { t: 'Цель', l: 'П', h: 'Часть' });
  assert.equal(links[4].target, '');
  assert.equal(links[4].heading, 'Тут');
  assert.equal(links[5].embed, true);
});

test('wiki: блок-ссылка ^block', () => {
  const [l] = extractWikiLinks('[[Заметка#^abc123]]');
  assert.equal(l.target, 'Заметка');
  assert.equal(l.block, 'abc123');
  assert.equal(l.heading, null);
});

test('wiki: игнорирует код-блоки, код-спаны и экранирование', () => {
  const links = extractWikiLinks('```\n[[в коде]]\n```\n`[[в спане]]`\n\\[[экранировано]]\n[[настоящая]]');
  assert.equal(links.length, 1);
  assert.equal(links[0].target, 'настоящая');
});

test('wiki: номер строки', () => {
  const [l] = extractWikiLinks('строка1\nстрока2\n[[тут]]');
  assert.equal(l.line, 3);
});

test('wiki: рендер разрешённой и битой ссылки', () => {
  const out = html('[[Есть]] [[Нет]]', {
    resolveWikiLink: l => (l.target === 'Есть' ? '/notes/est' : null),
  });
  assert.match(out, /<a class="wiki-link" href="\/notes\/est">Есть<\/a>/);
  assert.match(out, /<a class="wiki-link is-missing" data-target="Нет">Нет<\/a>/);
});

test('wiki: вложение-картинка и трансклюзия', () => {
  const out = html('![[схема.png]] ![[Другая]]', {
    resolveAsset: () => '/api/vault/asset/схема.png',
    resolveTransclusion: () => '<div class="transclusion">вставлено</div>',
  });
  assert.match(out, /<img src="\/api\/vault\/asset\/схема\.png"/);
  assert.match(out, /class="transclusion"/);
});

test('wiki: неразрешённое вложение даёт заглушку', () => {
  const out = html('![[нет.png]]');
  assert.match(out, /wiki-embed is-missing/);
  assert.ok(!out.includes('<img'));
});

// ——— Теги ———
test('tags: простые, вложенные, кириллица', () => {
  assert.deepEqual(extractTags('#бжд #учёба/семестр1 #методичка'), ['бжд', 'учёба/семестр1', 'методичка']);
});

test('tags: игнорируют заголовки, код, якоря URL и экранирование', () => {
  const tags = extractTags('# Заголовок\n`#код`\n```\n#в_блоке\n```\nhttps://example.com#anchor\n\\#экранировано\n#настоящий');
  assert.deepEqual(tags, ['настоящий']);
});

test('tags: чисто числовой тег не считается', () => {
  assert.deepEqual(extractTags('#123'), []);
});

test('tags: слияние с frontmatter и дедупликация без учёта регистра', () => {
  assert.deepEqual(extractTags('#БЖД #прочее', ['бжд', 'ещё']), ['БЖД', 'прочее', 'ещё']);
});

test('tags: рендер в ссылку', () => {
  const out = html('#бжд', { resolveTag: t => '/notes/tag/' + t });
  assert.match(out, /<a class="tag" href="\/notes\/tag\/бжд">#бжд<\/a>/);
});

// ——— Заголовки ———
test('slugifyHeading: кириллица и пунктуация', () => {
  assert.equal(slugifyHeading('Лабораторная работа №1: Введение!'), 'лабораторная-работа-1-введение');
  assert.equal(slugifyHeading('  Много    пробелов  '), 'много-пробелов');
  assert.equal(slugifyHeading('!!!'), 'section');
});

test('headings: id и дедупликация', () => {
  const out = html('# Повтор\n## Повтор\n### Повтор');
  assert.match(out, /<h1 id="повтор">/);
  assert.match(out, /<h2 id="повтор-1">/);
  assert.match(out, /<h3 id="повтор-2">/);
});

test('headings: закрывающие решётки и подчёркивание', () => {
  assert.match(html('## Заголовок ##'), /<h2 id="заголовок">Заголовок<\/h2>/);
  assert.match(html('Заголовок\n========='), /<h1 id="заголовок">/);
  assert.match(html('Заголовок\n---------'), /<h2 id="заголовок">/);
});

// ——— Inline ———
test('inline: выделения', () => {
  const out = html('**жирный** *курсив* ***оба*** ~~зачёрк~~ ==маркер== `код`');
  assert.match(out, /<strong>жирный<\/strong>/);
  assert.match(out, /<em>курсив<\/em>/);
  assert.match(out, /<strong><em>оба<\/em><\/strong>/);
  assert.match(out, /<del>зачёрк<\/del>/);
  assert.match(out, /<mark>маркер<\/mark>/);
  assert.match(out, /<code>код<\/code>/);
});

test('inline: кириллица внутри выделений', () => {
  const out = html('**важно** и _тоже_');
  assert.match(out, /<strong>важно<\/strong>/);
  assert.match(out, /<em>тоже<\/em>/);
});

test('inline: ссылки и картинки', () => {
  const out = html('[текст](https://example.com "тайтл") ![alt](/img/a.png)');
  assert.match(out, /<a href="https:\/\/example\.com" title="тайтл" rel="noopener nofollow" target="_blank">текст<\/a>/);
  assert.match(out, /<img src="\/img\/a\.png" alt="alt" loading="lazy">/);
});

test('inline: автоссылка и экранирование разметки', () => {
  assert.match(html('<https://example.com>'), /<a href="https:\/\/example\.com"/);
  assert.match(html('\\*не курсив\\*'), /\*не курсив\*/);
});

test('inline: жёсткий перенос строки', () => {
  assert.match(html('строка  \nвторая'), /<br>/);
});

// ——— Блоки ———
test('blocks: код-блок с языком', () => {
  const out = html('```js\nconst a = 1 < 2;\n```');
  assert.match(out, /<pre data-lang="js"><code class="language-js">const a = 1 &lt; 2;<\/code><\/pre>/);
});

test('blocks: блок-код не рендерит разметку внутри', () => {
  const out = html('```\n[[ссылка]] **жирный** <b>html</b>\n```');
  assert.ok(!out.includes('<strong>'));
  assert.ok(!out.includes('wiki-link'));
  assert.match(out, /&lt;b&gt;html&lt;\/b&gt;/);
});

test('blocks: цитата и вложенная цитата', () => {
  assert.match(html('> цитата'), /<blockquote><p>цитата<\/p><\/blockquote>/);
  assert.match(html('> > вложенная'), /<blockquote><blockquote>/);
});

test('blocks: callout с заголовком и сворачиванием', () => {
  const out = html('> [!note] Важно\n> текст внутри');
  assert.match(out, /<div class="callout callout-note" data-callout="note">/);
  assert.match(out, /<div class="callout-title">Важно<\/div>/);
  assert.match(out, /текст внутри/);
  const folded = html('> [!warning]- Скрыто\n> тело');
  assert.match(folded, /<details class="callout callout-warning"[^>]*data-callout="warning">/);
  assert.ok(!/open>/.test(folded));
  assert.match(html('> [!tip]+ Раскрыто'), /open>/);
});

test('blocks: callout без своего заголовка берёт имя типа', () => {
  assert.match(html('> [!danger]\n> опасно'), /<div class="callout-title">danger<\/div>/);
});

test('blocks: списки и вложенность', () => {
  const out = html('- один\n- два\n  - вложенный\n- три');
  assert.match(out, /<ul>/);
  assert.match(out, /<li>один<\/li>/);
  assert.match(out, /<li>два[\s\S]*<ul><li>вложенный<\/li><\/ul><\/li>/);
});

test('blocks: нумерованный список с start', () => {
  const out = html('3. три\n4. четыре');
  assert.match(out, /<ol start="3">/);
});

test('blocks: чек-лист', () => {
  const out = html('- [ ] сделать\n- [x] сделано');
  assert.match(out, /<li class="task-list-item"><input type="checkbox" disabled> сделать<\/li>/);
  assert.match(out, /<li class="task-list-item"><input type="checkbox" disabled checked> сделано<\/li>/);
});

test('blocks: таблица с выравниванием', () => {
  const out = html('| A | B | C |\n|---|:--:|--:|\n| 1 | 2 | 3 |');
  assert.match(out, /<table><thead><tr><th>A<\/th><th style="text-align:center">B<\/th><th style="text-align:right">C<\/th><\/tr><\/thead>/);
  assert.match(out, /<tbody><tr><td>1<\/td><td style="text-align:center">2<\/td><td style="text-align:right">3<\/td><\/tr><\/tbody>/);
});

test('blocks: разделитель', () => {
  assert.match(html('---'), /<hr>/);
  assert.match(html('текст\n\n***\n'), /<hr>/);
});

test('blocks: сноски', () => {
  const out = html('Текст[^1]\n\n[^1]: Сама сноска');
  assert.match(out, /<sup class="footnote-ref" id="fnref-1"><a href="#fn-1">1<\/a><\/sup>/);
  assert.match(out, /<section class="footnotes">/);
  assert.match(out, /<li id="fn-1">Сама сноска/);
});

test('blocks: многострочный абзац не склеивается с заголовком', () => {
  const out = html('абзац\n# Заголовок');
  assert.match(out, /<p>абзац<\/p>/);
  assert.match(out, /<h1 id="заголовок">/);
});

// ——— Безопасность ———
test('security: script и raw HTML экранируются', () => {
  const out = html('<script>alert(1)</script>');
  assert.ok(!out.includes('<script'));
  assert.match(out, /&lt;script&gt;/);
});

test('security: onerror в img не проходит', () => {
  const out = html('<img src=x onerror=alert(1)>');
  // сырой HTML обязан быть экранирован целиком, а не превратиться в настоящий тег
  assert.ok(!out.includes('<img'), `настоящий тег в выводе: ${out}`);
  assert.ok(!/<[a-z][^>]*onerror/i.test(out));
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('security: javascript: в ссылке отбрасывается', () => {
  const out = html('[x](javascript:alert(1))');
  assert.ok(!out.includes('javascript:'));
  assert.ok(!out.includes('href='));
  assert.match(out, /x/);
});

test('security: обфусцированные схемы отбрасываются', () => {
  // Свойство безопасности: опасное значение не попадает ни в href, ни в src.
  // Сама строка может остаться в тексте (экранированная) — это инертно.
  for (const bad of ['JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', ' javascript:alert(1)', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>']) {
    const out = html(`[x](${bad})`);
    assert.ok(!/href=|src=/.test(out), `должно быть отброшено: ${JSON.stringify(bad)} → ${out}`);
  }
  // и то же самое на уровне самого санитайзера, включая обход пробелами/табами
  assert.equal(safeUrl('java\tscript:alert(1)'), null);
  assert.equal(safeUrl('JaVaScRiPt:alert(1)'), null);
  assert.equal(safeUrl('\u0000javascript:alert(1)'), null);
});

test('security: data: в картинке не проходит', () => {
  const out = html('![x](data:text/html;base64,PHNjcmlwdD4=)');
  assert.ok(!out.includes('data:text/html'));
  assert.ok(!out.includes('src='));
});

test('security: автоссылка с опасной схемой не превращается в ссылку', () => {
  const out = html('<javascript:alert(1)>');
  assert.ok(!out.includes('href='));
});

test('security: safeUrl пропускает только безопасное', () => {
  assert.equal(safeUrl('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
  assert.equal(safeUrl('http://example.com'), 'http://example.com');
  assert.equal(safeUrl('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(safeUrl('/notes/x'), '/notes/x');
  assert.equal(safeUrl('#anchor'), '#anchor');
  assert.equal(safeUrl('относительный/путь'), 'относительный/путь');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('//evil.com'), null);
  assert.equal(safeUrl('data:text/html,x'), null);
});

test('security: плейсхолдеры \u0000 из исходника не ломают вывод', () => {
  const out = html('текст \u00000\u0000 и [[ссылка]]', { resolveWikiLink: () => '/notes/x' });
  assert.ok(!out.includes('\u0000'));
  assert.match(out, /<a class="wiki-link" href="\/notes\/x">ссылк/);
});

test('security: вложенные конструкции разворачиваются полностью', () => {
  const out = html('**[ссылка](https://e.com)** и *[вторая](/x)*');
  assert.match(out, /<strong><a href="https:\/\/e\.com"/);
  assert.match(out, /<em><a href="\/x">вторая<\/a><\/em>/);
});

// ——— Устойчивость ———
test('robust: битая разметка не бросает исключений', () => {
  const nasty = [
    '[[незакрытая', '**незакрытый жирный', '`висячий бэктик', '| A | B\n|--',
    '> [!', '```нез\nкод', '![', '[]()', '[](javascript:)', '***', '____',
    '#', '####### семь решёток', '\u0000\u0000', 'a'.repeat(5000),
  ];
  for (const md of nasty) {
    const out = html(md);
    assert.equal(typeof out, 'string', `сломалось на: ${JSON.stringify(md.slice(0, 40))}`);
    assert.ok(!out.includes('\u0000'), `остались плейсхолдеры: ${JSON.stringify(md.slice(0, 40))}`);
  }
});

test('robust: пустой ввод', () => {
  assert.equal(html(''), '');
  assert.equal(html(null), '');
  assert.equal(html('# Заголовок'), '<h1 id="заголовок">Заголовок</h1>');
});

test('robust: большая заметка рендерится за разумное время', () => {
  const md = ('# Раздел\n\nТекст **жирный** и [[ссылка]] и `код`.\n\n- пункт\n- пункт\n\n').repeat(400);
  const t0 = Date.now();
  const out = html(md, { resolveWikiLink: () => '/notes/x' });
  const ms = Date.now() - t0;
  assert.ok(out.length > 10000);
  assert.ok(ms < 3000, `слишком медленно: ${ms}ms`);
});

// ——— Итог ———
if (failures.length) {
  console.error(`\n✗ Провалено ${failures.length} из ${passed + failures.length}:`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ markdown: ${passed} тестов пройдено`);