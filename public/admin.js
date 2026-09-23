// Админ-панель lab-hub (раздел 8 ТЗ): дашборд, каталог, материалы, загрузка,
// хранилища, статистика, корзина, журнал, настройки. Плотная табличная вёрстка.
import { makeNotesSection } from './admin-notes.js';

// ——— Базовые утилиты ———
const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(9)) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, isErr = false) {
  const t = el('div', { class: 'toast' + (isErr ? ' err' : '') }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3500);
}
function fmtSize(b) { if (!b && b !== 0) return '—'; const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']; let i = 0, v = b; while (v >= 1024 && i < 4) { v /= 1024; i++; } return `${v >= 10 || !i ? Math.round(v) : v.toFixed(1)} ${u[i]}`; }
function fmtDate(ts) { return ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; }
function fmtDay(day) { const [, m, d] = String(day).split('-'); return `${d}.${m}`; }
const fmtDur = s => s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : null;

let CSRF = null;
async function api(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof Blob)) headers['Content-Type'] = 'application/json';
  if (CSRF) headers['X-CSRF-Token'] = CSRF;
  const r = await fetch(url, { ...opts, headers });
  if (r.status === 401 && !url.includes('/login')) { showLogin(); throw new Error('Требуется вход'); }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); msg = j.message || j.error || msg; } catch { }
    throw new Error(msg);
  }
  if (url.includes('/admin/login')) { /* csrf в теле */ }
  return r.status === 204 ? {} : r.json();
}

function modal(title, bodyNodes, actions) {
  const backdrop = el('div', { class: 'modal-backdrop', onclick: e => { if (e.target === backdrop) close(); } });
  const m = el('div', { class: 'modal' }, el('h2', {}, title), ...bodyNodes,
    el('div', { class: 'modal-actions' }, ...(actions || [el('button', { class: 'btn btn-secondary', onclick: close }, 'Закрыть')])));
  function close() { backdrop.remove(); }
  backdrop.append(m);
  document.body.append(backdrop);
  m.querySelector('input,textarea,select')?.focus();
  return { close, root: m };
}

const badge = (text, color = 'gray') => el('span', { class: `badge badge-${color}` }, text);
const STATUS_BADGE = {
  published: () => badge('опубликован', 'green'),
  processing: () => badge('обработка', 'blue'),
  hidden: () => badge('скрыт', 'amber'),
  deleted: () => badge('корзина', 'red'),
};
const VIS_BADGE = { listed: null, unlisted: () => badge('unlisted', 'amber'), private: () => badge('private', 'purple') };
const HEALTH_BADGE = { ok: () => badge('ok', 'green'), slow: () => badge('slow', 'amber'), broken: () => badge('ссылка сломана', 'red') };
const KIND_LABEL = { pdf: 'PDF', docx: 'DOC', video: 'Видео', image: 'Картинка', link: 'Ссылка' };
const SRC_LABEL = { local: 'сервер', s3: 'S3', webdav: 'WebDAV', drive: 'облако', url: 'URL', embed: 'embed' };

// ——— Вход ———
function showLogin() {
  $('#admin-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}
function showAdmin() {
  $('#login-view').classList.add('hidden');
  $('#admin-view').classList.remove('hidden');
}
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#login-btn');
  btn.disabled = true;
  $('#login-error').classList.add('hidden');
  try {
    const r = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ login: $('#login-login').value, password: $('#login-password').value, totp: $('#login-totp').value || undefined }),
    });
    if (r.needs2fa) { $('#totp-field').classList.remove('hidden'); $('#login-totp').focus(); btn.disabled = false; return; }
    CSRF = r.csrf;
    showAdmin();
    await start();
  } catch (err) {
    const e2 = $('#login-error');
    e2.textContent = err.message; e2.classList.remove('hidden');
  }
  btn.disabled = false;
});
$('#btn-logout').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); } catch { }
  CSRF = null;
  showLogin();
});

// ——— Hash-роутер ———
const routes = {};
function registerRoute(name, fn) { routes[name] = fn; }
async function nav() {
  const name = (location.hash.slice(1) || 'dashboard').split('?')[0];
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === name));
  const content = $('#admin-content');
  content.innerHTML = '<div class="empty-mini">Загрузка…</div>';
  try {
    await (routes[name] || routes.dashboard)(content, new URLSearchParams(location.hash.split('?')[1] || ''));
  } catch (e) {
    if (e.message !== 'Требуется вход') { content.innerHTML = ''; content.append(el('div', { class: 'alert alert-err' }, 'Ошибка: ' + e.message)); }
  }
}
window.addEventListener('hashchange', nav);

async function start() {
  const me = await api('/api/admin/me');
  CSRF = me.csrf;
  showAdmin();
  if (!location.hash) location.hash = '#dashboard';
  nav();
}

// ————————————————— ДАШБОРД (8.1) —————————————————
// Раздел «Заметки» живёт в отдельном модуле: редактор markdown, предпросмотр, граф, вложения.
const notesSection = makeNotesSection({ el, api, toast, modal, field });
registerRoute('notes', notesSection);

