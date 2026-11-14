'use strict';
/**
 * REST API OmniDash.
 * Роутер без зависимостей: method + шаблон пути ('/api/servers/:id/power').
 * Все ответы — JSON {ok:true, data} либо {ok:false, error, code}.
 */
const fs = require('fs');
const path = require('path');
const {
  now, iso, clamp, int, num, uuid, id, parseCookies, createLimiter, fmtBytes, fmtDuration,
  safeName, publicUser, parseVersion, compareVersions,
} = require('./util');
const db = require('./db');
const auth = require('./auth');
const serversCore = require('./servers');
const daemonCore = require('./daemon');
const filesCore = require('./files');
const backupsCore = require('./backups');
const eggsCore = require('./eggs');
const { makeTask, ACTIONS } = require('./scheduler');

const STATUSES = daemonCore.STATUS;
const loginLimiter = createLimiter(10, 5 * 60000);
const registerLimiter = createLimiter(6, 60 * 60000);

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'ERROR';
  }
}
const bad = (msg) => new HttpError(400, msg, 'BAD_REQUEST');
const notFound = (msg = 'Не найдено') => new HttpError(404, msg, 'NOT_FOUND');
const forbidden = (msg = 'Недостаточно прав') => new HttpError(403, msg, 'FORBIDDEN');
const conflict = (msg) => new HttpError(409, msg, 'CONFLICT');

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Слишком большой запрос', 'PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw bad('Некорректный JSON в теле запроса');
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function ok(res, data, extraHeaders) {
  sendJson(res, 200, { ok: true, data }, extraHeaders);
}

const MIME = {
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jar': 'application/java-archive',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
};

function streamFile(res, abs, name, inline = false) {
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw notFound('Файл не найден');
  }
  if (!stat.isFile()) throw notFound('Это не файл');
  const ext = path.extname(abs).toLowerCase();
  const encoded = encodeURIComponent(name).replace(/'/g, '%27');
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(abs).pipe(res);
}

function serverJson(server, user, daemon) {
  const owner = db.userById(server.ownerId);
  const node = db.nodeById(server.nodeId);
  const egg = db.eggById(server.eggId);
  const primary = db.allocationById(server.allocationId);
  const access = serversCore.access(user, server);
  const state = daemon ? daemon.publicState(server.id) : null;
  const ownerBackups = db.data.backups.filter((b) => b.serverId === server.id).length;
  return {
    id: server.id,
    uuid: server.uuid,
    name: server.name,
    description: server.description,
    status: server.suspended ? STATUSES.SUSPENDED : (state ? state.status : STATUSES.OFFLINE),
    suspended: !!server.suspended,
    suspendReason: server.suspendReason || null,
    owner: owner ? { id: owner.id, username: owner.username, avatarColor: owner.avatarColor } : null,
    node: node ? { id: node.id, name: node.name, location: node.location, flag: node.flag, status: node.status } : null,
    egg: egg ? { id: egg.id, name: egg.name, color: egg.color, category: egg.category } : null,
    allocation: primary ? { id: primary.id, ip: primary.ip, port: primary.port, label: `${primary.ip}:${primary.port}` } : null,
    allocations: (server.allocations || []).map((aid) => {
      const a = db.allocationById(aid);
      return a ? { id: a.id, ip: a.ip, port: a.port, primary: a.id === server.allocationId } : null;
    }).filter(Boolean),
    limits: server.limits,
    environment: server.environment || {},
    startupOverride: server.startupOverride || null,
    usage: state ? {
      cpu: state.cpu,
      memory: state.memory,
      disk: state.disk,
      players: state.players,
      tps: state.tps,
      uptimeMs: state.uptimeMs,
      startedAt: state.startedAt,
      pid: state.pid,
      history: state.history,
    } : { cpu: 0, memory: 0, disk: 0, players: 0, tps: null, uptimeMs: 0, history: [] },
    expiresAt: server.expiresAt || null,
    daysLeft: serversCore.daysLeft(server),
    createdAt: server.createdAt,
    renewals: server.renewals || 0,
    autoStart: !!server.autoStart,
    subusers: (server.subusers || []).map((s) => {
      const u = db.userById(s.userId);
      return u ? { id: u.id, username: u.username, perms: s.perms, avatarColor: u.avatarColor } : null;
    }).filter(Boolean),
    tasks: (server.tasks || []).length,
    backups: ownerBackups,
    permissions: access.perms,
    isOwner: access.isOwner,
    isAdmin: access.isAdmin,
  };
}

function userJson(user, { withServers = false } = {}) {
  const usage = serversCore.usageOf(user.id);
  const out = {
    ...publicUser(user),
    limits: { ...db.data.settings.defaultLimits, ...(user.limits || {}) },
    usage,
    apiKeys: (user.apiKeys || []).map(auth.publicKey),
    servers: serversCore.ownedServers(user.id).length,
    sharedWith: db.data.servers.filter((s) => (s.subusers || []).some((x) => x.userId === user.id)).length,
  };
  if (withServers) {
    out.serverList = serversCore.ownedServers(user.id).map((s) => ({
      id: s.id, name: s.name, status: s.suspended ? 'suspended' : 'offline', eggId: s.eggId,
    }));
  }
  return out;
}

function sessionMeta(req) {
  return { ip: req.ip, ua: String(req.headers['user-agent'] || '') };
}

function permit(user, server, perm) {
  const access = serversCore.access(user, server);
  if (!access.ok) throw notFound('Сервер не найден');
  if (perm && !access.perms.includes(perm)) throw forbidden(`Нет права «${serversCore.PERM_LABELS[perm] || perm}»`);
  return access;
}

function adminOnly(user) {
  if (!auth.isAdmin(user)) throw forbidden('Доступно только администратору');
}

function nodeIsLocal(node) {
  return !!node && ['localhost', '127.0.0.1', '::1'].includes(String(node.fqdn).toLowerCase());
}

/* ─────────────────────────── агрегаты ─────────────────────────── */

function aggregateHistory(servers, daemon) {
  const series = [];
  for (let i = 0; i < 45; i += 1) series.push({ cpu: 0, memory: 0, t: 0 });
  for (const server of servers) {
    const list = daemon ? (daemon.history.get(server.id) || []) : [];
    const slice = list.slice(-45);
    slice.forEach((point, idx) => {
      const target = series[45 - slice.length + idx];
      if (!target) return;
      target.cpu += point.cpu || 0;
      target.memory += point.memory || 0;
      target.t = point.t;
    });
  }
  return series;
}

function buildDashboard(user, daemon) {
  const isAdmin = auth.isAdmin(user);
  const servers = serversCore.visibleServers(user);
  const allStates = servers.map((s) => ({ server: s, state: daemon.publicState(s.id) }));
  const online = allStates.filter((x) => [STATUSES.RUNNING, STATUSES.STARTING].includes(x.state.status));
  const users = isAdmin ? db.data.users : [user];
  const nodes = db.data.nodes.map((n) => {
    const usage = serversCore.nodeUsage(n.id);
    return {
      id: n.id,
      name: n.name,
      location: n.location,
      flag: n.flag,
      status: n.status,
      maintenance: n.maintenance,
      fqdn: n.fqdn,
      memoryTotal: n.memoryTotal,
      diskTotal: n.diskTotal,
      servers: isAdmin ? usage.servers : servers.filter((s) => s.nodeId === n.id).length,
      memoryUsed: isAdmin ? usage.memory : servers.filter((s) => s.nodeId === n.id).reduce((a, s) => a + int(s.limits.memory), 0),
      ports: usage.ports,
      portsUsed: usage.portsUsed,
    };
  });
  const totalMemoryLimit = servers.reduce((a, s) => a + int(s.limits.memory), 0);
  const totalDiskLimit = servers.reduce((a, s) => a + int(s.limits.disk), 0);
  const memoryUsed = allStates.reduce((a, x) => a + (x.state.memory || 0), 0);
  const diskUsed = allStates.reduce((a, x) => a + (x.state.disk || 0), 0);
  const cpu = allStates.reduce((a, x) => a + (x.state.cpu || 0), 0);
  const players = allStates.reduce((a, x) => a + (x.state.players || 0), 0);
  const activity = isAdmin
    ? db.data.audit.slice(0, 12)
    : db.data.audit.filter((a) => servers.some((s) => s.name === a.target)).slice(0, 12);
  const expiring = servers
    .filter((s) => s.expiresAt && !s.suspended)
    .map((s) => ({ id: s.id, name: s.name, expiresAt: s.expiresAt, daysLeft: serversCore.daysLeft(s) }))
    .filter((s) => s.daysLeft !== null && s.daysLeft <= 7)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  return {
    scope: isAdmin ? 'admin' : 'user',
    user: publicUser(user),
    counts: {
      servers: servers.length,
      online: online.length,
      suspended: servers.filter((s) => s.suspended).length,
      users: users.length,
      usersOnline: db.data.users.filter((u) => u.lastLoginAt && now() - u.lastLoginAt < 15 * 60000).length,
      nodes: db.data.nodes.length,
      nodesOnline: db.data.nodes.filter((n) => n.status === 'online').length,
      expiring: expiring.length,
      renewRequests: isAdmin ? (db.data.renewRequests || []).filter((r) => r.status === 'pending').length : 0,
    },
    usage: {
      cpu: Math.round(cpu * 10) / 10,
      memory: memoryUsed,
      memoryLimit: totalMemoryLimit,
      disk: diskUsed,
      diskLimit: totalDiskLimit,
      players,
    },
    nodes,
    history: aggregateHistory(servers, daemon),
    recent: servers
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 6)
      .map((s) => serverJson(s, user, daemon)),
    expiring,
    activity,
    limits: isAdmin ? null : { ...db.data.settings.defaultLimits, ...(user.limits || {}) },
    system: daemon.hostInfo(),
  };
}

