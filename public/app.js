// Публичная часть lab-hub: SPA-роутер (History API), дерево папок, страницы папок
// и материалов, поиск с подсказками, темы, батчевая аналитика через sendBeacon (ТЗ 4.x, 8.4).

// ——— Иконки (inline SVG) ———
const ICONS = {
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>',
  flask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v7.5L4.7 18a2 2 0 0 0 1.7 3h11.2a2 2 0 0 0 1.7-3L14 9.5V2"/><path d="M8.5 2h7M7 16h10"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  sigma: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 4H6l6 8-6 8h12"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6M12 19h8"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>',
  docx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7M19 12H5"/></svg>',
  caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1Z"/></svg>',
  chevronL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 6v6M5.6 5.6l4.2 4.2m4.2 4.2 4.2 4.2M1 12h6m6 0h6M5.6 18.4l4.2-4.2m4.2-4.2 4.2-4.2"/></svg>',
};

const KIND_ICON = { pdf: 'pdf', docx: 'docx', video: 'video', image: 'image', link: 'link' };
const KIND_LABEL = { pdf: 'PDF', docx: 'DOCX', video: 'Видео', image: 'Изображение', link: 'Ссылка' };

// ——— Утилиты ———
const $ = sel => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = '') => { const s = el('span', { class: cls, html: ICONS[name] || ICONS.book }); const svg = s.firstChild; if (svg) { svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%'); } return s; };

function fmtSize(bytes) {
  if (!bytes) return '—';
  const u = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDuration(sec) {
  if (!sec) return null;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function toast(msg, isErr = false) {
  const t = el('div', { class: 'toast' + (isErr ? ' err' : '') }, msg);
  $('#toasts').append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 3200);
}
async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).message || msg; } catch { }
    throw new Error(msg);
  }
  return r.json();
}

// ——— Аналитика: батчи через sendBeacon (раздел 8.4) ———
const Analytics = (() => {
  let queue = [];
  let timer = null;
  function flush() {
    timer = null;
    if (!queue.length) return;
    const pending = [...queue];
    queue = [];
    const batch = JSON.stringify({ events: pending });
    if (navigator.sendBeacon && navigator.sendBeacon('/api/events', new Blob([batch], { type: 'application/json' }))) {
      return;
    }
    fetch('/api/events', { method: 'POST', body: batch, headers: { 'Content-Type': 'application/json' }, keepalive: true })
      .catch(() => { });
  }
  function push(ev) {
    if (navigator.doNotTrack === '1') return; // уважение DNT
    queue.push(ev);
    if (!timer) timer = setTimeout(flush, 5000);
  }
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  return { push, flush };
})();

const enteredAt = Date.now();
window.addEventListener('pagehide', () => {
  Analytics.push({ type: 'time_on_site', value: Math.round((Date.now() - enteredAt) / 1000) });
  Analytics.flush();
});

// ——— Тема ———
// theme.js уже применил тему из localStorage в <head>, здесь только обновляем иконки
function syncThemeIcons() {
  const isDark = document.documentElement.dataset.theme === 'dark';
  $('#icon-sun').classList.toggle('hidden', isDark);
  $('#icon-moon').classList.toggle('hidden', !isDark);
}
function applyTheme(theme) {
  let next = theme;
  if (!next) {
    const cur = document.documentElement.dataset.theme;
    next = cur === 'dark' ? 'light' : 'dark';
  }
  document.documentElement.dataset.theme = next;
  localStorage.setItem('lh-theme', next);
  syncThemeIcons();
}
$('#btn-theme').addEventListener('click', () => applyTheme());
// Синхронизировать иконки с темой, установленной в theme.js
syncThemeIcons();

// ——— Мобильный drawer ———
$('#btn-drawer').addEventListener('click', () => document.body.classList.toggle('drawer-open'));
$('#scrim').addEventListener('click', () => document.body.classList.remove('drawer-open'));

// ——— Дерево папок (раздел 4.2): один запрос, состояние в localStorage ———
let treeData = null;
const openState = JSON.parse(localStorage.getItem('lh-tree-open') || '{}');

function saveTreeState() { localStorage.setItem('lh-tree-open', JSON.stringify(openState)); }

async function loadTree() {
  treeData = (await api('/api/folders/tree')).folders;
  renderTree();
}

function treeMatches(f, q) {
  if (f.title.toLowerCase().includes(q)) return true;
  return (f.children || []).some(c => treeMatches(c, q));
}

function renderTree(filter = '') {
  const root = $('#folder-tree');
  root.innerHTML = '';
  const q = filter.trim().toLowerCase();
  const ul = el('ul');
  const build = (folders, parentUl) => {
    for (const f of folders) {
      if (q && !treeMatches(f, q)) continue;
      const isOpen = q ? true : !!openState[f.slug];
      const isActive = location.pathname === '/' + f.slug || location.pathname.startsWith('/' + f.slug + '/');
      const hasChildren = (f.children || []).length > 0;
      const row = el('div', {
        class: 'tree-row' + (isActive ? ' active' : ''), role: 'treeitem', tabindex: '0',
        'aria-expanded': hasChildren ? String(isOpen) : null,
      },
        el('span', {
          class: 't-caret' + (isOpen ? ' open' : ''),
          onclick: e => {
            e.stopPropagation();
            if (!hasChildren) return;
            openState[f.slug] = !isOpen; saveTreeState(); renderTree($('#tree-filter').value);
          },
          html: hasChildren ? ICONS.caret : '',
        }),
        el('span', { class: 't-icon', style: `color:${f.color}`, html: ICONS[f.icon] || ICONS.folder }),
        el('span', { class: 't-title', title: f.title }, f.title),
        el('span', { class: 't-count' }, f.total_count || ''),
      );
      row.addEventListener('click', () => navigate('/' + f.slug));
      row.addEventListener('keydown', e => { if (e.key === 'Enter') navigate('/' + f.slug); });
      const li = el('li', {}, row);
      if (hasChildren) {
        const sub = el('ul', { class: 'sub' + (isOpen || q ? '' : ' hidden') });
        build(f.children, sub);
        li.append(sub);
      }
      parentUl.append(li);
    }
  };
  build(treeData || [], ul);
  root.append(ul);
}
$('#tree-filter').addEventListener('input', e => renderTree(e.target.value));

