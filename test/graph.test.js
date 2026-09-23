// Тесты физики графа (public/notes-graph.js).
// Запуск: node test/graph.test.js
// Проверяем именно simulateStep — чистую часть без DOM (саму отрисовку в Node не проверить).
import assert from 'node:assert/strict';
import { createGraph, simulateStep, graphPalette } from '../public/notes-graph.js';

let passed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}: ${e.message}`); }
}

function makeState(nodes, edges, alpha = 1) {
  return {
    nodes: nodes.map(n => ({ fixed: false, vx: 0, vy: 0, ...n })),
    edges,
    alpha,
    width: 800,
    height: 600,
  };
}

const finite = (state, label) => {
  for (const n of state.nodes) {
    assert.ok(Number.isFinite(n.x), `${label}: x не число (${n.path})`);
    assert.ok(Number.isFinite(n.y), `${label}: y не число (${n.path})`);
    assert.ok(Number.isFinite(n.vx), `${label}: vx не число (${n.path})`);
    assert.ok(Number.isFinite(n.vy), `${label}: vy не число (${n.path})`);
  }
};

const kinetic = state => state.nodes.reduce((s, n) => s + n.vx * n.vx + n.vy * n.vy, 0);

test('пустой граф: не бросает, alpha обнуляется', () => {
  const st = makeState([], []);
  const a = simulateStep(st);
  assert.equal(a, 0);
  assert.equal(st.alpha, 0);
});

test('один изолированный узел остаётся конечным и не улетает', () => {
  const st = makeState([{ path: 'a', x: 400, y: 300, degree: 0 }], []);
  for (let i = 0; i < 500; i++) simulateStep(st);
  finite(st, 'изолированный');
  assert.ok(Math.abs(st.nodes[0].x) < 5000 && Math.abs(st.nodes[0].y) < 5000);
  // притяжение к центру должно его удержать около середины
  assert.ok(Math.hypot(st.nodes[0].x - 400, st.nodes[0].y - 300) < 200);
});

test('самопетли не ломают расчёт', () => {
  const st = makeState([{ path: 'a', x: 100, y: 100, degree: 1 }, { path: 'b', x: 200, y: 200, degree: 1 }],
    [{ source: 'a', target: 'a' }]);
  for (let i = 0; i < 100; i++) simulateStep(st);
  finite(st, 'самопетля');
});

test('дублирующиеся рёбра не взрывают layout', () => {
  const st = makeState([{ path: 'a', x: 10, y: 10 }, { path: 'b', x: 700, y: 500 }],
    [{ source: 'a', target: 'b' }, { source: 'a', target: 'b' }, { source: 'b', target: 'a' }]);
  for (let i = 0; i < 200; i++) simulateStep(st);
  finite(st, 'дубли');
});

test('рёбра на несуществующие узлы игнорируются', () => {
  const st = makeState([{ path: 'a', x: 100, y: 100 }, { path: 'b', x: 300, y: 300 }],
    [{ source: 'a', target: 'призрак' }, { source: 'нет', target: 'b' }]);
  for (let i = 0; i < 100; i++) simulateStep(st);
  finite(st, 'висячие рёбра');
});

test('совпавшие позиции не дают NaN', () => {
  const st = makeState([{ path: 'a', x: 100, y: 100 }, { path: 'b', x: 100, y: 100 }, { path: 'c', x: 100, y: 100 }], []);
  for (let i = 0; i < 300; i++) simulateStep(st);
  finite(st, 'совпавшие');
  // и должны разъехаться
  const d = Math.hypot(st.nodes[0].x - st.nodes[1].x, st.nodes[0].y - st.nodes[1].y);
  assert.ok(d > 1, `узлы не разъехались: ${d}`);
});

test('500 шагов: ни одной NaN/Infinity', () => {
  const nodes = Array.from({ length: 25 }, (_, i) => ({ path: `n${i}`, x: NaN, y: NaN, degree: i % 4 }));
  // NaN-координаты — как у только что добавленных узлов
  for (const n of nodes) { n.x = 400; n.y = 300; }
  const edges = [];
  for (let i = 0; i < 24; i++) edges.push({ source: `n${i}`, target: `n${i + 1}` });
  const st = makeState(nodes, edges);
  for (let i = 0; i < 500; i++) simulateStep(st);
  finite(st, '500 шагов');
});

test('layout сходится: кинетическая энергия падает', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ path: `n${i}`, x: 400 + i * 7, y: 300 - i * 5 }));
  const edges = Array.from({ length: 11 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}` }));
  const st = makeState(nodes, edges);
  for (let i = 0; i < 5; i++) simulateStep(st);
  const early = kinetic(st);
  for (let i = 5; i < 400; i++) simulateStep(st);
  const late = kinetic(st);
  assert.ok(late < early, `энергия не упала: ранняя ${early.toFixed(3)} → поздняя ${late.toFixed(3)}`);
  assert.ok(st.alpha < 0.01, `alpha должна остыть, а она ${st.alpha}`);
});

test('alpha остывает до нуля и симуляция останавливается', () => {
  const st = makeState([{ path: 'a', x: 0, y: 0 }, { path: 'b', x: 50, y: 50 }], [{ source: 'a', target: 'b' }]);
  let alpha = 1;
  for (let i = 0; i < 2000 && alpha > 0; i++) alpha = simulateStep(st);
  assert.equal(alpha, 0);
});

