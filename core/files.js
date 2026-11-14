'use strict';
/**
 * Файловый менеджер сервера: всё строго внутри каталога сервера (jail),
 * как `files.*` в Pterodactyl. Плюс архивы (zip) для удобства.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const zip = require('./zip');
const { resolveInside, safeName, MB } = require('./util');

const TEXT_LIMIT = 2 * MB;
const EDIT_LIMIT = 4 * MB;

function root(server) {
  const dir = db.serverDir(server.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function full(server, rel = '') {
  return resolveInside(root(server), rel);
}

function relOf(server, abs) {
  return path.relative(root(server), abs).replace(/\\/g, '/');
}

function isBinary(buf) {
  const sample = buf.slice(0, 8000);
  for (let i = 0; i < sample.length; i += 1) if (sample[i] === 0) return true;
  return false;
}

function list(server, rel = '') {
  const dir = full(server, rel);
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw Object.assign(new Error('Каталог не найден'), { status: 404 });
  }
  if (!stat.isDirectory()) throw Object.assign(new Error('Это не каталог'), { status: 400 });
  const items = fs.readdirSync(dir, { withFileTypes: true }).map((item) => {
    const abs = path.join(dir, item.name);
    let st = null;
    try { st = fs.lstatSync(abs); } catch { /* ignore */ }
    return {
      name: item.name,
      path: relOf(server, abs),
      dir: item.isDirectory(),
      symlink: item.isSymbolicLink(),
      size: st && !item.isDirectory() ? st.size : 0,
      mtime: st ? st.mtimeMs : 0,
      editable: item.isFile() && st && st.size <= EDIT_LIMIT,
    };
  }).sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'ru') : a.dir ? -1 : 1));
  const parent = rel ? path.posix.dirname(rel.replace(/\\/g, '/')) : null;
  return { path: relOf(server, dir), parent: parent === '.' ? '' : parent, entries: items };
}

function read(server, rel) {
  const abs = full(server, rel);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw Object.assign(new Error('Это не файл'), { status: 400 });
  if (st.size > EDIT_LIMIT) throw Object.assign(new Error('Файл больше 4 МБ — скачайте его'), { status: 413 });
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) return { binary: true, size: st.size, mtime: st.mtimeMs, content: '', path: rel };
  return { binary: false, size: st.size, mtime: st.mtimeMs, content: buf.toString('utf8'), path: rel };
}

function write(server, rel, content) {
  const abs = full(server, rel);
  if (Buffer.byteLength(content) > EDIT_LIMIT) throw Object.assign(new Error('Файл больше 4 МБ'), { status: 413 });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return { path: rel, size: fs.statSync(abs).size };
}

function mkdir(server, rel, name) {
  const clean = safeName(name);
  if (!clean) throw Object.assign(new Error('Недопустимое имя папки'), { status: 400 });
  const abs = full(server, path.posix.join(rel || '', clean));
  if (fs.existsSync(abs)) throw Object.assign(new Error('Папка уже существует'), { status: 409 });
  fs.mkdirSync(abs, { recursive: true });
  return { path: relOf(server, abs) };
}

function createFile(server, rel, name, content = '') {
  const clean = safeName(name);
  if (!clean) throw Object.assign(new Error('Недопустимое имя файла'), { status: 400 });
  const abs = full(server, path.posix.join(rel || '', clean));
  if (fs.existsSync(abs)) throw Object.assign(new Error('Файл уже существует'), { status: 409 });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return { path: relOf(server, abs) };
}

function rename(server, rel, name) {
  const clean = safeName(name);
  if (!clean) throw Object.assign(new Error('Недопустимое имя'), { status: 400 });
  const abs = full(server, rel);
  const target = path.join(path.dirname(abs), clean);
  if (target !== abs && fs.existsSync(target)) throw Object.assign(new Error('Имя уже занято'), { status: 409 });
  fs.renameSync(abs, target);
  return { path: relOf(server, target) };
}

function remove(server, rel) {
  const abs = full(server, rel);
  if (abs === root(server)) throw Object.assign(new Error('Нельзя удалить корень сервера'), { status: 400 });
  let st;
  try { st = fs.lstatSync(abs); } catch { throw Object.assign(new Error('Файл не найден'), { status: 404 }); }
  if (st.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
  else fs.unlinkSync(abs);
  return { removed: rel };
}

function diskUsed(server) {
  const { dirSize } = require('./daemon');
  return dirSize(root(server));
}

function upload(server, rel, name, buffer) {
  const clean = safeName(name);
  if (!clean) throw Object.assign(new Error('Недопустимое имя файла'), { status: 400 });
  const limitBytes = Number(server.limits.disk || 0) * MB;
  if (limitBytes && diskUsed(server) + buffer.length > limitBytes) {
    throw Object.assign(new Error('Не хватает места: лимит диска сервера исчерпан'), { status: 409 });
  }
  const abs = full(server, path.posix.join(rel || '', clean));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return { path: relOf(server, abs), size: buffer.length };
}

function archive(server, paths, name) {
  const entries = [];
  for (const rel of paths) {
    const abs = full(server, rel);
    let st;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      for (const entry of zip.walk(abs, abs)) entries.push({ ...entry, name: `${path.basename(abs)}/${entry.name}` });
      entries.push({ name: `${path.basename(abs)}/`, dir: true, data: Buffer.alloc(0) });
    } else {
      entries.push({ name: path.basename(abs), data: fs.readFileSync(abs), mtime: st.mtimeMs });
    }
  }
  const buf = zip.write(entries);
  const fileName = safeName(name || `archive-${Date.now()}.zip`).replace(/\.zip$/i, '') + '.zip';
  const abs = full(server, fileName);
  fs.writeFileSync(abs, buf);
  return { path: fileName, size: buf.length, files: entries.filter((e) => !e.dir).length };
}

function extract(server, rel) {
  const abs = full(server, rel);
  const buf = fs.readFileSync(abs);
  const target = path.join(path.dirname(abs), path.basename(abs).replace(/\.zip$/i, ''));
  const result = zip.extractTo(buf, target);
  return { path: relOf(server, target), ...result };
}

function download(server, rel) {
  const abs = full(server, rel);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw Object.assign(new Error('Это не файл'), { status: 400 });
  return { abs, name: path.basename(abs), size: st.size, mtime: st.mtimeMs };
}

module.exports = {
  list, read, write, mkdir, createFile, rename, remove, upload, archive, extract, download, diskUsed, full, root, isBinary,
};
