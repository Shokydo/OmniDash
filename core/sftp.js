'use strict';
/**
 * SFTP-сервер OmniDash.
 *
 * Подключение: логин и пароль от аккаунта панели (любой SFTP-клиент:
 * FileZilla, WinSCP, scp, Midnight Commander). После входа пользователь
 * видит каталог со своими серверами — папки-ссылки на каталоги серверов.
 *
 * Пути жёстко изолированы: resolveSafe не выпускает за пределы каталогов
 * серверов, доступных пользователю (проверка и по реальным путям, чтобы
 * симлинки внутри серверов не вели наружу).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const auth = require('./auth');
const serversCore = require('./servers');

let ssh2 = null;
try {
  ssh2 = require('ssh2');
} catch {
  ssh2 = null;
}

let server = null;
let running = false;
let lastError = '';
let handleSeq = 0;
const clients = new Set();

function settings() {
  const s = (db.data.settings && db.data.settings.sftp) || {};
  return {
    enabled: s.enabled !== false,
    port: Math.min(65535, Math.max(1, parseInt(s.port, 10) || 2222)),
  };
}

function sftpDir() {
  return path.join(db.DATA_DIR, 'sftp');
}

function rootsDir() {
  return path.join(sftpDir(), 'roots');
}

function ensureHostKey() {
  const dir = sftpDir();
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, 'host_key');
  if (fs.existsSync(keyFile)) {
    const existing = fs.readFileSync(keyFile, 'utf8');
    // ssh2 не парсит PKCS8 (BEGIN PRIVATE KEY) — такой ключ перегенерируем.
    if (!existing.includes('BEGIN PRIVATE KEY')) return existing;
  }
  // ECDSA P-256 в SEC1-формате — ssh2 парсит надёжно и быстро.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'sec1', format: 'pem' });
  fs.writeFileSync(keyFile, pem, { mode: 0o600 });
  try {
    const der = publicKey.export({ type: 'spki', format: 'der' });
    fs.writeFileSync(keyFile + '.pub', `ecdsa-sha2-nistp256 ${der.toString('base64')} omnidash-sftp\n`);
  } catch { /* ignore */ }
  return pem;
}

function slug(name, used) {
  const base = String(name || 'server').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'server';
  let out = base;
  let i = 2;
  while (used.has(out)) {
    out = `${base}-${i}`;
    i += 1;
  }
  used.add(out);
  return out;
}

function cleanupRoot(root) {
  try {
    if (!fs.existsSync(root)) return;
    for (const name of fs.readdirSync(root)) {
      try { fs.unlinkSync(path.join(root, name)); } catch { /* ignore */ }
    }
    fs.rmdirSync(root);
  } catch { /* ignore */ }
}

/** Виртуальный корень: папки-ссылки на каталоги доступных серверов. */
function buildRoot(user) {
  const root = path.join(rootsDir(), String(user.id).replace(/[^\w-]/g, ''));
  cleanupRoot(root);
  fs.mkdirSync(root, { recursive: true });
  const used = new Set();
  const allowed = [fs.realpathSync(root)];
  for (const srv of serversCore.visibleServers(user)) {
    const dir = db.serverDir(srv.id);
    if (!fs.existsSync(dir)) continue;
    const link = path.join(root, slug(srv.name, used));
    try {
      fs.symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
      allowed.push(fs.realpathSync(dir));
    } catch { /* сервер недоступен по SFTP */ }
  }
  return { root, allowed };
}

/**
 * Разрешить клиентский путь внутри jail.
 * null — выход за пределы разрешённых каталогов запрещён.
 */
function resolveSafe(root, allowed, p) {
  const clean = String(p || '/').replace(/\\/g, '/');
  const rel = path.posix.normalize('/' + clean).replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  // Реальный путь ближайшего существующего предка — защита от симлинков наружу.
  let cur = abs;
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  let real;
  try {
    real = fs.realpathSync(cur);
  } catch {
    return null;
  }
  if (!allowed.some((a) => real === a || real.startsWith(a + path.sep))) return null;
  return rest.length ? path.join(real, ...rest) : real;
}

