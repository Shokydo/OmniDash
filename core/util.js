'use strict';
/**
 * OmniDash — общие утилиты.
 * Ноль зависимостей: только стандартная библиотека Node.js.
 */
const crypto = require('crypto');
const path = require('path');

const now = () => Date.now();
const iso = (t = Date.now()) => new Date(t).toISOString();

function id(prefix = '') {
  return (prefix ? `${prefix}_` : '') + crypto.randomBytes(9).toString('hex');
}

function uuid() {
  // RFC 4122 v4 (uuid сервера / пользователя).
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function token(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hmac(token, secret) {
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

/** Постоянное по времени сравнение строк. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** '1.10.0' → [1,10,0]; мусор → [0,0,0]. */
function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/\d+(\.\d+)*/);
  if (!m) return [0, 0, 0];
  const parts = m[0].split('.').map((n) => Number(n) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

/** 1, если a новее b; -1, если старее; 0 — равны. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (x[i] > y[i]) return 1;
    if (x[i] < y[i]) return -1;
  }
  return 0;
}

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function num(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function int(n, fallback = 0) {
  return Math.trunc(num(n, fallback));
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Полное имя файла без путей и недопустимых символов. */
function safeName(name) {
  return String(name || '')
    .replace(/[\\/]/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^\.+$/, '')
    .trim()
    .slice(0, 200);
}

/** Абсолютный путь внутри корня. Бросает, если путь выходит за пределы. */
function resolveInside(root, relative = '') {
  const base = path.resolve(root);
  const target = path.resolve(base, '.' + path.sep + String(relative || '').replace(/^[\\/]+/, ''));
  if (target !== base && !target.startsWith(base + path.sep)) {
    const err = new Error('Путь вне каталога сервера');
    err.status = 400;
    err.code = 'PATH_ESCAPE';
    throw err;
  }
  return target;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Байты → «1.4 ГБ». */
function fmtBytes(bytes) {
  const b = num(bytes);
  if (b < 1024) return `${b} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** мс → «2ч 14м». */
function fmtDuration(ms) {
  const s = Math.max(0, Math.round(num(ms) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}д ${h}ч`;
  if (h) return `${h}ч ${m}м`;
  if (m) return `${m}м ${sec}с`;
  return `${sec}с`;
}

function parseCookies(header = '') {
  const out = {};
  String(header)
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i < 0) return;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (!k) return;
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    });
  return out;
}

/** Простой лимитер: не больше `limit` вызовов за `windowMs` для ключа. */
function createLimiter(limit, windowMs) {
  const hits = new Map();
  return function take(key) {
    const t = Date.now();
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= limit) {
      const retry = Math.ceil((windowMs - (t - arr[0])) / 1000);
      hits.set(key, arr);
      return { ok: false, retry };
    }
    arr.push(t);
    hits.set(key, arr);
    if (hits.size > 5000) hits.clear();
    return { ok: true, retry: 0 };
  };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    uuid: u.uuid,
    username: u.username,
    email: u.email,
    role: u.role,
    suspended: !!u.suspended,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
    limits: u.limits,
    avatarColor: u.avatarColor || '#262626',
    avatarImage: u.avatarImage || null,
  };
}

module.exports = {
  MB,
  GB,
  now,
  iso,
  id,
  uuid,
  token,
  sha256,
  hmac,
  safeEqual,
  parseVersion,
  compareVersions,
  clamp,
  num,
  int,
  slug,
  safeName,
  resolveInside,
  fmtBytes,
  fmtDuration,
  parseCookies,
  createLimiter,
  pick,
  sleep,
  publicUser,
};
