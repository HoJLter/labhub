// Собственная аналитика (раздел 8.4 ТЗ) без сторонних трекеров.
// — анонимность: HMAC(ip, соль_дня) с ротацией соли, cookie-идентификатор посетителя;
// — батчевый приём событий (sendBeacon с фронта);
// — фильтрация ботов по User-Agent;
// — сырые events + агрегаты daily_stats (графики не считаются по сырым данным);
// — ретенция сырых событий 12 месяцев.
import { get, all, run, tx, now, hashIp, getDaySalt, applyRetention } from './db.js';
import { isBot, detectDevice } from './http.js';
import crypto from 'node:crypto';

const VALID_TYPES = new Set([
  'pageview', 'material_view', 'reader_open', 'download', 'page_change',
  'video_progress', 'search', 'session_start', 'time_on_site',
]);

const dayKey = ts => new Date(ts).toISOString().slice(0, 10);

function bump(day, metric, dim, value = 1) {
  run(
    `INSERT INTO daily_stats(day, metric, dim, value) VALUES(?,?,?,?)
     ON CONFLICT(day, metric, dim) DO UPDATE SET value = value + excluded.value`,
    day, metric, dim, value
  );
}

// Приём батча событий от клиента (POST /api/events)
export function ingestEvents(req, batch) {
  const ua = String(req.headers['user-agent'] || '');
  const bot = isBot(ua) ? 1 : 0;
  // События должны считаться для обычных браузеров; локальные прокси иногда
  // передают нестандартный UA, поэтому фильтр применяется только к явным ботам.
  const device = detectDevice(ua);
  const referrer = String(req.headers['referer'] || '').slice(0, 500);
  const ipHash = hashIp(req.ip || '');
  const t = now();
  const day = dayKey(t);

  // Посетитель: first-party cookie, 1 год (раздел 8.4)
  let visitorId = req.cookies?.['lh_visitor'];
  let newVisitor = false;
  if (!visitorId || !/^[\w-]{8,64}$/.test(visitorId)) {
    visitorId = crypto.randomBytes(16).toString('base64url');
    newVisitor = true;
  }
  const visitorRow = get('SELECT id FROM visitors WHERE id = ?', visitorId);
  if (!visitorRow) {
    run('INSERT INTO visitors(id, first_seen, last_seen, ua, device, referrer) VALUES(?,?,?,?,?,?)',
      visitorId, t, t, ua.slice(0, 300), device, referrer);
  } else {
    run('UPDATE visitors SET last_seen = ? WHERE id = ?', t, visitorId);
  }

  const events = Array.isArray(batch?.events) ? batch.events.slice(0, 100) : [];
  let sessionsStarted = newVisitor;
  tx(() => {
    for (const e of events) {
      const type = VALID_TYPES.has(e.type) ? e.type : null;
      if (!type) continue;
      const materialId = Number.isFinite(+e.material_id) ? +e.material_id : null;
      const folderId = Number.isFinite(+e.folder_id) ? +e.folder_id : null;
      const query = e.query != null ? String(e.query).slice(0, 200) : null;
      const value = Number.isFinite(+e.value) ? +e.value : null;
      run(
        `INSERT INTO events(ts, type, visitor_id, material_id, folder_id, query, value, meta, ip_hash, device, referrer, bot)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        t, type, visitorId, materialId, folderId, query, value,
        JSON.stringify(e.meta || {}).slice(0, 1000), ipHash, device, referrer, bot
      );
      // Не исключаем события из агрегатов: просмотр — факт открытия материала,
       // а UA-фильтр применяется только к служебным PV/UV-метрикам.
      switch (type) {
        case 'pageview':
          bump(day, 'pv', String(e.path || 'all').slice(0, 200));
          if (sessionsStarted) bump(day, 'sessions', 'all');
          break;
        case 'material_view':
          bump(day, 'material_view', String(materialId));
          break;
        case 'reader_open':
          bump(day, 'reader_open', String(materialId));
          break;
        case 'download':
          bump(day, 'download', String(materialId));
          break;
        case 'page_change':
          // «до какой страницы дочитывают» и среднее время чтения
          if (materialId) bump(day, 'max_page_sum', String(materialId), value || 0);
          if (materialId) bump(day, 'max_page_n', String(materialId));
          break;
        case 'video_progress':
          if (materialId && [25, 50, 75, 100].includes(+value)) bump(day, `video_${+value}`, String(materialId));
          break;
        case 'search':
          bump(day, 'search', 'all');
          if (value === 0) bump(day, 'search_zero', (query || '').toLowerCase());
          break;
        case 'time_on_site':
          if (value) { bump(day, 'time_sum', 'all', value); bump(day, 'time_n', 'all'); }
          break;
      }
      // Устройство / источник перехода
      if (type === 'pageview') {
        bump(day, 'device', device);
        if (referrer) {
          try { bump(day, 'referrer', new URL(referrer).hostname); } catch { /* ignore */ }
        } else bump(day, 'referrer', 'direct');
      }
    }
    // UV — через отдельный маркер дня (unique по visitor_id)
    if (!bot) {
      const seen = get(`SELECT 1 FROM daily_stats WHERE day = ? AND metric = 'uv_seen' AND dim = ?`, day, visitorId);
      if (!seen) { bump(day, 'uv', 'all'); bump(day, 'uv_seen', visitorId, 0); }
    }
  });

  // Счётчики на материалах (видимые публично «просмотры»)
  for (const e of events) {
    if (e.type === 'material_view' && Number.isFinite(+e.material_id)) {
      run('UPDATE materials SET views_count = views_count + 1 WHERE id = ?', +e.material_id);
    }
    if (e.type === 'reader_open' && Number.isFinite(+e.material_id)) {
      run('UPDATE materials SET reads_count = reads_count + 1 WHERE id = ?', +e.material_id);
    }
  }

  return { ok: true, visitorId, setCookie: newVisitor || !visitorRow };
}

export function logSearch(query, resultsCount, visitorId) {
  run('INSERT INTO search_queries(query, results_count, visitor_id, created_at) VALUES(?,?,?,?)',
    String(query).slice(0, 200), resultsCount, visitorId || null, now());
}

// ——— Отчёты для админки (разделы 8.1, 8.4) ———
export function overview(days = 30) {
  const to = dayKey(now());
  const from = dayKey(now() - (days - 1) * 86400000);
  const prevFrom = dayKey(now() - (2 * days - 1) * 86400000);
  const prevTo = dayKey(now() - days * 86400000);

  const byDay = new Map();
  for (const r of all(`SELECT day, metric, SUM(value) AS v FROM daily_stats WHERE day BETWEEN ? AND ? AND metric IN ('pv','uv','sessions') AND dim != 'uv_seen' GROUP BY day, metric`, from, to)) {
    const e = byDay.get(r.day) || { day: r.day, pv: 0, uv: 0, sessions: 0 };
    if (r.metric === 'pv') e.pv = r.v;
    if (r.metric === 'uv') e.uv = r.v;
    if (r.metric === 'sessions') e.sessions = r.v;
    byDay.set(r.day, e);
  }
  const timeline = [];
  for (let d = new Date(from); dayKey(d) <= to; d = new Date(d.getTime() + 86400000)) {
    const k = dayKey(d);
    timeline.push(byDay.get(k) || { day: k, pv: 0, uv: 0, sessions: 0 });
  }

  const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
  const cur = { pv: sum(timeline, x => x.pv), uv: sum(timeline, x => x.uv), sessions: sum(timeline, x => x.sessions) };
  const prevRows = all(`SELECT metric, SUM(value) AS v FROM daily_stats WHERE day BETWEEN ? AND ? AND metric IN ('pv','uv','sessions') AND dim != 'uv_seen' GROUP BY metric`, prevFrom, prevTo);
  const prev = { pv: 0, uv: 0, sessions: 0 };
  for (const r of prevRows) prev[r.metric] = r.v;

  const avgTime = (() => {
    const s = all(`SELECT COALESCE(SUM(value), 0) AS value FROM daily_stats WHERE day BETWEEN ? AND ? AND metric='time_sum'`, from, to)[0]?.value || 0;
    const n = all(`SELECT COALESCE(SUM(value), 0) AS value FROM daily_stats WHERE day BETWEEN ? AND ? AND metric='time_n'`, from, to)[0]?.value || 0;
    return n ? Math.round(s / n) : 0;
  })();

  return { from, to, timeline, cur, prev, avgTimeSec: avgTime };
}

export function topMaterials(days = 30, limit = 5) {
  const from = dayKey(now() - (days - 1) * 86400000);
  return all(
    `SELECT m.id, m.title, m.slug, COALESCE(SUM(ds.value),0) AS views,
       (SELECT COALESCE(SUM(value),0) FROM daily_stats WHERE metric='download' AND dim = CAST(m.id AS TEXT) AND day >= ?) AS downloads,
       (SELECT COALESCE(SUM(value),0) FROM daily_stats WHERE metric='reader_open' AND dim = CAST(m.id AS TEXT) AND day >= ?) AS reads
     FROM daily_stats ds JOIN materials m ON CAST(m.id AS TEXT) = ds.dim
     WHERE ds.metric = 'material_view' AND ds.day >= ? AND m.status != 'deleted'
     GROUP BY m.id ORDER BY views DESC LIMIT ?`, from, from, from, limit);
}

export function topFolders(days = 30, limit = 5) {
  const from = dayKey(now() - (days - 1) * 86400000);
  return all(
    `SELECT f.id, f.title, f.slug, COALESCE(SUM(ds.value),0) AS views
     FROM daily_stats ds JOIN materials m ON CAST(m.id AS TEXT) = ds.dim
     JOIN folders f ON f.id = m.folder_id
     WHERE ds.metric = 'material_view' AND ds.day >= ? AND m.status != 'deleted'
     GROUP BY f.id ORDER BY views DESC LIMIT ?`, from, limit);
}

export function materialStats(materialId, days = 90) {
  const from = dayKey(now() - (days - 1) * 86400000);
  const id = String(materialId);
  const g = metric => get(`SELECT COALESCE(SUM(value),0) AS v FROM daily_stats WHERE metric=? AND dim=? AND day >= ?`, metric, id, from)?.v || 0;
  const pageN = g('max_page_n'), pageSum = g('max_page_sum');
  const reads = g('reader_open');
  return {
    views: g('material_view'),
    reads,
    downloads: g('download'),
    conversion: g('material_view') ? Math.round((reads / g('material_view')) * 100) : 0,
    avgPage: pageN ? Math.round(pageSum / pageN) : null,
    video: { q25: g('video_25'), q50: g('video_50'), q75: g('video_75'), q100: g('video_100') },
  };
}

export function searchStats(days = 30, limit = 20) {
  const from = now() - days * 86400000;
  return {
    popular: all(`SELECT query, COUNT(*) AS n, AVG(results_count) AS avg_results FROM search_queries WHERE created_at >= ? AND query != '' GROUP BY lower(query) ORDER BY n DESC LIMIT ?`, from, limit),
    zero: all(`SELECT query, COUNT(*) AS n FROM search_queries WHERE created_at >= ? AND results_count = 0 GROUP BY lower(query) ORDER BY n DESC LIMIT ?`, from, limit),
  };
}

export function techStats(days = 30) {
  const from = dayKey(now() - (days - 1) * 86400000);
  const dim = metric => all(`SELECT dim, SUM(value) AS n FROM daily_stats WHERE metric=? AND day >= ? GROUP BY dim ORDER BY n DESC LIMIT 10`, metric, from);
  return { devices: dim('device'), referrers: dim('referrer') };
}

// Экспорт отчёта в CSV (раздел 8.4)
export function exportCsv(days = 90) {
  const from = dayKey(now() - (days - 1) * 86400000);
  const rows = [
    ['day', 'pv', 'uv', 'sessions', 'downloads'],
    ...all(
      `SELECT day,
        COALESCE((SELECT SUM(value) FROM daily_stats d2 WHERE d2.day=d1.day AND d2.metric='pv'),0) AS pv,
        COALESCE((SELECT SUM(value) FROM daily_stats d3 WHERE d3.day=d1.day AND d3.metric='uv'),0) AS uv,
        COALESCE((SELECT SUM(value) FROM daily_stats d4 WHERE d4.day=d1.day AND d4.metric='sessions'),0) AS sessions,
        COALESCE((SELECT SUM(value) FROM daily_stats d5 WHERE d5.day=d1.day AND d5.metric='download'),0) AS downloads
       FROM (SELECT DISTINCT day FROM daily_stats WHERE day >= ?) d1 ORDER BY day`, from
    ).map(r => [r.day, r.pv, r.uv, r.sessions, r.downloads]),
    [],
    ['material_id', 'title', 'views', 'reads', 'downloads'],
    ...all(
      `SELECT m.id, m.title, m.views_count, m.reads_count, m.downloads_count
       FROM materials m WHERE m.status != 'deleted' ORDER BY m.views_count DESC`
    ).map(r => [r.id, r.title, r.views_count, r.reads_count, r.downloads_count]),
  ];
  return rows.map(cells => cells.map(c => {
    const s = String(c ?? '');
    return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(';')).join('\r\n');
}

export function startStatsJanitor() {
  const t = setInterval(() => {
    applyRetention();
    // uv_seen — служебные маркеры, чистим старше 2 дней
    run(`DELETE FROM daily_stats WHERE metric='uv_seen' AND day < ?`, dayKey(now() - 2 * 86400000));
  }, 3600_000);
  t.unref();
  return t;
}

// «Мёртвые» материалы: 0 просмотров за 90 дней (раздел 8.4, предлагаемые метрики)
export function deadMaterials(days = 90) {
  const from = dayKey(now() - days * 86400000);
  return all(
    `SELECT m.id, m.title, m.slug FROM materials m
     WHERE m.status = 'published' AND m.id NOT IN
       (SELECT DISTINCT CAST(dim AS INTEGER) FROM daily_stats WHERE metric='material_view' AND day >= ? AND dim GLOB '[0-9]*')`, from);
}

// Воронка «за неделю до сессии»: резкий рост просмотров по папкам (эвристика)
export function surgeFolders(days = 7) {
  const recent = dayKey(now() - days * 86400000);
  const before = dayKey(now() - 2 * days * 86400000);
  return all(
    `SELECT * FROM (
       SELECT f.id, f.title,
         COALESCE((SELECT SUM(ds.value) FROM daily_stats ds JOIN materials m ON CAST(m.id AS TEXT)=ds.dim
                   WHERE ds.metric='material_view' AND m.folder_id=f.id AND ds.day >= ?),0) AS recent,
         COALESCE((SELECT SUM(ds.value) FROM daily_stats ds JOIN materials m ON CAST(m.id AS TEXT)=ds.dim
                   WHERE ds.metric='material_view' AND m.folder_id=f.id AND ds.day BETWEEN ? AND ?),0) AS before_
       FROM folders f
     ) WHERE recent > before_ * 1.5 AND recent > 5 ORDER BY recent DESC LIMIT 5`, recent, before, recent);
}
