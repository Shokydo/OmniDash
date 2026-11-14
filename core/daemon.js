'use strict';
/**
 * OmniDash Daemon («wings-lite»).
 *
 * Запускает процессы серверов так же, как это делает Pterodactyl Wings:
 *  • стартовая команда собирается из шаблона (egg) и переменных сервера;
 *  • консоль читается построчно, хранится в кольцевом буфере и в файле;
 *  • команды уходят в stdin процесса;
 *  • остановка: команда stop → SIGTERM → SIGKILL;
 *  • живая статистика CPU/RAM из /proc, размер каталога — обходом ФС;
 *  • лимиты памяти и диска проверяются на ходу.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const db = require('./db');
const { fmtBytes } = require('./util');

const LOG_LIMIT = 1200;
const HISTORY = 90;
const ROOT = path.join(__dirname, '..');

const STATUS = {
  OFFLINE: 'offline',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  CRASHED: 'crashed',
  SUSPENDED: 'suspended',
};

function dirSize(dir, budget = 40000) {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < budget) {
    const cur = stack.pop();
    let list;
    try {
      list = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of list) {
      seen += 1;
      const full = path.join(cur, item.name);
      if (item.isDirectory()) stack.push(full);
      else if (item.isFile()) {
        try { total += fs.statSync(full).size; } catch { /* ignore */ }
      }
      if (seen >= budget) break;
    }
  }
  return total;
}

function procStats(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const parts = stat.slice(close + 2).split(' ');
    const utime = Number(parts[11]) || 0;
    const stime = Number(parts[12]) || 0;
    let rss = 0;
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/VmRSS:\s+(\d+) kB/);
      if (m) rss = Number(m[1]) * 1024;
    } catch { /* ignore */ }
    return { ticks: utime + stime, rss, alive: true };
  } catch {
    return { ticks: 0, rss: 0, alive: false };
  }
}

function renderTemplate(template, vars) {
  return String(template || '').replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (all, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : all
  ));
}

class Daemon extends EventEmitter {
  constructor() {
    super();
    this.procs = new Map(); // serverId → { child, pid, status, startedAt, ... }
    this.history = new Map();
    this.logs = new Map();
    this.streams = new Map();
    this.stats = new Map();
    this.timers = {};
    this.host = { cpus: os.cpus().length || 1, platform: process.platform };
  }

  /* ────────────────────────── жизненный цикл ────────────────────────── */

  boot() {
    // После перезапуска панели процессы не «висят»: помечаем offline,
    // автостарт — только у серверов с явным флагом autoStart.
    for (const server of db.data.servers) {
      this.state(server.id, { status: STATUS.OFFLINE, pid: null });
      if (server.autoStart && !server.suspended) {
        setTimeout(() => this.start(server).catch(() => {}), 1500 + Math.random() * 1500);
      }
    }
    this.timers.tick = setInterval(() => this.tick().catch(() => {}), 2000);
    if (this.timers.tick.unref) this.timers.tick.unref();
    this.timers.disk = setInterval(() => this.refreshDisk().catch(() => {}), 30000);
    if (this.timers.disk.unref) this.timers.disk.unref();
    setTimeout(() => this.refreshDisk().catch(() => {}), 800);
  }

  shutdown() {
    for (const id of this.procs.keys()) {
      const entry = this.procs.get(id);
      if (entry.child) {
        try { this.killTree(entry.child, 'SIGKILL'); } catch { /* ignore */ }
      }
    }
  }

  entry(serverId) {
    if (!this.procs.has(serverId)) {
      this.procs.set(serverId, {
        child: null,
        pid: null,
        status: STATUS.OFFLINE,
        startedAt: null,
        stoppedAt: null,
        exitCode: null,
        signal: null,
        lastError: null,
        stopping: false,
        lastTicks: 0,
        lastTickAt: 0,
      });
    }
    return this.procs.get(serverId);
  }

  state(serverId, patch) {
    const entry = this.entry(serverId);
    Object.assign(entry, patch);
    this.emit('state', { serverId, ...this.publicState(serverId) });
  }

  publicState(serverId) {
    const e = this.entry(serverId);
    const live = this.liveStats(serverId);
    return {
      serverId,
      status: e.status,
      pid: e.pid,
      startedAt: e.startedAt,
      stoppedAt: e.stoppedAt,
      exitCode: e.exitCode,
      lastError: e.lastError,
      uptimeMs: e.startedAt && (e.status === STATUS.RUNNING || e.status === STATUS.STARTING)
        ? Date.now() - e.startedAt : 0,
      cpu: live.cpu,
      memory: live.memory,
      disk: this.diskOf(serverId),
      players: this.playersOf(serverId),
      tps: this.tpsOf(serverId),
      history: this.history.get(serverId) || [],
    };
  }