registerRoute('dashboard', async (c) => {
  const d = await api('/api/admin/dashboard');
  const ov = d.overview;
  const delta = (cur, prev) => {
    if (prev === 0 || prev === null || prev === undefined) {
      if (cur === 0 || cur === null || cur === undefined) return { txt: '—', cls: '' };
      return { txt: 'новые данные', cls: 'up' };
    }
    const p = Math.round((cur - prev) / prev * 100);
    if (!isFinite(p)) return { txt: '—', cls: '' };
    return { txt: (p >= 0 ? '+' : '') + p + '%', cls: p >= 0 ? 'up' : 'down' };
  };
  const dpv = delta(ov.cur.pv, ov.prev.pv), duv = delta(ov.cur.uv, ov.prev.uv);

  c.append(el('div', { class: 'pg-head' }, el('h1', {}, 'Дашборд'), el('div', { class: 'spacer' }),
    el('span', { class: 'muted' }, `Период: ${fmtDay(ov.from)} — ${fmtDay(ov.to)}`)));

  c.append(el('div', { class: 'grid-4' },
    statCard('Просмотры (PV)', ov.cur.pv, dpv),
    statCard('Посетители (UV)', ov.cur.uv, duv),
    statCard('Сессии', ov.cur.sessions, null),
    statCard('Среднее время', Math.round(ov.avgTimeSec / 60) + ' мин', null)));

  // Алерты
  const alerts = [];
  if (d.alerts.brokenLinks.length) alerts.push(el('div', { class: 'alert alert-err' }, `⚠ Сломанные внешние ссылки: ${d.alerts.brokenLinks.length}. `, el('a', { href: '#materials', onclick: e => { e.preventDefault(); location.hash = '#materials'; } }, 'Открыть материалы')));
  if (d.alerts.diskWarning) alerts.push(el('div', { class: 'alert alert-err' }, 'Диск заполнен более чем на 85%!'));
  if (d.alerts.surges.length) alerts.push(el('div', { class: 'alert alert-ok' }, '🔥 Резкий рост интереса (возможно, скоро сессия): ' + d.alerts.surges.map(f => f.title).join(', ')));
  if (d.alerts.deadMaterials.length) alerts.push(el('div', { class: 'alert alert-warn' }, `«Мёртвые» материалы (0 просмотров за 90 дней): ${d.alerts.deadMaterials.length}`));
  if (alerts.length) c.append(el('div', {}, ...alerts));

  c.append(el('div', { class: 'grid-2' },
    el('div', { class: 'panel', style: 'grid-column: 1 / -1' }, el('h2', {}, 'Посещения за 30 дней'), lineChart(ov.timeline)),
  ));

  c.append(el('div', { class: 'grid-2' },
    panel('Топ-5 материалов', table(['Материал', 'Просм.', 'Чтений', 'Скач.'],
      d.topMaterials.map(m => [el('a', { href: '/m/' + m.slug, target: '_blank' }, m.title), m.views, m.reads, m.downloads]))),
    panel('Топ-5 разделов', table(['Папка', 'Просмотры материалов'],
      d.topFolders.map(f => [el('a', { href: '/' + f.slug, target: '_blank' }, f.title), f.views])))));

  const sys = d.system;
  c.append(el('div', { class: 'grid-2' },
    panel('Состояние системы', el('div', {},
      sysRow('Занято файлами', fmtSize(sys.filesSize)),
      sysRow('Кеш', `${fmtSize(sys.cache.total)} (${sys.cache.count} записей)`),
      sysRow('Диск сервера', sys.disk.total ? `${fmtSize(sys.disk.total - sys.disk.free)} из ${fmtSize(sys.disk.total)} (${Math.round(sys.disk.usedRatio * 100)}%)` : 'недоступно для измерения'),
      ...sys.storages.map(s => sysRow(s.name, s.health_status === 'ok' ? badge('ok', 'green') : s.health_status === 'broken' ? badge('broken', 'red') : badge('не проверено', 'gray'))),
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { class: 'btn btn-secondary btn-sm', onclick: async e => { e.target.disabled = true; e.target.textContent = 'Проверяем…'; try { const r = await api('/api/admin/health-check', { method: 'POST', body: '{}' }); toast(`Проверено ссылок: ${r.checked}, сломано: ${r.broken}`); nav(); } catch (err) { toast(err.message, true); } } }, 'Проверить внешние ссылки'),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: async () => { try { await api('/api/admin/cache/clear', { method: 'POST', body: '{}' }); toast('Кеш очищен'); nav(); } catch (e) { toast(e.message, true); } } }, 'Очистить кеш')))),
    panel('Последние действия', el('div', {},
      ...d.recentAudit.map(a => el('div', { style: 'padding:5px 0;border-bottom:1px dashed var(--border);font-size:12.5px' },
        el('b', {}, a.action), ' ', el('span', { class: 'muted' }, `${a.entity}${a.entity_id ? ' #' + a.entity_id : ''} · ${fmtDate(a.created_at)}`))),
      d.recentAudit.length ? null : el('div', { class: 'empty-mini' }, 'Пока пусто')))));

  c.append(panel('Последние публикации', table(['Материал', 'Тип', 'Статус', 'Дата'],
    d.recentMaterials.map(m => [el('a', { href: '/m/' + m.slug, target: '_blank' }, m.title), KIND_LABEL[m.kind] || m.kind, STATUS_BADGE[m.status]?.() || m.status, fmtDate(m.published_at)]))));
});

function statCard(label, value, delta) {
  return el('div', { class: 'stat-card' },
    el('div', { class: 'sc-label' }, label),
    el('div', { class: 'sc-value' }, String(value)),
    delta ? el('div', { class: 'sc-delta ' + delta.cls }, delta.txt) : null);
}
function panel(title, ...nodes) { return el('div', { class: 'panel' }, el('h2', {}, title), ...nodes); }
function sysRow(k, v) { return el('div', { style: 'display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed var(--border)' }, el('span', { class: 'muted' }, k), el('b', {}, v)); }
function table(head, rows) {
  if (!rows.length) return el('div', { class: 'empty-mini' }, 'Нет данных');
  return el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, ...head.map(h => el('th', {}, h)))),
    el('tbody', {}, ...rows.map(r => el('tr', {}, ...r.map(cell => el('td', {}, cell)))))));
}