// ——— SPA-роутер ———
function navigate(path, replace = false) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  route();
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!href || href.startsWith('http') || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  navigate(href);
});
window.addEventListener('popstate', route);

async function route() {
  document.body.classList.remove('drawer-open');
  destroyActiveGraph();   // цикл отрисовки графа не должен переживать уход со страницы
  const view = $('#view');
  const path = location.pathname;
  window.scrollTo(0, 0);
  if (treeData) renderTree($('#tree-filter')?.value || '');
  try {
    if (path === '/') { Analytics.push({ type: 'pageview', path: '/' }); await renderHome(view); }
    else if (path.startsWith('/m/')) { const slug = path.slice(3); Analytics.push({ type: 'pageview', path: '/m/' + slug }); await renderMaterial(view, slug); }
    else if (path.startsWith('/search')) { Analytics.push({ type: 'pageview', path: '/search' }); await renderSearch(view, new URLSearchParams(location.search).get('q') || ''); }
    else if (path === '/privacy') { Analytics.push({ type: 'pageview', path: '/privacy' }); renderPrivacy(view); }
    else if (path === '/notes' || path.startsWith('/notes/')) { Analytics.push({ type: 'pageview', path }); await renderNotesRoute(view, path); }
    else { Analytics.push({ type: 'pageview', path }); await renderFolder(view, path.slice(1).split('/')[0]); }
  } catch (e) {
    view.innerHTML = '';
    view.append(render404(e.message));
  }
  // подсветка активного узла дерева
  renderTree($('#tree-filter')?.value || '');
}

// ——— Главная (раздел 4.1) ———
async function renderHome(view) {
  const [site, tree] = await Promise.all([api('/api/site'), treeData ? Promise.resolve({ folders: treeData }) : api('/api/folders/tree')]);
  if (!treeData) { treeData = tree.folders; }
  document.getElementById('footer-note').textContent = site.footer_note || site.site_name;

  // Recently added: собираем из дерева (по одному запросу каталога нет — используем папки верхнего уровня)
  view.innerHTML = '';
  view.append(el('div', { class: 'hero fade-in' },
    el('h1', {}, site.site_name),
    el('p', {}, site.site_description)));

  const topFolders = treeData;
  view.append(el('div', { class: 'section-head' }, el('h2', {}, 'Предметы'), el('span', { class: 'count' }, `${topFolders.length}`)));
  const grid = el('div', { class: 'cards-grid fade-in' });
  for (const f of topFolders) {
    grid.append(subjectCard(f));
  }
  view.append(grid);

  // Недавно добавленное
  const recent = el('div', { class: 'mat-cards fade-in' }, recentSkeletons(6));
  view.append(el('div', { class: 'section-head' }, el('h2', {}, 'Недавно добавленное')));
  view.append(recent);
  loadRecent(recent);
}

function recentSkeletons(n) {
  return Array.from({ length: n }, () => el('div', { class: 'skeleton', style: 'height:120px;border-radius:14px' }));
}

async function loadRecent(container) {
  // один запрос: все папки верхнего уровня → их материалы; сортируем по published_at
  try {
    const all = [];
    const walk = async folders => {
      for (const f of folders) {
        const data = await api('/api/folders/' + encodeURIComponent(f.slug));
        for (const m of data.materials) all.push(m);
        if (f.children?.length) await walk(f.children);
      }
    };
    await walk(treeData);
    all.sort((a, b) => (b.published_at || 0) - (a.published_at || 0));
    container.innerHTML = '';
    if (!all.length) { container.append(emptyState('Пока пусто', 'Материалы появятся здесь после публикации админом.')); return; }
    for (const m of all.slice(0, 6)) container.append(materialCard(m));
  } catch {
    container.innerHTML = '';
    container.append(emptyState('Не удалось загрузить', 'Проверьте соединение и обновите страницу.'));
  }
}

function subjectCard(f) {
  return el('a', { class: 'subject-card', href: '/' + f.slug, 'data-link': true, style: `--c:${f.color}` },
    el('span', { class: 'sc-icon', html: ICONS[f.icon] || ICONS.folder }),
    el('h3', {}, f.title),
    el('p', {}, f.description || 'Учебные материалы по предмету'),
    el('div', { class: 'sc-meta' },
      el('span', {}, `${f.total_count ?? f.material_count} мат.`),
      (f.children?.length ? el('span', {}, `${f.children.length} разделов`) : null)));
}

// ——— Страница папки (раздел 4.3) ———
const folderUiState = {}; // slug → {view, sort, dir, kind, tag}

