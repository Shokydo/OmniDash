'use strict';
/**
 * Планировщик: задачи серверов (интервал / ежедневно / один раз),
 * автоматическая приостановка истёкших серверов, напоминания о продлении,
 * очистка сессий. Полный аналог «Schedules» из Pterodactyl в упрощённом виде.
 */
const db = require('./db');
const backups = require('./backups');
const serversCore = require('./servers');
const { id, now, int } = require('./util');

const ACTIONS = {
  command: 'Отправить команду',
  power_start: 'Запустить',
  power_stop: 'Остановить',
  power_restart: 'Перезапустить',
  backup: 'Создать бэкап',
};

function nextRun(task, from = now()) {
  const s = task.schedule || {};
  if (s.type === 'interval') {
    const minutes = Math.max(1, int(s.minutes, 60));
    return from + minutes * 60000;
  }
  if (s.type === 'daily') {
    const m = String(s.time || '04:00').match(/^(\d{1,2}):(\d{2})$/);
    const hh = m ? Math.min(23, int(m[1], 4)) : 4;
    const mm = m ? Math.min(59, int(m[2], 0)) : 0;
    const d = new Date(from);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (s.type === 'once') {
    return s.at ? Number(s.at) : null;
  }
  return null;
}

function makeTask(data) {
  const task = {
    id: id('task'),
    name: String(data.name || 'Задача').slice(0, 60),
    action: ACTIONS[data.action] ? data.action : 'command',
    payload: String(data.payload || '').slice(0, 500),
    schedule: {
      type: ['interval', 'daily', 'once'].includes(data.schedule && data.schedule.type) ? data.schedule.type : 'interval',
      minutes: Math.max(1, int(data.schedule && data.schedule.minutes, 60)),
      time: String((data.schedule && data.schedule.time) || '04:00').slice(0, 5),
      at: data.schedule && data.schedule.at ? Number(data.schedule.at) : null,
    },
    enabled: data.enabled !== false,
    createdAt: now(),
    lastRunAt: null,
    nextRunAt: null,
    lastResult: null,
  };
  task.nextRunAt = task.enabled ? nextRun(task) : null;
  return task;
}

class Scheduler {
  constructor(daemon) {
    this.daemon = daemon;
    this.timer = null;
    this.cleanupAt = 0;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((err) => console.error('[scheduler]', err.message)), 20000);
    if (this.timer.unref) this.timer.unref();
    setTimeout(() => this.tick().catch(() => {}), 3000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async runTask(server, task) {
    try {
      if (task.action === 'command') {
        this.daemon.send(server, task.payload || 'say hello');
      } else if (task.action === 'power_start') {
        await this.daemon.start(server, 'schedule');
      } else if (task.action === 'power_stop') {
        await this.daemon.stop(server);
      } else if (task.action === 'power_restart') {
        await this.daemon.restart(server, 'schedule');
      } else if (task.action === 'backup') {
        backups.create(server, { name: task.payload || `По расписанию: ${task.name}`, actor: null });
      }
      task.lastResult = 'ok';
    } catch (err) {
      task.lastResult = `ошибка: ${err.message}`;
      this.daemon.pushLog(server.id, `\u001b[31m[OmniDash] задача «${task.name}»: ${err.message}\u001b[0m`, { system: true });
    }
    task.lastRunAt = now();
    if (task.schedule.type === 'once') {
      task.enabled = false;
      task.nextRunAt = null;
    } else {
      task.nextRunAt = task.enabled ? nextRun(task) : null;
    }
    db.save();
  }

  async tick() {
    const t = now();
    // 1. Задачи серверов
    for (const server of db.data.servers) {
      for (const task of server.tasks || []) {
        if (!task.enabled) continue;
        if (!task.nextRunAt) task.nextRunAt = nextRun(task);
        if (task.nextRunAt && task.nextRunAt <= t) {
          if (!server.suspended) await this.runTask(server, task);
          else {
            task.nextRunAt = nextRun(task);
            db.save();
          }
        }
      }
    }

    // 2. Истёкшие серверы
    if (db.data.settings.autoSuspendExpired) {
      for (const server of db.data.servers) {
        if (!server.expiresAt || server.suspended) continue;
        if (server.expiresAt <= t) {
          serversCore.suspend(server, 'expired', null);
          const entry = this.daemon.entry(server.id);
          if (entry.child) await this.daemon.stop(server, { force: true }).catch(() => {});
          this.daemon.pushLog(server.id, '\u001b[31m[OmniDash] срок аренды истёк — сервер приостановлен\u001b[0m', { system: true });
          this.daemon.emit('notify', { type: 'server-expired', serverId: server.id, name: server.name });
        } else {
          const left = serversCore.daysLeft(server);
          const warn = int(db.data.settings.warnBeforeExpiryDays, 5);
          if (left !== null && left <= warn && server.expiryNotifiedAt !== new Date(t).toDateString()) {
            server.expiryNotifiedAt = new Date(t).toDateString();
            db.save();
            this.daemon.emit('notify', { type: 'server-expiring', serverId: server.id, name: server.name, days: left });
          }
        }
      }
    }

    // 3. Сессии и уборка раз в 5 минут
    if (t - this.cleanupAt > 5 * 60000) {
      this.cleanupAt = t;
      const auth = require('./auth');
      auth.cleanupSessions();
      // устаревшие запросы продления
      db.data.renewRequests = (db.data.renewRequests || []).filter((r) => t - r.at < 30 * 86400000);
      db.save();
    }
  }
}

module.exports = { Scheduler, makeTask, nextRun, ACTIONS };
