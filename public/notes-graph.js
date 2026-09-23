// Граф связей заметок: силовой layout на canvas (вид «графа» как в Obsidian).
//
// Модуль намеренно разделён на две половины:
//   simulateStep() — чистая физика без DOM, её гоняет test/graph.test.js в Node;
//   createGraph()  — отрисовка и взаимодействие (pan/zoom/hover/click).
// Зависимостей нет, CSP-безопасно: только canvas 2D, никаких инлайновых обработчиков и innerHTML.

const DEFAULTS = {
  theme: 'dark',
  labels: true,
  linkDistance: 90,     // просторнее, как в Obsidian: подписи не налезают друг на друга
  charge: -300,
  centerForce: 0.002,
  damping: 0.85,
  nodeSize: 1,          // множитель радиуса узлов
  labelSize: 9,         // размер шрифта подписей, px
  labelOpacity: 0.7,    // прозрачность подписей 0.05..1
  warnAt: 600,
  onOpen: null,
  onHover: null,
  onWarn: null,
};

const PALETTE = {
  dark: { bg: '#14141a', edge: '#33334a', edgeHot: '#7b7bd6', node: '#8b8bf0', dim: '#3a3a4a', text: '#e9e9f2', halo: 'rgba(20,20,26,0.82)', ring: '#c8c8ff' },
  light: { bg: '#ffffff', edge: '#d5d5e2', edgeHot: '#5b5bd6', node: '#5b5bd6', dim: '#c5c5d5', text: '#23232c', halo: 'rgba(255,255,255,0.86)', ring: '#2f2fa0' },
};

export function graphPalette(theme) { return PALETTE[theme] || PALETTE.dark; }

/**
 * Один шаг симуляции. Мутирует state на месте, возвращает новый alpha.
 * state = { nodes: [{x, y, vx, vy, path, fixed?}], edges: [{source, target}], alpha, width, height }
 * Никакого DOM — вызывается и в браузере, и в Node-тестах.
 */
export function simulateStep(state, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const nodes = state.nodes || [];
  const n = nodes.length;
  if (!n) { state.alpha = 0; return 0; }
  if (!Number.isFinite(state.alpha)) state.alpha = 1;

  const width = state.width || 800;
  const height = state.height || 600;
  const alpha = Math.max(state.alpha, 0);

  // 1. Расталкивание всех пар. Обрезаем дистанцию снизу, чтобы сила не уходила в бесконечность
  //    при почти совпавших узлах (иначе получаем NaN и «молнии» на экране).
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        // совпавшие узлы расталкиваем детерминированно, чтобы layout был воспроизводим
        dx = ((i % 7) - 3) * 0.5 + 0.1;
        dy = ((j % 7) - 3) * 0.5 + 0.1;
        d2 = dx * dx + dy * dy || 0.01;
      }
      const d = Math.sqrt(d2);
      const dd = Math.min(d, 500);              // дальше 500 px не считаем — экономим и стабилизируем
      const force = o.charge / (dd * dd);
      const fx = (dx / d) * force;
      const fy = (dy / d) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
  }

  // 2. Пружины вдоль рёбер
  const index = new Map();
  for (let i = 0; i < n; i++) index.set(nodes[i].path, i);
  for (const e of state.edges || []) {
    const i = index.get(e.source);
    const j = index.get(e.target);
    if (i === undefined || j === undefined || i === j) continue;   // самопетли и «висячие» рёбра
    const a = nodes[i];
    const b = nodes[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d - o.linkDistance) * 0.05;
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    a.vx += fx; a.vy += fy;
    b.vx -= fx; b.vy -= fy;
  }

  // 3. Притяжение к центру + затухание + интегрирование
  const cx = width / 2;
  const cy = height / 2;
  const centerForce = o.centerForce ?? 0.002;
  const damping = o.damping ?? 0.85;
  for (const nd of nodes) {
    if (nd.fixed) { nd.vx = 0; nd.vy = 0; continue; }
    nd.vx += (cx - nd.x) * centerForce;
    nd.vy += (cy - nd.y) * centerForce;
    nd.vx *= damping;
    nd.vy *= damping;
    if (!Number.isFinite(nd.x)) nd.x = cx;
    if (!Number.isFinite(nd.y)) nd.y = cy;
    if (!Number.isFinite(nd.vx)) nd.vx = 0;
    if (!Number.isFinite(nd.vy)) nd.vy = 0;
    nd.x += nd.vx * alpha;
    nd.y += nd.vy * alpha;
  }

  state.alpha = alpha * 0.985;
  if (state.alpha < 0.004) state.alpha = 0;
  return state.alpha;
}

function radiusOf(degree) {
  return 4 + Math.min(9, Math.log2((degree || 0) + 1) * 2.4);
}

