'use strict';
/**
 * Домен серверов: доступы, лимиты, аллокации портов, сроки, приостановка.
 * Здесь нет HTTP — только правила, которые использует API и демон.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { uuid, clamp, int, now } = require('./util');

const ALL_PERMS = ['console', 'power.start', 'power.stop', 'power.restart', 'power.kill', 'files', 'backups', 'startup', 'settings', 'users', 'schedule', 'allocations'];

const PERM_LABELS = {
  console: 'Консоль и команды',
  'power.start': 'Запуск сервера',
  'power.stop': 'Остановка сервера',
  'power.restart': 'Перезапуск сервера',
  'power.kill': 'Принудительное завершение',
  files: 'Файловый менеджер',
  backups: 'Резервные копии',
  startup: 'Переменные запуска',
  settings: 'Переименование и описание',
  users: 'Управление доступами',
  schedule: 'Расписание задач',
  allocations: 'Порты и аллокации',
};

/** Старое общее право control раскрывается в отдельные power.* */
function expandPerms(perms) {
  const out = [];
  for (const p of perms || []) {
    if (p === 'control') out.push('power.start', 'power.stop', 'power.restart', 'power.kill');
    else out.push(p);
  }
  return out;
}

/** Максимумы на один сервер (настройки панели). */
function serverMax() {
  const s = (db.data.settings && db.data.settings.serverMax) || {};
  return {
    memory: clamp(int(s.memory, 8192), 128, 1024 * 512),
    disk: clamp(int(s.disk, 20480), 64, 1024 * 1024 * 4),
    cpu: clamp(int(s.cpu, 400), 5, 1600),
    ports: clamp(int(s.ports, 4), 1, 100),
  };
}

/** Проверка лимитов сервера против максимумов панели. */
function checkServerMax(limits) {
  const max = serverMax();
  if (limits.memory > max.memory) return { ok: false, error: `Память превышает максимум на сервер: ${Math.round(max.memory / 1024)} ГБ` };
  if (limits.disk > max.disk) return { ok: false, error: `Диск превышает максимум на сервер: ${Math.round(max.disk / 1024)} ГБ` };
  if (limits.cpu > max.cpu) return { ok: false, error: `CPU превышает максимум на сервер: ${max.cpu / 100} ядер` };
  return { ok: true };
}

function ownedServers(userId) {
  return db.data.servers.filter((s) => s.ownerId === userId);
}

function subuserEntry(server, userId) {
  return (server.subusers || []).find((s) => s.userId === userId) || null;
}

/**
 * Права пользователя на сервер.
 * admin — всё; владелец — всё; сабъюзер — только выданные права.
 */
function access(user, server) {
  if (!user || !server) return { ok: false, perms: [], isOwner: false, isAdmin: false };
  if (user.role === 'admin') return { ok: true, perms: ALL_PERMS.slice(), isOwner: server.ownerId === user.id, isAdmin: true };
  if (server.ownerId === user.id) return { ok: true, perms: ALL_PERMS.slice(), isOwner: true, isAdmin: false };
  const entry = subuserEntry(server, user.id);
  if (entry) return { ok: true, perms: expandPerms(entry.perms).filter((p) => ALL_PERMS.includes(p)), isOwner: false, isAdmin: false };
  return { ok: false, perms: [], isOwner: false, isAdmin: false };
}

function can(user, server, perm) {
  return access(user, server).perms.includes(perm);
}

function visibleServers(user) {
  if (!user) return [];
  if (user.role === 'admin') return db.data.servers.slice();
  return db.data.servers.filter((s) => s.ownerId === user.id || subuserEntry(s, user.id));
}

function usageOf(userId) {
  const list = ownedServers(userId);
  return {
    servers: list.length,
    memory: list.reduce((a, s) => a + int(s.limits.memory), 0),
    disk: list.reduce((a, s) => a + int(s.limits.disk), 0),
    backups: db.data.backups.filter((b) => list.some((s) => s.id === b.serverId)).length,
  };
}