function toAttrs(st) {
  return {
    mode: st.mode,
    uid: 1000,
    gid: 1000,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function longname(name, st) {
  const type = st.isDirectory() ? 'd' : (st.isSymbolicLink() ? 'l' : '-');
  const perms = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
  const oct = (st.mode & 0o777).toString(8).padStart(3, '0');
  const mode = [...oct].map((c) => perms[parseInt(c, 10)]).join('');
  const d = new Date(st.mtimeMs);
  const date = `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${type}${mode} 1 user user ${st.size} ${date} ${name}`;
}

function fail(sftp, STATUS, reqid, err) {
  const code = err && err.code === 'ENOENT' ? STATUS.NO_SUCH_FILE
    : err && (err.code === 'EACCES' || err.code === 'EPERM') ? STATUS.PERMISSION_DENIED
      : STATUS.FAILURE;
  sftp.status(reqid, code, err ? String(err.message || err).slice(0, 200) : 'Ошибка');
}

// Коды статуса SFTP (ssh2 1.x не выставляет их на конструкторе класса).
const STATUS = {
  OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3,
  FAILURE: 4, BAD_MESSAGE: 5, NO_CONNECTION: 6, CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8, INVALID_HANDLE: 9,
};

function attachSftp(sftp, user, root, allowed) {
  const handles = new Map();
  const newHandle = () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE((handleSeq = (handleSeq + 1) >>> 0));
    return buf;
  };
  const getHandle = (h) => handles.get(Buffer.from(h).toString('hex'));

  sftp.on('OPEN', (reqid, filename, flags, attrs) => {
    const abs = resolveSafe(root, allowed, filename);
    if (!abs) return sftp.status(reqid, STATUS.NO_SUCH_FILE, 'Нет доступа');
    const READ = !!(flags & 0x1);
    const WRITE = !!(flags & 0x2);
    const APPEND = !!(flags & 0x4);
    const CREAT = !!(flags & 0x8);
    const TRUNC = !!(flags & 0x10);
    const EXCL = !!(flags & 0x20);
    const exists = fs.existsSync(abs);
    if (EXCL && CREAT && exists) return sftp.status(reqid, STATUS.FAILURE, 'Файл уже существует');
    let fsFlags;
    if (APPEND) fsFlags = READ ? 'a+' : 'a';
    else if (TRUNC || (!exists && CREAT)) fsFlags = READ ? 'w+' : 'w';
    else if (!exists) return sftp.status(reqid, STATUS.NO_SUCH_FILE, 'Нет файла');
    else fsFlags = WRITE ? 'r+' : 'r';
    let fd;
    try {
      fd = fs.openSync(abs, fsFlags);
    } catch (err) {
      return fail(sftp, STATUS, reqid, err);
    }
    const handle = newHandle();
    handles.set(handle.toString('hex'), { type: 'file', fd, path: abs });
    sftp.handle(reqid, handle);
  });

  sftp.on('READ', (reqid, handle, offset, length) => {
    const h = getHandle(handle);
    if (!h || h.type !== 'file') return sftp.status(reqid, STATUS.FAILURE, 'Bad handle');
    const buf = Buffer.alloc(length);
    let n = 0;
    try {
      n = fs.readSync(h.fd, buf, 0, length, offset);
    } catch (err) {
      return fail(sftp, STATUS, reqid, err);
    }
    if (n === 0) return sftp.status(reqid, STATUS.EOF, 'EOF');
    sftp.data(reqid, buf.slice(0, n));
  });

  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const h = getHandle(handle);
    if (!h || h.type !== 'file') return sftp.status(reqid, STATUS.FAILURE, 'Bad handle');
    try {
      fs.writeSync(h.fd, data, 0, data.length, offset);
    } catch (err) {
      return fail(sftp, STATUS, reqid, err);
    }
    sftp.status(reqid, STATUS.OK);
  });

  sftp.on('CLOSE', (reqid, handle) => {
    const key = Buffer.from(handle).toString('hex');
    const h = handles.get(key);
    if (h && h.type === 'file') {
      try { fs.closeSync(h.fd); } catch { /* ignore */ }
    }
    handles.delete(key);
    sftp.status(reqid, STATUS.OK);
  });

  sftp.on('OPENDIR', (reqid, filename) => {
    const abs = resolveSafe(root, allowed, filename);
    if (!abs) return sftp.status(reqid, STATUS.NO_SUCH_FILE, 'Нет доступа');
    let st;
    try {
      st = fs.statSync(abs);
    } catch (err) {
      return fail(sftp, STATUS, reqid, err);
    }
    if (!st.isDirectory()) return sftp.status(reqid, STATUS.FAILURE, 'Не каталог');
    let names;
    try {
      names = fs.readdirSync(abs);
    } catch (err) {
      return fail(sftp, STATUS, reqid, err);
    }
    const handle = newHandle();
    handles.set(handle.toString('hex'), { type: 'dir', path: abs, names, sent: false });
    sftp.handle(reqid, handle);
  });

  sftp.on('READDIR', (reqid, handle) => {
    const h = getHandle(handle);
    if (!h || h.type !== 'dir') return sftp.status(reqid, STATUS.FAILURE, 'Bad handle');
    if (h.sent) return sftp.status(reqid, STATUS.EOF, 'EOF');
    h.sent = true;
    const out = [];
    const pushEntry = (name, abs) => {
      try {
        const st = fs.statSync(abs);
        out.push({ filename: name, longname: longname(name, st), attrs: toAttrs(st) });
      } catch { /* ignore */ }
    };
    pushEntry('.', h.path);
    pushEntry('..', path.dirname(h.path));
    for (const name of h.names) pushEntry(name, path.join(h.path, name));
    sftp.name(reqid, out);
  });

  const statHandler = (follow) => (reqid, filename) => {
    const abs = resolveSafe(root, allowed, filename);
    if (!abs) return sftp.status(reqid, STATUS.NO_SUCH_FILE, 'Нет доступа');
    try {
      const st = follow ? fs.statSync(abs) : fs.lstatSync(abs);
      sftp.attrs(reqid, toAttrs(st));
    } catch (err) {
      fail(sftp, STATUS, reqid, err);
    }
  };
  sftp.on('STAT', statHandler(true));
  sftp.on('LSTAT', statHandler(false));

  sftp.on('FSTAT', (reqid, handle) => {
    const h = getHandle(handle);
    if (!h || h.type !== 'file') return sftp.status(reqid, STATUS.FAILURE, 'Bad handle');
    try {
      sftp.attrs(reqid, toAttrs(fs.fstatSync(h.fd)));
    } catch (err) {
      fail(sftp, STATUS, reqid, err);
    }
  });

  sftp.on('MKDIR', (reqid, filename) => {
    const abs = resolveSafe(root, allowed, filename);
    if (!abs) return sftp.status(reqid, STATUS.PERMISSION_DENIED, 'Нет доступа');
    try {
      fs.mkdirSync(abs);
      sftp.status(reqid, STATUS.OK);
    } catch (err) {
      fail(sftp, STATUS, reqid, err);
    }
  });

  sftp.on('RMDIR', (reqid, filename) => {
    const abs = resolveSafe(root, allowed, filename);
    if (!abs) return sftp.status(reqid, STATUS.PERMISSION_DENIED, 'Нет доступа');
    try {
      fs.rmdirSync(abs);
      sftp.status(reqid, STATUS.OK);
    } catch (err) {
      fail(sftp, STATUS, reqid, err);
    }
  });

  sftp.on('REMOVE', (reqid, filename) => {
    const abs = resolveSafe(root, allowed, filename);
    if (!abs) return sftp.status(reqid, STATUS.PERMISSION_DENIED, 'Нет доступа');
    try {
      fs.unlinkSync(abs);
      sftp.status(reqid, STATUS.OK);
    } catch (err) {
      fail(sftp, STATUS, reqid, err);
    }
  });

  sftp.on('RENAME', (reqid, oldPath, newPath) => {
    const from = resolveSafe(root, allowed, oldPath);
    const to = resolveSafe(root, allowed, newPath);
    if (!from || !to) return sftp.status(reqid, STATUS.PERMISSION_DENIED, 'Нет доступа');
    try {
      fs.renameSync(from, to);
      sftp.status(reqid, STATUS.OK);
    } catch (err) {
      fail(sftp, STATUS, reqid, err);
    }
  });

  sftp.on('REALPATH', (reqid, filename) => {
    const abs = resolveSafe(root, allowed, filename);
    if (!abs) return sftp.status(reqid, STATUS.NO_SUCH_FILE, 'Нет доступа');
    const rel = path.relative(root, abs).split(path.sep).join('/');
    sftp.name(reqid, [{ filename: '/' + rel }]);
  });

  sftp.on('READLINK', (reqid, filename) => {
    const abs = resolveSafe(root, allowed, filename);
    if (!abs) return sftp.status(reqid, STATUS.NO_SUCH_FILE, 'Нет доступа');
    try {
      sftp.name(reqid, [{ filename: fs.readlinkSync(abs) }]);
    } catch (err) {
      fail(sftp, STATUS, reqid, err);
    }
  });

  const applyAttrs = (target, attrs, isFd) => {
    if (!attrs) return;
    try {
      if (attrs.mode !== undefined) {
        if (isFd) fs.fchmodSync(target, attrs.mode & 0o7777);
        else fs.chmodSync(target, attrs.mode & 0o7777);
      }
      if (attrs.atime !== undefined || attrs.mtime !== undefined) {
        const nowSec = Math.floor(Date.now() / 1000);
        const atime = new Date((attrs.atime !== undefined ? attrs.atime : nowSec) * 1000);
        const mtime = new Date((attrs.mtime !== undefined ? attrs.mtime : nowSec) * 1000);
        if (isFd) fs.futimesSync(target, atime, mtime);
        else fs.utimesSync(target, atime, mtime);
      }
    } catch { /* ignore */ }
  };

  sftp.on('SETSTAT', (reqid, filename, attrs) => {
    const abs = resolveSafe(root, allowed, filename);
    if (!abs) return sftp.status(reqid, STATUS.PERMISSION_DENIED, 'Нет доступа');
    applyAttrs(abs, attrs, false);
    sftp.status(reqid, STATUS.OK);
  });

  sftp.on('FSETSTAT', (reqid, handle, attrs) => {
    const h = getHandle(handle);
    if (!h || h.type !== 'file') return sftp.status(reqid, STATUS.FAILURE, 'Bad handle');
    applyAttrs(h.fd, attrs, true);
    sftp.status(reqid, STATUS.OK);
  });

  sftp.on('SYMLINK', (reqid, linkpath, targetpath) => {
    sftp.status(reqid, STATUS.OP_UNSUPPORTED, 'Симлинки по SFTP запрещены');
  });
  sftp.on('LINK', (reqid, oldpath, newpath) => {
    sftp.status(reqid, STATUS.OP_UNSUPPORTED, 'Жёсткие ссылки не поддерживаются');
  });
  sftp.on('EXTENDED', (reqid) => {
    sftp.status(reqid, STATUS.OP_UNSUPPORTED, 'Не поддерживается');
  });

  return () => {
    for (const h of handles.values()) {
      if (h.type === 'file') {
        try { fs.closeSync(h.fd); } catch { /* ignore */ }
      }
    }
    handles.clear();
  };
}