async function renderFolder(view, slug) {
  const data = await api('/api/folders/' + encodeURIComponent(slug));
  const { folder, breadcrumb, children, materials } = data;
  Analytics.push({ type: 'pageview', path: '/' + slug, folder_id: folder.id });
  // Сортировка по умолчанию — по названию А→Я; пользовательский выбор запоминается в localStorage
  const [savedSort, savedDir] = (localStorage.getItem('lh-sort') || 'title:asc').split(':');
  const st = folderUiState[slug] || (folderUiState[slug] = { view: localStorage.getItem('lh-list-view') || 'table', sort: savedSort || 'title', dir: savedDir === 'desc' ? 'desc' : 'asc', kind: '', tag: '' });

  view.innerHTML = '';
  view.append(breadcrumbs(breadcrumb));
  view.append(el('div', { class: 'page-head fade-in' },
    el('h1', { class: 'page-title' }, folder.title),
    folder.description ? el('p', { class: 'page-sub' }, folder.description) : null));

  if (children.length) {
    const grid = el('div', { class: 'cards-grid fade-in', style: 'margin-bottom:8px' });
    for (const c of children) grid.append(subjectCard({ ...c, total_count: undefined, material_count: undefined, icon: c.icon, color: c.color, description: c.description }));
    view.append(el('div', { class: 'section-head' }, el('h2', {}, 'Разделы')));
    view.append(grid);
  }

  view.append(el('div', { class: 'section-head' }, el('h2', {}, 'Материалы'), el('span', { class: 'count' }, materials.length)));

  const allTags = [...new Set(materials.flatMap(m => m.tags || []))].sort((a, b) => a.localeCompare(b, 'ru'));
  const listContainer = el('div', { class: 'fade-in' });

  const toolbar = el('div', { class: 'list-toolbar' });
  const kindChips = el('div', { class: 'chips' },
    chip('Все', '', st.kind, v => { st.kind = v; draw(); }),
    chip('PDF', 'pdf', st.kind, v => { st.kind = v; draw(); }),
    chip('DOCX', 'docx', st.kind, v => { st.kind = v; draw(); }),
    chip('Видео', 'video', st.kind, v => { st.kind = v; draw(); }),
    chip('Другое', 'other', st.kind, v => { st.kind = v; draw(); }));
  const tagSelect = el('select', { class: 'select', onchange: e => { st.tag = e.target.value; draw(); } },
    el('option', { value: '' }, 'Все теги'),
    ...allTags.map(t => el('option', { value: t, selected: st.tag === t }, t)));
  const sortSelect = el('select', { class: 'select', onchange: e => { const [s, d] = e.target.value.split(':'); st.sort = s; st.dir = d; localStorage.setItem('lh-sort', `${s}:${d}`); draw(); } },
    ...[['date:desc', 'Сначала новые'], ['date:asc', 'Сначала старые'], ['title:asc', 'По названию А→Я'], ['title:desc', 'По названию Я→А'], ['size:desc', 'По размеру'], ['views:desc', 'По просмотрам']]
      .map(([v, label]) => el('option', { value: v, selected: `${st.sort}:${st.dir}` === v }, label)));
  const viewToggle = el('div', { class: 'view-toggle' },
    el('button', { class: st.view === 'table' ? 'active' : '', title: 'Таблица', 'aria-label': 'Таблица', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5h18M3 12h18M3 19h18"/></svg>', onclick: () => { st.view = 'table'; localStorage.setItem('lh-list-view', 'table'); draw(); } }),
    el('button', { class: st.view === 'cards' ? 'active' : '', title: 'Карточки', 'aria-label': 'Карточки', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>', onclick: () => { st.view = 'cards'; localStorage.setItem('lh-list-view', 'cards'); draw(); } }));
  toolbar.append(kindChips, tagSelect, sortSelect, viewToggle);
  view.append(toolbar, listContainer);

  function currentList() {
    let list = [...materials];
    if (st.kind) list = list.filter(m => st.kind === 'other' ? !['pdf', 'docx', 'video'].includes(m.kind) : m.kind === st.kind);
    if (st.tag) list = list.filter(m => (m.tags || []).includes(st.tag));
    const dir = st.dir === 'asc' ? 1 : -1;
    const cmp = { date: (a, b) => ((a.published_at || 0) - (b.published_at || 0)) * dir, title: (a, b) => a.title.localeCompare(b.title, 'ru') * dir, size: (a, b) => ((a.size || 0) - (b.size || 0)) * dir, views: (a, b) => (a.views_count - b.views_count) * dir }[st.sort];
    return list.sort(cmp || ((a, b) => 0));
  }

  function draw() {
    // перерисовка тулбара (активные чипы)
    kindChips.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.v === st.kind));
    viewToggle.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', (i === 0) === (st.view === 'table')));
    listContainer.innerHTML = '';
    const list = currentList();
    if (!list.length) { listContainer.append(emptyState('Ничего не найдено', 'Попробуйте изменить фильтры.')); return; }
    if (st.view === 'table') listContainer.append(materialTable(list));
    else { const g = el('div', { class: 'mat-cards' }); for (const m of list) g.append(materialCard(m)); listContainer.append(g); }
  }
  draw();
}

function chip(label, v, current, onclick) {
  return el('button', { class: 'chip' + (current === v ? ' active' : ''), 'data-v': v, onclick: () => onclick(v) }, label);
}

function materialTable(materials) {
  const tbody = el('tbody');
  for (const m of materials) {
    const dur = fmtDuration(m.duration_sec);
    tbody.append(el('tr', { onclick: () => navigate('/m/' + m.slug), style: 'cursor:pointer' },
      el('td', {},
        el('div', { class: 'mat-title-cell' },
          kindIcon(m.kind),
          el('div', {},
            el('div', { class: 'mat-name' }, m.title),
            el('div', { class: 'mat-sub' },
              m.tags?.length ? el('span', {}, m.tags.map(t => '#' + t).join(' ')) : null,
              m.visibility === 'unlisted' ? el('span', { class: 'badge badge-amber' }, 'unlisted') : null)))),
      el('td', { class: 'muted' }, KIND_LABEL[m.kind] || m.kind),
      el('td', { class: 'muted' }, fmtSize(m.size)),
      el('td', { class: 'muted' }, m.page_count ? `${m.page_count} стр.` : (dur || '—')),
      el('td', { class: 'muted' }, fmtDate(m.published_at)),
      el('td', { class: 'muted' }, m.views_count),
      el('td', { onclick: e => e.stopPropagation() },
        el('div', { class: 'row', style: 'gap:6px' },
          readButton(m, true),
          m.allow_download ? el('a', { class: 'btn btn-ghost btn-sm', href: `/api/download/${m.id}`, title: 'Скачать', 'aria-label': 'Скачать ' + m.title, onclick: () => Analytics.push({ type: 'download', material_id: m.id }) }, iconSvg('download')) : null))));
  }
  return el('div', { class: 'mat-table-wrap' },
    el('table', { class: 'mat-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Название'), el('th', {}, 'Тип'), el('th', {}, 'Размер'), el('th', {}, 'Объём'),
        el('th', {}, 'Дата'), el('th', {}, 'Просм.'), el('th', {}, ''))),
      tbody));
}

function iconSvg(name) { const s = el('span', { html: ICONS[name] }); const svg = s.firstChild; svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); return svg; }

function kindIcon(kind) {
  return el('span', { class: `kind-icon kind-${kind}`, html: ICONS[KIND_ICON[kind] || 'link'] });
}

function readButton(m, small = false) {
  const canRead = m.kind === 'pdf' || m.kind === 'video' || m.kind === 'image' || m.source_type === 'embed';
  if (!canRead) return null;
  const label = m.kind === 'video' ? 'Смотреть' : m.kind === 'image' ? 'Открыть' : 'Читать онлайн';
  const href = `/view/${m.slug}`;
  return el('a', {
    class: 'btn btn-primary' + (small ? ' btn-sm' : ''), href,
    onclick: () => Analytics.push({ type: 'reader_open', material_id: m.id }),
  }, iconSvg('read'), label);
}

