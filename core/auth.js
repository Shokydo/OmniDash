'use strict';
/**
 * Аутентификация: scrypt-пароли, серверные сессии в cookie, API-ключи.
 * Никаких JWT в localStorage — сессия живёт на сервере и отзывается мгновенно.
 */
const crypto = require('crypto');
const db = require('./db');
const { token, sha256, safeEqual, parseCookies, now } = require('./util');

const COOKIE = 'od_sid';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  }).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  if (!user || !user.passwordHash || !user.salt) return false;
  const { hash } = hashPassword(password, user.salt);
  return safeEqual(hash, user.passwordHash);
}

function cookieHeader(sid, maxAgeSec) {
  return `${COOKIE}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function clearCookieHeader() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function createSession(user, req) {
  const ttl = Math.max(1, Number(db.data.settings.sessionTtlHours) || 168) * 3600 * 1000;
  const sid = token(32);
  db.data.sessions[sid] = {
    userId: user.id,
    createdAt: now(),
    expiresAt: now() + ttl,
    ip: req ? req.ip : '',
    ua: req ? String(req.headers['user-agent'] || '').slice(0, 180) : '',
  };
  db.save();
  return { sid, ttl };
}

function destroySession(sid) {
  if (sid && db.data.sessions[sid]) {
    delete db.data.sessions[sid];
    db.save();
  }
}

function cleanupSessions() {
  const t = now();
  let changed = false;
  for (const [sid, s] of Object.entries(db.data.sessions)) {
    if (!s || s.expiresAt < t) {
      delete db.data.sessions[sid];
      changed = true;
    }
  }
  if (changed) db.save();
}

/* ─────────────────────────── API-ключи ─────────────────────────── */

function createApiKey(user, name) {
  const secret = 'od_' + token(24).replace(/[-_]/g, '').slice(0, 32);
  const row = {
    id: crypto.randomUUID(),
    name: String(name || 'API-ключ').slice(0, 60),
    prefix: secret.slice(0, 10),
    hash: sha256(secret),
    createdAt: now(),
    lastUsedAt: null,
  };
  user.apiKeys = user.apiKeys || [];
  user.apiKeys.push(row);
  db.save();
  return { secret, meta: publicKey(row) };
}

function publicKey(k) {
  return { id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt };
}

function revokeApiKey(user, keyId) {
  const before = (user.apiKeys || []).length;
  user.apiKeys = (user.apiKeys || []).filter((k) => k.id !== keyId);
  db.save();
  return user.apiKeys.length !== before;
}

function userByApiKey(raw) {
  if (!raw || !raw.startsWith('od_')) return null;
  const hash = sha256(raw);
  for (const user of db.data.users) {
    for (const k of user.apiKeys || []) {
      if (safeEqual(k.hash, hash)) {
        k.lastUsedAt = now();
        db.save();
        return user;
      }
    }
  }
  return null;
}

/* ─────────────────────── контекст запроса ─────────────────────── */

/**
 * Возвращает { user, session, via } либо null.
 * via: 'session' | 'api'
 */
function authenticate(req) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const headerKey = String(req.headers['x-api-key'] || '').trim();
  const rawKey = bearer || headerKey;
  if (rawKey) {
    const user = userByApiKey(rawKey);
    if (user && !user.suspended) return { user, session: null, via: 'api' };
    return null;
  }
  const sid = parseCookies(req.headers.cookie || '')[COOKIE];
  if (!sid) return null;
  const session = db.data.sessions[sid];
  if (!session) return null;
  if (session.expiresAt < now()) {
    destroySession(sid);
    return null;
  }
  const user = db.userById(session.userId);
  if (!user) {
    destroySession(sid);
    return null;
  }
  return { user, session, sid, via: 'session' };
}

function isAdmin(user) {
  return !!user && user.role === 'admin';
}

module.exports = {
  COOKIE,
  hashPassword,
  verifyPassword,
  cookieHeader,
  clearCookieHeader,
  createSession,
  destroySession,
  cleanupSessions,
  createApiKey,
  revokeApiKey,
  publicKey,
  authenticate,
  isAdmin,
};