  /* ────────────────────────── переменные и команда ────────────────────────── */

  variables(server) {
    const egg = db.eggById(server.eggId);
    const vars = { ...(server.environment || {}) };
    for (const v of (egg && egg.variables) || []) {
      if (vars[v.env] === undefined || vars[v.env] === '') vars[v.env] = v.default;
    }
    const alloc = (server.allocations || [])
      .map((aid) => db.allocationById(aid))
      .find((a) => a) || null;
    const primary = db.allocationById(server.allocationId) || alloc;
    return {
      ...vars,
      SERVER_NAME: server.name,
      SERVER_ID: server.id,
      SERVER_UUID: server.uuid,
      SERVER_DIR: db.serverDir(server.id),
      BASE: ROOT,
      PORT: primary ? primary.port : '',
      IP: primary ? primary.ip : '0.0.0.0',
      MEMORY: server.limits.memory,
      DISK: server.limits.disk,
      CPU: server.limits.cpu,
    };
  }

  buildCommand(server) {
    const egg = db.eggById(server.eggId);
    if (!egg) {
      const err = new Error('Шаблон (egg) сервера не найден');
      err.status = 400;
      throw err;
    }
    let startup = egg.startup;
    if (server.startupOverride && egg.allowStartupOverride !== false) startup = server.startupOverride;
    const command = renderTemplate(startup, this.variables(server));
    const env = {};
    for (const [k, v] of Object.entries(this.variables(server))) {
      if (/^[A-Z0-9_]+$/.test(k)) env[k] = String(v);
    }
    return { command, env, egg };
  }

  /* ────────────────────────── управление ────────────────────────── */

