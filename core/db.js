'use strict';
/**
 * Хранилище OmniDash — один JSON-файл с атомарной записью.
 * Специально без внешней СУБД: панель можно перенести одной папкой.
 * Данные лежат в `data/db.json`.
 */
const fs = require('fs');
const path = require('path');
const { id, uuid } = require('./util');

const DATA_DIR = process.env.OMNIDASH_DATA
  ? path.resolve(process.env.OMNIDASH_DATA)
  : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TMP_FILE = path.join(DATA_DIR, 'db.json.tmp');

const DEFAULT_SETTINGS = {
  panelName: 'OmniDash',
  company: 'OmniDash Cloud',
  registrationOpen: false,
  defaultLimits: { memory: 2048, disk: 10240, cpu: 150, servers: 3, backups: 5, ports: 2 },
  sessionTtlHours: 168,
  expiryDays: 30,
  autoSuspendExpired: true,
  warnBeforeExpiryDays: 5,
  defaultEggId: null,
  theme: 'obsidian',
  accent: '#ffffff',
  compact: false,
  devAutoReload: true,
  updateUrl: '',
  updateChannel: 'stable',
  motd: '',
  locale: 'ru',
  sftp: { enabled: true, port: 2222 },
  portRandom: true,
  blockedPorts: [],
};

const DEFAULT_DATA = () => ({
  schema: 1,
  meta: {
    createdAt: Date.now(),
    buildId: id('build'),
    bootCount: 0,
    seededAt: null,
    demo: false,
  },
  settings: { ...DEFAULT_SETTINGS },
  users: [],
  roles: [],
  nodes: [],
  allocations: [],
  eggs: [],
  servers: [],
  backups: [],
  audit: [],
  sessions: {},
  renewRequests: [],
});

let data = DEFAULT_DATA();
let saveTimer = null;
let lastSavedAt = 0;

function defaultsMerge(target, def) {
  for (const [k, v] of Object.entries(def)) {
    if (target[k] === undefined) {
      target[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : v;
    } else if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      defaultsMerge(target[k], v);
    }
  }
  return target;
}

function ensureDirs() {
  for (const dir of [DATA_DIR, path.join(DATA_DIR, 'servers'), path.join(DATA_DIR, 'backups'), path.join(DATA_DIR, 'logs')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function load() {
  ensureDirs();
  let raw = null;
  try {
    raw = fs.readFileSync(DB_FILE, 'utf8');
  } catch {
    raw = null;
  }
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      data = defaultsMerge(parsed, DEFAULT_DATA());
      try {
        const rolesCore = require('./roles');
        if (rolesCore.ensureRoles(data)) save();
      } catch { /* ignore */ }
    } catch (err) {
      const broken = path.join(DATA_DIR, `db.broken-${Date.now()}.json`);
      try { fs.copyFileSync(DB_FILE, broken); } catch { /* ignore */ }
      console.error(`[db] не удалось прочитать db.json (${err.message}), копия: ${broken}`);
      data = DEFAULT_DATA();
    }
  } else {
    data = DEFAULT_DATA();
  }
  if (!Array.isArray(data.users)) data.users = [];
  try {
    const rolesCore = require('./roles');
    rolesCore.ensureRoles(data);
  } catch { /* ignore */ }
  // миграция на чёрно-белую тему: старый цветной акцент -> белый
  if (data.settings && data.settings.accent === '#7c8cff') data.settings.accent = '#ffffff';
  data.meta.bootCount = Number(data.meta.bootCount || 0) + 1;
  data.meta.lastBootAt = Date.now();
  save();
  return data;
}

function writeNow() {
  ensureDirs();
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(data, null, 2));
    fs.renameSync(TMP_FILE, DB_FILE);
    lastSavedAt = Date.now();
  } catch (err) {
    console.error('[db] ошибка записи:', err.message);
  }
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, 120);
  if (saveTimer.unref) saveTimer.unref();
}

function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writeNow();
}

process.on('exit', () => {
  try { writeNow(); } catch { /* ignore */ }
});

/* ─────────────────────────── коллекции ─────────────────────────── */

const findById = (list, value) => (list || []).find((x) => x.id === value || x.uuid === value) || null;

function userByName(username) {
  const v = String(username || '').trim().toLowerCase();
  return data.users.find((u) => u.username.toLowerCase() === v || (u.email || '').toLowerCase() === v) || null;
}
const userById = (v) => findById(data.users, v);
const serverById = (v) => findById(data.servers, v);
const nodeById = (v) => findById(data.nodes, v);
const eggById = (v) => findById(data.eggs, v);
const allocationById = (v) => findById(data.allocations, v);
const backupById = (v) => findById(data.backups, v);

function newUser({ username, email, role = 'user', passwordHash, hash, salt, limits }) {
  const user = {
    id: uuid(),
    username,
    email: email || '',
    role,
    passwordHash: passwordHash || hash,
    salt,
    suspended: false,
    createdAt: Date.now(),
    lastLoginAt: null,
    limits: { ...data.settings.defaultLimits, ...(limits || {}) },
    apiKeys: [],
    avatarColor: ['#262626', '#404040', '#595959', '#737373', '#8c8c8c', '#a6a6a6'][Math.floor(Math.random() * 6)],
    avatarImage: null,
    forcePasswordChange: false,
  };
  data.users.push(user);
  save();
  return user;
}

function audit(entry) {
  const row = { id: id('log'), at: Date.now(), ...entry };
  data.audit.unshift(row);
  if (data.audit.length > 4000) data.audit.length = 4000;
  save();
  return row;
}

function serverDir(serverId) {
  return path.join(DATA_DIR, 'servers', String(serverId).replace(/[^\w-]/g, ''));
}

function backupDir(serverId) {
  return path.join(DATA_DIR, 'backups', String(serverId).replace(/[^\w-]/g, ''));
}

module.exports = {
  DATA_DIR,
  DB_FILE,
  DEFAULT_SETTINGS,
  get data() { return data; },
  load,
  save,
  flush,
  writeNow,
  ensureDirs,
  findById,
  userByName,
  userById,
  serverById,
  nodeById,
  eggById,
  allocationById,
  backupById,
  newUser,
  audit,
  serverDir,
  backupDir,
  get lastSavedAt() { return lastSavedAt; },
};
