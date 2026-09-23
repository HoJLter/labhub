// Сквозной тест заметок на живом сервере: поднимает приложение в изолированном временном
// DATA_DIR (рабочий data/ не трогается) и проверяет публичное чтение, read-only-режим
// vault в админке и совместимость с Obsidian. Запуск: node test/e2e.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'labhub-e2e-'));
const VAULT = path.join(TMP, 'vault');
const PORT = parseInt(process.env.E2E_PORT || '3997', 10);
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const fails = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fails.push(name); console.log('  FAIL ' + name + (detail ? '  — ' + detail : '')); }
};

const write = (rel, text) => {
  const abs = path.join(VAULT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
};

write('БЖД.md', '---\ntags: [учёба]\naliases: [Безопасность жизнедеятельности]\n---\n\n# БЖД\n\nКонспект по [[Лаба 1]] и #методичка.\n\n> [!note] Важно\n> Читать перед [[Лаба 1|первой лабой]].\n\n| Тема | Часы |\n|------|-----:|\n| Охрана труда | 4 |\n');
write('Лаба 1.md', '# Лаба 1\n\nОбратно в [[БЖД]]. Схема:\n\n![[схема.png]]\n\nСсылка в никуда: [[Не существует]].\n');
write('Секрет.md', '---\nvisibility: private\n---\n\n# Секрет\n\nЧерновик.\n');
fs.mkdirSync(path.join(VAULT, 'attachments'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'attachments', 'схема.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const outLog = path.join(TMP, 'out.log');
const errLog = path.join(TMP, 'err.log');
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  cwd: ROOT,
  env: { ...process.env, DATA_DIR: TMP, VAULT_DIR: VAULT, PORT: String(PORT), ADMIN_LOGIN: 'admin', ADMIN_PASSWORD: 'test12345' },
  stdio: ['ignore', fs.openSync(outLog, 'w'), fs.openSync(errLog, 'w')],
});

const cookies = new Map();
const storeCookies = res => {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
};
async function req(pathname, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(BASE + pathname, { ...opts, headers, redirect: 'manual' });
  storeCookies(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html или xml */ }
  return { status: res.status, headers: res.headers, text, json };
}

let CSRF = null;
const admin = (p, body, method = 'POST') => req(p, {
  method,
  headers: { 'Content-Type': 'application/json', ...(CSRF ? { 'X-CSRF-Token': CSRF } : {}) },
  body: JSON.stringify(body || {}),
});

try {
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    try { ready = (await fetch(BASE + '/api/site')).ok; } catch { /* поднимается */ }
    if (!ready) await new Promise(r => setTimeout(r, 250));
  }
  if (!ready) throw new Error('сервер не поднялся на порту ' + PORT);

  let r = await req('/api/notes');
  check('GET /api/notes → 200', r.status === 200, 'код ' + r.status);
  check('private-заметка скрыта из списка', r.json.notes.length === 2, 'видно ' + r.json.notes.length);
  const tags = r.json.tags.map(t => t.tag);
  check('теги из текста и frontmatter', tags.includes('методичка') && tags.includes('учёба'), tags.join(','));

  r = await req('/api/notes/graph');
  check('граф: узлы и рёбра', r.json.nodes.length >= 3 && r.json.edges.length >= 2, `узлов ${r.json.nodes.length}`);
  check('битая ссылка = missing-узел', r.json.nodes.some(n => n.missing));

  r = await req('/api/notes/bzhd');
  check('страница заметки открывается', r.status === 200);
  check('wiki-ссылка отрендерена с href', r.json.html.includes('class="wiki-link" href="/notes/laba-1"'));
  check('callout отрендерен', r.json.html.includes('callout-note'));
  check('таблица отрендерена', r.json.html.includes('<table>'));
  check('обратные ссылки посчитаны', r.json.backlinks.length >= 1);

  r = await req('/api/notes/bzhd/graph?depth=1');
  check('локальный граф заметки отдаётся', r.status === 200 && r.json.nodes.length >= 2, 'код ' + r.status);

  r = await req('/api/notes/sekret');
  check('private недоступна анонимно', r.status === 404, 'код ' + r.status);

  const seg = encodeURIComponent('схема.png');
  r = await req('/api/vault/asset/attachments/' + seg);
  check('вложение отдаётся как image/png', r.status === 200 && /image\/png/.test(r.headers.get('content-type') || ''));
  r = await req('/api/vault/asset/attachments/' + seg, { headers: { Range: 'bytes=0-9' } });
  check('вложение поддерживает Range', r.status === 206, 'код ' + r.status);
  r = await req('/api/vault/asset/..%2f..%2fpackage.json');
  check('path traversal заблокирован', r.status !== 200, 'код ' + r.status);

  r = await req('/notes/bzhd');
  check('публичная страница отдаётся', r.status === 200);
  check('SSR-мета: заголовок заметки', r.text.includes('<title>БЖД'));
  r = await req('/notes/graph');
  check('страница графа отдаётся', r.status === 200);
  r = await req('/api/notes/tag/' + encodeURIComponent('методичка'));
  check('страница тега отдаёт заметки', r.json.notes.length >= 1);

  r = await req('/api/notes', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  check('публичная запись невозможна', r.status === 404 || r.status === 405, 'код ' + r.status);
  r = await req('/api/admin/notes');
  check('админский API без сессии = 401', r.status === 401, 'код ' + r.status);

  r = await req('/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: 'test12345' }),
  });
  check('вход админа', r.status === 200, 'код ' + r.status);
  r = await req('/api/admin/me');
  CSRF = r.json?.csrf;
  check('CSRF-токен получен', !!CSRF);

  r = await req('/api/admin/notes');
  check('админ видит все заметки', r.json.notes.length === 3, 'видно ' + r.json.notes.length);

  // Vault доступен только для чтения из браузера: эндпоинты редактирования удалены
  r = await admin('/api/admin/notes', { path: 'Новая из админки', content: '# Тест\n' }, 'PUT');
  check('создание заметки из браузера заблокировано', r.status === 404 || r.status === 405, 'код ' + r.status);
  r = await req('/api/admin/notes/attach', {
    method: 'POST',
    headers: { 'X-File-Name': encodeURIComponent('снимок.png'), 'X-CSRF-Token': CSRF },
    body: fs.readFileSync(path.join(VAULT, 'attachments', 'схема.png')),
  });
  check('загрузка вложений из браузера заблокирована', r.status === 404, 'код ' + r.status);
  r = await admin('/api/admin/notes/rename', { path: 'Лаба 1', to: 'Лаба 1 (v2)' });
  check('переименование из браузера заблокировано', r.status === 404, 'код ' + r.status);
  r = await admin('/api/admin/notes/delete', { path: 'Секрет' });
  check('удаление из браузера заблокировано', r.status === 404, 'код ' + r.status);
  check('vault на диске не изменился', fs.existsSync(path.join(VAULT, 'Лаба 1.md')) && fs.existsSync(path.join(VAULT, 'Секрет.md')));

  r = await admin('/api/admin/notes/preview', { path: 'БЖД', content: '# Тест\n\n[[Лаба 1]] и #тег\n' });
  check('предпросмотр рендерит markdown', r.status === 200 && r.json.html.includes('wiki-link'), 'код ' + r.status);
  r = await req('/api/admin/notes/suggest?q=' + encodeURIComponent('Лаба'));
  check('автодополнение [[ссылок]] работает', r.status === 200 && r.json.items.length >= 1, 'код ' + r.status);
  r = await req('/api/admin/notes/download?path=' + encodeURIComponent('БЖД'));
  check('скачивание .md из админки работает', r.status === 200 && r.text.includes('# БЖД'), 'код ' + r.status);

  write('Из Obsidian.md', '# Из Obsidian\n\nНаписано в файле, ссылка на [[БЖД]], тег #обсидиан.\n');
  let found = false;
  for (let i = 0; i < 25 && !found; i++) {
    await new Promise(res => setTimeout(res, 300));
    found = (await req('/api/notes')).json.notes.some(n => n.path === 'Из Obsidian');
  }
  check('fs.watch подхватил файл из Obsidian', found);
  const obs = (await req('/api/notes')).json.notes.find(n => n.path === 'Из Obsidian');
  check('тег из файла Obsidian проиндексирован', (obs?.tags || []).includes('обсидиан'), (obs?.tags || []).join(','));
  r = await req('/api/notes/graph');
  check('новая заметка в графе со связью', r.json.edges.some(e => e.source === 'Из Obsidian' && e.target === 'БЖД'));

  r = await req('/api/folders/tree');
  check('каталог материалов не сломан', r.status === 200);
  r = await req('/admin');
  check('в админке есть раздел «Заметки»', r.status === 200 && r.text.includes('data-nav="notes"'));
  // node:sqlite на Node 22.x ещё экспериментальный и при старте пишет безобидный
  // ExperimentalWarning (+ подсказку про --trace-warnings). Реальной ошибкой это не
  // является, на Node 23+ предупреждения нет вовсе — поэтому отфильтровываем его.
  const errText = fs.readFileSync(errLog, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !/ExperimentalWarning/i.test(l) && !/--trace-warnings/i.test(l))
    .join('\n')
    .trim();
  check('в stderr сервера нет ошибок', !errText, errText.split('\n').slice(0, 3).join(' | '));
} catch (e) {
  fails.push('исключение: ' + e.message);
  console.log('  FAIL исключение: ' + e.message);
} finally {
  server.kill();
  await new Promise(r => setTimeout(r, 600));
  if (fails.length) {
    console.log('\n--- stdout сервера ---\n' + fs.readFileSync(outLog, 'utf8').split('\n').slice(0, 20).join('\n'));
    console.log('--- stderr сервера ---\n' + fs.readFileSync(errLog, 'utf8').split('\n').slice(0, 30).join('\n'));
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* sqlite держится процессом */ }
  if (fails.length) {
    console.error(`\n✗ e2e: провалено ${fails.length} из ${pass + fails.length}`);
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`\n✓ e2e: ${pass} проверок пройдено`);
}