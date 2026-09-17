// Health-check внешних ссылок (раздел 7.3): раз в сутки HEAD-проверка,
// статусы ok / slow / broken, алерты на дашборде.
import { all, get, run, now } from './db.js';
import { probeUrl, cfgOf, webdavUrl, webdavHeaders, presignS3Get, driveUrl } from './sources.js';
import { config } from './config.js';

function checkUrlFor(material, storage) {
  const cfg = JSON.parse(material.source_config || '{}');
  switch (material.source_type) {
    case 'url': return probeUrl(cfg.url);
    case 'webdav': return storage ? probeUrlWith(webdavUrl(storage, cfg.key || material.slug), webdavHeaders(storage)) : probeUrl(cfg.url || '');
    case 's3': {
      if (!storage) return Promise.resolve({ ok: false, status: 0, error: 'нет хранилища' });
      try { return probeUrl(presignS3Get(storage, cfg.key || material.slug, 300)); }
      catch (e) { return Promise.resolve({ ok: false, status: 0, error: String(e.message || e) }); }
    }
    case 'drive': return probeUrl(driveUrl(cfg, true));
    default: return Promise.resolve({ ok: true, status: 200 });
  }
}

async function probeUrlWith(url, headers) {
  const started = Date.now();
  try {
    const res = await fetch(url, { method: 'HEAD', headers, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    return { ok: res.ok, status: res.status, took: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, took: Date.now() - started, error: String(e.message || e) };
  }
}

export async function checkMaterialHealth(materialId) {
  const m = get('SELECT * FROM materials WHERE id = ? AND source_type != ?', materialId, 'local');
  if (!m) return null;
  const storage = m.storage_id ? get('SELECT * FROM storages WHERE id = ?', m.storage_id) : null;
  const r = await checkUrlFor(m, storage);
  const status = !r.ok ? 'broken' : (r.took > 3000 ? 'slow' : 'ok');
  run(
    `INSERT INTO link_health(material_id, status, http_code, checked_at, error_msg)
     VALUES(?,?,?,?,?)
     ON CONFLICT(material_id) DO UPDATE SET status=excluded.status, http_code=excluded.http_code, checked_at=excluded.checked_at, error_msg=excluded.error_msg`,
    m.id, status, r.status || null, now(), r.error || ''
  );
  return { materialId: m.id, status, httpCode: r.status, took: r.took };
}

// Проход по всем внешним материалам с ограничением параллелизма
export async function runHealthCheckAll(onProgress) {
  const rows = all("SELECT id FROM materials WHERE source_type != 'local' AND status != 'deleted'");
  const results = { ok: 0, slow: 0, broken: 0 };
  const CONC = 4;
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const idx = i++;
      try {
        const r = await checkMaterialHealth(rows[idx].id);
        if (r) { results[r.status]++; onProgress?.(r); }
      } catch { /* ignore single failure */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, rows.length || 1) }, worker));
  // Обновляем агрегированный статус хранилищ
  for (const st of all('SELECT * FROM storages')) {
    const broken = get(
      `SELECT COUNT(*) AS c FROM link_health lh JOIN materials m ON m.id = lh.material_id
       WHERE m.storage_id = ? AND lh.status = 'broken'`, st.id)?.c ?? 0;
    run('UPDATE storages SET health_status = ?, last_check_at = ? WHERE id = ?', broken > 0 ? 'broken' : 'ok', now(), st.id);
  }
  return { checked: rows.length, ...results };
}

export function startHealthChecker(intervalMs = config.healthCheckIntervalMs) {
  const t = setInterval(() => { runHealthCheckAll().catch(() => {}); }, intervalMs);
  t.unref();
  return t;
}
