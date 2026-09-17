// Поиск (раздел 4.5 ТЗ): полнотекстовый по названию + описанию + тегам.
// Postgres FTS недоступен в SQLite-стеке, поэтому реализована эквивалентная схема:
// нормализация (lower, ё→е) + русский стеммер (снятие флексий) + LIKE-матчинг по токенам.
// Подсказки по мере ввода, логирование запросов и «нулевых» результатов — в stats.js.
import { all, get } from './db.js';

const ENDINGS = [
  'иями', 'ями', 'ами', 'иях', 'ях', 'ах', 'ий', 'ый', 'ой', 'ей', 'ая', 'яя', 'ое', 'ее',
  'ать', 'ять', 'еть', 'ить', 'ует', 'ует', 'ова', 'ева', 'ов', 'ев', 'ам', 'ям', 'ах',
  'ию', 'ью', 'ия', 'ья', 'ий', 'ей', 'ой', 'ую', 'юю', 'ая', 'ым', 'им', 'ем', 'ом',
  'ых', 'их', 'ам', 'ям', 'ой', 'ей', 'а', 'я', 'ы', 'и', 'е', 'о', 'у', 'ю', 'ь',
  'ся', 'сь', 'ла', 'ло', 'ли', 'л',
];

export function stem(word) {
  let w = word.toLowerCase().replace(/ё/g, 'е');
  // Отделяем возможно имеющееся окончание существительного/прилагательного/глагола
  for (let pass = 0; pass < 2 && w.length > 4; pass++) {
    let cut = false;
    for (const e of ENDINGS) {
      if (w.length - e.length >= 3 && w.endsWith(e)) { w = w.slice(0, -e.length); cut = true; break; }
    }
    if (!cut) break;
  }
  return w;
}

export function tokenize(q) {
  return String(q || '').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/i).filter(s => s.length >= 2);
}

// LIKE-шаблон по стемме: ищем вхождение основы слова
function likeFor(token) {
  return `%${stem(token).replace(/[%_]/g, '')}%`;
}

export function searchMaterials(q, { limit = 30, visibility = 'listed', includeUnlisted = false } = {}) {
  const tokens = tokenize(q);
  if (!tokens.length) return [];
  const cond = tokens.map(() => `(loweru(m.title) LIKE ? OR loweru(m.description) LIKE ? OR EXISTS (
      SELECT 1 FROM material_tags mt JOIN tags t ON t.id = mt.tag_id
      WHERE mt.material_id = m.id AND loweru(t.name) LIKE ?))`).join(' AND ');
  const params = tokens.flatMap(t => {
    const l = `%${t.replace(/[%_]/g, '')}%`;
    return [l, likeFor(t), likeFor(t)];
  });
  const vis = includeUnlisted
    ? `m.visibility IN ('listed','unlisted')`
    : `m.visibility = 'listed'`;
  const rows = all(
    `SELECT m.id, m.slug, m.title, m.description, m.kind, m.mime, m.size, m.page_count, m.duration_sec,
            m.views_count, m.published_at, m.poster_path, f.title AS folder_title, f.slug AS folder_slug, f.color AS folder_color,
            (SELECT group_concat(t.name, ', ') FROM material_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.material_id = m.id) AS tags
     FROM materials m JOIN folders f ON f.id = m.folder_id
     WHERE m.status = 'published' AND ${vis} AND ${cond}
     ORDER BY
       CASE WHEN loweru(m.title) LIKE ? THEN 0 ELSE 1 END,
       m.published_at DESC
     LIMIT ?`,
    ...params,
    `%${tokens[0].replace(/[%_]/g, '')}%`,
    limit
  );
  return rows;
}

export function suggest(q, limit = 8) {
  const tokens = tokenize(q);
  if (!tokens.length) return [];
  const last = tokens[tokens.length - 1];
  const rows = all(
    `SELECT title, slug, kind FROM materials
     WHERE status = 'published' AND visibility = 'listed' AND loweru(title) LIKE ?
     ORDER BY views_count DESC, published_at DESC LIMIT ?`,
    `${last.toLowerCase().replace(/[%_]/g, '')}%`, limit
  );
  const folders = all(
    `SELECT title, slug FROM folders WHERE visibility = 'listed' AND deleted_at IS NULL AND loweru(title) LIKE ? LIMIT 3`,
    `${last.toLowerCase().replace(/[%_]/g, '')}%`
  ).map(f => ({ title: f.title, slug: f.slug, kind: 'folder' }));
  return [...folders, ...rows.map(r => ({ ...r, kind: r.kind }))].slice(0, limit);
}