/** Создаёт контроллер графа поверх переданного <canvas>. */
export function createGraph(canvas, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  let ctx = null;
  try { ctx = canvas.getContext('2d'); } catch { ctx = null; }

  const state = { nodes: [], edges: [], alpha: 0, width: 1, height: 1 };
  let view = { scale: 1, x: 0, y: 0 };
  let hovered = null;
  let selected = null;
  let dragging = null;      // узел
  let panning = null;
  let downAt = null;
  let raf = null;
  let destroyed = false;
  let warned = false;
  let needsDraw = true;
  const listeners = [];

  const palette = () => graphPalette(o.theme);

  function on(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    listeners.push(() => target.removeEventListener(type, fn, options));
  }

  // ——— Система координат: экран ↔ «мир» графа ———
  const toWorld = (sx, sy) => ({ x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale });

  function measure() {
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 0, height: 0 };
    const w = Math.max(1, Math.round(canvas.clientWidth || rect.width || 1));
    const h = Math.max(1, Math.round(canvas.clientHeight || rect.height || 1));
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) ? Math.min(devicePixelRatio, 3) : 1;
    state.width = w;
    state.height = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (ctx && ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    needsDraw = true;
  }

  function seedPositions() {
    // Новым узлам выдаём позиции по спирали Фибоначчи вокруг центра, уже известным — не трогаем,
    // иначе граф «дёргается» при каждом обновлении данных.
    const n = state.nodes.length;
    state.nodes.forEach((nd, i) => {
      if (Number.isFinite(nd.x) && Number.isFinite(nd.y)) return;
      const g = (i + 1) * 2.399963;                 // золотой угол
      const r = 12 * Math.sqrt(i + 1);
      nd.x = state.width / 2 + r * Math.cos(g);
      nd.y = state.height / 2 + r * Math.sin(g);
      nd.vx = 0;
      nd.vy = 0;
    });
  }

  function kick(alpha = 0.9) {
    state.alpha = Math.max(state.alpha, alpha);
    needsDraw = true;
    startLoop();
  }

  // ——— Отрисовка ———
  function draw() {
    if (!ctx) return;
    const p = palette();
    const { width, height } = state;

    ctx.save();
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, width, height);

    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);

    const neighbours = neighbourhood();

    // Рёбра
    const byPath = new Map(state.nodes.map(n => [n.path, n]));
    ctx.lineWidth = 1 / view.scale;
    for (const e of state.edges) {
      const a = byPath.get(e.source);
      const b = byPath.get(e.target);
      if (!a || !b) continue;
      const hot = hovered && (e.source === hovered || e.target === hovered);
      const cold = hovered && !hot;
      ctx.strokeStyle = hot ? p.edgeHot : p.edge;
      ctx.globalAlpha = hot ? 0.95 : (cold ? 0.12 : 0.5);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Узлы
    const sizeK = Number.isFinite(o.nodeSize) && o.nodeSize > 0 ? o.nodeSize : 1;
    for (const nd of state.nodes) {
      const r = radiusOf(nd.degree) * sizeK;
      const isHover = hovered === nd.path;
      const isSel = selected === nd.path;
      const isNeighbour = neighbours.has(nd.path);
      const faded = hovered && !isHover && !isNeighbour;

      ctx.globalAlpha = faded ? 0.22 : 1;
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
      ctx.fillStyle = nd.missing ? p.dim : (isHover || isSel ? p.node : p.node);
      ctx.fill();

      if (nd.missing) {
        // «Битые» ссылки (заметки ещё нет) — пунктиром, как неразрешённые ссылки в Obsidian
        ctx.setLineDash([3 / view.scale, 2 / view.scale]);
        ctx.strokeStyle = p.dim;
        ctx.lineWidth = 1.2 / view.scale;
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (isSel) {
        ctx.strokeStyle = p.ring;
        ctx.lineWidth = 2 / view.scale;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // Подписи: аккуратные «пилюли» с настраиваемым размером и прозрачностью
    if (o.labels) {
      const fs = Number.isFinite(o.labelSize) && o.labelSize > 0 ? o.labelSize : 11;
      const lAlpha = Math.min(1, Math.max(0.05, Number.isFinite(o.labelOpacity) ? o.labelOpacity : 1));
      ctx.font = `500 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.textBaseline = 'middle';
      const padX = fs * 0.42, padY = fs * 0.32;
      const rad = fs * 0.55;
      for (const nd of state.nodes) {
        const isHover = hovered === nd.path;
        const isSel = selected === nd.path;
        const isNeighbour = neighbours.has(nd.path);
        const important = (nd.degree || 0) >= 3;
        const zoomedIn = view.scale > 1.6;
        if (!isHover && !isNeighbour && !zoomedIn && !(important && view.scale > 0.8)) continue;
        const r = radiusOf(nd.degree) * sizeK;
        const label = String(nd.title || nd.path || '');
        const text = label.length > 28 ? label.slice(0, 27) + '…' : label;
        const x = nd.x + r + fs * 0.45;
        const y = nd.y;
        const dimmed = hovered && !isHover && !isNeighbour;
        ctx.globalAlpha = lAlpha * (dimmed ? 0.25 : 1);
        const w = ctx.measureText(text).width;
        const bx = x - padX, by = y - fs / 2 - padY, bw = w + padX * 2, bh = fs + padY * 2;
        // Подложка-пилюля: скруглённая, слегка прозрачная
        ctx.fillStyle = p.halo;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(bx, by, bw, bh, rad);
        } else {
          ctx.rect(bx, by, bw, bh);
        }
        ctx.fill();
        // Тонкая обводка — текст читается даже на плотном графе
        if (isHover || isSel) {
          ctx.strokeStyle = p.edgeHot;
          ctx.lineWidth = 1 / view.scale;
          ctx.stroke();
        }
        ctx.fillStyle = nd.missing ? p.dim : p.text;
        ctx.fillText(text, x, y + fs * 0.06);
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  function neighbourhood() {
    const set = new Set();
    if (!hovered) return set;
    set.add(hovered);
    for (const e of state.edges) {
      if (e.source === hovered) set.add(e.target);
      if (e.target === hovered) set.add(e.source);
    }
    return set;
  }

  function startLoop() {
    if (raf !== null || destroyed) return;
    const step = () => {
      raf = null;
      if (destroyed) return;
      let active = false;
      if (state.alpha > 0) {
        for (let k = 0; k < 2; k++) simulateStep(state, o);
        active = true;
      }
      if (active || needsDraw) {
        needsDraw = false;
        draw();
      }
      if (state.alpha > 0 || needsDraw) startLoop();   // ждём, пока layout успокоится
    };
    // requestAnimationFrame есть только в браузере; в Node модуль просто ничего не рисует
    if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(step);
    else { step(); raf = null; }
  }

  function hitTest(sx, sy) {
    const w = toWorld(sx, sy);
    const sizeK = Number.isFinite(o.nodeSize) && o.nodeSize > 0 ? o.nodeSize : 1;
    let best = null;
    let bestD = Infinity;
    for (const nd of state.nodes) {
      const dx = nd.x - w.x;
      const dy = nd.y - w.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const r = radiusOf(nd.degree) * sizeK + 6 / view.scale;
      if (d <= r && d < bestD) { bestD = d; best = nd; }
    }
    return best;
  }

  function clientPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ——— Взаимодействие ———
  on(canvas, 'wheel', e => {
    e.preventDefault();
    const { x, y } = clientPos(e);
    const before = toWorld(x, y);
    const factor = Math.exp(-e.deltaY * 0.0015);
    view.scale = Math.min(6, Math.max(0.15, view.scale * factor));
    const after = toWorld(x, y);
    view.x += (after.x - before.x) * view.scale;
    view.y += (after.y - before.y) * view.scale;
    needsDraw = true;
    startLoop();
  }, { passive: false });

  on(canvas, 'mousedown', e => {
    const { x, y } = clientPos(e);
    const node = hitTest(x, y);
    downAt = { x, y };
    if (node) {
      dragging = node;
      node.fixed = true;
      selected = node.path;
    } else {
      panning = { x, y, vx: view.x, vy: view.y };
    }
    needsDraw = true;
    startLoop();
  });

  on(canvas, 'mousemove', e => {
    const { x, y } = clientPos(e);
    if (dragging) {
      const w = toWorld(x, y);
      dragging.x = w.x;
      dragging.y = w.y;
      dragging.vx = 0;
      dragging.vy = 0;
      state.alpha = Math.max(state.alpha, 0.3);
      needsDraw = true;
      startLoop();
      return;
    }
    if (panning) {
      view.x = panning.vx + (x - panning.x);
      view.y = panning.vy + (y - panning.y);
      needsDraw = true;
      startLoop();
      return;
    }
    const node = hitTest(x, y);
    const path = node ? node.path : null;
    if (path !== hovered) {
      hovered = path;
      if (o.onHover) { try { o.onHover(path); } catch { /* ignore */ } }
      needsDraw = true;
      startLoop();
    }
  });

  const endDrag = e => {
    if (dragging) {
      dragging.fixed = false;
      dragging = null;
      kick(0.4);
    }
    if (panning) panning = null;
    // клик = нажатие и отпускание почти без движения
    if (e && downAt) {
      const { x, y } = clientPos(e);
      const moved = Math.hypot(x - downAt.x, y - downAt.y);
      if (moved < 5) {
        const node = hitTest(x, y);
        if (node && o.onOpen && !node.missing) { try { o.onOpen(node.path); } catch { /* ignore */ } }
      }
    }
    downAt = null;
  };
  on(canvas, 'mouseup', endDrag);
  on(canvas, 'mouseleave', () => {
    endDrag(null);
    if (hovered) { hovered = null; needsDraw = true; startLoop(); }
  });

  // Двойной клик по фону — вписать граф целиком
  on(canvas, 'dblclick', e => {
    const { x, y } = clientPos(e);
    if (!hitTest(x, y)) fit();
  });

  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => { measure(); kick(0.15); });
    ro.observe(canvas);
    listeners.push(() => ro.disconnect());
  } else if (typeof window !== 'undefined') {
    const onResize = () => { measure(); kick(0.15); };
    window.addEventListener('resize', onResize);
    listeners.push(() => window.removeEventListener('resize', onResize));
  }

  function fit() {
    const nodes = state.nodes;
    if (!nodes.length) { view = { scale: 1, x: 0, y: 0 }; needsDraw = true; startLoop(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const nd of nodes) {
      minX = Math.min(minX, nd.x); maxX = Math.max(maxX, nd.x);
      minY = Math.min(minY, nd.y); maxY = Math.max(maxY, nd.y);
    }
    const pad = 60;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const scale = Math.min(3, Math.max(0.15, Math.min((state.width - pad * 2) / w, (state.height - pad * 2) / h)));
    view.scale = scale;
    view.x = state.width / 2 - ((minX + maxX) / 2) * scale;
    view.y = state.height / 2 - ((minY + maxY) / 2) * scale;
    needsDraw = true;
    startLoop();
  }

  const controller = {
    setData({ nodes = [], edges = [] } = {}) {
      const prev = new Map(state.nodes.map(n => [n.path, n]));
      state.nodes = nodes.map(n => {
        const old = prev.get(n.path);
        return {
          ...n,
          x: old ? old.x : NaN,
          y: old ? old.y : NaN,
          vx: 0,
          vy: 0,
        };
      });
      state.edges = edges;
      if (nodes.length > o.warnAt && !warned) {
        warned = true;
        if (o.onWarn) { try { o.onWarn(`Граф большой: ${nodes.length} заметок — подписи скрыты, layout упрощён.`); } catch { /* ignore */ } }
      }
      measure();
      seedPositions();
      kick(1);
      return controller;
    },
    /** Подсветить и приблизить конкретную заметку. */
    focus(path) {
      const nd = state.nodes.find(n => n.path === path);
      selected = path;
      if (nd && Number.isFinite(nd.x)) {
        view.scale = Math.max(view.scale, 1.2);
        view.x = state.width / 2 - nd.x * view.scale;
        view.y = state.height / 2 - nd.y * view.scale;
      }
      hovered = path;
      needsDraw = true;
      startLoop();
      return controller;
    },
    setLabels(flag) { o.labels = !!flag; needsDraw = true; startLoop(); return controller; },
    setTheme(theme) { o.theme = theme; needsDraw = true; startLoop(); return controller; },
    updatePhysics(params = {}) {
      if ('linkDistance' in params) o.linkDistance = params.linkDistance;
      if ('charge' in params) o.charge = params.charge;
      if ('centerForce' in params) o.centerForce = params.centerForce;
      if ('damping' in params) o.damping = params.damping;
      kick(0.6);
      return controller;
    },
    /** Визуальные параметры (размер узлов/подписей, прозрачность) — без перезапуска физики. */
    updateVisual(params = {}) {
      if ('nodeSize' in params) o.nodeSize = Math.min(3, Math.max(0.3, +params.nodeSize || 1));
      if ('labelSize' in params) o.labelSize = Math.min(24, Math.max(7, +params.labelSize || 11));
      if ('labelOpacity' in params) o.labelOpacity = Math.min(1, Math.max(0.05, +params.labelOpacity || 1));
      needsDraw = true;
      startLoop();
      return controller;
    },
    /** Ручной запуск перерисовки (например, после смены темы извне). */
    refresh() { needsDraw = true; startLoop(); return controller; },
    fit() { fit(); return controller; },
    resize() { measure(); kick(0.2); return controller; },
    getData() { return { nodes: state.nodes, edges: state.edges, alpha: state.alpha }; },
    destroy() {
      destroyed = true;
      if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = null;
      for (const off of listeners) { try { off(); } catch { /* ignore */ } }
      listeners.length = 0;
    },
  };

  measure();
  return controller;
}