/** Проверка лимитов пользователя при создании сервера. */
function checkUserLimits(user, { memory, disk, cpu, ports = 1 }, ignoreServerId = null) {
  if (!user) return { ok: false, error: 'Пользователь не найден' };
  if (user.role === 'admin') return { ok: true };
  const limits = { ...db.data.settings.defaultLimits, ...(user.limits || {}) };
  const list = ownedServers(user.id).filter((s) => s.id !== ignoreServerId);
  const used = {
    servers: list.length,
    memory: list.reduce((a, s) => a + int(s.limits.memory), 0),
    disk: list.reduce((a, s) => a + int(s.limits.disk), 0),
  };
  if (used.servers + 1 > limits.servers) {
    return { ok: false, error: `Лимит серверов исчерпан (${used.servers}/${limits.servers})` };
  }
  if (used.memory + int(memory) > limits.memory) {
    return { ok: false, error: `Лимит памяти исчерпан (${used.memory + int(memory)} / ${limits.memory} МБ)` };
  }
  if (used.disk + int(disk) > limits.disk) {
    return { ok: false, error: `Лимит диска исчерпан (${used.disk + int(disk)} / ${limits.disk} МБ)` };
  }
  if (int(cpu) > limits.cpu) {
    return { ok: false, error: `CPU на сервер не может превышать ${limits.cpu}%` };
  }
  return { ok: true, used, limits };
}

/** Свободная память/диск узла (по суммарным лимитам его серверов). */
function nodeUsage(nodeId) {
  const node = db.nodeById(nodeId);
  const servers = db.data.servers.filter((s) => s.nodeId === nodeId);
  const allocations = db.data.allocations.filter((a) => a.nodeId === nodeId);
  return {
    servers: servers.length,
    memory: servers.reduce((a, s) => a + int(s.limits.memory), 0),
    disk: servers.reduce((a, s) => a + int(s.limits.disk), 0),
    ports: allocations.length,
    portsUsed: allocations.filter((a) => !!a.serverId).length,
    memoryTotal: node ? int(node.memoryTotal) : 0,
    diskTotal: node ? int(node.diskTotal) : 0,
    online: node ? node.status !== 'offline' : false,
  };
}

/** Порты, которые рандомайзер никогда не выдаёт (блоклист админа). */
function blockedPorts() {
  return new Set((db.data.settings.blockedPorts || []).map((p) => int(p)).filter((p) => p >= 1 && p <= 65535));
}

function portRandom() {
  return db.data.settings.portRandom !== false;
}

function freeAllocation(nodeId) {
  const blocked = blockedPorts();
  const free = db.data.allocations.filter((a) => a.nodeId === nodeId && !a.serverId && !blocked.has(int(a.port)));
  if (!free.length) return null;
  if (portRandom()) return free[Math.floor(Math.random() * free.length)];
  return free[0];
}

/** Создаёт аллокацию из диапазона узла, если свободных нет. */
function spawnAllocation(nodeId, extra = {}) {
  const node = db.nodeById(nodeId);
  if (!node) return Object.assign(new Error('Узел не найден'), { status: 404 });
  const from = int(node.portStart, 25565);
  const to = int(node.portEnd, 25600);
  const existing = new Set(db.data.allocations.filter((a) => a.nodeId === nodeId).map((a) => int(a.port)));
  const blocked = blockedPorts();
  const candidates = [];
  for (let port = from; port <= to; port += 1) {
    if (!existing.has(port) && !blocked.has(port)) candidates.push(port);
  }
  if (!candidates.length) return Object.assign(new Error('Свободных портов в диапазоне узла нет'), { status: 409 });
  const port = portRandom() ? candidates[Math.floor(Math.random() * candidates.length)] : candidates[0];
  const alloc = {
    id: uuid(),
    nodeId,
    ip: node.fqdn === 'localhost' || node.fqdn === '127.0.0.1' ? '0.0.0.0' : node.fqdn,
    port,
    serverId: null,
    createdAt: now(),
    notes: extra.notes || '',
  };
  db.data.allocations.push(alloc);
  db.save();
  return alloc;
}

function ensureAllocation(nodeId, serverId) {
  let alloc = freeAllocation(nodeId);
  if (!alloc) alloc = spawnAllocation(nodeId);
  if (alloc instanceof Error) throw alloc;
  alloc.serverId = serverId;
  db.save();
  return alloc;
}

