// Читалка (раздел 5 ТЗ): PDF.js с прогрессивной загрузкой и Range-запросами,
// миниатюры, оглавление, поиск по тексту с подсветкой, зум/поворот, режимы
// «одна страница / прокрутка / разворот», темы день/сепия/ночь, запоминание
// страницы, hotkeys, индикатор прогресса чтения, мобильный тулбар.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

// Данные материала сервер кладёт в JSON-блок (CSP запрещает инлайн-скрипты)
const boot = (() => {
  try { return JSON.parse(document.getElementById('boot-data').textContent); }
  catch { return { error: 'not_found' }; }
})();
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// ——— Мини-аналитика (sendBeacon-батчи, как в app.js) ———
const queue = [];
function pushEvent(ev) {
  if (navigator.doNotTrack === '1') return;
  queue.push(ev);
  if (queue.length === 1) setTimeout(flush, 5000);
}
function flush() {
  if (!queue.length) return;
  const body = JSON.stringify({ events: queue.splice(0) });
  if (!navigator.sendBeacon?.('/api/events', new Blob([body], { type: 'application/json' }))) {
    fetch('/api/events', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
  }
}
window.addEventListener('pagehide', flush);

// ——— Служебное ———
function showError(title, text, showLink = true) {
  $('#loading')?.classList.add('hidden');
  const e = $('#error');
  e.classList.remove('hidden');
  const back = boot.slug
    ? `<a href="/m/${boot.slug}">← Вернуться к материалу</a>`
    : `<a href="/">← В каталог</a>`;
  e.innerHTML = `<h3>${title}</h3><p>${text}</p>` + (showLink ? `<p>${back}</p>` : '');
}
if (boot.error) {
  showError('Материал недоступен', 'Возможно, он скрыт или удалён.');
  document.title = 'Материал недоступен';
}

document.title = (boot.title || 'Читалка') + ' — Lab-Hub';
$('#tb-title').textContent = boot.title || '';
$('#tb-title').title = boot.title || '';
$('#btn-back').href = boot.slug ? `/m/${boot.slug}` : '/';
const dlBtn = $('#btn-download');
if (boot.downloadUrl) dlBtn.href = boot.downloadUrl;
else dlBtn.classList.add('hidden');
dlBtn.addEventListener('click', () => pushEvent({ type: 'download', material_id: boot.id }));

// ——— Неподдерживаемые в читалке типы: видео/изображения/embed ———
if (boot.kind === 'video' || boot.kind === 'image' || boot.embedUrl) {
  for (const id of ['#btn-sidebar', '.page-nav', '#btn-zoom-out', '#zoom-label', '#btn-zoom-in', '#btn-fit', '#btn-rotate', '.mode-switch', '#btn-search', '#theme-select', '#btn-print']) {
    $$(id).forEach(n => n.classList.add('hidden'));
    const n = $(id); if (n) n.classList.add('hidden');
  }
  $('#loading').classList.add('hidden');
  const stage = document.createElement('div');
  stage.className = 'video-stage';
  if (boot.embedUrl) {
    const f = document.createElement('iframe');
    f.src = boot.embedUrl; f.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture'; f.allowFullscreen = true; f.title = boot.title;
    stage.append(f);
  } else if (boot.kind === 'video') {
    const v = document.createElement('video');
    v.controls = true; v.playsInline = true; v.src = boot.streamUrl;
    const key = 'lh-pos-video-' + boot.id;
    v.addEventListener('loadedmetadata', () => {
      const s = parseFloat(localStorage.getItem(key) || '0');
      if (s > 1 && s < v.duration - 10) v.currentTime = s;
    });
    let seen = new Set();
    v.addEventListener('timeupdate', () => {
      localStorage.setItem(key, String(v.currentTime));
      if (v.duration) {
        const p = v.currentTime / v.duration * 100;
        for (const q of [25, 50, 75, 100]) if (p >= q && !seen.has(q)) { seen.add(q); pushEvent({ type: 'video_progress', material_id: boot.id, value: q }); }
      }
      const pr = v.duration ? (v.currentTime / v.duration * 100) : 0;
      $('#read-progress').style.width = pr + '%';
    });
    v.addEventListener('play', () => pushEvent({ type: 'reader_open', material_id: boot.id }), { once: true });
    stage.append(v);
  } else {
    const img = document.createElement('img');
    img.src = boot.streamUrl; img.alt = boot.title; img.style.maxWidth = '100%'; img.style.maxHeight = 'calc(100vh - 110px)';
    stage.append(img);
  }
  $('#pages').replaceWith(stage);
  pushEvent({ type: 'reader_open', material_id: boot.id });
}

// ——— PDF/DOCX-читалка ———
const isPdfLike = !boot.error && (boot.kind === 'pdf' || (boot.kind === 'docx' && boot.convert_status === 'ready'));

if (boot.kind === 'docx' && boot.convert_status !== 'ready' && !boot.error) {
  showError('Онлайн-просмотр DOCX недоступен',
    boot.convert_status === 'converting'
      ? 'Идёт конвертация в PDF — обновите страницу через минуту, либо скачайте оригинал.'
      : 'Конвертация не выполнена (серверу нужен LibreOffice). Скачайте оригинальный файл.');
}

if (isPdfLike) initPdf().catch(e => {
  console.error(e);
  showError('Не удалось открыть документ', String(e?.message || e) + '. Проверьте соединение — при восстановлении сети нажмите «Обновить».', true);
});

async function initPdf() {
  pushEvent({ type: 'reader_open', material_id: boot.id });
  const loadingTask = pdfjsLib.getDocument({
    url: boot.streamUrl,
    rangeChunkSize: 1024 * 512,          // прогрессивная загрузка чанками (Range)
    disableAutoFetch: false,
    isEvalSupported: false,
  });
  loadingTask.onProgress = p => {
    if (p.total) $('#load-progress-bar').style.width = Math.min(100, p.loaded / p.total * 100) + '%';
    $('#loading-text').textContent = `Загрузка… ${(p.loaded / 1048576).toFixed(1)} МБ`;
  };
  const pdf = await loadingTask.promise;
  $('#loading').classList.add('hidden');
  const N = pdf.numPages;
  $('#page-total').textContent = '/ ' + N;

  // ——— Состояние ———
  const posKey = 'lh-pos-pdf-' + boot.id;
  let startPage = parseInt(new URLSearchParams(location.search).get('page') || '0', 10) || parseInt(localStorage.getItem(posKey) || '1', 10);
  startPage = Math.min(Math.max(1, startPage), N);
  let mode = localStorage.getItem('lh-view-mode-' + boot.id) || 'scroll';
  let scale = null;        // null = авто (fit-width)
  let fitMode = 'width';   // width | page
  let rotation = 0;
  let currentPage = startPage;
  let maxSeenPage = startPage;
  const wraps = [];        // {div, canvas, textLayer, rendered, page}
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

  const pagesEl = $('#pages');
  const viewerEl = $('#viewer');

  // Тема чтения
  const savedTheme = localStorage.getItem('lh-read-theme') || (document.documentElement.dataset.theme === 'dark' ? 'night' : 'day');
  $('#theme-select').value = savedTheme;
  document.documentElement.dataset.readTheme = savedTheme;
  $('#theme-select').addEventListener('change', e => {
    document.documentElement.dataset.readTheme = e.target.value;
    localStorage.setItem('lh-read-theme', e.target.value);
  });

  // ——— Каркас страниц ———
  async function buildSkeleton() {
    pagesEl.innerHTML = '';
    wraps.length = 0;
    for (let i = 1; i <= N; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1, rotation });
      const wrap = document.createElement('div');
      wrap.className = 'page-wrap';
      wrap.dataset.page = i;
      const canvas = document.createElement('canvas');
      const textLayer = document.createElement('div');
      textLayer.className = 'text-layer';
      wrap.append(canvas, textLayer);
      pagesEl.append(wrap);
      wraps.push({ div: wrap, canvas, textLayer, rendered: false, renderTask: null, page, baseW: base.width, baseH: base.height, scale: 1 });
    }
    applyLayout(true);
  }

  function computeScale() {
    if (scale != null) return scale;
    const w0 = wraps[0];
    if (!w0) return 1;
    const availW = viewerEl.clientWidth - (mode === 'spread' ? 60 : 44);
    const availH = viewerEl.clientHeight - 40;
    const perPageW = mode === 'spread' ? availW / 2 : availW;
    const sW = perPageW / w0.baseW;
    const sH = availH / w0.baseH;
    return fitMode === 'width' ? sW : Math.min(sW, sH);
  }

  function applyLayout(scrollToPage = false) {
    const s = computeScale();
    pagesEl.classList.toggle('spread', mode === 'spread');
    for (const w of wraps) {
      w.scale = s;
      w.div.style.width = Math.floor(w.baseW * s) + 'px';
      w.div.style.height = Math.floor(w.baseH * s) + 'px';
      w.div.style.display = (mode === 'single' && +w.div.dataset.page !== currentPage) ? 'none' : '';
      if (mode === 'spread') {
        const odd = (+w.div.dataset.page - 1) >> 1;
        w.div.style.order = odd;
      }
    }
    $('#zoom-label').textContent = Math.round(s * 100) + '%';
    if (scrollToPage) goToPage(currentPage, true);
    else scheduleRender();
    buildThumbs();
  }

  // ——— Рендер (ленивое окно ±5, раздел 5) ———
  let renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => { renderScheduled = false; renderVisible(); });
  }

  function visibleRange() {
    if (mode === 'single') return [currentPage, currentPage];
    const vTop = viewerEl.scrollTop, vBot = vTop + viewerEl.clientHeight;
    let first = N, last = 1;
    for (const w of wraps) {
      const top = w.div.offsetTop, bot = top + w.div.offsetHeight;
      if (bot >= vTop - viewerEl.clientHeight * 2 && top <= vBot + viewerEl.clientHeight * 2) {
        first = Math.min(first, +w.div.dataset.page);
        last = Math.max(last, +w.div.dataset.page);
      }
    }
    if (first > last) return [currentPage, currentPage];
    return [Math.max(1, first - 5), Math.min(N, last + 5)];
  }

  let rendering = new Set();
  async function renderVisible() {
    const [a, b] = visibleRange();
    for (const w of wraps) {
      const p = +w.div.dataset.page;
      if (p < a || p > b) {
        // за пределами окна ±5 — освобождаем память слабых ноутбуков
        if (w.rendered && !rendering.has(p)) { w.rendered = false; const c = w.canvas.getContext('2d'); c?.clearRect(0, 0, w.canvas.width, w.canvas.height); w.canvas.width = w.canvas.height = 0; w.textLayer.innerHTML = ''; }
        continue;
      }
      if (w.rendered && Math.abs(w.renderedScale - w.scale) < 0.01 && w.renderedRot === rotation) continue;
      if (rendering.has(p)) continue;
      rendering.add(p);
      try { await renderPage(w); } catch (e) { console.warn('render fail', p, e); }
      rendering.delete(p);
    }
    updateThumbActive();
    updateOutlineActive?.();
  }

  async function renderPage(w) {
    const s = w.scale * dpr();
    const viewport = w.page.getViewport({ scale: s, rotation });
    w.canvas.width = Math.floor(viewport.width);
    w.canvas.height = Math.floor(viewport.height);
    w.canvas.style.width = Math.floor(w.baseW * w.scale) + 'px';
    w.canvas.style.height = Math.floor(w.baseH * w.scale) + 'px';
    w.renderTask?.cancel?.();
    const task = w.page.render({ canvasContext: w.canvas.getContext('2d'), viewport });
    w.renderTask = task;
    await task.promise;
    w.rendered = true; w.renderedScale = w.scale; w.renderedRot = rotation;
    // текстовый слой (выделение/копирование, поиск) — раздел 5
    w.textLayer.innerHTML = '';
    try {
      const cssViewport = w.page.getViewport({ scale: w.scale, rotation });
      w.textLayer.style.width = Math.floor(cssViewport.width) + 'px';
      w.textLayer.style.height = Math.floor(cssViewport.height) + 'px';
      await pdfjsLib.renderTextLayer({
        textContentSource: w.page.streamTextContent(),
        container: w.textLayer,
        viewport: cssViewport,
      }).promise;
    } catch (e) { /* текстовый слой не критичен */ }
    if (searchState.active && searchState.matches.some(m => m.page === +w.div.dataset.page)) drawHighlights(w);
  }

  // ——— Навигация по страницам ———
  function goToPage(p, instant = false) {
    p = Math.min(Math.max(1, p), N);
    currentPage = p;
    $('#page-input').value = p;
    maxSeenPage = Math.max(maxSeenPage, p);
    localStorage.setItem(posKey, String(p));
    pushEvent({ type: 'page_change', material_id: boot.id, value: p });
    if (mode === 'single') {
      for (const w of wraps) w.div.style.display = +w.div.dataset.page === p ? '' : 'none';
      scheduleRender();
      updateThumbActive();
      $('#read-progress').style.width = (p / N * 100) + '%';
      return;
    }
    const w = wraps[p - 1];
    if (w) {
      const top = w.div.offsetTop - 10;
      viewerEl.scrollTo({ top, behavior: instant ? 'auto' : 'smooth' });
    }
  }
  $('#page-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { goToPage(parseInt(e.target.value, 10) || 1); e.target.blur(); }
  });
  $('#page-input').addEventListener('blur', e => { e.target.value = currentPage; });

  // текущая страница по скроллу + прогресс чтения
  viewerEl.addEventListener('scroll', () => {
    if (mode === 'single') return;
    const mid = viewerEl.scrollTop + viewerEl.clientHeight * 0.35;
    for (const w of wraps) {
      if (w.div.offsetTop <= mid && w.div.offsetTop + w.div.offsetHeight > mid) {
        const p = +w.div.dataset.page;
        if (p !== currentPage) {
          currentPage = p;
          $('#page-input').value = p;
          maxSeenPage = Math.max(maxSeenPage, p);
          localStorage.setItem(posKey, String(p));
          pushEvent({ type: 'page_change', material_id: boot.id, value: p });
          updateThumbActive();
        }
        break;
      }
    }
    const max = viewerEl.scrollHeight - viewerEl.clientHeight;
    $('#read-progress').style.width = (max > 0 ? Math.min(100, viewerEl.scrollTop / max * 100) : 100) + '%';
    scheduleRender();
    // мобильные: скрываем тулбар при прокрутке вниз
    if (window.innerWidth <= 860) {
      const down = viewerEl.scrollTop > (viewerEl._lastTop || 0) + 4 && viewerEl.scrollTop > 80;
      document.body.classList.toggle('fs-hidden', down);
      viewerEl._lastTop = viewerEl.scrollTop;
    }
  }, { passive: true });

  // ——— Зум/поворот/вписать ———
  function zoom(factor) {
    const cur = computeScale();
    scale = Math.min(5, Math.max(0.25, (scale ?? cur) * factor));
    fitMode = 'width';
    applyLayout();
  }
  $('#btn-zoom-in').addEventListener('click', () => zoom(1.2));
  $('#btn-zoom-out').addEventListener('click', () => zoom(1 / 1.2));
  $('#btn-fit').addEventListener('click', () => {
    scale = null;
    fitMode = fitMode === 'width' ? 'page' : 'width';
    $('#btn-fit').title = fitMode === 'width' ? 'Сейчас: по ширине (клик — по странице)' : 'Сейчас: по странице (клик — по ширине)';
    applyLayout(true);
  });
  $('#btn-rotate').addEventListener('click', () => { rotation = (rotation + 90) % 360; applyLayout(true); });

  // ——— Режимы ———
  function setMode(m) {
    mode = m;
    localStorage.setItem('lh-view-mode-' + boot.id, m);
    $('#mode-single').classList.toggle('active', m === 'single');
    $('#mode-scroll').classList.toggle('active', m === 'scroll');
    $('#mode-spread').classList.toggle('active', m === 'spread');
    applyLayout(true);
  }
  $('#mode-single').addEventListener('click', () => setMode('single'));
  $('#mode-scroll').addEventListener('click', () => setMode('scroll'));
  $('#mode-spread').addEventListener('click', () => setMode('spread'));

  // ——— Миниатюры (ленивые) ———
  const thumbsEl = $('#thumbs');
  let thumbsBuilt = false, thumbActive = null;
  function buildThumbs() {
    if (thumbsBuilt || $('#sidebar').classList.contains('hidden')) return;
    thumbsBuilt = true;
    thumbsEl.innerHTML = '';
    for (let i = 1; i <= N; i++) {
      const t = document.createElement('div');
      t.className = 'thumb'; t.dataset.page = i;
      t.style.width = '100%';
      const num = document.createElement('span'); num.className = 'thumb-num'; num.textContent = i;
      t.append(num);
      t.addEventListener('click', () => goToPage(i));
      thumbsEl.append(t);
    }
    (async () => {
      for (let i = 1; i <= N; i++) {
        try {
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: 0.28, rotation });
          const c = document.createElement('canvas');
          c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
          await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
          const t = thumbsEl.children[i - 1];
          t?.prepend(c);
        } catch { /* пропуск */ }
      }
    })();
    updateThumbActive();
  }
  function updateThumbActive() {
    const t = thumbsEl.querySelector(`.thumb[data-page="${currentPage}"]`);
    if (t === thumbActive) return;
    thumbActive?.classList.remove('active');
    t?.classList.add('active');
    thumbActive = t;
    t?.scrollIntoView({ block: 'nearest' });
  }

  // ——— Оглавление (bookmarks PDF) ———
  const outlineEl = $('#outline');
  async function buildOutline() {
    const outline = await pdf.getOutline();
    if (!outline?.length) {
      outlineEl.innerHTML = '<p style="padding:12px;color:var(--text-3);font-size:13px">В этом PDF нет оглавления (закладок).</p>';
      return;
    }
    outlineEl.innerHTML = '';
    const walk = async (items, level) => {
      for (const it of items) {
        let page = null;
        try {
          if (it.dest) {
            const dest = typeof it.dest === 'string' ? await pdf.getDestination(it.dest) : it.dest;
            if (dest?.[0]) page = (await pdf.getPageIndex(dest[0])) + 1;
          }
        } catch { /* ignore */ }
        const a = document.createElement('a');
        a.href = '#'; a.textContent = it.title; a.className = 'lvl-' + Math.min(3, level + 1);
        a.addEventListener('click', e => { e.preventDefault(); if (page) goToPage(page); });
        outlineEl.append(a);
        if (it.items?.length) await walk(it.items, level + 1);
      }
    };
    await walk(outline, 0);
  }
  function updateOutlineActive() { /* активный пункт оглавления — Phase 2 */ }

  // ——— Сайдбар ———
  $('#btn-sidebar').addEventListener('click', () => {
    const sb = $('#sidebar');
    sb.classList.toggle('hidden');
    $('#btn-sidebar').classList.toggle('active', !sb.classList.contains('hidden'));
    if (!sb.classList.contains('hidden')) { buildThumbs(); buildOutline(); applyLayout(true); }
    else applyLayout(true);
  });
  $('#tab-thumbs').addEventListener('click', () => { $('#thumbs').classList.remove('hidden'); $('#outline').classList.add('hidden'); $('#tab-thumbs').classList.add('active'); $('#tab-outline').classList.remove('active'); });
  $('#tab-outline').addEventListener('click', () => { $('#outline').classList.remove('hidden'); $('#thumbs').classList.add('hidden'); $('#tab-outline').classList.add('active'); $('#tab-thumbs').classList.remove('active'); buildOutline(); });

  // ——— Поиск по тексту (раздел 5: «найден 3 из 17») ———
  const searchState = { active: false, matches: [], idx: -1, pageTexts: new Map() };
  $('#btn-search').addEventListener('click', () => toggleSearch());
  function toggleSearch(open = true) {
    const bar = $('#search-bar');
    bar.classList.toggle('hidden', !open);
    if (open) { $('#search-input').focus(); $('#search-input').select(); }
    else { clearHighlights(); $('#search-count').textContent = ''; }
    searchState.active = open;
  }
  let searchTimer = null;
  $('#search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 350);
  });
  $('#search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.shiftKey ? stepMatch(-1) : stepMatch(1); }
    if (e.key === 'Escape') toggleSearch(false);
  });
  $('#search-next').addEventListener('click', () => stepMatch(1));
  $('#search-prev').addEventListener('click', () => stepMatch(-1));
  $('#search-close').addEventListener('click', () => toggleSearch(false));

  async function runSearch() {
    const q = $('#search-input').value.trim().toLowerCase();
    clearHighlights();
    searchState.matches = [];
    searchState.idx = -1;
    if (q.length < 2) { $('#search-count').textContent = ''; return; }
    $('#search-count').textContent = 'Ищем…';
    // лениво: тексты страниц подгружаются по ходу поиска
    for (let p = 1; p <= N; p++) {
      let items = searchState.pageTexts.get(p);
      if (!items) {
        try {
          const page = await pdf.getPage(p);
          const tc = await page.getTextContent();
          items = tc.items.filter(it => it.str);
          searchState.pageTexts.set(p, items);
        } catch { items = []; searchState.pageTexts.set(p, items); }
      }
      for (let ii = 0; ii < items.length; ii++) {
        if (items[ii].str.toLowerCase().includes(q)) searchState.matches.push({ page: p, item: ii });
      }
    }
    if (!searchState.matches.length) { $('#search-count').textContent = 'Нет совпадений'; return; }
    searchState.idx = 0;
    jumpToMatch();
  }
  function stepMatch(d) {
    if (!searchState.matches.length) return;
    searchState.idx = (searchState.idx + d + searchState.matches.length) % searchState.matches.length;
    jumpToMatch();
  }
  function jumpToMatch() {
    const m = searchState.matches[searchState.idx];
    if (!m) return;
    $('#search-count').textContent = `найден ${searchState.idx + 1} из ${searchState.matches.length}`;
    if (m.page !== currentPage) goToPage(m.page);
    setTimeout(() => {
      const w = wraps[m.page - 1];
      if (w) { drawHighlights(w, m); }
    }, 350);
  }
  function clearHighlights() { $$('.search-highlight').forEach(n => n.remove()); }
  async function drawHighlights(w, currentMatch = null) {
    const q = $('#search-input').value.trim().toLowerCase();
    if (!q) return;
    const p = +w.div.dataset.page;
    const items = searchState.pageTexts.get(p) || [];
    const s = w.scale;
    const page = w.page;
    const viewport = page.getViewport({ scale: s, rotation });
    w.textLayer.querySelectorAll('.search-highlight').forEach(n => n.remove());
    for (let ii = 0; ii < items.length; ii++) {
      const it = items[ii];
      if (!it.str || !it.str.toLowerCase().includes(q)) continue;
      try {
        const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
        const fontHeight = Math.hypot(tx[2], tx[3]) || 12 * s;
        const left = tx[4], top = tx[5] - fontHeight;
        const width = (it.width || 0) * s * (it.str.length ? 1 : 1);
        const h = document.createElement('div');
        h.className = 'search-highlight' + (currentMatch && currentMatch.page === p && currentMatch.item === ii ? ' current' : '');
        h.style.left = left + 'px'; h.style.top = top + 'px';
        h.style.width = Math.max(8, width) + 'px'; h.style.height = fontHeight + 'px';
        w.textLayer.append(h);
      } catch { /* skip item */ }
    }
  }

  // ——— Печать (через нативный PDF-рендер браузера) ———
  $('#btn-print').addEventListener('click', () => {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    f.src = boot.streamUrl;
    document.body.append(f);
    f.onload = () => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch { window.open(boot.streamUrl, '_blank'); } setTimeout(() => f.remove(), 60_000); };
  });

  // ——— Полный экран ———
  $('#btn-fullscreen').addEventListener('click', toggleFs);
  function toggleFs() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.();
  }

  // ——— Горячие клавиши (раздел 5) ———
  document.addEventListener('keydown', e => {
    const inInput = /input|textarea|select/i.test(document.activeElement?.tagName || '');
    if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); toggleSearch(true); return; }
    if (inInput) return;
    switch (e.key) {
      case 'ArrowRight': case 'PageDown': case ' ': e.preventDefault(); goToPage(currentPage + 1); break;
      case 'ArrowLeft': case 'PageUp': e.preventDefault(); goToPage(currentPage - 1); break;
      case 'Home': e.preventDefault(); goToPage(1); break;
      case 'End': e.preventDefault(); goToPage(N); break;
      case '+': case '=': zoom(1.2); break;
      case '-': zoom(1 / 1.2); break;
      case 'f': case 'F': case 'а': case 'А': toggleFs(); break;
      case 'Escape': toggleSearch(false); break;
    }
  });

  // ——— Свайпы между страницами на мобильных ———
  let touchX = null;
  viewerEl.addEventListener('touchstart', e => { if (e.touches.length === 1) touchX = e.touches[0].clientX; }, { passive: true });
  viewerEl.addEventListener('touchend', e => {
    if (touchX == null || mode !== 'single') { touchX = null; return; }
    const dx = (e.changedTouches[0].clientX - touchX);
    if (Math.abs(dx) > 70) goToPage(currentPage + (dx < 0 ? 1 : -1));
    touchX = null;
  }, { passive: true });

  // ——— Восстановление после потери связи ———
  window.addEventListener('offline', () => { $('#loading-text') && ($('#loading-text').textContent = 'Нет соединения — ждём сеть…'); });
  window.addEventListener('online', () => { scheduleRender(); });

  // ——— Старт ———
  await buildSkeleton();
  setMode(mode);
  goToPage(startPage, true);
  window.addEventListener('resize', () => { if (scale == null) applyLayout(); });
  // периодический «прогресс чтения» для средней статистики
  setInterval(flush, 30_000);
}