function onClient(client) {
  clients.add(client);
  let user = null;
  let rootInfo = null;
  let closeSftp = null;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clients.delete(client);
    try { closeSftp && closeSftp(); } catch { /* ignore */ }
    if (rootInfo) cleanupRoot(rootInfo.root);
  };

  client.on('authentication', (ctx) => {
    if (ctx.method !== 'password') return ctx.reject(['password']);
    const found = db.data.users.find((u) => u.username === ctx.username);
    if (!found || found.suspended || !auth.verifyPassword(ctx.password, found)) {
      return ctx.reject(['password']);
    }
    user = found;
    ctx.accept();
  });

  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('sftp', (acceptSftp) => {
        if (!user) return;
        try {
          rootInfo = buildRoot(user);
        } catch (err) {
          console.warn('[sftp] не удалось подготовить каталог:', err.message);
          return;
        }
        const ip = (client.info && client.info.remoteAddress) || '';
        db.audit({
          action: 'sftp.login',
          actorId: user.id,
          actorName: user.username,
          meta: { ip },
        });
        const sftp = acceptSftp();
        closeSftp = attachSftp(sftp, user, rootInfo.root, rootInfo.allowed);
        sftp.on('end', cleanup);
      });
      session.on('shell', (accept) => accept().end());
      session.on('exec', (accept) => accept().reject());
      session.on('env', (accept) => accept().accept());
      session.on('pty', (accept) => accept().reject());
      session.on('window-change', () => {});
      session.on('signal', () => {});
      session.on('exit', () => {});
    });
  });

  client.on('end', cleanup);
  client.on('close', cleanup);
  client.on('error', cleanup);
}