function assignAllocation(serverId, allocationId, primary = false) {
  const server = db.serverById(serverId);
  const alloc = db.allocationById(allocationId);
  if (!server || !alloc) throw Object.assign(new Error('Сервер или аллокация не найдена'), { status: 404 });
  if (alloc.serverId && alloc.serverId !== server.id) throw Object.assign(new Error('Порт уже занят другим сервером'), { status: 409 });
  alloc.serverId = server.id;
  if (!Array.isArray(server.allocations)) server.allocations = [];
  if (!server.allocations.includes(alloc.id)) server.allocations.push(alloc.id);
  if (primary || !server.allocationId) server.allocationId = alloc.id;
  db.save();
  return alloc;
}

function releaseAllocation(allocationId) {
  const alloc = db.allocationById(allocationId);
  if (!alloc) return false;
  alloc.serverId = null;
  db.data.servers.forEach((s) => {
    s.allocations = (s.allocations || []).filter((a) => a !== allocationId);
    if (s.allocationId === allocationId) s.allocationId = (s.allocations || [])[0] || null;
  });
  db.save();
  return true;
}

function normalizeLimits(raw = {}) {
  return {
    memory: clamp(int(raw.memory, 1024), 128, 1024 * 512),
    disk: clamp(int(raw.disk, 5120), 64, 1024 * 1024 * 4),
    cpu: clamp(int(raw.cpu, 100), 5, 1600),
    io: clamp(int(raw.io, 500), 10, 1000),
  };
}

function createServer({ owner, egg, node, name, description = '', limits, environment = {}, expiresDays = null, actor = null, autoStart = false }) {
  if (!owner) throw Object.assign(new Error('Владелец не найден'), { status: 400 });
  if (!egg) throw Object.assign(new Error('Шаблон не найден'), { status: 400 });
  if (!node) throw Object.assign(new Error('Узел не найден'), { status: 400 });
  const cleanName = String(name || '').trim().slice(0, 60);
  if (!/^[a-zA-Zа-яА-Я0-9 _.\-–]{2,60}$/u.test(cleanName)) {
    throw Object.assign(new Error('Имя: 2–60 символов, буквы/цифры/пробел/точка/дефис'), { status: 400 });
  }
  const lim = normalizeLimits(limits);
  const maxCheck = checkServerMax(lim);
  if (!maxCheck.ok) throw Object.assign(new Error(maxCheck.error), { status: 409 });
  const check = checkUserLimits(owner, lim);
  if (!check.ok) throw Object.assign(new Error(check.error), { status: 409 });

  const server = {
    id: uuid(),
    uuid: uuid(),
    name: cleanName,
    description: String(description || '').slice(0, 500),
    ownerId: owner.id,
    nodeId: node.id,
    eggId: egg.id,
    allocationId: null,
    allocations: [],
    limits: lim,
    environment: { ...environment },
    startupOverride: null,
    autoStart: !!autoStart,
    suspended: false,
    suspendReason: null,
    createdAt: now(),
    expiresAt: expiresDays ? now() + clamp(int(expiresDays, 30), 1, 3650) * 86400000 : null,
    renewals: 0,
    subusers: [],
    tasks: [],
    notes: '',
    lastStartedAt: null,
  };
  db.data.servers.push(server);
  const alloc = ensureAllocation(node.id, server.id);
  server.allocationId = alloc.id;
  server.allocations = [alloc.id];
  fs.mkdirSync(db.serverDir(server.id), { recursive: true });
  fs.mkdirSync(`${db.serverDir(server.id)}/logs`, { recursive: true });
  db.audit({
    action: 'server.create',
    actorId: actor ? actor.id : null,
    actorName: actor ? actor.username : 'system',
    target: server.name,
    meta: { owner: owner.username, egg: egg.name, memory: lim.memory, disk: lim.disk, port: alloc.port },
  });
  db.save();
  return server;
}

function deleteServer(serverId, actor = null) {
  const idx = db.data.servers.findIndex((s) => s.id === serverId);
  if (idx < 0) return false;
  const server = db.data.servers[idx];
  db.data.servers.splice(idx, 1);
  db.data.allocations.forEach((a) => { if (a.serverId === serverId) a.serverId = null; });
  db.data.backups = db.data.backups.filter((b) => {
    if (b.serverId !== serverId) return true;
    try { fs.rmSync(path.join(db.backupDir(serverId), b.file), { force: true }); } catch { /* ignore */ }
    return false;
  });
  db.data.renewRequests = db.data.renewRequests.filter((r) => r.serverId !== serverId);
  db.audit({
    action: 'server.delete',
    actorId: actor ? actor.id : null,
    actorName: actor ? actor.username : 'system',
    target: server.name,
    meta: { owner: (db.userById(server.ownerId) || {}).username },
  });
  db.save();
  return true;
}