test('пружины работают: связанные узлы ближе несвязанных', () => {
  const st = makeState(
    [
      { path: 'a', x: 100, y: 300 }, { path: 'b', x: 700, y: 300 },        // связаны
      { path: 'c', x: 400, y: 100 }, { path: 'd', x: 400, y: 500 },        // не связаны
    ],
    [{ source: 'a', target: 'b' }]
  );
  for (let i = 0; i < 600; i++) simulateStep(st);
  const byPath = Object.fromEntries(st.nodes.map(n => [n.path, n]));
  const linked = Math.hypot(byPath.a.x - byPath.b.x, byPath.a.y - byPath.b.y);
  const unlinked = Math.hypot(byPath.c.x - byPath.d.x, byPath.c.y - byPath.d.y);
  assert.ok(linked < unlinked, `связанные (${linked.toFixed(1)}) должны быть ближе несвязанных (${unlinked.toFixed(1)})`);
  // и держаться около linkDistance (дефолт 90)
  assert.ok(Math.abs(linked - 90) < 45, `расстояние по ребру ${linked.toFixed(1)} далеко от 90`);
});

test('fixed-узлы не двигаются', () => {
  const st = makeState([{ path: 'a', x: 123, y: 456, fixed: true }, { path: 'b', x: 200, y: 200 }],
    [{ source: 'a', target: 'b' }]);
  for (let i = 0; i < 200; i++) simulateStep(st);
  assert.equal(st.nodes[0].x, 123);
  assert.equal(st.nodes[0].y, 456);
  assert.equal(st.nodes[0].vx, 0);
});

test('alpha = 0 означает полную остановку', () => {
  const st = makeState([{ path: 'a', x: 10, y: 10 }, { path: 'b', x: 20, y: 20 }], [{ source: 'a', target: 'b' }], 0);
  const snapshot = st.nodes.map(n => ({ x: n.x, y: n.y }));
  simulateStep(st);
  st.nodes.forEach((n, i) => {
    assert.equal(n.x, snapshot[i].x);
    assert.equal(n.y, snapshot[i].y);
  });
});

test('большой граф считается за разумное время', () => {
  const nodes = Array.from({ length: 400 }, (_, i) => ({ path: `n${i}`, x: 400 + (i % 20) * 10, y: 300 + Math.floor(i / 20) * 10 }));
  const edges = Array.from({ length: 399 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}` }));
  const st = makeState(nodes, edges);
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) simulateStep(st);
  const ms = Date.now() - t0;
  finite(st, 'большой граф');
  assert.ok(ms < 5000, `слишком медленно: ${ms}ms на 60 шагов`);
});

// ——— Модуль должен импортироваться в Node и не трогать DOM на верхнем уровне ———
test('модуль импортируется без DOM', () => {
  assert.equal(typeof createGraph, 'function');
  assert.equal(typeof simulateStep, 'function');
  assert.equal(typeof graphPalette, 'function');
});

test('createGraph не падает без реального canvas (заглушка)', () => {
  // Минимальная заглушка: контроллер обязан выжить, даже если context получить не удалось
  const fake = {
    getContext: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    clientWidth: 800,
    clientHeight: 600,
    addEventListener: () => { },
    removeEventListener: () => { },
  };
  const g = createGraph(fake, {});
  g.setData({
    nodes: [{ path: 'a', title: 'А', degree: 1 }, { path: 'b', title: 'Б', degree: 1 }],
    edges: [{ source: 'a', target: 'b' }],
  });
  g.focus('a');
  g.setLabels(false);
  g.setTheme('light');
  g.resize();
  g.fit();
  const data = g.getData();
  assert.equal(data.nodes.length, 2);
  assert.ok(Number.isFinite(data.nodes[0].x), 'координаты должны быть проставлены');
  g.destroy();
});

test('createGraph переживает пустые данные', () => {
  const fake = {
    getContext: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    clientWidth: 0, clientHeight: 0,
    addEventListener: () => { }, removeEventListener: () => { },
  };
  const g = createGraph(fake, {});
  g.setData({ nodes: [], edges: [] });
  g.fit();
  g.focus('нет-такого');
  assert.deepEqual(g.getData().nodes, []);
  g.destroy();
});

test('онварн срабатывает на большом графе ровно один раз', () => {
  const fake = {
    getContext: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    clientWidth: 800, clientHeight: 600,
    addEventListener: () => { }, removeEventListener: () => { },
  };
  let warns = 0;
  const g = createGraph(fake, { warnAt: 3, onWarn: () => warns++ });
  const nodes = Array.from({ length: 5 }, (_, i) => ({ path: `n${i}`, title: `N${i}`, degree: 1 }));
  g.setData({ nodes, edges: [] });
  g.setData({ nodes, edges: [] });
  assert.equal(warns, 1, `предупреждений: ${warns}, ожидалось 1`);
  g.destroy();
});

// ——— Итог ———
if (failures.length) {
  console.error(`\n✗ Провалено ${failures.length} из ${passed + failures.length}:`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ graph: ${passed} тестов пройдено`);