function start() {
  const cfg = settings();
  if (!cfg.enabled) return;
  if (!ssh2) {
    lastError = 'ssh2 не установлен — выполните npm install';
    console.warn('[sftp] ssh2 не установлен, SFTP недоступен. Выполните: npm install');
    return;
  }
  if (server) return;
  let hostKey;
  try {
    hostKey = ensureHostKey();
  } catch (err) {
    lastError = err.message;
    console.warn('[sftp] не удалось подготовить ключ хоста:', err.message);
    return;
  }
  try {
    server = new ssh2.Server({ hostKeys: [hostKey] }, onClient);
  } catch (err) {
    lastError = err.message;
    server = null;
    console.warn(`[sftp] не удалось запустить: ${err.message}`);
    return;
  }
  server.on('error', (err) => {
    lastError = err.message;
    running = false;
    console.warn(`[sftp] ошибка: ${err.message}`);
  });
  try {
    server.listen(cfg.port, '0.0.0.0', () => {
      running = true;
      lastError = '';
      console.log(`[sftp] слушает 0.0.0.0:${cfg.port} — логин/пароль от аккаунта панели`);
    });
  } catch (err) {
    lastError = err.message;
    server = null;
    console.warn(`[sftp] не удалось слушать порт ${cfg.port}: ${err.message}`);
  }
}

function stop() {
  if (!server) return;
  for (const c of clients) {
    try { c.end(); } catch { /* ignore */ }
  }
  clients.clear();
  try {
    server.close();
  } catch { /* ignore */ }
  server = null;
  running = false;
}

/** Перезапуск при смене настроек (вкл/выкл, порт). */
function apply() {
  stop();
  start();
}

function status() {
  const cfg = settings();
  return { enabled: cfg.enabled, port: cfg.port, running, error: lastError };
}

module.exports = { start, stop, apply, status, settings };