function materialCard(m) {
  const dur = fmtDuration(m.duration_sec);
  return el('a', { class: 'mat-card', href: '/m/' + m.slug, 'data-link': true },
    el('div', { class: 'mc-head' }, kindIcon(m.kind),
      el('div', { class: 'grow' },
        el('h3', {}, m.title),
        el('div', { class: 'muted', style: 'font-size:12px' }, KIND_LABEL[m.kind] || m.kind, m.page_count ? ` · ${m.page_count} стр.` : (dur ? ` · ${dur}` : '')))),
    m.description ? el('p', {}, m.description) : null,
    el('div', { class: 'mc-foot' },
      el('span', {}, fmtDate(m.published_at)),
      el('span', { style: 'margin-left:auto' }, `${m.views_count} просм.`),
      m.visibility === 'unlisted' ? el('span', { class: 'badge badge-amber' }, 'unlisted') : null));
}

// ——— Карточка материала (раздел 4.4) ———
async function renderMaterial(view, slug) {
  const data = await api('/api/materials/' + encodeURIComponent(slug));
  const m = data.material;
  Analytics.push({ type: 'material_view', material_id: m.id, folder_id: m.folder_id });
  view.innerHTML = '';
  view.append(breadcrumbs(data.breadcrumb, { title: m.title }));

  const dur = fmtDuration(m.duration_sec);
  const page = el('div', { class: 'mat-page fade-in' });

  const hero = el('div', { class: 'mat-hero' });
  hero.append(el('div', { class: 'mat-hero-head' }, kindIcon(m.kind),
    el('div', { class: 'grow' },
      el('h1', { id: 'material-' + m.slug }, m.title),
      el('div', { class: 'mat-meta' },
        el('span', {}, iconSvg('calendar'), fmtDate(m.published_at)),
        m.size ? el('span', {}, iconSvg('download'), fmtSize(m.size)) : null,
        m.page_count ? el('span', {}, `${m.page_count} страниц`) : (dur ? el('span', {}, iconSvg('clock'), dur) : null),
        el('span', {}, iconSvg('eye'), `${m.views_count}`)))));
  if (m.description) hero.append(el('div', { class: 'mat-desc' }, m.description));
  if (m.tags?.length) hero.append(el('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px;margin-top:6px' },
    ...m.tags.map(t => el('a', { class: 'tag', href: '/search?q=' + encodeURIComponent(t), 'data-link': true }, '#' + t))));

  const actions = el('div', { class: 'mat-actions' });
  const read = readButton(m);
  if (read) actions.append(read);
  if (m.allow_download) {
    actions.append(el('a', { class: 'btn btn-secondary', href: `/api/download/${m.id}`, onclick: () => Analytics.push({ type: 'download', material_id: m.id }) }, iconSvg('download'), 'Скачать'));
  } else if (m.kind === 'docx') {
    actions.append(el('span', { class: 'muted' }, 'Онлайн-просмотр DOCX не поддерживается, а скачивание отключено'));
  }
  actions.append(el('button', {
    class: 'btn btn-ghost', onclick: async () => {
      try { await navigator.clipboard.writeText(location.href); toast('Ссылка скопирована'); }
      catch { toast('Не удалось скопировать', true); }
    }
  }, iconSvg('copy'), 'Скопировать ссылку'));
  hero.append(actions);

  // Превью / плеер
  if (m.kind === 'video') {
    hero.append(videoBlock(m));
  } else if (m.kind === 'image') {
    hero.append(el('div', { class: 'mat-preview' }, el('img', { src: data.streamUrl, alt: m.title, loading: 'lazy' })));
  } else if (m.poster) {
    hero.append(el('div', { class: 'mat-preview' },
      el('img', { src: m.poster, alt: 'Превью: ' + m.title, loading: 'lazy' }),
      read ? el('div', { class: 'play-overlay', onclick: () => { Analytics.push({ type: 'reader_open', material_id: m.id }); navigate('/view/' + m.slug); } },
        el('span', { class: 'play-circle', html: ICONS.play })) : null));
  } else if (m.kind === 'pdf' || m.kind === 'docx') {
    hero.append(el('div', { class: 'mat-preview', style: 'display:grid;place-items:center;padding:40px 20px;color:var(--text-3)' },
      el('div', { style: 'text-align:center;display:flex;flex-direction:column;align-items:center;gap:10px' },
        kindIcon(m.kind),
        el('div', {}, m.kind === 'docx'
          ? 'DOCX: доступно скачивание — онлайн-просмотр не поддерживается'
          : 'Откройте материал в читалке — без скачивания'))));
  }

  const side = el('div', { class: 'mat-side' });
  side.append(el('div', { class: 'side-card' },
    el('h3', {}, 'О материале'),
    sideStat('Тип', KIND_LABEL[m.kind] || m.kind),
    sideStat('Размещён', sourceLabel(m)),
    m.size ? sideStat('Размер', fmtSize(m.size)) : null,
    m.page_count ? sideStat('Страниц', m.page_count) : null,
    dur ? sideStat('Длительность', dur) : null,
    sideStat('Добавлен', fmtDate(m.published_at)),
    sideStat('Просмотров', m.views_count),
    sideStat('Открытий в читалке', m.reads_count),
    sideStat('Скачиваний', m.downloads_count)));

  if (data.related?.length) {
    const rel = el('div', { class: 'side-card' }, el('h3', {}, 'Из этого раздела'));
    for (const r of data.related) {
      rel.append(el('div', { class: 'related-item' },
        el('span', { class: `kind-icon kind-${r.kind}`, html: ICONS[KIND_ICON[r.kind] || 'link'] }),
        el('a', { href: '/m/' + r.slug, 'data-link': true }, r.title)));
    }
    side.append(rel);
  }
  side.append(el('button', { class: 'btn btn-secondary', onclick: () => history.length > 1 ? history.back() : navigate('/' + (data.breadcrumb.at(-1)?.slug || '')) }, iconSvg('back'), 'Назад к списку'));

  page.append(hero, side);
  view.append(page);

  // deep-link ?page=12 → сразу открываем читалку на нужной странице (раздел 4.4)
  const qPage = new URLSearchParams(location.search).get('page');
  if (qPage && data.viewerUrl) {
    location.replace(`/view/${m.slug}?page=${encodeURIComponent(qPage)}`);
  }
}

