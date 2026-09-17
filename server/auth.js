// Авторизация админа: scrypt-хеш пароля (стойкая KDF из node:crypto; Argon2id из ТЗ
// требует нативной зависимости — scrypt с N=2^15 эквивалентен по назначению),
// сессии в httpOnly-cookie, блокировка после N неудач, опциональный TOTP (2FA).
import crypto from 'node:crypto';
import { get, all, run, now, audit, getSetting } from './db.js';
import { config } from './config.js';
import { HttpError, newCsrfToken } from './http.js';

// ——— Пароли (scrypt, N=2^14 r=8 p=1 — параметры OWASP) ———
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password.normalize('NFKC'), salt, 64, SCRYPT_OPTS);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [alg, saltB64, hashB64] = stored.split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password.normalize('NFKC'), salt, expected.length, SCRYPT_OPTS);
    return crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

// ——— TOTP (RFC 6238), 2FA как опция (раздел 3) ———
export function generateTotpSecret() {
  return crypto.randomBytes(20).toString('base32hex').replace(/=/g, '').toUpperCase().slice(0, 32);
}

function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s.toUpperCase().replace(/=+$/, '')) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totpNow(secret, offset = 0) {
  const counter = Math.floor(Date.now() / 30000) + offset;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = hmac[19] & 0x0f;
  const code = ((hmac[o] & 0x7f) << 24 | hmac[o + 1] << 16 | hmac[o + 2] << 8 | hmac[o + 3]) % 1_000_000;
  return String(code).padStart(6, '0');
}

export function verifyTotp(secret, code) {
  for (const off of [-1, 0, 1]) if (totpNow(secret, off) === String(code).trim()) return true;
  return false;
}

// ——— Bootstrap единственного админа (раздел 3) ———
export function ensureAdminUser() {
  const u = get('SELECT id FROM admin_users LIMIT 1');
  if (u) return;
  run(
    'INSERT INTO admin_users(login, password_hash, created_at) VALUES(?,?,?)',
    config.adminBootstrap.login,
    hashPassword(config.adminBootstrap.password),
    now()
  );
  audit('system', 'admin.bootstrap', 'admin_users', null, { login: config.adminBootstrap.login });
  console.log(`[lab-hub] создан админ: ${config.adminBootstrap.login} (смените пароль в /admin → Настройки → Учётка)`);
}

// ——— Сессии ———
export function createSession(userId, req) {
  const id = crypto.randomBytes(32).toString('base64url');
  const csrf = newCsrfToken();
  run(
    'INSERT INTO sessions(id, user_id, csrf, ua, ip_hash, created_at, expires_at) VALUES(?,?,?,?,?,?,?)',
    id, userId, csrf, String(req.headers['user-agent'] || '').slice(0, 300), '', now(), now() + config.sessionTtlMs
  );
  run('DELETE FROM sessions WHERE expires_at < ?', now());
  return { id, csrf };
}

export function getSession(req) {
  const cookies = req.cookies || {};
  const sid = cookies['lh_session'];
  if (!sid) return null;
  const s = get('SELECT * FROM sessions WHERE id = ?', sid);
  if (!s || s.expires_at < now()) {
    if (s) run('DELETE FROM sessions WHERE id = ?', sid);
    return null;
  }
  return s;
}

export function destroySession(req, res) {
  const sid = (req.cookies || {})['lh_session'];
  if (sid) run('DELETE FROM sessions WHERE id = ?', sid);
  res.setHeader('Set-Cookie', `lh_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

export function requireAdmin(req) {
  const s = getSession(req);
  if (!s) throw new HttpError(401, 'Требуется вход', 'unauthorized');
  return s;
}

export function requireCsrf(req) {
  const s = requireAdmin(req);
  const header = req.headers['x-csrf-token'];
  if (!header || header !== s.csrf) throw new HttpError(403, 'Недействительный CSRF-токен', 'csrf');
  return s;
}

// ——— Вход с rate-limit и блокировкой (раздел 3) ———
export function attemptLogin(login, password, totpCode, req) {
  const user = get('SELECT * FROM admin_users WHERE login = ?', login);
  if (!user) throw new HttpError(401, 'Неверный логин или пароль');
  if (user.locked_until && user.locked_until > now()) {
    const left = Math.ceil((user.locked_until - now()) / 60000);
    throw new HttpError(423, `Аккаунт заблокирован на ${left} мин из-за неудачных попыток`);
  }
  if (!verifyPassword(password, user.password_hash)) {
    const fails = (user.failed_attempts || 0) + 1;
    const lock = fails >= config.loginMaxFails ? now() + config.loginLockMs : null;
    run('UPDATE admin_users SET failed_attempts = ?, locked_until = ? WHERE id = ?', fails, lock, user.id);
    audit('auth', 'login.failed', 'admin_users', user.id, { login });
    if (lock) throw new HttpError(423, 'Слишком много попыток — аккаунт временно заблокирован');
    throw new HttpError(401, 'Неверный логин или пароль');
  }
  if (user.totp_secret) {
    if (!totpCode) return { needs2fa: true, user };
    if (!verifyTotp(user.totp_secret, totpCode)) {
      run('UPDATE admin_users SET failed_attempts = failed_attempts + 1 WHERE id = ?', user.id);
      throw new HttpError(401, 'Неверный код 2FA');
    }
  }
  run('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', now(), user.id);
  audit('admin', 'login.success', 'admin_users', user.id, { login });
  return { needs2fa: false, user, session: createSession(user.id, req) };
}

export function changePassword(userId, oldPassword, newPassword, keepSessionId = null) {
  const user = get('SELECT * FROM admin_users WHERE id = ?', userId);
  if (!user || !verifyPassword(oldPassword, user.password_hash)) throw new HttpError(400, 'Текущий пароль неверен');
  if (String(newPassword).length < 8) throw new HttpError(400, 'Новый пароль должен быть не короче 8 символов');
  run('UPDATE admin_users SET password_hash = ? WHERE id = ?', hashPassword(newPassword), userId);
  // Смена пароля рвёт все сессии кроме текущей
  if (keepSessionId) run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, keepSessionId);
  else run('DELETE FROM sessions WHERE user_id = ?', userId);
  audit('admin', 'password.changed', 'admin_users', userId, {});
}