function suspend(server, reason = 'manual', actor = null) {
  server.suspended = true;
  server.suspendReason = reason;
  server.suspendedAt = now();
  db.audit({
    action: 'server.suspend',
    actorId: actor ? actor.id : null,
    actorName: actor ? actor.username : 'system',
    target: server.name,
    meta: { reason },
  });
  db.save();
  return server;
}

function unsuspend(server, actor = null) {
  const wasSuspended = server.suspended;
  server.suspended = false;
  server.suspendReason = null;
  server.suspendedAt = null;
  if (wasSuspended) {
    db.audit({
      action: 'server.unsuspend',
      actorId: actor ? actor.id : null,
      actorName: actor ? actor.username : 'system',
      target: server.name,
    });
  }
  db.save();
  return server;
}

function extend(server, days, actor = null) {
  const d = clamp(int(days, 30), 1, 3650);
  const from = server.expiresAt && server.expiresAt > now() ? server.expiresAt : now();
  server.expiresAt = from + d * 86400000;
  server.renewals = int(server.renewals) + 1;
  server.suspended = false;
  server.suspendReason = null;
  db.audit({
    action: 'server.renew',
    actorId: actor ? actor.id : null,
    actorName: actor ? actor.username : 'system',
    target: server.name,
    meta: { days: d, until: new Date(server.expiresAt).toISOString() },
  });
  db.save();
  return server;
}

function daysLeft(server) {
  if (!server.expiresAt) return null;
  return Math.ceil((server.expiresAt - now()) / 86400000);
}

function setSubuser(server, userId, perms) {
  const user = db.userById(userId);
  if (!user) throw Object.assign(new Error('Пользователь не найден'), { status: 404 });
  if (user.id === server.ownerId) throw Object.assign(new Error('Владельцу доступы не нужны'), { status: 400 });
  const clean = [...new Set((perms || []).filter((p) => ALL_PERMS.includes(p)))];
  server.subusers = server.subusers || [];
  const existing = server.subusers.find((s) => s.userId === userId);
  if (existing) existing.perms = clean;
  else server.subusers.push({ userId, perms: clean, addedAt: now() });
  db.audit({
    action: 'server.access.grant',
    actorName: 'panel',
    target: server.name,
    meta: { user: user.username, perms: clean },
  });
  db.save();
  return server.subusers;
}

function removeSubuser(server, userId) {
  server.subusers = (server.subusers || []).filter((s) => s.userId !== userId);
  db.save();
  return server.subusers;
}

function transfer(server, newOwnerId, actor = null) {
  const user = db.userById(newOwnerId);
  if (!user) throw Object.assign(new Error('Пользователь не найден'), { status: 404 });
  const check = checkUserLimits(user, server.limits);
  if (!check.ok) throw Object.assign(new Error(check.error), { status: 409 });
  const old = db.userById(server.ownerId);
  server.ownerId = user.id;
  server.subusers = (server.subusers || []).filter((s) => s.userId !== newOwnerId);
  db.audit({
    action: 'server.transfer',
    actorId: actor ? actor.id : null,
    actorName: actor ? actor.username : 'system',
    target: server.name,
    meta: { from: old ? old.username : '?', to: user.username },
  });
  db.save();
  return server;
}

module.exports = {
  ALL_PERMS,
  PERM_LABELS,
  access,
  can,
  visibleServers,
  ownedServers,
  subuserEntry,
  usageOf,
  checkUserLimits,
  nodeUsage,
  freeAllocation,
  spawnAllocation,
  assignAllocation,
  releaseAllocation,
  normalizeLimits,
  createServer,
  serverMax,
  checkServerMax,
  expandPerms,
  deleteServer,
  suspend,
  unsuspend,
  extend,
  daysLeft,
  setSubuser,
  removeSubuser,
  transfer,
};