function sourceLabel(m) {
  return { local: 'На сервере', s3: 'S3-хранилище', webdav: 'WebDAV', drive: 'Облачный диск', url: 'Внешний источник', embed: 'Внешний плеер' }[m.source_type] || 'Внешний';
}
function sideStat(k, v) { return el('div', { class: 'side-stat' }, el('span', {}, k), el('b', {}, String(v))); }

function videoBlock(m) {
  if (m.source_type === 'embed') {
    // iframe внешнего плеера
    return el('div', { class: 'mat-preview' },
      el('div', { style: 'position:relative;padding-top:56.25%' },
        el('iframe', { src: m.mode === 'embed' ? `/view/${m.slug}` : `/api/stream/${m.id}`, style: 'position:absolute;inset:0;width:100%;height:100%;border:0', allow: 'fullscreen; picture-in-picture; encrypted-media', allowfullscreen: true, title: m.title })));
  }
  const video = el('video', {
    controls: true, preload: 'metadata', playsinline: true,
    poster: m.poster || undefined, style: 'width:100%;max-height:520px;background:#000',
  });
  video.src = `/api/stream/${m.id}`;
  // Запоминание позиции просмотра (раздел 6.2)
  const key = 'lh-pos-video-' + m.id;
  video.addEventListener('loadedmetadata', () => {
    const saved = parseFloat(localStorage.getItem(key) || '0');
    if (saved > 1 && saved < video.duration - 10) { video.currentTime = saved; toast('Продолжаем с ' + fmtDuration(saved)); }
  });
  let quartiles = new Set();
  video.addEventListener('timeupdate', () => {
    localStorage.setItem(key, String(video.currentTime));
    if (!video.duration) return;
    const p = Math.floor((video.currentTime / video.duration) * 100);
    for (const q of [25, 50, 75, 100]) {
      if (p >= q && !quartiles.has(q)) { quartiles.add(q); Analytics.push({ type: 'video_progress', material_id: m.id, value: q }); }
    }
  });
  video.addEventListener('play', () => Analytics.push({ type: 'reader_open', material_id: m.id }));
  return el('div', { class: 'mat-preview' }, video);
}

// ——— Поиск (раздел 4.5) ———
async function renderSearch(view, q) {
  view.innerHTML = '';
  view.append(el('div', { class: 'page-head fade-in' },
    el('h1', { class: 'page-title' }, 'Результаты поиска'),
    el('p', { class: 'page-sub' }, q ? `По запросу «${q}»` : 'Введите запрос в строку поиска наверху')));
  if (!q) return;
  const info = el('div', { class: 'search-info' }, 'Ищем…');
  const list = el('div', { class: 'mat-cards fade-in' });
  view.append(info, list);
  try {
    const data = await api('/api/search?q=' + encodeURIComponent(q));
    Analytics.push({ type: 'search', query: q, value: data.results.length });
    info.textContent = data.results.length
      ? `Найдено материалов: ${data.results.length}`
      : `По запросу «${q}» ничего не найдено. Администратор увидит этот запрос в статистике — возможно, материал ещё не загружен.`;
    for (const m of data.results) {
      const card = materialCard(m);
      card.querySelector('h3').innerHTML = highlight(m.title, q);
      if (m.description) card.querySelector('p') && (card.querySelector('p').innerHTML = highlight(m.description, q));
      list.append(card);
    }
  } catch (e) {
    info.textContent = 'Ошибка поиска: ' + e.message;
  }
}

function highlight(text, q) {
  const tokens = q.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
  let out = esc(text);
  for (const t of tokens) {
    out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  }
  return out;
}

// Подсказки в шапке
let suggestTimer = null;
const searchInput = $('#search-input');
const suggestBox = $('#search-suggest');
searchInput.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { suggestBox.classList.remove('open'); return; }
  suggestTimer = setTimeout(async () => {
    try {
      const data = await api('/api/search?q=' + encodeURIComponent(q));
      const items = (data.suggestions || []).slice(0, 7);
      suggestBox.innerHTML = '';
      for (const it of items) {
        suggestBox.append(el('a', {
          href: it.kind === 'folder' ? '/' + it.slug : '/m/' + it.slug, role: 'option',
          onclick: e => { e.preventDefault(); suggestBox.classList.remove('open'); navigate(it.kind === 'folder' ? '/' + it.slug : '/m/' + it.slug); }
        }, iconSvg(it.kind === 'folder' ? 'folder' : (KIND_ICON[it.kind] || 'link')),
          el('span', { html: highlight(it.title, q) }),
          el('span', { class: 'sg-kind' }, it.kind === 'folder' ? 'папка' : (KIND_LABEL[it.kind] || it.kind))));
      }
      if (!items.length) {
        suggestBox.append(el('a', { href: '/search?q=' + encodeURIComponent(q), onclick: e => { e.preventDefault(); doSearch(q); } }, 'Искать «' + q + '» во всех материалах'));
      }
      suggestBox.classList.add('open');
    } catch { /* тихо */ }
  }, 220);
});
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { doSearch(searchInput.value.trim()); }
  if (e.key === 'Escape') suggestBox.classList.remove('open');
});
document.addEventListener('click', e => { if (!e.target.closest('.header-search')) suggestBox.classList.remove('open'); });
document.addEventListener('keydown', e => {
  if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); searchInput.focus(); }
});
function doSearch(q) {
  suggestBox.classList.remove('open');
  if (!q) return;
  navigate('/search?q=' + encodeURIComponent(q));
}

// ——— Хлебные крошки (раздел 4.6) ———
function breadcrumbs(items, last = null) {
  const bc = el('nav', { class: 'breadcrumbs', 'aria-label': 'Хлебные крошки' },
    el('a', { href: '/', 'data-link': true }, 'Главная'));
  for (const it of items) {
    bc.append(el('span', { class: 'sep' }, '/'), el('a', { href: '/' + it.slug, 'data-link': true }, it.title));
  }
  if (last) bc.append(el('span', { class: 'sep' }, '/'), el('span', {}, last));
  return bc;
}