function lineChart(timeline) {
  const W = 900, H = 180, P = { l: 40, r: 12, t: 10, b: 22 };
  const max = Math.max(10, ...timeline.map(t => Math.max(t.pv, t.uv)));
  const x = i => P.l + (W - P.l - P.r) * (i / Math.max(1, timeline.length - 1));
  const y = v => H - P.b - (H - P.t - P.b) * (v / max);
  const path = key => timeline.map((t, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(t[key]).toFixed(1)}`).join(' ');
  const area = path('pv') + ` L${x(timeline.length - 1)},${H - P.b} L${x(0)},${H - P.b} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(max * f));
  const labels = timeline.filter((_, i) => i % Math.ceil(timeline.length / 6) === 0);
  const labelIdx = timeline.map((t, i) => i).filter(i => i % Math.ceil(timeline.length / 6) === 0);
  const svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${ticks.map(t => `<line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${P.l - 6}" y="${y(t) + 3}" text-anchor="end">${t}</text>`).join('')}
    <path class="area-pv" d="${area}"/>
    <path class="line-pv" d="${path('pv')}"/>
    <path class="line-uv" d="${path('uv')}"/>
    ${labelIdx.map(i => `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${fmtDay(timeline[i].day)}</text>`).join('')}
  </svg>`;
  return el('div', { html: svg + `<div class="row" style="gap:14px;font-size:11.5px;color:var(--text-3)"><span><b style="color:var(--accent)">━</b> просмотры</span><span><b style="color:var(--ok)">╌</b> посетители</span></div>` });
}

// ————————————————— ПАПКИ (8.2) —————————————————
let foldersCache = [];
async function loadFolders() { foldersCache = (await api('/api/admin/folders')).folders; return foldersCache; }
function folderById(id) { return foldersCache.find(f => f.id === id); }
function folderPath(f) {
  const parts = [];
  let cur = f;
  while (cur) { parts.unshift(cur.title); cur = cur.parent_id ? folderById(cur.parent_id) : null; }
  return parts.join(' / ');
}

registerRoute('folders', async (c) => {
  const { folders, storages } = await api('/api/admin/folders');
  foldersCache = folders;
  c.append(el('div', { class: 'pg-head' }, el('h1', {}, 'Папки каталога'), el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn-primary', onclick: () => folderForm(null, folders, storages) }, '+ Новая папка')));
  c.append(el('div', { class: 'panel' },
    el('p', { class: 'muted', style: 'margin-top:0' }, 'Перетаскивайте папки для перемещения. Удаление папки с содержимым требует подтверждения.'),
    folderTree(folders.filter(f => !f.parent_id), folders, storages)));
});

function folderTree(nodes, all, storages) {
  const wrap = el('div', { class: 'ftree' });
  const build = list => {
    const frag = document.createDocumentFragment();
    for (const f of list.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title, 'ru'))) {
      const node = el('div', { class: 'fnode', draggable: 'true' });
      node.dataset.id = f.id;
      node.append(
        el('span', { class: 'fdot', style: `background:${f.color}` }),
        el('span', { class: 'f-title' }, f.title),
        f.visibility !== 'listed' ? VIS_BADGE[f.visibility]?.() : null,
        el('span', { class: 'f-meta' }, `/${f.slug} · ${f.material_count} мат.`),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => folderForm({ parentId: f.id }, all, storages) }, '+ подпапка'),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => folderForm(f, all, storages) }, 'Изменить'),
        el('button', { class: 'btn btn-danger btn-sm', onclick: () => deleteFolder(f) }, 'Удалить'));
      // drag&drop перемещение
      node.addEventListener('dragstart', e => { e.dataTransfer.setData('text/folder', String(f.id)); e.stopPropagation(); });
      node.addEventListener('dragover', e => { e.preventDefault(); node.classList.add('drag-over'); });
      node.addEventListener('dragleave', () => node.classList.remove('drag-over'));
      node.addEventListener('drop', async e => {
        e.preventDefault(); e.stopPropagation();
        node.classList.remove('drag-over');
        const srcId = +e.dataTransfer.getData('text/folder');
        if (!srcId || srcId === f.id) return;
        try {
          await api(`/api/admin/folders/${srcId}`, { method: 'PATCH', body: JSON.stringify({ parent_id: f.id }) });
          toast('Папка перемещена'); nav();
        } catch (err) { toast(err.message, true); }
      });
      frag.append(node);
      const children = all.filter(x => x.parent_id === f.id);
      if (children.length) { const sub = el('div', { class: 'fchildren' }); sub.append(build(children)); frag.append(sub); }
    }
    return frag;
  };
  wrap.append(build(nodes));
  return wrap;
}

function folderForm(f, all, storages) {
  const isNew = !f?.id;
  const data = isNew ? { title: '', description: '', icon: 'book', color: '#5b5bd6', visibility: 'listed', parent_id: f?.parentId || null, default_storage_id: null } : { ...f };
  const icons = ['book', 'code', 'flask', 'globe', 'sigma', 'database', 'terminal', 'folder', 'pen'];
  const form = el('div', {},
    field('Название', el('input', { type: 'text', id: 'ff-title', value: data.title })),
    field('Описание (markdown-lite)', el('textarea', { id: 'ff-desc' }, data.description || '')),
    el('div', { class: 'grid-2' },
      field('Иконка', el('select', { id: 'ff-icon' }, ...icons.map(i => el('option', { value: i, selected: data.icon === i }, i)))),
      field('Цвет', el('input', { type: 'text', id: 'ff-color', value: data.color }))),
    el('div', { class: 'grid-2' },
      field('Родитель', el('select', { id: 'ff-parent' }, el('option', { value: '' }, '— корень каталога —'),
        ...all.filter(x => x.id !== data.id).map(x => el('option', { value: x.id, selected: data.parent_id === x.id }, folderPathStatic(x, all))))),
      field('Видимость', el('select', { id: 'ff-vis' },
        ...[['listed', 'listed — видна всем'], ['unlisted', 'unlisted — по ссылке'], ['private', 'private — только админ']].map(([v, l]) => el('option', { value: v, selected: data.visibility === v }, l))))),
    field('Хранилище по умолчанию', el('select', { id: 'ff-storage' }, el('option', { value: '' }, '— не задано —'),
      ...storages.map(s => el('option', { value: s.id, selected: data.default_storage_id === s.id }, `${s.name} (${s.type})`)))));

  const m = modal(isNew ? 'Новая папка' : `Папка «${data.title}»`, [form], [
    el('button', { class: 'btn btn-secondary', onclick: () => m.close() }, 'Отмена'),
    el('button', {
      class: 'btn btn-primary', onclick: async () => {
        const body = {
          title: $('#ff-title').value.trim(), description: $('#ff-desc').value, icon: $('#ff-icon').value,
          color: $('#ff-color').value, visibility: $('#ff-vis').value,
          parent_id: $('#ff-parent').value ? +$('#ff-parent').value : null,
          default_storage_id: $('#ff-storage').value ? +$('#ff-storage').value : null,
        };
        if (!body.title) return toast('Название обязательно', true);
        try {
          if (isNew) await api('/api/admin/folders', { method: 'POST', body: JSON.stringify(body) });
          else await api('/api/admin/folders/' + data.id, { method: 'PATCH', body: JSON.stringify(body) });
          toast('Сохранено'); m.close(); nav();
        } catch (e) { toast(e.message, true); }
      }
    }, 'Сохранить')]);
}
function folderPathStatic(f, all) {
  const parts = []; let cur = f;
  while (cur) { parts.unshift(cur.title); cur = cur.parent_id ? all.find(x => x.id === cur.parent_id) : null; }
  return parts.join(' / ');
}
function field(label, input) { return el('div', { class: 'field' }, el('label', {}, label), input); }

async function deleteFolder(f) {
  if (!confirm(`Удалить папку «${f.title}»?`)) return;
  try {
    await api('/api/admin/folders/' + f.id, { method: 'DELETE' });
    toast('Папка удалена'); nav();
  } catch (e) {
    const r = await fetch('/api/admin/folders/' + f.id, { method: 'DELETE', headers: { 'X-CSRF-Token': CSRF || '' } });
    if (r.status === 409) {
      const j = await r.json();
      if (confirm(`${j.message}\n\nУдалить принудительно (содержимое попадёт в корзину)?`)) {
        await api('/api/admin/folders/' + f.id + '?force=1', { method: 'DELETE' });
        toast('Папка удалена принудительно'); nav();
      }
    } else toast(e.message, true);
  }
}

// ————————————————— МАТЕРИАЛЫ (8.3) —————————————————
const matState = { folder_id: '', kind: '', status: '', q: '', sort: 'date', dir: 'desc', page: 1 };
registerRoute('materials', async (c, qs) => {
  if (qs.get('folder_id')) matState.folder_id = qs.get('folder_id');
  const folders = await loadFolders();
  c.append(el('div', { class: 'pg-head' }, el('h1', {}, 'Материалы'), el('div', { class: 'spacer' }),
    el('a', { class: 'btn btn-primary', href: '#upload' }, '+ Загрузить')));

  const toolbar = el('div', { class: 'toolbar-row' },
    el('input', { type: 'search', placeholder: 'Поиск по названию…', value: matState.q, oninput: debounce(e => { matState.q = e.target.value; matState.page = 1; reload(); }, 350) }),
    selectFilter('Папка', [['', 'Все папки'], ...folders.map(f => [f.id, folderPathStatic(f, folders)])], matState.folder_id, v => { matState.folder_id = v; matState.page = 1; reload(); }),
    selectFilter('Тип', [['', 'Любой'], ['pdf', 'PDF'], ['docx', 'DOCX'], ['video', 'Видео'], ['image', 'Изображение'], ['link', 'Ссылка']], matState.kind, v => { matState.kind = v; matState.page = 1; reload(); }),
    selectFilter('Статус', [['', 'Активные'], ['published', 'Опубликованные'], ['hidden', 'Скрытые'], ['processing', 'В обработке']], matState.status, v => { matState.status = v; matState.page = 1; reload(); }));
  const bulkBar = el('div', { class: 'toolbar-row hidden', id: 'bulk-bar' });
  const list = el('div', {});
  c.append(toolbar, bulkBar, list);

  function selectFilter(label, opts, value, onchange) {
    return el('select', { class: 'select', title: label, onchange: e => onchange(e.target.value) },
      ...opts.map(([v, l]) => el('option', { value: v, selected: String(value) === String(v) }, label + ': ' + l)));
  }
  async function reload() {
    const qs = new URLSearchParams({ page: matState.page, per_page: 25, sort: matState.sort, dir: matState.dir });
    for (const [k, v] of Object.entries(matState)) if (v && !['page', 'sort', 'dir'].includes(k)) qs.set(k, v);
    const d = await api('/api/admin/materials?' + qs);
    list.innerHTML = '';
    const selected = new Set();
    const updateBulk = () => {
      bulkBar.innerHTML = '';
      if (!selected.size) { bulkBar.classList.add('hidden'); return; }
      bulkBar.classList.remove('hidden');
      bulkBar.append(el('b', {}, `Выбрано: ${selected.size}`),
        selectFilter('…', [['', 'Массовая операция'], ...folders.map(f => ['move:' + f.id, 'Переместить в «' + folderPathStatic(f, folders) + '»']), ['publish', 'Опубликовать'], ['unpublish', 'Снять с публикации'], ['delete', 'В корзину']], '', async v => {
          if (!v) return;
          try {
            const [action, arg] = v.split(':');
            const payload = action === 'move' ? { folder_id: +arg } : {};
            const r = await api('/api/admin/materials/bulk', { method: 'POST', body: JSON.stringify({ ids: [...selected], action, payload }) });
            toast(`Обработано: ${r.done}`); selected.clear(); reload();
          } catch (e) { toast(e.message, true); }
        }));
    };
    const rows = d.materials.map(m => {
      const tr = el('tr', {},
        el('td', {}, el('input', { type: 'checkbox', class: 'row-check', onchange: e => { e.target.checked ? selected.add(m.id) : selected.delete(m.id); updateBulk(); } })),
        el('td', {}, el('a', { href: '/m/' + m.slug, target: '_blank', style: 'font-weight:600;color:var(--text)' }, m.title),
          el('div', { class: 'muted', style: 'font-size:11.5px' }, `/${m.slug}`)),
        el('td', {}, el('span', { class: 'muted' }, folderPathStatic(folderById(m.folder_id) || { id: m.folder_id, title: '?' }, foldersCache))),
        el('td', {}, KIND_LABEL[m.kind] || m.kind, ' ', el('span', { class: 'muted' }, SRC_LABEL[m.source_type] || '')),
        el('td', { class: 'num' }, fmtSize(m.size)),
        el('td', {},
          STATUS_BADGE[m.status]?.() || m.status, ' ',
          VIS_BADGE[m.visibility]?.() || '', ' ',
          m.link_status ? HEALTH_BADGE[m.link_status]?.() || '' : ''),
        el('td', { class: 'num' }, m.views_count, ' / ', m.downloads_count),
        el('td', {}, fmtDate(m.published_at)),
        el('td', { class: 'tbl-actions' },
          el('button', { class: 'btn btn-secondary btn-sm', onclick: () => materialForm(m, folders) }, 'Изменить'),
          el('button', { class: 'btn btn-ghost btn-sm', title: 'Статистика', onclick: () => showMaterialStats(m) }, '📈'),
          el('button', { class: 'btn btn-danger btn-sm', onclick: async () => { if (confirm(`«${m.title}» → в корзину?`)) { await api('/api/admin/materials/' + m.id, { method: 'DELETE' }); toast('В корзине'); reload(); } } }, '✕')));
      return tr;
    });
    // Кликабельные заголовки-сортировки (название / размер / просмотры / дата)
    const cols = [['', null], ['Название', 'title'], ['Папка', null], ['Тип/источник', 'kind'], ['Размер', 'size'], ['Статусы', null], ['Просм/Скач', 'views'], ['Дата', 'date'], ['', null]];
    const ths = cols.map(([label, key]) => {
      if (!key) return el('th', {}, label);
      const active = matState.sort === key;
      const arrow = active ? (matState.dir === 'asc' ? ' ↑' : ' ↓') : '';
      return el('th', {
        style: 'cursor:pointer;user-select:none' + (active ? ';color:var(--accent)' : ''),
        title: 'Сортировать по ' + label.toLowerCase(),
        onclick: () => {
          if (matState.sort === key) matState.dir = matState.dir === 'asc' ? 'desc' : 'asc';
          else { matState.sort = key; matState.dir = key === 'title' ? 'asc' : 'desc'; }
          matState.page = 1; reload();
        }
      }, label + arrow);
    });
    list.append(el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {}, ...ths)),
      el('tbody', {}, ...rows))));
    // пагинация
    const pages = Math.ceil(d.total / d.perPage);
    if (pages > 1) {
      const pg = el('div', { class: 'pagination' }, el('span', { class: 'muted' }, `Стр. ${d.page} из ${pages} · всего ${d.total}`));
      for (const p of [d.page - 1, d.page, d.page + 1]) {
        if (p < 1 || p > pages) continue;
        pg.append(el('button', { class: p === d.page ? 'active' : '', onclick: () => { matState.page = p; reload(); } }, p));
      }
      list.append(pg);
    }
    updateBulk();
  }
  reload();
});

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function materialForm(m, folders) {
  // m.tags может быть массивом (из materialPublic) или строкой — нормализуем
  const tags = Array.isArray(m.tags) ? m.tags : String(m.tags || '').split(', ').filter(Boolean);
  const form = el('div', {},
    field('Название', el('input', { type: 'text', id: 'mf-title', value: m.title })),
    field('Описание', el('textarea', { id: 'mf-desc', style: 'min-height:100px' }, m.description || '')),
    el('div', { class: 'grid-2' },
      field('Папка', el('select', { id: 'mf-folder' }, ...folders.map(f => el('option', { value: f.id, selected: f.id === m.folder_id }, folderPathStatic(f, folders))))),
      field('Теги (через запятую)', el('input', { type: 'text', id: 'mf-tags', value: tags.join(', ') }))),
    el('div', { class: 'grid-2' },
      field('Статус', el('select', { id: 'mf-status' }, ...[['published', 'Опубликован'], ['hidden', 'Скрыт (черновик)']].map(([v, l]) => el('option', { value: v, selected: m.status === v }, l)))),
      field('Видимость', el('select', { id: 'mf-vis' }, ...[['listed', 'listed'], ['unlisted', 'unlisted — по ссылке'], ['private', 'private — только админ']].map(([v, l]) => el('option', { value: v, selected: m.visibility === v }, l))))),
    el('div', { class: 'row' },
      el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'mf-dl', checked: !!m.allow_download }), 'Разрешить скачивание'),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'mf-noindex', checked: !!m.noindex }), 'noindex (скрыть от поисковиков)')));
  const actions = [el('button', { class: 'btn btn-secondary', onclick: () => mo.close() }, 'Отмена')];
  actions.push(el('button', {
    class: 'btn btn-primary', onclick: async () => {
      try {
        await api('/api/admin/materials/' + m.id, {
          method: 'PATCH', body: JSON.stringify({
            title: $('#mf-title').value, description: $('#mf-desc').value, folder_id: +$('#mf-folder').value,
            tags: $('#mf-tags').value.split(',').map(s => s.trim()).filter(Boolean),
            status: $('#mf-status').value, visibility: $('#mf-vis').value,
            allow_download: $('#mf-dl').checked, noindex: $('#mf-noindex').checked,
          })
        });
        toast('Сохранено'); mo.close(); nav();
      } catch (e) { toast(e.message, true); }
    }
  }, 'Сохранить'));
  const mo = modal(`Материал «${m.title}»`, [form], actions);
}

async function showMaterialStats(m) {
  const s = await api(`/api/admin/materials/${m.id}/stats`);
  const rows = [
    ['Просмотры карточки (90 дней)', s.views],
    ['Открытия читалки', s.reads],
    ['Конверсия «карточка → читалка»', s.conversion + '%'],
    ['Скачивания', s.downloads],
  ];
  if (m.kind === 'video') rows.push(['Дошли до 25/50/75/100%', `${s.video.q25} / ${s.video.q50} / ${s.video.q75} / ${s.video.q100}`]);
  else if (s.avgPage != null) rows.push(['Средняя дочитанная страница', s.avgPage + (m.page_count ? ` из ${m.page_count}` : '')]);
  modal('Статистика: ' + m.title, [table(['Метрика', 'Значение'], rows)]);
}

// ————————————————— ЗАГРУЗКА (7.4) —————————————————
registerRoute('upload', async (c) => {
  const folders = await loadFolders();
  c.append(el('div', { class: 'pg-head' }, el('h1', {}, 'Загрузка материалов')));
  const folderSel = el('select', { id: 'up-folder', style: 'max-width:420px' },
    ...folders.map(f => el('option', { value: f.id }, folderPathStatic(f, folders))));
  const dz = el('div', { class: 'dropzone', tabindex: '0', role: 'button' },
    el('div', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>' }),
    el('b', {}, 'Перетащите файлы сюда'), ' или нажмите для выбора',
    el('div', { class: 'muted', style: 'margin-top:6px' }, 'PDF, DOCX, MP4, изображения, архивы. Несколько файлов сразу, прогресс по каждому. Лимит — в настройках.'));
  const fileInput = el('input', { type: 'file', multiple: true, class: 'hidden' });
  const list = el('div', { class: 'panel', style: 'margin-top:14px' }, el('h2', {}, 'Очередь загрузки'));
  dz.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => addFiles(e.dataTransfer.files));

  function addFiles(files) {
    for (const f of files) uploadOne(f, folderSel.value);
  }

  function uploadOne(file, folderId) {
    const bar = el('div', {});
    const name = el('b', { style: 'max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, file.name);
    const status = el('span', { class: 'muted' }, fmtSize(file.size));
    const pbar = el('div', {});
    const item = el('div', { class: 'up-item' }, name, el('div', { class: 'up-bar' }, pbar), status);
    list.append(item);
    const xhr = new XMLHttpRequest();
    const url = `/api/admin/upload?folder_id=${folderId}&filename=${encodeURIComponent(file.name)}`;
    xhr.open('PUT', url);
    xhr.setRequestHeader('X-CSRF-Token', CSRF || '');
    xhr.upload.onprogress = e => { if (e.lengthComputable) pbar.style.width = (e.loaded / e.total * 100) + '%'; };
    xhr.onload = () => {
      let r = {}; try { r = JSON.parse(xhr.responseText); } catch { }
      if (xhr.status >= 200 && xhr.status < 300) {
        item.classList.add('done'); pbar.style.width = '100%';
        status.textContent = 'готово' + (r.duplicateOf ? ` · дубликат «${r.duplicateOf.title}» (не занял место)` : '');
        toast(`Загружено: ${file.name}`);
      } else {
        item.classList.add('err');
        status.textContent = r.message || `ошибка HTTP ${xhr.status}`;
        toast(`Ошибка: ${file.name} — ${status.textContent}`, true);
      }
    };
    xhr.onerror = () => { item.classList.add('err'); status.textContent = 'сетевая ошибка'; };
    xhr.send(file);
  }

  c.append(el('div', { class: 'panel' },
    el('h2', {}, '1. Загрузить файлы на сервер'),
    field('Папка назначения', folderSel), dz, fileInput));
  c.append(list);

  // Внешний источник
  const urlInput = el('input', { type: 'url', placeholder: 'https://… ссылка на файл, YouTube, Google Drive, Яндекс.Диск' });
  const modeSel = el('select', { id: 'ex-mode' }, ...[['', 'авто'], ['proxy', 'proxy (через сервер)'], ['redirect', 'redirect (напрямую)'], ['embed', 'embed (плеер в iframe)']].map(([v, l]) => el('option', { value: v }, l)));
  c.append(el('div', { class: 'panel' },
    el('h2', {}, '2. Или указать внешний источник'),
    el('p', { class: 'muted', style: 'margin-top:0' }, 'Тип источника (S3 / WebDAV / облако / URL / embed) определится автоматически; доступность и размер будут проверены.'),
    field('Папка назначения', el('select', { id: 'ex-folder' }, ...folders.map(f => el('option', { value: f.id }, folderPathStatic(f, folders))))),
    field('Ссылка', urlInput),
    el('div', { class: 'grid-2' },
      field('Название (необязательно)', el('input', { type: 'text', id: 'ex-title', placeholder: 'определится из ссылки' })),
      field('Режим отдачи', modeSel)),
    el('button', {
      class: 'btn btn-primary', onclick: async e => {
        e.target.disabled = true; e.target.textContent = 'Проверяем…';
        try {
          const r = await api('/api/admin/materials/attach-external', {
            method: 'POST', body: JSON.stringify({
              url: urlInput.value.trim(), folder_id: +$('#ex-folder').value, title: $('#ex-title').value || undefined,
              mode: modeSel.value || undefined,
            })
          });
          toast(`Добавлено: ${r.source_type} / ${r.kind}${r.size ? ' · ' + fmtSize(r.size) : ''}`);
          location.hash = '#materials';
        } catch (err) { toast(err.message, true); }
        e.target.disabled = false; e.target.textContent = 'Добавить материал';
      }
    }, 'Добавить материал')));
});

// ————————————————— ХРАНИЛИЩА (7.5) —————————————————
registerRoute('storages', async (c) => {
  const d = await api('/api/admin/storages');
  c.append(el('div', { class: 'pg-head' }, el('h1', {}, 'Хранилища (источники файлов)'), el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn-primary', onclick: () => storageForm(null) }, '+ Добавить хранилище')));
  c.append(el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, ...['Название', 'Тип', 'По умолчанию', 'Материалов', 'Здоровье', 'Проверено', ''].map(h => el('th', {}, h)))),
    el('tbody', {}, ...d.storages.map(s => el('tr', {},
      el('td', {}, el('b', {}, s.name)),
      el('td', {}, badge(s.type, 'blue')),
      el('td', {}, s.is_default ? badge('default', 'green') : ''),
      el('td', { class: 'num' }, s.material_count),
      el('td', {}, HEALTH_BADGE[s.health_status]?.() || badge('unknown', 'gray')),
      el('td', { class: 'muted' }, fmtDate(s.last_check_at)),
      el('td', { class: 'tbl-actions' },
        el('button', { class: 'btn btn-secondary btn-sm', onclick: async e => { e.target.textContent = '…'; const r = await api(`/api/admin/storages/${s.id}/test`, { method: 'POST', body: '{}' }); toast(r.ok ? `Соединение OK (${r.detail})` : `Проблема: ${r.detail}`, !r.ok); nav(); } }, 'Тест'),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => storageForm(s) }, 'Изменить'),
        el('button', { class: 'btn btn-danger btn-sm', onclick: async () => { if (confirm('Удалить хранилище?')) { try { await api('/api/admin/storages/' + s.id, { method: 'DELETE' }); nav(); } catch (e) { toast(e.message, true); } } } }, '✕'))))))));
});

function storageForm(s) {
  const isNew = !s;
  const cfg = s?.config || {};
  const nameI = el('input', { type: 'text', value: s?.name || '' });
  const typeS = el('select', { onchange: renderFields }, ...[['local', 'Локальный диск'], ['s3', 'S3-совместимое'], ['webdav', 'WebDAV']].map(([v, l]) => el('option', { value: v, selected: s?.type === v }, l)));
  const fieldsBox = el('div', {});
  const inputs = {};
  function renderFields() {
    fieldsBox.innerHTML = '';
    const t = typeS.value;
    const defs = {
      local: [['dir', 'Каталог на диске', '']],
      s3: [['endpoint', 'Endpoint (https://s3.… или MinIO)', ''], ['region', 'Регион', 'us-east-1'], ['bucket', 'Bucket', ''], ['accessKey', 'Access Key', ''], ['secretKey', 'Secret Key (или env:VAR_NAME)', ''], ['pathStyle', 'Path-style (чекбокс)', '']],
      webdav: [['url', 'Базовый URL WebDAV', ''], ['username', 'Логин', ''], ['password', 'Пароль (или env:VAR_NAME)', '']],
    }[t] || [];
    for (const [k, label] of defs) {
      if (k === 'pathStyle') { inputs[k] = el('input', { type: 'checkbox', checked: cfg[k] !== false && t === 's3' ? !!cfg[k] : false }); fieldsBox.append(el('label', { class: 'check' }, inputs[k], ' Path-style access (MinIO и т.п.)')); continue; }
      inputs[k] = el('input', { type: k.toLowerCase().includes('key') || k === 'password' ? 'password' : 'text', value: cfg[k] || '' });
      inputs[k].type = (k === 'secretKey' || k === 'password') ? 'password' : 'text';
      fieldsBox.append(field(label, inputs[k]));
    }
  }
  typeS.value = s?.type || 'local';
  renderFields();
  const defCheck = el('input', { type: 'checkbox', checked: !!s?.is_default });
  const m = modal(isNew ? 'Новое хранилище' : 'Хранилище «' + s.name + '»', [
    field('Название', nameI),
    field('Тип', typeS), fieldsBox,
    el('label', { class: 'check' }, defCheck, ' Использовать по умолчанию'),
    el('p', { class: 'muted', style: 'font-size:12px' }, 'Секреты можно не хранить в БД: укажите env:ИМЯ_ПЕРЕМЕННОЙ — значение возьмётся из окружения сервера.'),
  ], [
    el('button', { class: 'btn btn-secondary', onclick: () => m.close() }, 'Отмена'),
    el('button', {
      class: 'btn btn-primary', onclick: async () => {
        const config2 = {};
        for (const [k, i] of Object.entries(inputs)) config2[k] = i.type === 'checkbox' ? i.checked : i.value;
        const body = { name: nameI.value.trim(), type: typeS.value, config: config2, is_default: defCheck.checked };
        if (!body.name) return toast('Название обязательно', true);
        try {
          if (isNew) await api('/api/admin/storages', { method: 'POST', body: JSON.stringify(body) });
          else await api('/api/admin/storages/' + s.id, { method: 'PATCH', body: JSON.stringify(body) });
          toast('Сохранено'); m.close(); nav();
        } catch (e) { toast(e.message, true); }
      }
    }, 'Сохранить')]);
}

// ————————————————— СТАТИСТИКА (8.4) —————————————————
registerRoute('stats', async (c, qs) => {
  const days = +(qs.get('days') || 30);
  c.append(el('div', { class: 'pg-head' }, el('h1', {}, 'Статистика'), el('div', { class: 'spacer' }),
    el('select', { class: 'select', onchange: e => location.hash = '#stats?days=' + e.target.value },
      ...[[7, '7 дней'], [30, '30 дней'], [90, '90 дней'], [365, 'Год']].map(([v, l]) => el('option', { value: v, selected: days === v }, l))),
    el('a', { class: 'btn btn-secondary', href: `/api/admin/stats/export.csv?days=${days}` }, 'Экспорт CSV')));
  const [ov, top, search, tech] = await Promise.all([
    api('/api/admin/stats/overview?days=' + days), api('/api/admin/stats/top?days=' + days),
    api('/api/admin/stats/search?days=' + days), api('/api/admin/stats/tech?days=' + days),
  ]);
  c.append(lineChart(ov.timeline));
  c.append(el('div', { class: 'grid-4' },
    statCard('Просмотры', ov.cur.pv, null), statCard('Посетители', ov.cur.uv, null),
    statCard('Сессии', ov.cur.sessions, null), statCard('Среднее время', Math.round(ov.avgTimeSec / 60) + ' мин', null)));
  c.append(el('div', { class: 'grid-2' },
    panel('Популярные материалы', table(['#', 'Материал', 'Просм.', 'Чтений', 'Скач.'],
      top.materials.map((m, i) => [i + 1, el('a', { href: '/m/' + m.slug, target: '_blank' }, m.title), m.views, m.reads, m.downloads]))),
    panel('Популярные разделы', table(['Папка', 'Просмотры'], top.folders.map(f => [el('a', { href: '/' + f.slug, target: '_blank' }, f.title), f.views])))));
  c.append(el('div', { class: 'grid-2' },
    panel('Поисковые запросы', table(['Запрос', 'Раз', 'Сред. результатов'], search.popular.map(s => [s.query || '—', s.n, Math.round(s.avg_results ?? 0)]))),
    panel('Запросы без результата (что ищут и не находят)', table(['Запрос', 'Раз'], search.zero.map(s => [s.query || '—', s.n])))));
  c.append(el('div', { class: 'grid-2' },
    panel('Устройства', table(['Устройство', 'Просмотры'], tech.devices.map(d2 => [d2.dim, d2.n]))),
    panel('Источники переходов', table(['Источник', 'Сессии'], tech.referrers.map(r => [r.dim, r.n])))));
});

// ————————————————— КОРЗИНА / ЖУРНАЛ —————————————————
registerRoute('trash', async (c) => {
  const d = await api('/api/admin/trash');
  c.append(el('div', { class: 'pg-head' }, el('h1', {}, 'Корзина'), el('span', { class: 'muted' }, `Автоочистка через ${d.purgeAfterDays} дней после удаления`)));
  c.append(el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, ...['Материал', 'Папка', 'Удалён', ''].map(h => el('th', {}, h)))),
    el('tbody', {}, ...d.items.map(i => el('tr', {},
      el('td', {}, el('b', {}, i.title), ' ', el('span', { class: 'muted' }, KIND_LABEL[i.kind] || '')),
      el('td', { class: 'muted' }, i.folder_title),
      el('td', { class: 'muted' }, fmtDate(i.deleted_at)),
      el('td', { class: 'tbl-actions' },
        el('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { await api(`/api/admin/materials/${i.id}/restore`, { method: 'POST', body: '{}' }); toast('Восстановлен'); nav(); } }, 'Восстановить'),
        el('button', { class: 'btn btn-danger btn-sm', onclick: async () => { if (confirm('Удалить БЕЗВОЗВРАТНО? Файл будет стёрт с диска.')) { await api(`/api/admin/materials/${i.id}?purge=1`, { method: 'DELETE' }); toast('Удалено навсегда'); nav(); } } }, 'Уничтожить'))))),
    d.items.length ? null : el('tbody', {}, el('tr', {}, el('td', {}, el('div', { class: 'empty-mini' }, 'Корзина пуста')))))));
});

registerRoute('audit', async (c) => {
  const d = await api('/api/admin/audit');
  c.append(el('div', { class: 'pg-head' }, el('h1', {}, 'Журнал действий')));
  c.append(el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, ...['Когда', 'Кто', 'Действие', 'Объект', 'Данные'].map(h => el('th', {}, h)))),
    el('tbody', {}, ...d.items.map(i => el('tr', {},
      el('td', { class: 'muted' }, fmtDate(i.created_at)),
      el('td', {}, i.actor),
      el('td', {}, el('span', { class: 'mono' }, i.action)),
      el('td', { class: 'muted' }, `${i.entity}${i.entity_id ? ' #' + i.entity_id : ''}`),
      el('td', { class: 'mono muted', style: 'max-width:320px;overflow:hidden;text-overflow:ellipsis' }, i.payload)))))));
});

// ————————————————— НАСТРОЙКИ (8.5) —————————————————
registerRoute('settings', async (c) => {
  const d = await api('/api/admin/settings');
  const s = d.settings;
  c.append(el('div', { class: 'pg-head' }, el('h1', {}, 'Настройки')));
  const inputs = {};
  function text(key, label, hint, type = 'text') { inputs[key] = el('input', { type, value: s[key] ?? '' }); return field(label, inputs[key], hint); }
  function check(key, label) { inputs[key] = el('input', { type: 'checkbox', checked: !!s[key] }); return el('label', { class: 'check' }, inputs[key], ' ' + label); }
  function fld(label, input, hint) { return el('div', { class: 'field' }, el('label', {}, label), input, hint ? el('div', { class: 'hint' }, hint) : null); }

  c.append(el('div', { class: 'panel' }, el('h2', {}, 'Сайт'),
    fld('Название сайта', inputs.site_name = el('input', { type: 'text', value: s.site_name })),
    fld('Описание (meta description)', inputs.site_description = el('input', { type: 'text', value: s.site_description })),
    fld('Подпись в подвале', inputs.footer_note = el('input', { type: 'text', value: s.footer_note })),
    el('div', { class: 'grid-2' },
      fld('Акцентный цвет', el('div', { class: 'row' }, inputs.accent_color = el('input', { type: 'text', value: s.accent_color, style: 'width:110px' }), el('input', { type: 'color', value: s.accent_color, oninput: e => inputs.accent_color.value = e.target.value, style: 'width:44px;height:32px;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface);cursor:pointer' }))),
      fld('Тема по умолчанию', inputs.default_theme = el('select', {}, ...['system', 'light', 'dark'].map(v => el('option', { value: v, selected: s.default_theme === v }, v)))))),
    el('button', { class: 'btn btn-primary', onclick: () => saveSettings() }, 'Сохранить настройки сайта'));

  c.append(el('div', { class: 'panel' }, el('h2', {}, 'Доступ и лимиты'),
    check('allow_download', 'Разрешить скачивание материалов globally'),
    check('public_search', 'Публичный поиск включён'),
    check('global_noindex', 'Глобальный noindex (рекомендуется для материалов вуза — раздел 13 ТЗ)'),
    check('closed_mode', 'Закрытый режим: доступ только по инвайт-коду (Phase 2)'),
    fld('Инвайт-код закрытого режима', inputs.invite_code = el('input', { type: 'text', value: s.invite_code || '' })),
    fld('Максимальный размер загрузки, МБ', inputs.max_upload_mb = el('input', { type: 'number', value: s.max_upload_mb, min: '1' })),
    fld('Разрешённые расширения (через запятую)', inputs.allowed_ext = el('input', { type: 'text', value: (s.allowed_ext || []).join(', ') })),
    el('button', { class: 'btn btn-primary', onclick: () => saveSettings() }, 'Сохранить')));

  c.append(el('div', { class: 'panel' }, el('h2', {}, 'Учётная запись администратора'),
    el('div', { class: 'grid-2' },
      field('Смена пароля', el('div', {},
        fld('Текущий пароль', inputs.oldp = el('input', { type: 'password' })),
        fld('Новый пароль (мин. 8 символов)', inputs.newp = el('input', { type: 'password' })),
        el('button', { class: 'btn btn-secondary', onclick: async () => { try { await api('/api/admin/account/password', { method: 'POST', body: JSON.stringify({ oldPassword: inputs.oldp.value, newPassword: inputs.newp.value }) }); toast('Пароль изменён, прочие сессии завершены'); inputs.oldp.value = inputs.newp.value = ''; } catch (e) { toast(e.message, true); } } }, 'Сменить пароль'))),
      field('Двухфакторная аутентификация (TOTP)', el('div', {},
        d.account.twoFactor
          ? el('div', {}, badge('2FA включена', 'green'), el('div', { style: 'margin-top:8px' },
            fld('Пароль (для отключения)', inputs.twop = el('input', { type: 'password' })),
            el('button', { class: 'btn btn-danger btn-sm', onclick: async () => { try { await api('/api/admin/account/2fa/disable', { method: 'POST', body: JSON.stringify({ password: inputs.twop.value }) }); toast('2FA отключена'); nav(); } catch (e) { toast(e.message, true); } } }, 'Отключить 2FA')))
          : el('div', {}, el('p', { class: 'muted', style: 'font-size:12.5px' }, 'Рекомендуется для продакшена. Нужен TOTP-приложение (Google Authenticator, Aegis, 1Password).'),
            el('button', { class: 'btn btn-secondary', onclick: async () => {
              try {
                const r = await api('/api/admin/account/2fa/setup', { method: 'POST', body: '{}' });
                const code = el('input', { type: 'text', maxlength: '6', placeholder: '123456' });
                const m2 = modal('Настройка 2FA', [
                  field('Секрет (введите вручную в приложение)', el('input', { type: 'text', value: r.secret, readonly: true, onclick: e => e.target.select() })),
                  fld('otpauth-ссылка', el('input', { type: 'text', value: r.otpauth, readonly: true, onclick: e => e.target.select() }), 'Откроется в приложении-аутентификаторе; QR не генерируется офлайн.'),
                  field('Код подтверждения', code),
                ], [el('button', { class: 'btn btn-secondary', onclick: () => m2.close() }, 'Отмена'),
                el('button', { class: 'btn btn-primary', onclick: async () => { try { await api('/api/admin/account/2fa/confirm', { method: 'POST', body: JSON.stringify({ code: code.value }) }); toast('2FA включена'); m2.close(); nav(); } catch (e) { toast(e.message, true); } } }, 'Включить 2FA')]);
              } catch (e) { toast(e.message, true); }
            } }, 'Настроить 2FA')))),
    el('h2', { style: 'margin-top:18px' }, 'Активные сессии'),
    table(['UA', 'Создана', 'Истекает', ''], d.sessions.map(ss => [
      el('span', { class: 'muted', style: 'font-size:11.5px' }, (ss.ua || '').slice(0, 60)), fmtDate(ss.created_at), fmtDate(ss.expires_at),
      el('button', { class: 'btn btn-danger btn-sm', onclick: async () => { try { await api('/api/admin/account/sessions/' + encodeURIComponent(ss.id), { method: 'DELETE' }); toast('Сессия завершена'); nav(); } catch (e) { toast(e.message, true); } } }, 'Завершить'),
    ])))));

  c.append(el('div', { class: 'panel' }, el('h2', {}, 'Резервные копии и перенос'),
    el('div', { class: 'row' },
      el('a', { class: 'btn btn-secondary', href: '/api/admin/export/catalog' }, 'Экспорт каталога (JSON)'),
      el('button', { class: 'btn btn-secondary', onclick: () => $('#import-file').click() }, 'Импорт каталога (JSON)'),
      el('input', { type: 'file', id: 'import-file', accept: '.json', class: 'hidden', onchange: async e => {
        const f = e.target.files[0]; if (!f) return;
        if (!confirm('Импорт перезапишет метаданные папок и материалов. Продолжить?')) return;
        try { const r = await api('/api/admin/import/catalog', { method: 'POST', body: await f.text() }); toast(`Импортировано: папок ${r.folders}, материалов ${r.materials}`); } catch (err) { toast(err.message, true); }
      } })),
    el('p', { class: 'muted', style: 'font-size:12.5px' }, 'Полный бэкап (БД + файлы): node scripts/backup.js — см. README. В docker-compose настроен nightly-бэкап.')));

  // Синхронизация с Obsidian Git-репозиторием
  const syncState = await api('/api/admin/vault/sync/state');
  const syncInputs = {};
  c.append(el('div', { class: 'panel' }, el('h2', {}, 'Синхронизация с Obsidian Git'),
    el('p', { class: 'muted', style: 'font-size:12.5px;margin-bottom:12px' }, 'Автоматическая двусторонняя синхронизация vault с Git-репозиторием. При включении Lab-Hub будет периодически получать изменения из репозитория и отправлять локальные изменения обратно.'),
    el('label', { class: 'check' }, syncInputs.enabled = el('input', { type: 'checkbox', checked: syncState.enabled }), ' Включить синхронизацию'),
    fld('URL Git-репозитория', syncInputs.url = el('input', { type: 'url', value: syncState.url, placeholder: 'https://github.com/user/vault.git или git@github.com:user/vault.git' }), 'SSH или HTTPS. Для SSH убедитесь, что ключ доступен серверу.'),
    el('div', { class: 'grid-2' },
      fld('Интервал автосинхронизации (минуты)', syncInputs.interval = el('input', { type: 'number', value: syncState.interval, min: '1', max: '1440' })),
      el('div', { class: 'field' }, el('label', { class: 'check', style: 'margin-top:28px' }, syncInputs.autoSync = el('input', { type: 'checkbox', checked: syncState.autoSync }), ' Автоматическая синхронизация по расписанию'))),
    syncState.lastSync ? el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, `Последняя синхронизация: ${fmtDate(syncState.lastSync)} — ${syncState.lastStatus === 'success' ? '✓ успешно' : '✗ ошибка: ' + (syncState.lastError || 'неизвестная ошибка')}`) : null,
    el('div', { class: 'row', style: 'margin-top:12px' },
      el('button', { class: 'btn btn-secondary', onclick: async () => {
        if (!syncInputs.url.value.trim()) return toast('Укажите URL репозитория', true);
        try { const r = await api('/api/admin/vault/sync/test', { method: 'POST', body: JSON.stringify({ url: syncInputs.url.value.trim() }) }); toast(r.ok ? '✓ Репозиторий доступен' : '✗ ' + r.error, !r.ok); } catch (e) { toast(e.message, true); }
      } }, 'Проверить подключение'),
      el('button', { class: 'btn btn-primary', onclick: async () => {
        const body = { enabled: syncInputs.enabled.checked, url: syncInputs.url.value.trim(), interval: +syncInputs.interval.value, autoSync: syncInputs.autoSync.checked };
        try { await api('/api/admin/vault/sync/settings', { method: 'POST', body: JSON.stringify(body) }); toast('Настройки синхронизации сохранены'); nav(); } catch (e) { toast(e.message, true); }
      } }, 'Сохранить настройки синхронизации'),
      el('button', { class: 'btn btn-secondary', onclick: async () => {
        if (!confirm('Запустить синхронизацию сейчас?')) return;
        try { const r = await api('/api/admin/vault/sync/now', { method: 'POST', body: '{}' }); toast(r.message || 'Синхронизация завершена'); nav(); } catch (e) { toast(e.message, true); }
      }, disabled: !syncState.enabled && !syncInputs.enabled.checked }, 'Синхронизировать сейчас'))));

  async function saveSettings() {
    const body = {};
    for (const k of ['site_name', 'site_description', 'footer_note', 'accent_color', 'default_theme', 'invite_code']) body[k] = inputs[k].value;
    for (const k of ['allow_download', 'public_search', 'global_noindex', 'closed_mode']) body[k] = inputs[k].checked;
    body.max_upload_mb = +inputs.max_upload_mb.value || 2048;
    body.allowed_ext = inputs.allowed_ext.value.split(',').map(x => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
    try { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) }); toast('Настройки сохранены'); } catch (e) { toast(e.message, true); }
  }
});

// ——— Старт ———
(async function init() {
  try {
    const me = await api('/api/admin/me');
    CSRF = me.csrf;
    showAdmin();
    if (!location.hash) location.hash = '#dashboard';
    nav();
  } catch {
    showLogin();
  }
})();
