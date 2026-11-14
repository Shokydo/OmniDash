'use strict';
/**
 * Резервные копии серверов: ZIP-архив каталога сервера, sha256, восстановление.
 * Хранятся в data/backups/<serverId>/<id>.zip и переживают обновление панели.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const zip = require('./zip');
const { id, now, sha256, fmtBytes } = require('./util');

function pathOf(backup) {
  return path.join(db.backupDir(backup.serverId), backup.file);
}

function listFor(serverId) {
  return db.data.backups
    .filter((b) => b.serverId === serverId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((b) => ({ ...b, sizeLabel: fmtBytes(b.size), exists: fs.existsSync(pathOf(b)) }));
}

function create(server, { name, actor = null } = {}) {
  const owner = db.userById(server.ownerId);
  const limit = Number((owner && owner.limits && owner.limits.backups) || db.data.settings.defaultLimits.backups || 5);
  const existing = db.data.backups.filter((b) => b.serverId === server.id);
  if (existing.length >= limit) {
    throw Object.assign(new Error(`Лимит бэкапов: ${existing.length}/${limit}. Удалите старый бэкап.`), { status: 409 });
  }
  const dir = db.serverDir(server.id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const buf = zip.zipDir(dir, {
    filter: (full, rel) => {
      if (rel.startsWith('logs/console-') && rel.endsWith('.log') && rel !== 'logs/console.log') return false;
      return rel !== 'logs' || true;
    },
  });
  fs.mkdirSync(db.backupDir(server.id), { recursive: true });
  const backup = {
    id: id('bk'),
    serverId: server.id,
    name: String(name || `Бэкап ${new Date().toLocaleString('ru-RU')}`).slice(0, 80),
    file: `${Date.now()}-${id()}.zip`,
    size: buf.length,
    sha256: sha256(buf),
    createdAt: now(),
    createdBy: actor ? actor.username : 'system',
    locked: false,
  };
  fs.writeFileSync(pathOf(backup), buf);
  db.data.backups.push(backup);
  db.audit({
    action: 'backup.create',
    actorId: actor ? actor.id : null,
    actorName: actor ? actor.username : 'system',
    target: server.name,
    meta: { name: backup.name, size: backup.size },
  });
  db.save();
  return backup;
}

function remove(backup) {
  try { fs.rmSync(pathOf(backup), { force: true }); } catch { /* ignore */ }
  db.data.backups = db.data.backups.filter((b) => b.id !== backup.id);
  db.save();
  return true;
}

/** Восстановление: текущий каталог откладывается, архив распаковывается поверх. */
function restore(backup, actor = null) {
  const server = db.serverById(backup.serverId);
  if (!server) throw Object.assign(new Error('Сервер не найден'), { status: 404 });
  const file = pathOf(backup);
  if (!fs.existsSync(file)) throw Object.assign(new Error('Файл бэкапа потерян'), { status: 404 });
  const buf = fs.readFileSync(file);
  if (sha256(buf) !== backup.sha256) {
    throw Object.assign(new Error('Контрольная сумма бэкапа не совпала — файл повреждён'), { status: 409 });
  }
  const dir = db.serverDir(server.id);
  const tmp = `${dir}.restore-${Date.now()}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(dir, tmp);
  try {
    const result = zip.extractTo(buf, dir);
    fs.rmSync(tmp, { recursive: true, force: true });
    db.audit({
      action: 'backup.restore',
      actorId: actor ? actor.id : null,
      actorName: actor ? actor.username : 'system',
      target: server.name,
      meta: { backup: backup.name, files: result.files },
    });
    db.save();
    return result;
  } catch (err) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
    } catch { /* ignore */ }
    throw err;
  }
}

module.exports = { create, listFor, remove, restore, pathOf };