/* ─────────────────────────── API ─────────────────────────── */

function createApi(deps) {
  const { daemon, scheduler, updater } = deps;
  const clients = new Set();
  const startedAt = now();

  function broadcast(event, payload) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      try {
        client.res.write(frame);
      } catch {
        clients.delete(client);
      }
    }
  }

  function notify(payload) {
    broadcast('notify', payload);
  }

  function canSee(user, serverId) {
    const server = db.serverById(serverId);
    if (!server) return false;
    return serversCore.access(user, server).ok;
  }

  /* ───────────── события демона → SSE ───────────── */
  daemon.on('log', (payload) => {
    for (const client of clients) {
      if (canSee(client.user, payload.serverId)) {
        try { client.res.write(`event: log\ndata: ${JSON.stringify(payload)}\n\n`); } catch { clients.delete(client); }
      }
    }
  });
  daemon.on('state', (payload) => {
    const server = db.serverById(payload.serverId);
    for (const client of clients) {
      if (server && canSee(client.user, payload.serverId)) {
        try { client.res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`); } catch { clients.delete(client); }
      }
    }
  });
  let statsTick = 0;
  daemon.on('stats', (payload) => {
    statsTick += 1;
    const server = db.serverById(payload.serverId);
    for (const client of clients) {
      if (server && canSee(client.user, payload.serverId)) {
        try { client.res.write(`event: stats\ndata: ${JSON.stringify(payload)}\n\n`); } catch { clients.delete(client); }
      }
    }
    if (statsTick % 5 === 0) broadcast('heartbeat', { at: now(), servers: db.data.servers.length });
  });
  daemon.on('notify', (payload) => {
    for (const client of clients) {
      if (payload.serverId && !canSee(client.user, payload.serverId)) continue;
      try { client.res.write(`event: notify\ndata: ${JSON.stringify(payload)}\n\n`); } catch { clients.delete(client); }
    }
  });

  function serverChanged(serverId) {
    broadcast('servers', { serverId, at: now() });
  }

  /* ───────────────────────── маршруты ───────────────────────── */

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    routes.push({ method, pattern, handler, opts, regex: patternToRegex(pattern) });
  };
  function patternToRegex(pattern) {
    const keys = [];
    const src = pattern
      .split('/')
      .map((part) => {
        if (part.startsWith(':')) {
          keys.push(part.slice(1));
          return '([^/]+)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    return { regex: new RegExp(`^${src}$`), keys };
  }

  /* ─────────── служебное / авторизация ─────────── */

  route('GET', '/api/meta', (ctx) => {
    const settings = db.data.settings;
    return {
      name: settings.panelName,
      company: settings.company,
      version: updater ? updater.currentVersion() : '1.0.0',
      buildId: db.data.meta.buildId,
      registrationOpen: !!settings.registrationOpen,
      expiryDays: settings.expiryDays,
      defaultLimits: settings.defaultLimits,
      motd: settings.motd || '',
      theme: settings.theme,
      accent: settings.accent,
      locale: settings.locale,
      startedAt,
      uptime: now() - startedAt,
      demo: {
        enabled: !!db.data.meta.demo,
        logins: db.data.meta.demo ? [
          { username: 'admin', password: 'omnidash', role: 'admin' },
          { username: 'steve', password: 'steve123', role: 'user' },
        ] : [],
      },
      features: {
        subusers: true, backups: true, scheduler: true, api: true,
        autoUpdate: !!updater, ssh: false, databases: false,
      },
    };
  }, { public: true });

  route('POST', '/api/auth/login', async (ctx) => {
    const { username, password } = ctx.body || {};
    const limit = loginLimiter(`${ctx.req.ip}|${String(username || '').toLowerCase()}`);
    if (!limit.ok) throw new HttpError(429, `Слишком много попыток. Повторите через ${limit.retry} с.`, 'RATE_LIMIT');
    if (!username || !password) throw bad('Введите логин и пароль');
    const user = db.userByName(username);
    if (!user || !auth.verifyPassword(password, user)) {
      db.audit({ action: 'auth.login.fail', actorName: String(username).slice(0, 40), meta: sessionMeta(ctx.req) });
      throw new HttpError(401, 'Неверный логин или пароль', 'BAD_CREDENTIALS');
    }
    if (user.suspended) throw new HttpError(403, 'Аккаунт заблокирован администратором', 'SUSPENDED');
    const { sid, ttl } = auth.createSession(user, ctx.req);
    user.lastLoginAt = now();
    db.save();
    db.audit({ action: 'auth.login', actorId: user.id, actorName: user.username, meta: sessionMeta(ctx.req) });
    return { user: publicUser(user), cookie: auth.cookieHeader(sid, Math.floor(ttl / 1000)) };
  }, { public: true });

  route('POST', '/api/auth/register', async (ctx) => {
    if (!db.data.settings.registrationOpen) throw forbidden('Регистрация закрыта — попросите администратора выдать аккаунт');
    const limit = registerLimiter(ctx.req.ip);
    if (!limit.ok) throw new HttpError(429, 'Слишком много регистраций, попробуйте позже', 'RATE_LIMIT');
    const { username, email, password } = ctx.body || {};
    const name = String(username || '').trim();
    if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(name)) throw bad('Логин: 3–24 символа, латиница, цифры, _ . -');
    if (db.userByName(name)) throw conflict('Такой логин уже занят');
    if (String(password || '').length < 8) throw bad('Пароль минимум 8 символов');
    const user = db.newUser({
      username: name,
      email: String(email || '').slice(0, 120),
      role: 'user',
      ...auth.hashPassword(String(password)),
    });
    db.audit({ action: 'user.register', actorId: user.id, actorName: user.username, meta: sessionMeta(ctx.req) });
    const { sid, ttl } = auth.createSession(user, ctx.req);
    return { user: publicUser(user), cookie: auth.cookieHeader(sid, Math.floor(ttl / 1000)) };
  }, { public: true });

  route('POST', '/api/auth/logout', (ctx) => {
    if (ctx.sid) auth.destroySession(ctx.sid);
    return { cookie: auth.clearCookieHeader() };
  });

  route('GET', '/api/auth/me', (ctx) => ({
    user: userJson(ctx.user),
    settings: {
      panelName: db.data.settings.panelName,
      theme: db.data.settings.theme,
      accent: db.data.settings.accent,
      compact: db.data.settings.compact,
    },
    roles: { admin: auth.isAdmin(ctx.user) },
  }));

  route('PATCH', '/api/auth/me', (ctx) => {
    const body = ctx.body || {};
    if (body.email !== undefined) ctx.user.email = String(body.email).slice(0, 120);
    if (body.avatarColor) ctx.user.avatarColor = String(body.avatarColor).slice(0, 20);
    if (body.currentPassword || body.newPassword) {
      if (!auth.verifyPassword(String(body.currentPassword || ''), ctx.user)) throw bad('Текущий пароль неверен');
      if (String(body.newPassword || '').length < 8) throw bad('Новый пароль минимум 8 символов');
      Object.assign(ctx.user, auth.hashPassword(String(body.newPassword)));
      // разлогиниваем остальные сессии
      for (const [sid, s] of Object.entries(db.data.sessions)) {
        if (s.userId === ctx.user.id && sid !== ctx.sid) delete db.data.sessions[sid];
      }
      db.audit({ action: 'auth.password.change', actorId: ctx.user.id, actorName: ctx.user.username });
    }
    db.save();
    return { user: userJson(ctx.user) };
  });

  route('GET', '/api/auth/keys', (ctx) => ({ keys: (ctx.user.apiKeys || []).map(auth.publicKey) }));
  route('POST', '/api/auth/keys', (ctx) => {
    if ((ctx.user.apiKeys || []).length >= 10) throw conflict('Максимум 10 ключей');
    const { secret, meta } = auth.createApiKey(ctx.user, (ctx.body || {}).name);
    db.audit({ action: 'api.key.create', actorId: ctx.user.id, actorName: ctx.user.username, meta: { name: meta.name } });
    return { secret, key: meta };
  });
  route('DELETE', '/api/auth/keys/:keyId', (ctx) => {
    const done = auth.revokeApiKey(ctx.user, ctx.params.keyId);
    if (!done) throw notFound('Ключ не найден');
    return { removed: true };
  });

  /* ─────────── SSE ─────────── */
  route('GET', '/api/events', (ctx) => {
    const res = ctx.res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    res.write(`event: hello\ndata: ${JSON.stringify({ at: now(), buildId: db.data.meta.buildId, version: updater ? updater.currentVersion() : '1.0.0' })}\n\n`);
    const client = { res, user: ctx.user, at: now() };
    clients.add(client);
    const ping = setInterval(() => {
      try { res.write(`event: ping\ndata: {"at":${now()}}\n\n`); } catch { /* ignore */ }
    }, 25000);
    if (ping.unref) ping.unref();
    ctx.req.on('close', () => {
      clearInterval(ping);
      clients.delete(client);
    });
    return undefined; // ответ уже открыт
  }, { public: false, raw: true });

  /* ─────────── дашборд ─────────── */
  route('GET', '/api/dashboard', (ctx) => buildDashboard(ctx.user, daemon));
  route('GET', '/api/system', (ctx) => {
    adminOnly(ctx.user);
    return {
      host: daemon.hostInfo(),
      node: process.version,
      dataDir: db.DATA_DIR,
      dbSize: (() => { try { return fs.statSync(db.DB_FILE).size; } catch { return 0; } })(),
      startedAt,
      uptime: now() - startedAt,
      counts: {
        users: db.data.users.length,
        servers: db.data.servers.length,
        backups: db.data.backups.length,
        allocations: db.data.allocations.length,
      },
      memory: process.memoryUsage(),
    };
  });

  /* ─────────── серверы ─────────── */
  route('GET', '/api/servers', (ctx) => {
    const list = serversCore.visibleServers(ctx.user);
    const q = String(ctx.query.q || '').trim().toLowerCase();
    const status = String(ctx.query.status || '').trim();
    const owner = String(ctx.query.owner || '').trim();
    const filtered = list.filter((s) => {
      if (q && !s.name.toLowerCase().includes(q) && !s.uuid.includes(q)) return false;
      if (owner && (db.userById(s.ownerId) || {}).username !== owner) return false;
      if (status) {
        const st = daemon.publicState(s.id);
        const current = s.suspended ? 'suspended' : st.status;
        if (status === 'active' ? !['running', 'starting'].includes(current) : current !== status) return false;
      }
      return true;
    });
    return {
      servers: filtered.map((s) => serverJson(s, ctx.user, daemon)),
      total: list.length,
    };
  });

  route('POST', '/api/servers', (ctx) => {
    const body = ctx.body || {};
    const isAdmin = auth.isAdmin(ctx.user);
    const owner = isAdmin && body.ownerId ? db.userById(body.ownerId) : ctx.user;
    if (!owner) throw bad('Владелец не найден');
    if (!isAdmin && body.ownerId && body.ownerId !== ctx.user.id) throw forbidden();
    const egg = db.eggById(body.eggId) || db.eggById(db.data.settings.defaultEggId) || db.data.eggs[0];
    if (!egg) throw bad('Сначала создайте шаблон сервера');
    const node = (isAdmin && body.nodeId ? db.nodeById(body.nodeId) : db.data.nodes.find((n) => nodeIsLocal(n)))
      || db.data.nodes.find((n) => nodeIsLocal(n));
    if (!node) throw bad('Нет доступного узла');
    if (!nodeIsLocal(node)) throw bad('Запуск возможен только на локальном узле (fqdn localhost)');
    const limits = serversCore.normalizeLimits({
      memory: body.memory,
      disk: body.disk,
      cpu: body.cpu,
      io: body.io,
    });
    const check = serversCore.checkUserLimits(owner, limits);
    if (!check.ok) throw conflict(check.error);
    const server = serversCore.createServer({
      owner,
      egg,
      node,
      name: body.name,
      description: body.description || '',
      limits,
      environment: body.environment || {},
      expiresDays: isAdmin ? (body.expiresDays === undefined ? db.data.settings.expiryDays : body.expiresDays) : db.data.settings.expiryDays,
      actor: ctx.user,
      autoStart: body.autoStart === true,
    });
    if (body.start === true) {
      daemon.start(server, ctx.user.username).catch((err) => notify({ type: 'error', text: err.message }));
    }
    return serverJson(server, ctx.user, daemon);
  });

  route('GET', '/api/servers/:id', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound('Сервер не найден');
    const access = serversCore.access(ctx.user, server);
    if (!access.ok) throw notFound('Сервер не найден');
    const owner = db.userById(server.ownerId);
    const egg = db.eggById(server.eggId);
    const node = db.nodeById(server.nodeId);
    return {
      server: serverJson(server, ctx.user, daemon),
      logs: daemon.getLogs(server.id, 250),
      egg: egg ? {
        id: egg.id, name: egg.name, description: egg.description, category: egg.category,
        startup: server.startupOverride || egg.startup, image: egg.image,
        variables: egg.variables || [], config: egg.config || {},
      } : null,
      node: node ? { id: node.id, name: node.name, location: node.location, fqdn: node.fqdn, status: node.status } : null,
      owner: owner ? { ...publicUser(owner), usage: serversCore.usageOf(owner.id) } : null,
      availablePorts: db.data.allocations
        .filter((a) => a.nodeId === server.nodeId && (!a.serverId || a.serverId === server.id))
        .map((a) => ({ id: a.id, ip: a.ip, port: a.port, assigned: a.serverId === server.id })),
      perms: access.perms,
      permLabels: serversCore.PERM_LABELS,
      allPerms: serversCore.ALL_PERMS,
      usage: { ...serversCore.usageOf(owner ? owner.id : ''), nodes: serversCore.nodeUsage(server.nodeId) },
    };
  });

  route('PATCH', '/api/servers/:id', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    const access = permit(ctx.user, server, 'settings');
    const body = ctx.body || {};
    const isAdmin = auth.isAdmin(ctx.user);
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!/^[a-zA-Zа-яА-Я0-9 _.\-–]{2,60}$/u.test(name)) throw bad('Некорректное имя сервера');
      server.name = name;
    }
    if (body.description !== undefined) server.description = String(body.description).slice(0, 500);
    if (body.autoStart !== undefined) server.autoStart = !!body.autoStart;
    if (body.notes !== undefined) server.notes = String(body.notes).slice(0, 2000);
    if (body.limits && isAdmin) {
      const previous = { ...server.limits };
      const limits = serversCore.normalizeLimits({ ...server.limits, ...body.limits });
      const owner = db.userById(server.ownerId);
      const check = serversCore.checkUserLimits(owner, limits, server.id);
      if (!check.ok) throw conflict(check.error);
      server.limits = limits;
      db.audit({
        action: 'server.limits.update', actorId: ctx.user.id, actorName: ctx.user.username,
        target: server.name, meta: { from: previous, to: limits },
      });
    }
    if (body.expiresAt !== undefined && isAdmin) {
      server.expiresAt = body.expiresAt === null ? null : Number(body.expiresAt);
      if (server.expiresAt && server.expiresAt > now()) {
        server.suspended = false;
        server.suspendReason = null;
      }
    }
    if (body.expiresDays !== undefined && isAdmin) {
      serversCore.extend(server, body.expiresDays, ctx.user);
    }
    if (body.suspended !== undefined && isAdmin && body.suspended !== server.suspended) {
      if (body.suspended) serversCore.suspend(server, body.suspendReason || 'manual', ctx.user);
      else serversCore.unsuspend(server, ctx.user);
    }
    db.save();
    serverChanged(server.id);
    return serverJson(server, ctx.user, daemon);
  });

  route('DELETE', '/api/servers/:id', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    const access = serversCore.access(ctx.user, server);
    if (!access.ok) throw notFound();
    // владелец может удалить только если это разрешено настройкой, админ — всегда
    if (!auth.isAdmin(ctx.user) && !access.isOwner) throw forbidden('Удалить сервер может владелец или администратор');
    const entry = daemon.entry(server.id);
    if (entry.child) {
      try { daemon.killTree(entry.child, 'SIGKILL'); } catch { /* ignore */ }
    }
    daemon.closeStream(server.id);
    serversCore.deleteServer(server.id, ctx.user);
    try { fs.rmSync(db.serverDir(server.id), { recursive: true, force: true }); } catch { /* ignore */ }
    broadcast('servers', { serverId: server.id, deleted: true });
    return { deleted: true };
  });

  route('POST', '/api/servers/:id/power', async (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'control');
    if (server.suspended) throw conflict('Сервер приостановлен — управление недоступно');
    const node = db.nodeById(server.nodeId);
    if (node && !nodeIsLocal(node)) throw conflict(`Узел «${node.name}» офлайн: запуск только на локальном узле`);
    const action = String((ctx.body || {}).action || '');
    let state;
    if (action === 'start') {
      if (!daemon.isOnline(server.id) && db.data.servers.filter((s) => s.nodeId === server.nodeId).length > 0) {
        const nodeUsage = serversCore.nodeUsage(server.nodeId);
        if (nodeUsage.memoryTotal && nodeUsage.memory > nodeUsage.memoryTotal) {
          throw conflict('На узле не хватает памяти для этого сервера');
        }
      }
      server.lastStartedAt = now();
      state = await daemon.start(server, ctx.user.username);
      db.audit({ action: 'server.start', actorId: ctx.user.id, actorName: ctx.user.username, target: server.name, meta: { via: ctx.via } });
    } else if (action === 'stop') {
      state = await daemon.stop(server);
      db.audit({ action: 'server.stop', actorId: ctx.user.id, actorName: ctx.user.username, target: server.name });
    } else if (action === 'restart') {
      state = await daemon.restart(server, ctx.user.username);
      db.audit({ action: 'server.restart', actorId: ctx.user.id, actorName: ctx.user.username, target: server.name });
    } else if (action === 'kill') {
      state = await daemon.kill(server);
      db.audit({ action: 'server.kill', actorId: ctx.user.id, actorName: ctx.user.username, target: server.name });
    } else {
      throw bad('Неизвестное действие: start | stop | restart | kill');
    }
    serverChanged(server.id);
    return { state, server: serverJson(server, ctx.user, daemon) };
  });

  route('POST', '/api/servers/:id/command', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'console');
    if (server.suspended) throw conflict('Сервер приостановлен');
    const command = String((ctx.body || {}).command || '').trim();
    if (!command) throw bad('Пустая команда');
    const sent = daemon.send(server, command);
    db.audit({ action: 'server.command', actorId: ctx.user.id, actorName: ctx.user.username, target: server.name, meta: { command: command.slice(0, 200) } });
    return { sent };
  });

  route('GET', '/api/servers/:id/logs', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'console');
    return { logs: daemon.getLogs(server.id, clamp(int(ctx.query.tail, 250), 1, 1200)) };
  });

  route('GET', '/api/servers/:id/stats', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, null);
    return daemon.publicState(server.id);
  });

  route('POST', '/api/servers/:id/suspend', (ctx) => {
    adminOnly(ctx.user);
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    serversCore.suspend(server, String((ctx.body || {}).reason || 'manual').slice(0, 120), ctx.user);
    daemon.stop(server, { force: true }).catch(() => {});
    daemon.pushLog(server.id, '\u001b[33m[OmniDash] сервер приостановлен администратором\u001b[0m', { system: true });
    serverChanged(server.id);
    return serverJson(server, ctx.user, daemon);
  });

  route('POST', '/api/servers/:id/unsuspend', (ctx) => {
    adminOnly(ctx.user);
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    serversCore.unsuspend(server, ctx.user);
    serverChanged(server.id);
    return serverJson(server, ctx.user, daemon);
  });

  route('POST', '/api/servers/:id/renew', (ctx) => {
    adminOnly(ctx.user);
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    const days = clamp(int((ctx.body || {}).days, 30), 1, 3650);
    serversCore.extend(server, days, ctx.user);
    db.data.renewRequests = (db.data.renewRequests || []).map((r) => (
      r.serverId === server.id && r.status === 'pending' ? { ...r, status: 'approved', decidedAt: now() } : r
    ));
    db.save();
    serverChanged(server.id);
    return serverJson(server, ctx.user, daemon);
  });

  route('POST', '/api/servers/:id/request-renew', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    const access = serversCore.access(ctx.user, server);
    if (!access.ok) throw notFound();
    if (auth.isAdmin(ctx.user)) throw bad('Администратор может продлить сервер сразу');
    const pending = (db.data.renewRequests || []).find((r) => r.serverId === server.id && r.status === 'pending');
    if (pending) throw conflict('Запрос уже отправлен — ожидайте решения');
    const request = {
      id: id('renew'),
      serverId: server.id,
      userId: ctx.user.id,
      days: clamp(int((ctx.body || {}).days, 30), 1, 365),
      comment: String((ctx.body || {}).comment || '').slice(0, 500),
      at: now(),
      status: 'pending',
    };
    db.data.renewRequests.push(request);
    db.save();
    db.audit({ action: 'server.renew.request', actorId: ctx.user.id, actorName: ctx.user.username, target: server.name, meta: { days: request.days } });
    notify({ type: 'renew-request', serverName: server.name, username: ctx.user.username });
    return request;
  });

  route('POST', '/api/servers/:id/transfer', (ctx) => {
    adminOnly(ctx.user);
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    const target = db.userById((ctx.body || {}).userId);
    if (!target) throw bad('Пользователь не найден');
    serversCore.transfer(server, target.id, ctx.user);
    serverChanged(server.id);
    return serverJson(server, ctx.user, daemon);
  });

  /* ─────────── доступы (subusers) ─────────── */
  route('GET', '/api/servers/:id/subusers', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    serversCore.access(ctx.user, server).ok || (() => { throw notFound(); })();
    return {
      subusers: (server.subusers || []).map((s) => {
        const u = db.userById(s.userId);
        return u ? { userId: u.id, username: u.username, email: u.email, perms: s.perms, addedAt: s.addedAt } : null;
      }).filter(Boolean),
      allPerms: serversCore.ALL_PERMS,
      permLabels: serversCore.PERM_LABELS,
      users: auth.isAdmin(ctx.user) || serversCore.access(ctx.user, server).isOwner
        ? db.data.users.map((u) => ({ id: u.id, username: u.username }))
        : [],
    };
  });

  route('POST', '/api/servers/:id/subusers', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    const access = serversCore.access(ctx.user, server);
    if (!access.ok) throw notFound();
    if (!access.isAdmin && !access.perms.includes('users')) throw forbidden('Нет права управлять доступами');
    const { userId, perms } = ctx.body || {};
    const list = serversCore.setSubuser(server, userId, perms);
    serverChanged(server.id);
    return { subusers: list };
  });

  route('DELETE', '/api/servers/:id/subusers/:userId', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    const access = serversCore.access(ctx.user, server);
    if (!access.ok) throw notFound();
    if (!access.isAdmin && !access.perms.includes('users')) throw forbidden('Нет права управлять доступами');
    serversCore.removeSubuser(server, ctx.params.userId);
    serverChanged(server.id);
    return { removed: true };
  });

  /* ─────────── аллокации сервера ─────────── */
  route('GET', '/api/servers/:id/allocations', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'allocations');
    return {
      assigned: (server.allocations || []).map((aid) => {
        const a = db.allocationById(aid);
        return a ? { id: a.id, ip: a.ip, port: a.port, primary: a.id === server.allocationId } : null;
      }).filter(Boolean),
      available: db.data.allocations
        .filter((a) => a.nodeId === server.nodeId && !a.serverId)
        .map((a) => ({ id: a.id, ip: a.ip, port: a.port })),
    };
  });

  route('POST', '/api/servers/:id/allocations', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'allocations');
    const { allocationId, primary } = ctx.body || {};
    if (!allocationId) {
      const alloc = serversCore.ensureAllocation(server.nodeId, server.id);
      if (!server.allocations.includes(alloc.id)) server.allocations.push(alloc.id);
      db.save();
      serverChanged(server.id);
      return { allocation: alloc };
    }
    const owner = db.userById(server.ownerId);
    const maxPorts = int((owner && owner.limits && owner.limits.ports) || db.data.settings.defaultLimits.ports || 2);
    if (!auth.isAdmin(ctx.user) && (server.allocations || []).length >= maxPorts) {
      throw conflict(`Лимит портов: ${maxPorts}`);
    }
    const alloc = serversCore.assignAllocation(server.id, allocationId, primary !== false);
    db.audit({ action: 'server.port.add', actorId: ctx.user.id, actorName: ctx.user.username, target: server.name, meta: { port: alloc.port } });
    serverChanged(server.id);
    return serverJson(server, ctx.user, daemon);
  });

  route('DELETE', '/api/servers/:id/allocations/:allocationId', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'allocations');
    if ((server.allocations || []).length <= 1) throw conflict('У сервера должен остаться хотя бы один порт');
    if (server.allocationId === ctx.params.allocationId) throw conflict('Нельзя удалить основной порт');
    serversCore.releaseAllocation(ctx.params.allocationId);
    serverChanged(server.id);
    return { removed: true };
  });

  /* ─────────── запуск / переменные ─────────── */
  route('POST', '/api/servers/:id/startup', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'startup');
    const egg = db.eggById(server.eggId);
    const body = ctx.body || {};
    if (body.environment && typeof body.environment === 'object') {
      const env = {};
      for (const v of (egg && egg.variables) || []) {
        if (!v.userEditable && !auth.isAdmin(ctx.user)) continue;
        if (body.environment[v.env] !== undefined) env[v.env] = String(body.environment[v.env]).slice(0, 500);
      }
      server.environment = { ...(server.environment || {}), ...env };
    }
    if (body.startupOverride !== undefined) {
      server.startupOverride = body.startupOverride ? String(body.startupOverride).slice(0, 800) : null;
    }
    db.save();
    db.audit({ action: 'server.startup.update', actorId: ctx.user.id, actorName: ctx.user.username, target: server.name });
    return { environment: server.environment, startupOverride: server.startupOverride };
  });

  /* ─────────── файлы ─────────── */
  route('GET', '/api/servers/:id/files', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'files');
    const listing = filesCore.list(server, String(ctx.query.path || ''));
    return { ...listing, usage: { used: daemon.diskOf(server.id), limit: int(server.limits.disk) * 1024 * 1024 } };
  });

  route('GET', '/api/servers/:id/files/content', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'files');
    return filesCore.read(server, String(ctx.query.path || ''));
  });

  route('PUT', '/api/servers/:id/files/content', async (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'files');
    const { path: rel, content } = ctx.body || {};
    if (!rel) throw bad('Не указан путь');
    const result = filesCore.write(server, rel, String(content ?? ''));
    db.audit({ action: 'file.write', actorId: ctx.user.id, actorName: ctx.user.username, target: server.name, meta: { path: rel } });
    return result;
  });

  route('POST', '/api/servers/:id/files/mkdir', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'files');
    if (!(ctx.body || {}).name) throw bad('Не указано имя папки');
    return filesCore.mkdir(server, String((ctx.body || {}).path || ''), ctx.body.name);
  });

  route('POST', '/api/servers/:id/files/touch', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'files');
    if (!(ctx.body || {}).name) throw bad('Не указано имя файла');
    return filesCore.createFile(server, String((ctx.body || {}).path || ''), ctx.body.name, String(ctx.body.content || ''));
  });

  route('POST', '/api/servers/:id/files/rename', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'files');
    return filesCore.rename(server, String((ctx.body || {}).path || ''), String((ctx.body || {}).name || ''));
  });

  route('POST', '/api/servers/:id/files/delete', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'files');
    const paths = (ctx.body || {}).paths;
    if (!Array.isArray(paths) || !paths.length) throw bad('Не выбраны файлы');
    const removed = [];
    for (const rel of paths.slice(0, 200)) {
      try {
        filesCore.remove(server, rel);
        removed.push(rel);
      } catch { /* пропускаем несуществующие */ }
    }
    db.audit({ action: 'file.delete', actorId: ctx.user.id, actorName: ctx.user.username, target: server.name, meta: { paths: removed.slice(0, 10) } });
    return { removed };
  });

  route('POST', '/api/servers/:id/files/upload', async (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'files');
    const rel = String(ctx.query.path || '');
    const name = String(ctx.query.name || '').trim();
    if (!name) throw bad('Не указано имя файла');
    if (server.suspended) throw conflict('Сервер приостановлен');
    const buf = await readBody(ctx.req, 256 * 1024 * 1024);
    const result = filesCore.upload(server, rel, name, buf);
    db.audit({ action: 'file.upload', actorId: ctx.user.id, actorName: ctx.user.username, target: server.name, meta: { name, size: result.size } });
    return result;
  }, { rawBody: true });

  route('GET', '/api/servers/:id/files/download', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'files');
    const file = filesCore.download(server, String(ctx.query.path || ''));
    streamFile(ctx.res, file.abs, file.name);
    return undefined;
  });

  route('POST', '/api/servers/:id/files/archive', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'files');
    const paths = Array.isArray((ctx.body || {}).paths) ? ctx.body.paths : [];
    if (!paths.length) throw bad('Не выбраны файлы');
    return filesCore.archive(server, paths, (ctx.body || {}).name);
  });

  route('POST', '/api/servers/:id/files/extract', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'files');
    return filesCore.extract(server, String((ctx.body || {}).path || ''));
  });

  /* ─────────── бэкапы ─────────── */
  route('GET', '/api/servers/:id/backups', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'backups');
    const owner = db.userById(server.ownerId);
    return {
      backups: backupsCore.listFor(server.id),
      limit: int((owner && owner.limits && owner.limits.backups) || db.data.settings.defaultLimits.backups),
    };
  });

  route('POST', '/api/servers/:id/backups', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'backups');
    const backup = backupsCore.create(server, { name: (ctx.body || {}).name, actor: ctx.user });
    serverChanged(server.id);
    return { ...backup, sizeLabel: fmtBytes(backup.size) };
  });

  route('POST', '/api/servers/:id/backups/:backupId/restore', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'backups');
    const backup = backupsCore.listFor(server.id).find((b) => b.id === ctx.params.backupId);
    if (!backup) throw notFound('Бэкап не найден');
    if (daemon.isOnline(server.id)) throw conflict('Остановите сервер перед восстановлением');
    const result = backupsCore.restore(backup, ctx.user);
    daemon.pushLog(server.id, `\u001b[32m[OmniDash] восстановлен бэкап «${backup.name}»\u001b[0m`, { system: true });
    return result;
  });

  route('DELETE', '/api/servers/:id/backups/:backupId', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'backups');
    const backup = backupsCore.listFor(server.id).find((b) => b.id === ctx.params.backupId);
    if (!backup) throw notFound('Бэкап не найден');
    backupsCore.remove(backup);
    serverChanged(server.id);
    return { removed: true };
  });

  route('GET', '/api/servers/:id/backups/:backupId/download', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'backups');
    const backup = db.backupById(ctx.params.backupId);
    if (!backup || backup.serverId !== server.id) throw notFound('Бэкап не найден');
    streamFile(ctx.res, backupsCore.pathOf(backup), `${server.name}-${backup.name}.zip`.replace(/[\\/:*?"<>|]/g, '_'));
    return undefined;
  });

  /* ─────────── задачи ─────────── */
  route('GET', '/api/servers/:id/tasks', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'schedule');
    return { tasks: server.tasks || [], actions: ACTIONS };
  });

  route('POST', '/api/servers/:id/tasks', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'schedule');
    if ((server.tasks || []).length >= 20) throw conflict('Максимум 20 задач на сервер');
    const task = makeTask(ctx.body || {});
    if (task.schedule.type === 'once' && !task.schedule.at) throw bad('Для одноразовой задачи укажите время');
    server.tasks = server.tasks || [];
    server.tasks.push(task);
    db.save();
    db.audit({ action: 'task.create', actorId: ctx.user.id, actorName: ctx.user.username, target: server.name, meta: { name: task.name, action: task.action } });
    return task;
  });

  route('PATCH', '/api/servers/:id/tasks/:taskId', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'schedule');
    const task = (server.tasks || []).find((t) => t.id === ctx.params.taskId);
    if (!task) throw notFound('Задача не найдена');
    if (ctx.body.enabled !== undefined) {
      task.enabled = !!ctx.body.enabled;
      task.nextRunAt = task.enabled ? require('./scheduler').nextRun(task) : null;
    }
    if (ctx.body.name) task.name = String(ctx.body.name).slice(0, 60);
    if (ctx.body.payload !== undefined) task.payload = String(ctx.body.payload).slice(0, 500);
    db.save();
    return task;
  });

  route('DELETE', '/api/servers/:id/tasks/:taskId', (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'schedule');
    server.tasks = (server.tasks || []).filter((t) => t.id !== ctx.params.taskId);
    db.save();
    return { removed: true };
  });

  route('POST', '/api/servers/:id/tasks/:taskId/run', async (ctx) => {
    const server = db.serverById(ctx.params.id);
    if (!server) throw notFound();
    permit(ctx.user, server, 'schedule');
    const task = (server.tasks || []).find((t) => t.id === ctx.params.taskId);
    if (!task) throw notFound('Задача не найдена');
    await scheduler.runTask(server, task);
    return task;
  });

  /* ─────────── пользователи (админ) ─────────── */
  route('GET', '/api/users', (ctx) => {
    adminOnly(ctx.user);
    const q = String(ctx.query.q || '').trim().toLowerCase();
    const list = db.data.users
      .filter((u) => !q || u.username.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((u) => userJson(u));
    return { users: list, defaults: db.data.settings.defaultLimits };
  });

  route('GET', '/api/users/:id', (ctx) => {
    adminOnly(ctx.user);
    const user = db.userById(ctx.params.id);
    if (!user) throw notFound('Пользователь не найден');
    return {
      user: userJson(user, { withServers: true }),
      servers: serversCore.ownedServers(user.id).map((s) => serverJson(s, ctx.user, daemon)),
      shared: db.data.servers.filter((s) => (s.subusers || []).some((x) => x.userId === user.id))
        .map((s) => ({ id: s.id, name: s.name, perms: serversCore.subuserEntry(s, user.id).perms })),
    };
  });

  route('POST', '/api/users', (ctx) => {
    adminOnly(ctx.user);
    const { username, email, password, role, limits } = ctx.body || {};
    const name = String(username || '').trim();
    if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(name)) throw bad('Логин: 3–24 символа, латиница, цифры, _ . -');
    if (db.userByName(name)) throw conflict('Такой логин уже занят');
    if (String(password || '').length < 8) throw bad('Пароль минимум 8 символов');
    const user = db.newUser({
      username: name,
      email: String(email || '').slice(0, 120),
      role: role === 'admin' ? 'admin' : 'user',
      ...auth.hashPassword(String(password)),
      limits: limits || {},
    });
    db.audit({ action: 'user.create', actorId: ctx.user.id, actorName: ctx.user.username, target: user.username, meta: { role: user.role } });
    return userJson(user);
  });

  route('PATCH', '/api/users/:id', (ctx) => {
    adminOnly(ctx.user);
    const user = db.userById(ctx.params.id);
    if (!user) throw notFound('Пользователь не найден');
    const body = ctx.body || {};
    if (body.email !== undefined) user.email = String(body.email).slice(0, 120);
    if (body.role !== undefined && user.id !== ctx.user.id) {
      user.role = body.role === 'admin' ? 'admin' : 'user';
      db.audit({ action: 'user.role', actorId: ctx.user.id, actorName: ctx.user.username, target: user.username, meta: { role: user.role } });
    }
    if (body.limits && typeof body.limits === 'object') {
      const lim = {
        memory: clamp(int(body.limits.memory, user.limits.memory), 128, 1024 * 1024),
        disk: clamp(int(body.limits.disk, user.limits.disk), 64, 1024 * 1024 * 4),
        cpu: clamp(int(body.limits.cpu, user.limits.cpu), 5, 1600),
        servers: clamp(int(body.limits.servers, user.limits.servers), 0, 500),
        backups: clamp(int(body.limits.backups, user.limits.backups), 0, 200),
        ports: clamp(int(body.limits.ports, user.limits.ports), 0, 100),
      };
      user.limits = lim;
      db.audit({ action: 'user.limits', actorId: ctx.user.id, actorName: ctx.user.username, target: user.username, meta: lim });
    }
    if (body.suspended !== undefined) {
      if (user.id === ctx.user.id) throw bad('Нельзя заблокировать самого себя');
      user.suspended = !!body.suspended;
      if (user.suspended) {
        for (const [sid, s] of Object.entries(db.data.sessions)) if (s.userId === user.id) delete db.data.sessions[sid];
        db.data.servers.filter((s) => s.ownerId === user.id).forEach((s) => {
          serversCore.suspend(s, 'owner-suspended', ctx.user);
          daemon.stop(s, { force: true }).catch(() => {});
        });
      }
      db.audit({ action: user.suspended ? 'user.suspend' : 'user.unsuspend', actorId: ctx.user.id, actorName: ctx.user.username, target: user.username });
    }
    db.save();
    return userJson(user);
  });

  route('POST', '/api/users/:id/password', (ctx) => {
    adminOnly(ctx.user);
    const user = db.userById(ctx.params.id);
    if (!user) throw notFound();
    const password = String((ctx.body || {}).password || '');
    if (password.length < 8) throw bad('Пароль минимум 8 символов');
    Object.assign(user, auth.hashPassword(password));
    for (const [sid, s] of Object.entries(db.data.sessions)) if (s.userId === user.id) delete db.data.sessions[sid];
    db.save();
    db.audit({ action: 'user.password.reset', actorId: ctx.user.id, actorName: ctx.user.username, target: user.username });
    return { reset: true };
  });

  route('DELETE', '/api/users/:id', (ctx) => {
    adminOnly(ctx.user);
    if (ctx.params.id === ctx.user.id) throw bad('Нельзя удалить себя');
    const user = db.userById(ctx.params.id);
    if (!user) throw notFound();
    const owned = serversCore.ownedServers(user.id);
    if (owned.length) throw conflict(`У пользователя ${owned.length} сервер(ов). Передайте или удалите их сначала.`);
    db.data.users = db.data.users.filter((u) => u.id !== user.id);
    db.data.servers.forEach((s) => { s.subusers = (s.subusers || []).filter((x) => x.userId !== user.id); });
    for (const [sid, s] of Object.entries(db.data.sessions)) if (s.userId === user.id) delete db.data.sessions[sid];
    db.save();
    db.audit({ action: 'user.delete', actorId: ctx.user.id, actorName: ctx.user.username, target: user.username });
    return { deleted: true };
  });

  /* ─────────── узлы ─────────── */
  route('GET', '/api/nodes', (ctx) => {
    adminOnly(ctx.user);
    return {
      nodes: db.data.nodes.map((n) => {
        const usage = serversCore.nodeUsage(n.id);
        return { ...n, usage, local: nodeIsLocal(n) };
      }),
    };
  });

  route('POST', '/api/nodes', (ctx) => {
    adminOnly(ctx.user);
    const body = ctx.body || {};
    const name = String(body.name || '').trim();
    if (name.length < 2) throw bad('Укажите имя узла');
    const node = {
      id: uuid(),
      name: name.slice(0, 60),
      description: String(body.description || '').slice(0, 300),
      fqdn: String(body.fqdn || 'localhost').slice(0, 120),
      scheme: body.scheme === 'https' ? 'https' : 'http',
      port: clamp(int(body.port, 8080), 1, 65535),
      location: String(body.location || '').slice(0, 80),
      flag: String(body.flag || '🌍').slice(0, 8),
      memoryTotal: clamp(int(body.memoryTotal, 8192), 512, 1024 * 1024),
      diskTotal: clamp(int(body.diskTotal, 51200), 1024, 1024 * 1024 * 8),
      portStart: clamp(int(body.portStart, 25565), 1, 65535),
      portEnd: clamp(int(body.portEnd, 25600), 1, 65535),
      status: 'online',
      maintenance: false,
      createdAt: now(),
      token: id('node').replace('node_', ''),
    };
    if (node.portEnd < node.portStart) throw bad('Конец диапазона портов меньше начала');
    db.data.nodes.push(node);
    db.audit({ action: 'node.create', actorId: ctx.user.id, actorName: ctx.user.username, target: node.name });
    db.save();
    return node;
  });

  route('PATCH', '/api/nodes/:id', (ctx) => {
    adminOnly(ctx.user);
    const node = db.nodeById(ctx.params.id);
    if (!node) throw notFound('Узел не найден');
    const body = ctx.body || {};
    for (const key of ['name', 'description', 'fqdn', 'location', 'flag', 'scheme']) {
      if (body[key] !== undefined) node[key] = String(body[key]).slice(0, 200);
    }
    for (const key of ['port', 'memoryTotal', 'diskTotal', 'portStart', 'portEnd']) {
      if (body[key] !== undefined) node[key] = clamp(int(body[key], node[key]), 1, 1024 * 1024);
    }
    if (body.status !== undefined && ['online', 'offline', 'maintenance'].includes(body.status)) node.status = body.status;
    if (body.maintenance !== undefined) node.maintenance = !!body.maintenance;
    db.save();
    db.audit({ action: 'node.update', actorId: ctx.user.id, actorName: ctx.user.username, target: node.name, meta: body });
    return node;
  });

  route('DELETE', '/api/nodes/:id', (ctx) => {
    adminOnly(ctx.user);
    const node = db.nodeById(ctx.params.id);
    if (!node) throw notFound();
    if (db.data.servers.some((s) => s.nodeId === node.id)) throw conflict('На узле есть серверы — перенесите или удалите их');
    db.data.nodes = db.data.nodes.filter((n) => n.id !== node.id);
    db.data.allocations = db.data.allocations.filter((a) => a.nodeId !== node.id);
    db.save();
    db.audit({ action: 'node.delete', actorId: ctx.user.id, actorName: ctx.user.username, target: node.name });
    return { deleted: true };
  });

  /* ─────────── аллокации (админ) ─────────── */
  route('GET', '/api/allocations', (ctx) => {
    adminOnly(ctx.user);
    const nodeId = String(ctx.query.node || '');
    const status = String(ctx.query.status || '');
    const list = db.data.allocations
      .filter((a) => (!nodeId || a.nodeId === nodeId))
      .filter((a) => (status === 'free' ? !a.serverId : status === 'used' ? !!a.serverId : true))
      .map((a) => {
        const server = a.serverId ? db.serverById(a.serverId) : null;
        const node = db.nodeById(a.nodeId);
        return {
          id: a.id, ip: a.ip, port: a.port, nodeId: a.nodeId,
          nodeName: node ? node.name : '—', notes: a.notes || '',
          server: server ? { id: server.id, name: server.name } : null,
          createdAt: a.createdAt,
        };
      })
      .sort((a, b) => a.port - b.port);
    return { allocations: list, nodes: db.data.nodes.map((n) => ({ id: n.id, name: n.name })) };
  });

  route('POST', '/api/allocations', (ctx) => {
    adminOnly(ctx.user);
    const body = ctx.body || {};
    const node = db.nodeById(body.nodeId) || db.data.nodes[0];
    if (!node) throw bad('Сначала создайте узел');
    const port = clamp(int(body.port, 0), 1, 65535);
    if (!port) throw bad('Укажите порт');
    if (db.data.allocations.some((a) => a.nodeId === node.id && int(a.port) === port)) throw conflict(`Порт ${port} уже создан на этом узле`);
    const alloc = {
      id: uuid(),
      nodeId: node.id,
      ip: String(body.ip || '0.0.0.0').slice(0, 60),
      port,
      serverId: null,
      notes: String(body.notes || '').slice(0, 160),
      createdAt: now(),
    };
    db.data.allocations.push(alloc);
    db.save();
    db.audit({ action: 'allocation.create', actorId: ctx.user.id, actorName: ctx.user.username, target: `${node.name}:${port}` });
    return alloc;
  });

  route('POST', '/api/allocations/bulk', (ctx) => {
    adminOnly(ctx.user);
    const { nodeId, from, to } = ctx.body || {};
    const node = db.nodeById(nodeId) || db.data.nodes[0];
    if (!node) throw bad('Сначала создайте узел');
    const a = clamp(int(from, 0), 1, 65535);
    const b = clamp(int(to, 0), 1, 65535);
    if (!a || !b || b < a) throw bad('Некорректный диапазон портов');
    if (b - a > 500) throw bad('Максимум 500 портов за раз');
    const existing = new Set(db.data.allocations.filter((x) => x.nodeId === node.id).map((x) => int(x.port)));
    let created = 0;
    for (let port = a; port <= b; port += 1) {
      if (existing.has(port)) continue;
      db.data.allocations.push({
        id: uuid(), nodeId: node.id, ip: '0.0.0.0', port, serverId: null, notes: '', createdAt: now(),
      });
      created += 1;
    }
    db.save();
    db.audit({ action: 'allocation.bulk', actorId: ctx.user.id, actorName: ctx.user.username, target: node.name, meta: { from: a, to: b, created } });
    return { created };
  });

  route('DELETE', '/api/allocations/:id', (ctx) => {
    adminOnly(ctx.user);
    const alloc = db.allocationById(ctx.params.id);
    if (!alloc) throw notFound();
    if (alloc.serverId) throw conflict('Порт занят сервером — сначала освободите его в настройках сервера');
    db.data.allocations = db.data.allocations.filter((a) => a.id !== alloc.id);
    db.save();
    db.audit({ action: 'allocation.delete', actorId: ctx.user.id, actorName: ctx.user.username, target: `${alloc.ip}:${alloc.port}` });
    return { deleted: true };
  });

  /* ─────────── шаблоны ─────────── */
  route('GET', '/api/eggs', (ctx) => {
    if (!ctx.user) throw forbidden();
    return { eggs: db.data.eggs.map((e) => ({ ...e, servers: db.data.servers.filter((s) => s.eggId === e.id).length })) };
  });

  route('POST', '/api/eggs', (ctx) => {
    adminOnly(ctx.user);
    const egg = eggsCore.fromSpec(ctx.body || {});
    egg.variables = egg.variables || [];
    db.data.eggs.push(egg);
    db.save();
    db.audit({ action: 'egg.create', actorId: ctx.user.id, actorName: ctx.user.username, target: egg.name });
    return egg;
  });

  route('PATCH', '/api/eggs/:id', (ctx) => {
    adminOnly(ctx.user);
    const egg = db.eggById(ctx.params.id);
    if (!egg) throw notFound();
    const body = ctx.body || {};
    if (body.name) egg.name = String(body.name).slice(0, 80);
    if (body.description !== undefined) egg.description = String(body.description).slice(0, 600);
    if (body.startup) egg.startup = String(body.startup).slice(0, 800);
    if (body.config && typeof body.config === 'object') egg.config = { ...egg.config, ...body.config };
    if (Array.isArray(body.variables)) egg.variables = eggsCore.fromSpec({ ...egg, variables: body.variables }).variables;
    db.save();
    db.audit({ action: 'egg.update', actorId: ctx.user.id, actorName: ctx.user.username, target: egg.name });
    return egg;
  });

  route('DELETE', '/api/eggs/:id', (ctx) => {
    adminOnly(ctx.user);
    const egg = db.eggById(ctx.params.id);
    if (!egg) throw notFound();
    if (db.data.servers.some((s) => s.eggId === egg.id)) throw conflict('Шаблон используется серверами');
    db.data.eggs = db.data.eggs.filter((e) => e.id !== egg.id);
    db.save();
    db.audit({ action: 'egg.delete', actorId: ctx.user.id, actorName: ctx.user.username, target: egg.name });
    return { deleted: true };
  });

  /* ─────────── журнал ─────────── */
  route('GET', '/api/audit', (ctx) => {
    adminOnly(ctx.user);
    const q = String(ctx.query.q || '').toLowerCase();
    const limit = clamp(int(ctx.query.limit, 100), 1, 500);
    const list = db.data.audit
      .filter((a) => !q || String(a.action).includes(q) || String(a.actorName || '').toLowerCase().includes(q) || String(a.target || '').toLowerCase().includes(q))
      .slice(0, limit);
    return { entries: list, total: db.data.audit.length };
  });

  /* ─────────── продления ─────────── */
  route('GET', '/api/renew-requests', (ctx) => {
    adminOnly(ctx.user);
    const list = (db.data.renewRequests || []).map((r) => {
      const server = db.serverById(r.serverId);
      const user = db.userById(r.userId);
      return {
        ...r,
        serverName: server ? server.name : '—',
        username: user ? user.username : '—',
        expiresAt: server ? server.expiresAt : null,
      };
    });
    return { requests: list };
  });

  route('POST', '/api/renew-requests/:id/approve', (ctx) => {
    adminOnly(ctx.user);
    const request = (db.data.renewRequests || []).find((r) => r.id === ctx.params.id);
    if (!request) throw notFound();
    if (request.status !== 'pending') throw conflict('Запрос уже обработан');
    const server = db.serverById(request.serverId);
    if (!server) throw notFound('Сервер удалён');
    serversCore.extend(server, request.days || 30, ctx.user);
    request.status = 'approved';
    request.decidedAt = now();
    request.decidedBy = ctx.user.username;
    db.save();
    serverChanged(server.id);
    return { approved: true, server: serverJson(server, ctx.user, daemon) };
  });

  route('POST', '/api/renew-requests/:id/reject', (ctx) => {
    adminOnly(ctx.user);
    const request = (db.data.renewRequests || []).find((r) => r.id === ctx.params.id);
    if (!request) throw notFound();
    request.status = 'rejected';
    request.decidedAt = now();
    request.decidedBy = ctx.user.username;
    db.save();
    return { rejected: true };
  });

  /* ─────────── настройки ─────────── */
  route('GET', '/api/settings', (ctx) => {
    adminOnly(ctx.user);
    return {
      settings: db.data.settings,
      defaults: serversCore.normalizeLimits({}),
      version: updater ? updater.currentVersion() : '1.0.0',
    };
  });

  route('PATCH', '/api/settings', (ctx) => {
    adminOnly(ctx.user);
    const body = ctx.body || {};
    const s = db.data.settings;
    for (const key of ['panelName', 'company', 'theme', 'accent', 'motd', 'updateUrl', 'updateChannel', 'locale']) {
      if (body[key] !== undefined) s[key] = String(body[key]).slice(0, 300);
    }
    for (const key of ['registrationOpen', 'autoSuspendExpired', 'compact', 'devAutoReload']) {
      if (body[key] !== undefined) s[key] = !!body[key];
    }
    for (const key of ['sessionTtlHours', 'expiryDays', 'warnBeforeExpiryDays']) {
      if (body[key] !== undefined) s[key] = clamp(int(body[key], s[key]), 1, 8760);
    }
    if (body.defaultLimits && typeof body.defaultLimits === 'object') {
      const merged = { ...s.defaultLimits, ...body.defaultLimits };
      s.defaultLimits = {
        memory: clamp(int(merged.memory, 1024), 128, 1024 * 64),
        disk: clamp(int(merged.disk, 5120), 64, 1024 * 1024),
        cpu: clamp(int(merged.cpu, 100), 5, 1600),
        servers: clamp(int(merged.servers, 2), 0, 500),
        backups: clamp(int(merged.backups, 5), 0, 200),
        ports: clamp(int(merged.ports, 2), 0, 100),
      };
    }
    if (body.defaultEggId !== undefined) {
      s.defaultEggId = body.defaultEggId ? String(body.defaultEggId) : null;
    }
    if (body.showDemoCredentials !== undefined) db.data.meta.demo = !!body.showDemoCredentials;
    db.save();
    db.audit({ action: 'settings.update', actorId: ctx.user.id, actorName: ctx.user.username, meta: { keys: Object.keys(body) } });
    return { settings: s };
  });

  /* ─────────── обновления ─────────── */
  route('GET', '/api/update', (ctx) => {
    if (!updater) throw notFound('Модуль обновлений не подключён');
    return updater.info();
  });

  route('POST', '/api/update/check', async (ctx) => {
    adminOnly(ctx.user);
    if (!updater) throw notFound();
    return updater.check();
  });

  route('POST', '/api/update/upload', async (ctx) => {
    adminOnly(ctx.user);
    if (!updater) throw notFound();
    const buf = await readBody(ctx.req, 128 * 1024 * 1024);
    return updater.applyPackage(buf, ctx.user);
  }, { rawBody: true });

  route('POST', '/api/update/from-file', (ctx) => {
    adminOnly(ctx.user);
    if (!updater) throw notFound();
    const file = String((ctx.body || {}).file || '');
    return updater.applyFromDisk(file, ctx.user);
  });

  /* ─────────── health ─────────── */
  route('GET', '/api/health', () => ({
    ok: true,
    version: updater ? updater.currentVersion() : '1.0.0',
    uptime: now() - startedAt,
    servers: db.data.servers.length,
    running: db.data.servers.filter((s) => daemon.isOnline(s.id)).length,
  }), { public: true });

  /* ───────────────────────── dispatcher ───────────────────────── */

  async function handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) return false;

    req.ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || (req.socket && req.socket.remoteAddress) || 'local';
    const cookieHeader = {};
    const method = req.method.toUpperCase();

    // CORS для API-ключей и внешних клиентов
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    let matched = null;
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.regex.regex);
      if (m) {
        const params = {};
        r.regex.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
        matched = { route: r, params };
        break;
      }
    }
    if (!matched) {
      sendJson(res, 404, { ok: false, error: 'Метод API не найден', code: 'NO_ROUTE' });
      return true;
    }

    const ctx = {
      req,
      res,
      query: Object.fromEntries(url.searchParams.entries()),
      params: matched.params,
      user: null,
      session: null,
      sid: null,
      via: 'session',
      body: {},
    };

    try {
      const session = auth.authenticate(req);
      if (session) {
        ctx.user = session.user;
        ctx.session = session.session;
        ctx.sid = session.sid;
        ctx.via = session.via;
      }
      if (!matched.route.opts.public && !ctx.user) {
        throw new HttpError(401, 'Требуется вход в панель', 'UNAUTHORIZED');
      }
      if (method !== 'GET' && !matched.route.opts.raw && !matched.route.opts.rawBody) {
        ctx.body = await readJson(req);
      }
      const result = await matched.route.handler(ctx);
      if (result && typeof result === 'object' && typeof result.cookie === 'string') {
        res.setHeader('Set-Cookie', result.cookie);
        const { cookie, ...rest } = result;
        ok(res, rest);
      } else if (result !== undefined && !res.writableEnded) {
        ok(res, result);
      }
      if (process.env.OMNIDASH_LOG !== '0' && pathname !== '/api/events') {
        const ms = Date.now() - started;
        if (ms > 400) console.log(`[api] ${method} ${pathname} — ${ms} мс`);
      }
      return true;
    } catch (err) {
      const status = Number(err.status) || 500;
      if (status >= 500) console.error(`[api] ${method} ${pathname}:`, err);
      if (!res.writableEnded) {
        sendJson(res, status, {
          ok: false,
          error: status >= 500 ? 'Внутренняя ошибка сервера' : err.message,
          code: err.code || 'ERROR',
          details: status >= 500 ? err.message : undefined,
        });
      }
      return true;
    }
  }

  return { handle, broadcast, notify, clients };
}

module.exports = { createApi, HttpError };
