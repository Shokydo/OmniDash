'use strict';
/**
 * Файловый менеджер сервера (в стиле OmniPanel):
 * - jail: всё строго внутри каталога сервера, проверка симлинков;
 * - дерево каталогов, поиск по имени, чтение/запись с лимитами;
 * - server.properties: чтение/запись с экранированием \\uXXXX;
 * - архивы zip (создание/распаковка), загрузка/скачивание.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const zip = require('./zip');
const { resolveInside, safeName, MB } = require('./util');

const TEXT_LIMIT = 2 * MB;
const EDIT_LIMIT = 4 * MB;
const MAX_READ = 16 * MB;
const MAX_WRITE = 32 * MB;
const MAX_TREE_ENTRIES = 4000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', 'logs', '.arena']);

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

function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'].includes(ext)) return 'image';
  if (['.zip', '.tar', '.gz', '.tgz', '.jar', '.rar', '.7z'].includes(ext)) return 'archive';
  if (['.js', '.json', '.yml', '.yaml', '.toml', '.xml', '.html', '.css', '.sh', '.txt', '.md', '.properties', '.cfg', '.conf', '.ini', '.env', '.log', '.sql', '.py', '.java', '.ts', '.tsx', '.jsx', '.vue', '.gradle', '.gitignore', '.dockerignore', '.editorconfig'].includes(ext)) return 'text';
  if (['.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov', '.pdf'].includes(ext)) return 'media';
  return 'other';
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
      kind: item.isDirectory() ? 'dir' : kindOf(item.name),
      editable: item.isFile() && st && st.size <= EDIT_LIMIT,
    };
  }).sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'ru', { numeric: true }) : a.dir ? -1 : 1));
  const parent = rel ? path.posix.dirname(rel.replace(/\\/g, '/')) : null;
  return { path: relOf(server, dir), parent: parent === '.' ? '' : parent, entries: items };
}

function tree(server) {
  const base = root(server);
  const out = [];
  let count = 0;
  const walk = (dir, depth) => {
    if (count >= MAX_TREE_ENTRIES || depth > 12) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name, 'ru', { numeric: true }) : a.isDirectory() ? -1 : 1));
    for (const item of entries) {
      if (count >= MAX_TREE_ENTRIES) break;
      if (item.isDirectory() && SKIP_DIRS.has(item.name)) continue;
      if (item.isSymbolicLink()) continue;
      const abs = path.join(dir, item.name);
      count += 1;
      out.push({ path: relOf(server, abs), name: item.name, dir: item.isDirectory(), depth });
      if (item.isDirectory()) walk(abs, depth + 1);
    }
  };
  walk(base, 0);
  return { entries: out, truncated: count >= MAX_TREE_ENTRIES };
}

function read(server, rel) {
  const abs = full(server, rel);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw Object.assign(new Error('Это не файл'), { status: 400 });
  if (st.size > MAX_READ) throw Object.assign(new Error('Файл больше 16 МБ — скачайте его'), { status: 413 });
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) return { binary: true, size: st.size, mtime: st.mtimeMs, content: '', path: rel, kind: kindOf(path.basename(abs)) };
  let content = buf.toString('utf8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  return { binary: false, size: st.size, mtime: st.mtimeMs, content, path: rel, kind: kindOf(path.basename(abs)) };
}

function write(server, rel, content) {
  const abs = full(server, rel);
  if (Buffer.byteLength(content) > MAX_WRITE) throw Object.assign(new Error('Файл больше 32 МБ'), { status: 413 });
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

function move(server, rel, destRel) {
  const abs = full(server, rel);
  const dest = full(server, destRel);
  if (abs === root(server)) throw Object.assign(new Error('Нельзя переместить корень сервера'), { status: 400 });
  if (dest === abs || dest.startsWith(abs + path.sep)) throw Object.assign(new Error('Нельзя переместить внутрь себя'), { status: 400 });
  if (fs.existsSync(dest)) throw Object.assign(new Error('Цель уже существует'), { status: 409 });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(abs, dest);
  return { path: relOf(server, dest) };
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

function search(server, query, limit = 200) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { results: [] };
  const base = root(server);
  const results = [];
  const walk = (dir) => {
    if (results.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of entries) {
      if (results.length >= limit) return;
      if (item.isDirectory() && SKIP_DIRS.has(item.name)) continue;
      if (item.isSymbolicLink()) continue;
      const abs = path.join(dir, item.name);
      if (item.name.toLowerCase().includes(q)) {
        results.push({ path: relOf(server, abs), name: item.name, dir: item.isDirectory() });
      }
      if (item.isDirectory()) walk(abs);
    }
  };
  walk(base);
  return { results };
}

function readImage(server, rel) {
  const abs = full(server, rel);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw Object.assign(new Error('Это не файл'), { status: 400 });
  if (st.size > 12 * MB) throw Object.assign(new Error('Картинка больше 12 МБ'), { status: 413 });
  const ext = path.extname(abs).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon' }[ext];
  if (!mime) throw Object.assign(new Error('Не картинка'), { status: 400 });
  const buf = fs.readFileSync(abs);
  return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, size: st.size };
}

/* ───────── server.properties ───────── */
function propsPath(server) {
  return path.join(root(server), 'server.properties');
}

function readProps(server) {
  const file = propsPath(server);
  if (!fs.existsSync(file)) return { exists: false, props: {}, raw: '' };
  const raw = fs.readFileSync(file, 'utf8');
  const props = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    props[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return { exists: true, props, raw };
}

function escapeProp(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    .replace(/[^\x20-\x7e]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

function writeProps(server, props) {
  const file = propsPath(server);
  const lines = ['# OmniDash — server.properties', `# ${new Date().toISOString()}`];
  for (const [key, value] of Object.entries(props || {})) {
    if (key === undefined || key === null || String(key).trim() === '') continue;
    lines.push(`${String(key).trim()}=${escapeProp(value ?? '')}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { path: 'server.properties', size: fs.statSync(file).size };
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
  list, tree, read, write, mkdir, createFile, rename, move, remove, search,
  readImage, readProps, writeProps, upload, archive, extract, download,
  diskUsed, full, root, isBinary, kindOf, TEXT_LIMIT, EDIT_LIMIT,
};