// ——— 404 / недоступно (экран 7) ———
function render404(message) {
  return el('div', { class: 'empty fade-in' },
    el('div', { html: ICONS.inbox, style: 'width:56px;height:56px;margin:0 auto 12px;opacity:.4' }),
    el('h3', {}, message && message !== 'Не найдено' ? message : 'Страница не найдена'),
    el('p', {}, 'Возможно, материал скрыт, перемещён или удалён.'),
    el('p', { style: 'margin-top:16px' }, el('a', { class: 'btn btn-primary', href: '/', 'data-link': true }, 'На главную')));
}

function emptyState(title, text) {
  return el('div', { class: 'empty' },
    el('div', { html: ICONS.inbox, style: 'width:56px;height:56px;margin:0 auto 12px;opacity:.4' }),
    el('h3', {}, title), el('p', {}, text));
}

// ——— Политика конфиденциальности одной страницей (раздел 9.4) ———
function renderPrivacy(view) {
  view.innerHTML = '';
  view.append(el('div', { class: 'page-head fade-in' }, el('h1', { class: 'page-title' }, 'Политика конфиденциальности')));
  view.append(el('div', { class: 'mat-hero fade-in', html: `
    <p><b>Какие данные собираются.</b> Сайт не требует регистрации и не собирает персональные данные. Для обезличенной статистики посещаемости используются: cookie-идентификатор посетителя (first-party, срок 1 год) и хеш IP-адреса (HMAC с ежедневно ротируемой солью, необратимый).</p>
    <p><b>Зачем.</b> Чтобы понимать, какие материалы востребованы, и улучшать каталог. Статистика доступна только администратору сайта.</p>
    <p><b>Сторонние сервисы.</b> Не используются. Ни Google Analytics, ни других внешних трекеров на сайте нет. Видео и документы с внешних источников (YouTube, облачные диски) могут собирать данные по своей политике — это происходит только при открытии таких материалов.</p>
    <p><b>Do Not Track.</b> Если в браузере включён сигнал DNT, события статистики не отправляются.</p>
    <p><b>Удаление данных.</b> Cookie-идентификатор можно удалить в настройках браузера в любой момент. Сырые события хранятся не более 12 месяцев.</p>` }));
}

// ——— Заметки (раздел «как в Obsidian») ———
// Публичная часть — только чтение: список, страница заметки с обратными ссылками,
// глобальный и локальный граф, страницы тегов. Пишутся заметки исключительно в админке.
let activeGraph = null;
function destroyActiveGraph() {
  if (activeGraph) { try { activeGraph.destroy(); } catch { } activeGraph = null; }
}

function noteGraphTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

async function renderNotesRoute(view, path) {
  const parts = path.split('/').filter(Boolean);   // ['notes', ...]
  const seg = parts[1] || '';
  if (!seg) return renderNotesIndex(view);
  if (seg === 'graph') return renderNotesGraph(view);
  if (seg === 'tags') return renderNotesTags(view);
  if (seg === 'tag') return renderTagPage(view, parts[2] ? decodeURIComponent(parts[2]) : '');
  return renderNote(view, seg);
}

function noteCard(n) {
  return el('a', { class: 'note-card', href: '/notes/' + encodeURIComponent(n.slug), 'data-link': true },
    el('div', { class: 'note-card-title' }, n.title),
    n.excerpt ? el('div', { class: 'note-card-excerpt' }, n.excerpt) : null,
    el('div', { class: 'note-card-foot' },
      el('span', { class: 'note-card-meta' }, n.word_count + ' сл. · ' + fmtDate(n.updated_at)),
      ...(n.tags || []).slice(0, 3).map(t => el('span', { class: 'tag' }, '#' + t))));
}

