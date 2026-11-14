'use strict';
/**
 * Минимальный ZIP: чтение и запись на встроенном zlib.
 * Нужен бэкапам серверов и пакетам обновлений — без внешних утилит,
 * одинаково работает на Windows и Linux.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ───────────────────────────── CRC32 ───────────────────────────── */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xffff;
  const day = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, day };
}

/* ───────────────────────────── запись ───────────────────────────── */

/**
 * @param {{name:string, data:Buffer, mtime?:number|Date, store?:boolean}[]} entries
 * @returns {Buffer}
 */
function write(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = String(entry.name).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name) continue;
    const isDir = entry.dir || name.endsWith('/');
    const data = isDir ? Buffer.alloc(0) : Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const nameBuf = Buffer.from(isDir ? name.replace(/\/?$/, '/') : name, 'utf8');
    const { time, day } = dosTime(entry.mtime);
    const crc = crc32(data);

    let method = 0;
    let payload = data;
    if (!isDir && !entry.store && data.length > 64) {
      const deflated = zlib.deflateRawSync(data, { level: 6 });
      if (deflated.length < data.length) {
        method = 8;
        payload = deflated;
      }
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(day, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(isDir ? 0x10 : 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/* ───────────────────────────── чтение ───────────────────────────── */

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * @param {Buffer} buf
 * @returns {{name:string, data:Buffer, dir:boolean, mtime:number}[]}
 */
function read(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('Файл не похож на ZIP');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('Не найден конец ZIP-архива');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset >= buf.length) throw new Error('Повреждён ZIP-архив');

  const items = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const day = buf.readUInt16LE(p + 14);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (!name || name.includes('..')) continue;
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);

    let data = Buffer.alloc(0);
    try {
      if (method === 0) data = raw;
      else if (method === 8) data = zlib.inflateRawSync(raw);
      else if (method === 12) data = zlib.inflateRawSync(raw);
      else continue;
    } catch {
      continue;
    }
    const mtime = new Date(1980 + (day >> 9), ((day >> 5) & 0xf) - 1, day & 0x1f, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2).getTime();
    items.push({ name, data, dir: name.endsWith('/') || (uncompSize === 0 && compSize === 0 && name.endsWith('/')), mtime, size: uncompSize });
  }
  return items;
}

/* ────────────────────────── вспомогательное ────────────────────────── */

function walk(dir, base = dir, out = [], filter = null) {
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of list) {
    const full = path.join(dir, item.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (filter && !filter(full, rel, item)) continue;
    if (item.isDirectory()) {
      out.push({ name: rel + '/', dir: true, data: Buffer.alloc(0) });
      walk(full, base, out, filter);
    } else if (item.isFile()) {
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size > 512 * 1024 * 1024) continue;
      try {
        out.push({ name: rel, data: fs.readFileSync(full), mtime: stat.mtimeMs, dir: false });
      } catch { /* занятый файл — пропускаем */ }
    }
  }
  return out;
}

/** Упаковать каталог в ZIP-буфер. */
function zipDir(dir, opts = {}) {
  if (!fs.existsSync(dir)) throw new Error('Каталог не найден');
  const entries = walk(dir, dir, [], opts.filter);
  if (opts.prefix) {
    for (const e of entries) e.name = `${opts.prefix.replace(/\/$/, '')}/${e.name}`;
  }
  return write(entries);
}

/** Распаковать ZIP в каталог с защитой от выхода за его пределы. */
function extractTo(buf, dest) {
  const items = read(buf);
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  let files = 0;
  for (const item of items) {
    const target = path.resolve(root, item.name.replace(/^\/+/, ''));
    if (target !== root && !target.startsWith(root + path.sep)) continue;
    if (item.dir) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, item.data);
    files += 1;
  }
  return { files, entries: items.length };
}

module.exports = { crc32, write, read, zipDir, extractTo, walk };