  async start(server, actor = 'system') {
    const entry = this.entry(server.id);
    if (server.suspended) {
      const err = new Error('Сервер приостановлен');
      err.status = 409;
      throw err;
    }
    if ([STATUS.RUNNING, STATUS.STARTING, STATUS.STOPPING].includes(entry.status)) {
      return this.publicState(server.id);
    }
    const { command, env, egg } = this.buildCommand(server);
    if (!command || !command.trim()) throw Object.assign(new Error('Пустая стартовая команда'), { status: 400 });

    const dir = db.serverDir(server.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    this.rotateLog(server.id);

    this.pushLog(server.id, `\u001b[90m[OmniDash] запуск: ${command}\u001b[0m`, { system: true });
    const child = spawn(command, {
      cwd: dir,
      shell: true,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        ...env,
        PATH: process.env.PATH,
        SERVER_DIR: dir,
        HOME: dir,
        NODE_ENV: 'production',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.state(server.id, {
      child,
      pid: child.pid,
      status: STATUS.STARTING,
      startedAt: Date.now(),
      stoppedAt: null,
      exitCode: null,
      signal: null,
      lastError: null,
      stopping: false,
      lastTicks: 0,
      lastTickAt: Date.now(),
    });
    this.emit('notify', { type: 'server-start', serverId: server.id, name: server.name, actor });

    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        this.handleLine(server, line, egg);
        idx = buffer.indexOf('\n');
      }
      if (buffer.length > 8192) {
        this.handleLine(server, buffer, egg);
        buffer = '';
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      this.pushLog(server.id, `\u001b[31m[OmniDash] ошибка запуска: ${err.message}\u001b[0m`, { system: true });
      this.state(server.id, { status: STATUS.CRASHED, lastError: err.message, child: null, pid: null });
    });

    child.on('exit', (code, signal) => {
      if (buffer.trim()) this.handleLine(server, buffer, egg);
      buffer = '';
      const wasStopping = this.entry(server.id).stopping;
      this.state(server.id, {
        child: null,
        pid: null,
        exitCode: code,
        signal,
        stoppedAt: Date.now(),
        stopping: false,
        status: wasStopping ? STATUS.OFFLINE : code === 0 ? STATUS.OFFLINE : STATUS.CRASHED,
      });
      const msg = wasStopping
        ? '\u001b[90m[OmniDash] процесс остановлен\u001b[0m'
        : code === 0
          ? '\u001b[90m[OmniDash] процесс завершился с кодом 0\u001b[0m'
          : `\u001b[31m[OmniDash] процесс завершился с кодом ${code}${signal ? ` (${signal})` : ''}\u001b[0m`;
      this.pushLog(server.id, msg, { system: true });
      this.emit('notify', { type: 'server-stop', serverId: server.id, name: server.name, code });
      if (!wasStopping && code !== 0) {
        db.audit({
          action: 'server.crash',
          actorName: 'daemon',
          target: server.name,
          meta: { code, signal },
        });
      }
    });

    return this.publicState(server.id);
  }

  async stop(server, { force = false } = {}) {
    const entry = this.entry(server.id);
    if (!entry.child) {
      this.state(server.id, { status: STATUS.OFFLINE, pid: null });
      return this.publicState(server.id);
    }
    const egg = db.eggById(server.eggId) || {};
    const stopCommand = (egg.config && egg.config.stopCommand) || 'stop';
    const timeout = Math.max(3, Math.min(120, (egg.config && egg.config.stopTimeout) || 15));
    entry.stopping = true;
    this.state(server.id, { status: STATUS.STOPPING });

    if (!force && stopCommand && entry.child.stdin.writable) {
      try {
        entry.child.stdin.write(stopCommand + '\n');
        this.pushLog(server.id, `\u001b[90m[OmniDash] отправлена команда остановки: ${stopCommand}\u001b[0m`, { system: true });
      } catch { /* ignore */ }
      const done = await Promise.race([
        new Promise((resolve) => entry.child.once('exit', () => resolve(true))),
        new Promise((resolve) => setTimeout(() => resolve(false), timeout * 1000)),
      ]);
      if (done) return this.publicState(server.id);
    }

    try { this.killTree(entry.child, 'SIGTERM'); } catch { /* ignore */ }
    const exited = await Promise.race([
      new Promise((resolve) => entry.child.once('exit', () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    if (!exited) {
      try { this.killTree(entry.child, 'SIGKILL'); } catch { /* ignore */ }
    }
    entry.stopping = true;
    return this.publicState(server.id);
  }

  async restart(server, actor = 'system') {
    await this.stop(server);
    await new Promise((r) => setTimeout(r, 600));
    return this.start(server, actor);
  }

  kill(server) {
    return this.stop(server, { force: true });
  }

  killTree(child, signal) {
    if (!child || !child.pid) return;
    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']); } catch { /* ignore */ }
      try { child.kill(signal); } catch { /* ignore */ }
      return;
    }
    try { process.kill(-child.pid, signal); } catch {
      try { child.kill(signal); } catch { /* ignore */ }
    }
  }

  send(server, command) {
    const entry = this.entry(server.id);
    if (!entry.child || !entry.child.stdin.writable) {
      const err = new Error('Сервер не запущен — консоль недоступна');
      err.status = 409;
      throw err;
    }
    const clean = String(command || '').replace(/[\r\n]+/g, ' ').slice(0, 1000);
    if (!clean.trim()) return false;
    entry.child.stdin.write(clean + '\n');
    this.pushLog(server.id, `\u001b[36m> ${clean}\u001b[0m`, { command: true });
    return true;
  }

  /* ────────────────────────── логи и события ────────────────────────── */

  logFile(serverId) {
    return path.join(db.serverDir(serverId), 'logs', 'console.log');
  }

  rotateLog(serverId) {
    try {
      const file = this.logFile(serverId);
      const stat = fs.statSync(file);
      if (stat.size > 5 * 1024 * 1024) {
        fs.renameSync(file, path.join(path.dirname(file), `console-${Date.now()}.log`));
      }
    } catch { /* файла нет — норм */ }
    this.closeStream(serverId);
  }

  closeStream(serverId) {
    const stream = this.streams.get(serverId);
    if (stream) {
      try { stream.end(); } catch { /* ignore */ }
      this.streams.delete(serverId);
    }
  }

  writeStream(serverId) {
    if (!this.streams.has(serverId)) {
      try {
        fs.mkdirSync(path.dirname(this.logFile(serverId)), { recursive: true });
        const stream = fs.createWriteStream(this.logFile(serverId), { flags: 'a' });
        stream.on('error', () => { });
        this.streams.set(serverId, stream);
      } catch {
        return null;
      }
    }
    return this.streams.get(serverId);
  }

  pushLog(serverId, line, extra = {}) {
    const entry = { at: Date.now(), line: String(line) };
    const list = this.logs.get(serverId) || [];
    list.push(entry);
    if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT);
    this.logs.set(serverId, list);

    const stream = this.writeStream(serverId);
    if (stream) stream.write(`${new Date(entry.at).toISOString()} ${String(line).replace(/\u001b\[[0-9;]*m/g, '')}\n`);
    this.emit('log', { serverId, ...entry, ...extra });
  }

  getLogs(serverId, tail = 200) {
    const list = this.logs.get(serverId);
    if (list && list.length) return list.slice(-tail);
    // после рестарта панели консоль читаем с диска
    try {
      const raw = fs.readFileSync(this.logFile(serverId), 'utf8').trim().split('\n').slice(-tail);
      return raw.map((row) => {
        const m = row.match(/^(\S+)\s(.*)$/);
        return { at: m ? Date.parse(m[1]) || Date.now() : Date.now(), line: m ? m[2] : row };
      });
    } catch {
      return [];
    }
  }

  handleLine(server, line, egg) {
    const text = String(line).replace(/\r$/, '');
    this.pushLog(server.id, text);
    const entry = this.entry(server.id);
    if (entry.status === STATUS.STARTING) {
      const doneRe = egg && egg.config && egg.config.readyRegex ? new RegExp(egg.config.readyRegex) : /done|listening|started|готов|started on|bot ready|online/i;
      if (doneRe.test(text)) this.state(server.id, { status: STATUS.RUNNING });
    }
    const cfg = (egg && egg.config) || {};
    if (cfg.playerJoinRegex) {
      try {
        if (new RegExp(cfg.playerJoinRegex, 'i').test(text)) {
          this.stats.set(server.id, { ...(this.stats.get(server.id) || {}), players: (this.stats.get(server.id)?.players || 0) + 1 });
        }
        if (cfg.playerLeaveRegex && new RegExp(cfg.playerLeaveRegex, 'i').test(text)) {
          this.stats.set(server.id, { ...(this.stats.get(server.id) || {}), players: Math.max(0, (this.stats.get(server.id)?.players || 0) - 1) });
        }
      } catch { /* неверная регулярка в egg */ }
    }
    const tpsMatch = text.match(/(?:TPS|tps)[:=]\s*([\d.]+)/);
    if (tpsMatch) this.stats.set(server.id, { ...(this.stats.get(server.id) || {}), tps: Number(tpsMatch[1]) });
  }

  /* ────────────────────────── метрики ────────────────────────── */

  liveStats(serverId) {
    const entry = this.entry(serverId);
    if (!entry.pid) return { cpu: 0, memory: 0 };
    const ps = procStats(entry.pid);
    let cpu = 0;
    if (ps.alive && entry.lastTickAt) {
      const dt = Date.now() - entry.lastTickAt;
      const ds = ps.ticks - entry.lastTicks;
      if (dt > 0 && ds >= 0) cpu = (ds / (dt / 1000)) * 100 / this.host.cpus;
    }
    return { cpu: Math.max(0, Math.min(999, Math.round(cpu * 10) / 10)), memory: ps.rss };
  }

  diskOf(serverId) {
    return (this.stats.get(serverId) || {}).disk || 0;
  }

  playersOf(serverId) {
    return (this.stats.get(serverId) || {}).players || 0;
  }

  tpsOf(serverId) {
    return (this.stats.get(serverId) || {}).tps || null;
  }

  async refreshDisk() {
    for (const server of db.data.servers) {
      const disk = dirSize(db.serverDir(server.id));
      this.stats.set(server.id, { ...(this.stats.get(server.id) || {}), disk });
    }
  }

  async tick() {
    for (const server of db.data.servers) {
      const entry = this.entry(server.id);
      if (!entry.pid) continue;
      const live = this.liveStats(server.id);
      entry.lastTicks = procStats(entry.pid).ticks;
      entry.lastTickAt = Date.now();
      const list = this.history.get(server.id) || [];
      list.push({ t: Date.now(), cpu: live.cpu, memory: live.memory });
      if (list.length > HISTORY) list.splice(0, list.length - HISTORY);
      this.history.set(server.id, list);

      // Лимит памяти: как в Pterodactyl — предупреждение, затем принудительная остановка.
      if (server.limits && server.limits.memory && live.memory > server.limits.memory * 1024 * 1024 * 1.02) {
        entry.overMemory = (entry.overMemory || 0) + 1;
        if (entry.overMemory === 3) {
          this.pushLog(server.id, `\u001b[33m[OmniDash] превышен лимит памяти (${fmtBytes(live.memory)} / ${server.limits.memory} МБ)\u001b[0m`, { system: true });
        }
        if (entry.overMemory > 10) {
          this.pushLog(server.id, '\u001b[31m[OmniDash] остановка: лимит памяти исчерпан\u001b[0m', { system: true });
          entry.overMemory = 0;
          this.stop(server, { force: true }).catch(() => {});
        }
      } else {
        entry.overMemory = 0;
      }

      this.emit('stats', { serverId: server.id, ...live, disk: this.diskOf(server.id), players: this.playersOf(server.id) });
    }
  }

  hostInfo() {
    const load = os.loadavg();
    return {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpus: this.host.cpus,
      cpuModel: (os.cpus()[0] || {}).model || 'CPU',
      load1: Math.round(load[0] * 100) / 100,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      nodeVersion: process.version,
      uptime: os.uptime(),
    };
  }

  isOnline(serverId) {
    return [STATUS.RUNNING, STATUS.STARTING].includes(this.entry(serverId).status);
  }
}

module.exports = { Daemon, STATUS, renderTemplate, dirSize };