async function renderNotesIndex(view) {
  const data = await api('/api/notes');
  view.innerHTML = '';
  view.append(el('div', { class: 'page-head fade-in' },
    el('h1', { class: 'page-title' }, 'Заметки'),
    el('p', { class: 'page-sub' }, 'Конспекты, методички и связи между ними. Пишутся в админ-панели, читаются всеми.'),
    el('div', { class: 'notes-toolbar' },
      el('a', { class: 'btn btn-primary', href: '/notes/graph', 'data-link': true }, iconSvg('globe'), 'Граф связей'),
      el('a', { class: 'btn btn-secondary', href: '/notes/tags', 'data-link': true }, 'Теги'))));

  const notes = data.notes || [];
  if (!notes.length) {
    view.append(emptyState('Заметок пока нет', 'Первая заметка создаётся в админ-панели, раздел «Заметки». Vault лежит в data/vault и совместим с Obsidian.'));
    return;
  }

  const groups = new Map();
  for (const n of notes) {
    const dir = n.folder || '';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(n);
  }
  for (const [dir, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'))) {
    view.append(el('div', { class: 'section-head' },
      el('h2', {}, dir || 'Корень vault'),
      el('span', { class: 'count' }, String(list.length))));
    const grid = el('div', { class: 'notes-grid fade-in' });
    for (const n of list) grid.append(noteCard(n));
    view.append(grid);
  }

  if ((data.tags || []).length) {
    view.append(el('div', { class: 'section-head' }, el('h2', {}, 'Теги')));
    const cloud = el('div', { class: 'tag-cloud fade-in' });
    for (const t of data.tags) {
      cloud.append(el('a', { class: 'tag-chip', href: '/notes/tag/' + encodeURIComponent(t.tag), 'data-link': true },
        '#' + t.tag, el('span', { class: 'tag-count' }, String(t.count))));
    }
    view.append(cloud);
  }
}

async function renderNote(view, slug) {
  const data = await api('/api/notes/' + encodeURIComponent(slug));
  const n = data.note;
  view.innerHTML = '';
  view.append(el('nav', { class: 'breadcrumbs', 'aria-label': 'Хлебные крошки' },
    el('a', { href: '/notes', 'data-link': true }, 'Заметки'),
    el('span', { class: 'sep' }, '/'),
    el('span', {}, n.title)));

  const layout = el('div', { class: 'note-layout fade-in' });
  const article = el('article', { class: 'note-article markdown-body' });
  // html отдан серверным рендерером: HTML из исходника экранирован, опасные URL отброшены
  article.innerHTML = data.html || '';
  layout.append(article);

  const side = el('aside', { class: 'note-side' });

  const headings = (data.headings || []).filter(h => h.level <= 3);
  if (headings.length) {
    const panel = el('div', { class: 'note-panel' }, el('h3', {}, 'Содержание'));
    const list = el('ul', { class: 'note-toc' });
    for (const h of headings) {
      list.append(el('li', { class: 'toc-l' + h.level }, el('a', { href: '#' + h.id }, h.text)));
    }
    panel.append(list);
    side.append(panel);
  }

  if ((data.tags || []).length) {
    const panel = el('div', { class: 'note-panel' }, el('h3', {}, 'Теги'));
    const cloud = el('div', { class: 'tag-cloud' });
    for (const t of data.tags) {
      cloud.append(el('a', { class: 'tag-chip', href: '/notes/tag/' + encodeURIComponent(t), 'data-link': true }, '#' + t));
    }
    panel.append(cloud);
    side.append(panel);
  }

  const back = data.backlinks || [];
  if (back.length) {
    const panel = el('div', { class: 'note-panel' }, el('h3', {}, 'Обратные ссылки · ' + back.length));
    for (const b of back) {
      panel.append(el('a', { class: 'backlink', href: '/notes/' + encodeURIComponent(b.slug), 'data-link': true },
        el('b', {}, b.title), b.excerpt ? el('span', {}, b.excerpt) : null));
    }
    side.append(panel);
  }

  const missing = (data.outgoing || []).filter(l => l.missing);
  if (missing.length) {
    const panel = el('div', { class: 'note-panel' }, el('h3', {}, 'Ненайденные ссылки · ' + missing.length));
    for (const l of missing) panel.append(el('div', { class: 'backlink is-missing' }, l.raw));
    side.append(panel);
  }

  const graphPanel = el('div', { class: 'note-panel' }, el('h3', {}, 'Локальный граф'));
  const canvas = el('canvas', { class: 'note-graph-canvas', 'aria-label': 'Граф связей заметки' });
  graphPanel.append(canvas);
  side.append(graphPanel);

  layout.append(side);
  view.append(layout);

  renderLocalGraph(canvas, slug);
}

async function renderLocalGraph(canvas, slug) {
  try {
    const mod = await import('/notes-graph.js');
    const data = await api('/api/notes/' + encodeURIComponent(slug) + '/graph?depth=1');
    activeGraph = mod.createGraph(canvas, {
      theme: noteGraphTheme(),
      labels: true,
      onOpen: path => {
        const nd = (data.nodes || []).find(x => x.path === path);
        if (nd && nd.slug) navigate('/notes/' + encodeURIComponent(nd.slug));
      },
    });
    activeGraph.setData(data);
    activeGraph.fit();
  } catch (e) {
    canvas.replaceWith(el('div', { class: 'muted' }, 'Граф недоступен'));
  }
}

async function renderNotesGraph(view) {
  const data = await api('/api/notes/graph');
  view.innerHTML = '';
  view.append(el('div', { class: 'page-head fade-in' },
    el('h1', { class: 'page-title' }, 'Граф связей'),
    el('p', { class: 'page-sub' }, 'Заметок: ' + data.nodes.length + ', связей: ' + data.edges.length +
      '. Клик по узлу открывает заметку, перетаскивание сдвигает, колесо мыши масштабирует.'),
    el('div', { class: 'notes-toolbar' },
      el('a', { class: 'btn btn-secondary', href: '/notes', 'data-link': true }, iconSvg('back'), 'К списку заметок'))));

  const wrap = el('div', { class: 'graph-wrap fade-in' });
  const canvas = el('canvas', { class: 'graph-canvas', 'aria-label': 'Граф связей заметок' });

  // Настройки графа (как в Obsidian): значения по умолчанию + сохранённые в localStorage.
  // Ключ с версией (-v2): при смене дефолтов старые сохранённые значения не всплывают.
  const GRAPH_DEFAULTS = { labels: true, linkDistance: 90, charge: -300, centerForce: 0.002, damping: 0.85, nodeSize: 1, labelSize: 9, labelOpacity: 0.7 };
  const GRAPH_SETTINGS_KEY = 'lh-graph-settings-v2';
  let graphSettings = { ...GRAPH_DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(GRAPH_SETTINGS_KEY) || '{}');
    for (const k of ['linkDistance', 'charge', 'centerForce', 'damping', 'nodeSize', 'labelSize', 'labelOpacity']) {
      if (Number.isFinite(+saved[k])) graphSettings[k] = +saved[k];
    }
    if (typeof saved.labels === 'boolean') graphSettings.labels = saved.labels;
  } catch { /* игнорируем повреждённые данные */ }
  const saveGraphSettings = () => { try { localStorage.setItem(GRAPH_SETTINGS_KEY, JSON.stringify(graphSettings)); } catch { } };

  // Описание ползунков — единый формат «слайдер + значение»
  const SLIDERS = [
    { key: 'linkDistance', label: 'Расстояние между узлами', min: 30, max: 150, step: 1, fmt: v => String(v) },
    { key: 'charge', label: 'Сила отталкивания', min: -500, max: -50, step: 5, fmt: v => String(Math.abs(v)) },
    { key: 'centerForce', label: 'Притяжение к центру', min: 0, max: 0.01, step: 0.0005, fmt: v => (v * 1000).toFixed(1) },
    { key: 'damping', label: 'Затухание', min: 0.5, max: 0.95, step: 0.05, fmt: v => (v * 100).toFixed(0) + '%' },
    { key: 'nodeSize', label: 'Размер узлов', min: 0.3, max: 3, step: 0.1, fmt: v => v.toFixed(1) + '×' },
    { key: 'labelSize', label: 'Размер подписей', min: 7, max: 24, step: 1, fmt: v => v + ' px' },
    { key: 'labelOpacity', label: 'Прозрачность подписей', min: 0.05, max: 1, step: 0.05, fmt: v => (v * 100).toFixed(0) + '%' },
  ];

  const PHYSICS_KEYS = new Set(['linkDistance', 'charge', 'centerForce', 'damping']);
  const VISUAL_KEYS = new Set(['nodeSize', 'labelSize', 'labelOpacity']);

  function sliderControl(def) {
    const val = el('span', { class: 'graph-value' }, def.fmt(graphSettings[def.key]));
    const input = el('input', {
      type: 'range',
      min: String(def.min),
      max: String(def.max),
      step: String(def.step),
      value: String(graphSettings[def.key]),
      style: 'flex:1',
      oninput: e => {
        graphSettings[def.key] = Number(e.target.value);
        val.textContent = def.fmt(graphSettings[def.key]);
        if (activeGraph) {
          if (PHYSICS_KEYS.has(def.key)) activeGraph.updatePhysics({ [def.key]: graphSettings[def.key] });
          else if (VISUAL_KEYS.has(def.key)) activeGraph.updateVisual({ [def.key]: graphSettings[def.key] });
        }
        saveGraphSettings();
      },
    });
    return el('label', { class: 'graph-setting' },
      el('span', {}, def.label),
      el('div', { style: 'display:flex;align-items:center;gap:8px' }, input, val));
  }

  function labelsControl() {
    return el('label', { class: 'graph-setting' },
      el('span', {}, 'Подписи узлов'),
      el('input', {
        type: 'checkbox',
        checked: graphSettings.labels,
        onchange: e => {
          graphSettings.labels = e.target.checked;
          if (activeGraph) activeGraph.setLabels(graphSettings.labels);
          saveGraphSettings();
        },
      }));
  }

  function resetButton() {
    return el('button', {
      class: 'btn btn-secondary', style: 'width:100%;margin-top:8px', onclick: () => {
        graphSettings = { ...GRAPH_DEFAULTS };
        saveGraphSettings();
        if (activeGraph) {
          activeGraph.updatePhysics({
            linkDistance: graphSettings.linkDistance,
            charge: graphSettings.charge,
            centerForce: graphSettings.centerForce,
            damping: graphSettings.damping,
          });
          activeGraph.updateVisual({
            nodeSize: graphSettings.nodeSize,
            labelSize: graphSettings.labelSize,
            labelOpacity: graphSettings.labelOpacity,
          });
          activeGraph.setLabels(graphSettings.labels);
        }
        // Пересобираем панель с дефолтными значениями
        settingsPanel.querySelector('.graph-settings-body').replaceWith(settingsBody());
      },
    }, 'Сбросить настройки');
  }

  function settingsBody() {
    return el('div', { class: 'graph-settings-body' },
      labelsControl(),
      ...SLIDERS.map(sliderControl),
      resetButton());
  }

  let settingsOpen = false;
  const settingsPanel = el('div', { class: 'graph-settings' },
    el('div', { class: 'graph-settings-header' },
      el('h3', {}, 'Настройки графа'),
      el('button', {
        class: 'btn-icon-sm', onclick: () => {
          settingsOpen = false;
          settingsPanel.classList.remove('open');
        },
      }, '×')),
    settingsBody());

  const bar = el('div', { class: 'graph-bar' },
    el('button', {
      class: 'btn btn-secondary', onclick: () => { if (activeGraph) activeGraph.fit(); },
    }, 'Вписать'),
    el('button', {
      class: 'btn btn-secondary', onclick: () => {
        settingsOpen = !settingsOpen;
        settingsPanel.classList.toggle('open', settingsOpen);
      },
    }, iconSvg('settings'), 'Настройки'));
  wrap.append(canvas, settingsPanel, bar);
  view.append(wrap);

  try {
    const mod = await import('/notes-graph.js');
    activeGraph = mod.createGraph(canvas, {
      theme: noteGraphTheme(),
      labels: graphSettings.labels,
      linkDistance: graphSettings.linkDistance,
      charge: graphSettings.charge,
      centerForce: graphSettings.centerForce,
      damping: graphSettings.damping,
      nodeSize: graphSettings.nodeSize,
      labelSize: graphSettings.labelSize,
      labelOpacity: graphSettings.labelOpacity,
      onWarn: msg => toast(msg),
      onOpen: path => {
        const nd = (data.nodes || []).find(x => x.path === path);
        if (nd && nd.slug) navigate('/notes/' + encodeURIComponent(nd.slug));
      },
    });
    activeGraph.setData(data);
    activeGraph.fit();
  } catch (e) {
    wrap.append(el('div', { class: 'empty' }, 'Не удалось построить граф: ' + e.message));
  }
}

