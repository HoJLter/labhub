// Интеграционные тесты слоя заметок (server/vault.js) на настоящей файловой системе.
// Работают в изолированном временном каталоге, поэтому НЕ трогают рабочий data/ проекта.
// Запуск: node test/vault.test.js
//
// Переменные окружения должны быть выставлены ДО импорта модулей: config.js читает их
// на этапе загрузки модуля, поэтому здесь используется динамический import().
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'labhub-vault-'));
process.env.DATA_DIR = TMP;
process.env.VAULT_DIR = path.join(TMP, 'vault');
process.env.DB_PATH = path.join(TMP, 'test.sqlite');
process.env.IP_SALT = 'test-salt';

const vault = await import('../server/vault.js');
const { renderMarkdown } = await import('../server/markdown.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}: ${e.message}`); }
}

const V = path.join(TMP, 'vault');
const write = (rel, content) => {
  const abs = path.join(V, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
};

// ——— Готовим «настоящий» vault ———
write('БЖД.md', [
  '---',
  'tags: [учёба]',
  'aliases: [Безопасность жизнедеятельности]',
  '---',
  '',
  '# БЖД',
  '',
  'Конспект по [[Лаба 1]] и #методичка.',
  '',
  '> [!note] Важно',
  '> Читать перед [[Лаба 1|первой лабой]].',
  '',
  '## Разделы',
  '',
  '- [x] Введение',
  '- [ ] Практика',
  '',
  '| Тема | Часы |',
  '|------|-----:|',
  '| Охрана труда | 4 |',
  '',
].join('\n'));

write('Лаба 1.md', [
  '# Лаба 1',
  '',
  'Обратно в [[БЖД]]. Схема:',
  '',
  '![[схема.png]]',
  '',
  'Подробности в [[Лаба 2#Введение]].',
  '',
].join('\n'));

write('Лаба 2.md', '# Лаба 2\n\n## Введение\n\nСсылка в никуда: [[Не существует]].\n');

write('Секрет.md', '---\nvisibility: private\n---\n\n# Секрет\n\nЧерновик с [[БЖД]].\n');

// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
fs.mkdirSync(path.join(V, 'attachments'), { recursive: true });
fs.writeFileSync(path.join(V, 'attachments', 'схема.png'), PNG);

// ——— Индексация ———
let stat;
test('reindexAll индексирует все .md-файлы', () => {
  stat = vault.reindexAll();
  assert.equal(stat.scanned, 4, `просканировано ${stat.scanned}`);
  assert.equal(stat.added, 4, `добавлено ${stat.added}`);
  assert.equal(stat.removed, 0);
});

test('заметки читаются по slug с транслитерацией', () => {
  const bzhd = vault.noteBySlug('bzhd');
  assert.ok(bzhd, 'заметка bzhd не найдена');
  assert.equal(bzhd.title, 'БЖД');
  const laba = vault.noteBySlug('laba-1');
  assert.ok(laba, 'заметка laba-1 не найдена');
});

test('alias из frontmatter сохраняется', () => {
  const bzhd = vault.noteBySlug('bzhd');
  assert.deepEqual(JSON.parse(bzhd.aliases), ['Безопасность жизнедеятельности']);
});

test('frontmatter visibility: private учитывается', () => {
  const pub = vault.allNotes({ isAdmin: false });
  const adm = vault.allNotes({ isAdmin: true });
  assert.equal(pub.length, 3, `публичных ${pub.length}`);
  assert.equal(adm.length, 4, `для админа ${adm.length}`);
  assert.ok(!pub.some(n => n.path === 'Секрет'));
  assert.ok(adm.some(n => n.path === 'Секрет'));
});

test('private-заметка недоступна по slug для не-админа', () => {
  assert.equal(vault.noteBySlug('sekret', { isAdmin: false }), null);
  assert.ok(vault.noteBySlug('sekret', { isAdmin: true }));
});

test('теги собираются из текста и frontmatter', () => {
  const tags = vault.tagCounts({ isAdmin: false }).map(t => t.tag);
  assert.ok(tags.includes('учёба'), `нет тега из frontmatter: ${tags.join(',')}`);
  assert.ok(tags.includes('методичка'), `нет тега из текста: ${tags.join(',')}`);
});

test('tags не подхватывают служебные символы из ссылок', () => {
  const tags = vault.tagCounts({ isAdmin: true }).map(t => t.tag);
  assert.ok(!tags.some(t => t.includes('#')), `в тегах остались решётки: ${tags.join(',')}`);
});

// ——— Ссылки ———
test('wiki-ссылки разрешаются в заметки', () => {
  const bzhd = vault.noteBySlug('bzhd');
  const out = vault.renderNote(bzhd).outgoing;
  const target = out.find(l => l.raw === 'Лаба 1');
  assert.ok(target, `ссылка не разрешилась: ${JSON.stringify(out)}`);
  assert.equal(target.slug, 'laba-1');
  assert.equal(target.missing, false);
});

test('ссылка с подписью [[Цель|Подпись]] разрешается', () => {
  const bzhd = vault.noteBySlug('bzhd');
  const out = vault.renderNote(bzhd).outgoing;
  assert.ok(out.some(l => l.raw === 'Лаба 1' && !l.missing));
});

test('битая ссылка помечается missing', () => {
  const laba2 = vault.noteBySlug('laba-2');
  const out = vault.renderNote(laba2).outgoing;
  const bad = out.find(l => l.raw === 'Не существует');
  assert.ok(bad, 'битая ссылка не попала в исходящие');
  assert.equal(bad.missing, true);
  assert.equal(bad.slug, null);
});

test('обратные ссылки (backlinks) считаются', () => {
  const bzhd = vault.noteBySlug('bzhd');
  const bl = vault.renderNote(bzhd).backlinks.map(b => b.path);
  assert.ok(bl.includes('Лаба 1'), `backlinks: ${bl.join(',')}`);
});

test('ссылка с якорем даёт правильный href', () => {
  const laba1 = vault.noteBySlug('laba-1');
  const rendered = vault.renderNote(laba1);
  assert.match(rendered.html, /href="\/notes\/laba-2#введение"/, rendered.html.slice(0, 400));
});

test('разрешение по alias работает', () => {
  const resolved = vault.resolveTarget('Безопасность жизнедеятельности', 'Лаба 1');
  assert.ok(resolved, 'alias не разрешился в заметку');
  assert.equal(resolved.path, 'БЖД');
});

// ——— Рендер ———
test('renderNote отдаёт html, оглавление и теги', () => {
  const bzhd = vault.noteBySlug('bzhd');
  const r = vault.renderNote(bzhd);
  assert.ok(r.html.includes('<h1'), 'нет заголовка');
  assert.ok(r.html.includes('wiki-link'), 'нет wiki-ссылок в html');
  assert.ok(r.headings.length >= 2, `оглавление: ${JSON.stringify(r.headings)}`);
  assert.ok(r.tags.includes('методичка'));
});

test('callout, чек-лист и таблица рендерятся', () => {
  const r = vault.renderNote(vault.noteBySlug('bzhd'));
  assert.match(r.html, /class="callout callout-note"/);
  assert.match(r.html, /task-list-item/);
  assert.match(r.html, /<table>/);
});

test('вложение-картинка получает URL раздачи', () => {
  const r = vault.renderNote(vault.noteBySlug('laba-1'));
  assert.match(r.html, /<img src="\/api\/vault\/asset\//, r.html.slice(0, 300));
});

test('рендер заметки экранирует HTML из файла', () => {
  write('Злая.md', '# Злая\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n');
  vault.reindexAll();
  const r = vault.renderNote(vault.noteBySlug('zlaya'));
  assert.ok(!r.html.includes('<script'), 'скрипт прошёл насквозь!');
  assert.ok(!r.html.includes('javascript:'), 'javascript: в ссылке!');
});

// ——— Граф ———
test('граф содержит узлы и рёбра', () => {
  const g = vault.graphData({ isAdmin: false });
  assert.ok(g.nodes.length >= 3);
  assert.ok(g.edges.length >= 3, `рёбер ${g.edges.length}`);
  const edge = g.edges.find(e => e.source === 'БЖД' && e.target === 'Лаба 1');
  assert.ok(edge, `нет ребра БЖД→Лаба 1: ${JSON.stringify(g.edges)}`);
});

test('граф помечает битые ссылки узлами missing', () => {
  const g = vault.graphData({ isAdmin: false, includeMissing: true });
  const missing = g.nodes.filter(n => n.missing);
  assert.ok(missing.length >= 1, 'нет missing-узлов');
  assert.ok(missing.some(n => n.title === 'Не существует'));
});

test('граф не показывает private-заметки обычным посетителям', () => {
  const g = vault.graphData({ isAdmin: false });
  assert.ok(!g.nodes.some(n => n.path === 'Секрет'));
});

test('степень узла считается', () => {
  const g = vault.graphData({ isAdmin: false });
  const bzhd = g.nodes.find(n => n.path === 'БЖД');
  assert.ok(bzhd.degree >= 1, `degree=${bzhd.degree}`);
});

test('локальный граф берёт окружение заметки', () => {
  const lg = vault.localGraph('bzhd', { depth: 1 });
  const paths = lg.nodes.map(n => n.path);
  assert.ok(paths.includes('БЖД'));
  assert.ok(paths.includes('Лаба 1'), `окружение: ${paths.join(',')}`);
});

// ——— Переименование (совместимость с Obsidian) ———
test('переименование файла сохраняет slug заметки', () => {
  const before = vault.noteBySlug('laba-1').slug;
  vault.moveNoteRaw('Лаба 1', 'Лаба 1 (новая)');
  vault.reindexAll();
  const after = vault.noteBySlug(before);
  assert.ok(after, `заметка потерялась после переименования (slug ${before})`);
  assert.equal(after.slug, before, 'slug не должен меняться');
  assert.equal(after.path, 'Лаба 1 (новая)');
});

test('переименование не теряет входящие ссылки', () => {
  const bl = vault.renderNote(vault.noteBySlug('bzhd')).backlinks.map(b => b.path);
  assert.ok(bl.includes('Лаба 1 (новая)'), `backlinks после переименования: ${bl.join(',')}`);
});

// ——— Редактирование существующей заметки ———
test('правка содержимого переиндексируется', () => {
  const raw = vault.readNoteRaw('Лаба 2');
  vault.writeNoteRaw('Лаба 2', raw + '\n\nДобавлено #новое и [[БЖД]].\n');
  vault.reindexAll();
  const tags = vault.tagCounts({ isAdmin: false }).map(t => t.tag);
  assert.ok(tags.includes('новое'), `нет нового тега: ${tags.join(',')}`);
});

test('удаление файла убирает заметку из индекса', () => {
  fs.rmSync(path.join(V, 'Злая.md'));
  vault.reindexAll();
  assert.equal(vault.noteBySlug('zlaya'), null);
});

// ——— Мягкое удаление в .trash ———
test('trashNoteRaw переносит файл в .trash и убирает из индекса', () => {
  vault.trashNoteRaw('Лаба 2');
  vault.reindexAll();
  assert.equal(vault.noteBySlug('laba-2'), null);
  const trashed = fs.readdirSync(path.join(V, '.trash'));
  assert.ok(trashed.length >= 1, 'в .trash пусто');
});

// ——— Вложения ———
test('saveAttachment кладёт файл и не перетирает существующий', () => {
  const a = vault.saveAttachment('схема.png', PNG);
  const b = vault.saveAttachment('схема.png', PNG);
  assert.notEqual(a, b, 'второе вложение перетерло первое');
  assert.ok(vault.assetExists(a));
  assert.ok(vault.assetExists(b));
});

test('saveAttachment отвергает недопустимые типы', () => {
  assert.throws(() => vault.saveAttachment('зловред.exe', Buffer.from('MZ')), /Недопустимый тип/);
});

test('assetUrl кодирует кириллицу', () => {
  assert.match(vault.assetUrl('attachments/схема.png'), /^\/api\/vault\/asset\/attachments\/%D1%81/);
});

// ——— Защита путей ———
test('safeRelPath блокирует выход за пределы vault', () => {
  for (const bad of ['../секрет', '..\\секрет', '/etc/passwd', 'a/../../b', '.obsidian/app.json', '.trash/x']) {
    assert.throws(() => vault.safeRelPath(bad), `не заблокировано: ${bad}`);
  }
});

test('safeRelPath пропускает нормальные пути, включая кириллицу', () => {
  assert.equal(vault.safeRelPath('Методички/БЖД'), 'Методички/БЖД');
  assert.equal(vault.safeRelPath('./a//b/'), 'a/b');
});

test('absPath не выходит за корень', () => {
  assert.throws(() => vault.absPath('../../x'), /Путь вне vault/);
});

test('вложения не отдаются из скрытых каталогов', () => {
  assert.throws(() => vault.safeRelPath('.obsidian/workspace.json'));
});

// ——— Сводка ———
test('vaultStats считает заметки, ссылки и битые ссылки', () => {
  const s = vault.vaultStats();
  assert.ok(s.notes >= 2, `заметок ${s.notes}`);
  assert.ok(s.links >= 1, `ссылок ${s.links}`);
  assert.ok(s.broken >= 1, `битых ${s.broken}`);
  assert.ok(typeof s.dir === 'string' && s.dir.length > 0);
});

test('notesIndex отдаёт список для интерфейса', () => {
  const idx = vault.notesIndex({ isAdmin: true });
  assert.ok(idx.length >= 2);
  const bzhd = idx.find(n => n.path === 'БЖД');
  assert.ok(bzhd.slug && bzhd.title && Array.isArray(bzhd.tags));
});

// ——— Уборка ———
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* файлы БД могут держаться процессом */ }

if (failures.length) {
  console.error(`\n✗ Провалено ${failures.length} из ${passed + failures.length}:`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ vault: ${passed} тестов пройдено`);