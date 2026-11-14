'use strict';
/**
 * Домен серверов: доступы, лимиты, аллокации портов, сроки, приостановка.
 * Здесь нет HTTP — только правила, которые использует API и демон.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { uuid, clamp, int, now } = require('./util');

const ALL_PERMS = ['console', 'control', 'files', 'backups', 'startup', 'settings', 'users', 'schedule', 'allocations'];

const PERM_LABELS = {
  console: 'Консоль и команды',
  control: 'Старт / стоп / рестарт',
  files: 'Файловый менеджер',
  backups: 'Резервные копии',
  startup: 'Переменные запуска',
  settings: 'Переименование и описание',
  users: 'Управление доступами',
  schedule: 'Расписание задач',
  allocations: 'Порты и аллокации',
};

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
  if (entry) return { ok: true, perms: entry.perms.filter((p) => ALL_PERMS.includes(p)), isOwner: false, isAdmin: false };
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

function freeAllocation(nodeId) {
  return db.data.allocations.find((a) => a.nodeId === nodeId && !a.serverId) || null;
}

/** Создаёт аллокацию из диапазона узла, если свободных нет. */
function spawnAllocation(nodeId, extra = {}) {
  const node = db.nodeById(nodeId);
  if (!node) return Object.assign(new Error('Узел не найден'), { status: 404 });
  const from = int(node.portStart, 25565);
  const to = int(node.portEnd, 25600);
  const existing = new Set(db.data.allocations.filter((a) => a.nodeId === nodeId).map((a) => int(a.port)));
  for (let port = from; port <= to; port += 1) {
    if (!existing.has(port)) {
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
  }
  return Object.assign(new Error('Свободных портов в диапазоне узла нет'), { status: 409 });
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
  deleteServer,
  suspend,
  unsuspend,
  extend,
  daysLeft,
  setSubuser,
  removeSubuser,
  transfer,
};