async function renderNotesTags(view) {
  const data = await api('/api/notes/tags');
  view.innerHTML = '';
  view.append(el('div', { class: 'page-head fade-in' },
    el('h1', { class: 'page-title' }, 'Теги заметок'),
    el('div', { class: 'notes-toolbar' },
      el('a', { class: 'btn btn-secondary', href: '/notes', 'data-link': true }, iconSvg('back'), 'К списку заметок'))));
  const tags = data.tags || [];
  if (!tags.length) { view.append(emptyState('Тегов нет', 'Добавьте #тег в текст заметки или в её frontmatter.')); return; }
  const cloud = el('div', { class: 'tag-cloud tag-cloud-lg fade-in' });
  for (const t of tags) {
    cloud.append(el('a', { class: 'tag-chip', href: '/notes/tag/' + encodeURIComponent(t.tag), 'data-link': true },
      '#' + t.tag, el('span', { class: 'tag-count' }, String(t.count))));
  }
  view.append(cloud);
}

async function renderTagPage(view, tag) {
  const data = await api('/api/notes/tag/' + encodeURIComponent(tag));
  view.innerHTML = '';
  view.append(el('nav', { class: 'breadcrumbs', 'aria-label': 'Хлебные крошки' },
    el('a', { href: '/notes', 'data-link': true }, 'Заметки'),
    el('span', { class: 'sep' }, '/'),
    el('a', { href: '/notes/tags', 'data-link': true }, 'Теги'),
    el('span', { class: 'sep' }, '/'),
    el('span', {}, '#' + tag)));
  view.append(el('div', { class: 'page-head fade-in' }, el('h1', { class: 'page-title' }, '#' + tag)));
  const notes = data.notes || [];
  if (!notes.length) { view.append(emptyState('Нет заметок с этим тегом', 'Возможно, тег удалён из заметок.')); return; }
  const grid = el('div', { class: 'notes-grid fade-in' });
  for (const n of notes) grid.append(noteCard(n));
  view.append(grid);
}

// ——— Инициализация ———
loadTree().then(route).catch(e => {
  console.error(e);
  $('#view').innerHTML = '';
  $('#view').append(render404('Сервер недоступен'));
});
