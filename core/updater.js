'use strict';
/**
 * Обновления OmniDash — как в OmniPanel, но без GitHub.
 *
 * 1. Автоперезагрузка интерфейса (dev): файлы public/, core/ и server.js
 *    отслеживаются, панель сама перезагружает вкладку у всех клиентов.
 * 2. Канал обновлений: локальная папка updates/ или свой HTTP(S)-адрес
 *    с манифестом. Никакой привязки к GitHub.
 * 3. Применение ZIP-пакета: проверка пути, бэкап кода, распаковка,
 *    горячая перезагрузка статики. Данные (data/) не трогаются никогда.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const db = require('./db');
const zip = require('./zip');
const { compareVersions, sha256, now, iso } = require('./util');

const ROOT = path.join(__dirname, '..');
const UPDATES_DIR = path.join(ROOT, 'updates');
const BACKUP_DIR = path.join(db.DATA_DIR, 'updates');
const PROTECTED = [/^data\//, /^updates\//, /^\.git\//, /^node_modules\//, /^OmniDashData\//];
const CODE_DIRS = ['core', 'public', 'demo', 'tools'];

function ensureDirs() {
  for (const dir of [UPDATES_DIR, BACKUP_DIR]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function pkgVersion() {
  const pkg = readJson(path.join(ROOT, 'package.json'), {});
  return pkg.version || '1.0.0';
}

function releaseInfo() {
  return readJson(path.join(ROOT, 'version.json'), { version: pkgVersion(), notes: '' });
}

function hashDir() {
  const hash = crypto.createHash('sha1');
  const walk = (dir) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of list) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(full);
      } else {
        try {
          const st = fs.statSync(full);
          hash.update(`${path.relative(ROOT, full)}:${st.size}:${st.mtimeMs}\n`);
        } catch { /* ignore */ }
      }
    }
  };
  for (const dir of CODE_DIRS) walk(path.join(ROOT, dir));
  for (const file of ['server.js', 'version.json']) {
    try {
      const st = fs.statSync(path.join(ROOT, file));
      hash.update(`${file}:${st.size}:${st.mtimeMs}\n`);
    } catch { /* ignore */ }
  }
  return hash.digest('hex').slice(0, 12);
}

class Updater {
  constructor({ broadcast } = {}) {
    this.broadcast = broadcast || (() => {});
    this.buildId = hashDir();
    this.lastCheck = null;
    this.lastResult = null;
    this.watchers = [];
    this.debounce = null;
    this.history = [];
  }

  currentVersion() {
    return releaseInfo().version || pkgVersion();
  }

  info() {
    const release = releaseInfo();
    return {
      version: release.version || pkgVersion(),
      notes: release.notes || '',
      publishedAt: release.at || null,
      buildId: this.buildId,
      channel: db.data.settings.updateChannel || 'stable',
      updateUrl: db.data.settings.updateUrl || '',
      autoReload: !!db.data.settings.devAutoReload,
      mode: process.env.NODE_ENV === 'production' ? 'prod' : 'dev',
      lastCheck: this.lastCheck,
      lastResult: this.lastResult,
      history: this.history.slice(0, 10),
      pending: this.lastResult && this.lastResult.available ? this.lastResult : null,
      packages: this.listPackages(),
      restartRequired: this.restartRequired || false,
    };
  }

  listPackages() {
    ensureDirs();
    try {
      return fs.readdirSync(UPDATES_DIR)
        .filter((f) => f.endsWith('.zip'))
        .map((f) => {
          const st = fs.statSync(path.join(UPDATES_DIR, f));
          return { file: f, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
  }

  /* ───────────────────────── проверка ───────────────────────── */

  manifestFromDisk() {
    ensureDirs();
    const file = path.join(UPDATES_DIR, 'update.json');
    return readJson(file, null);
  }

  fetchRemote(url, timeout = 6000) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(url);
      } catch {
        reject(new Error('Некорректный адрес канала обновлений'));
        return;
      }
      const lib = target.protocol === 'https:' ? https : http;
      const req = lib.get(target, { headers: { 'user-agent': `OmniDash/${this.currentVersion()}` }, timeout }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.fetchRemote(res.headers.location, timeout).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Канал ответил ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { reject(new Error('Канал вернул не JSON')); }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('Канал обновлений не ответил вовремя')); });
      req.on('error', reject);
    });
  }

  async check() {
    const current = this.currentVersion();
    const url = String(db.data.settings.updateUrl || '').trim();
    let manifest = null;
    let source = 'local';
    let error = null;
    try {
      if (url) {
        manifest = await this.fetchRemote(url);
        source = url;
      } else {
        manifest = this.manifestFromDisk();
        source = 'updates/update.json';
      }
    } catch (err) {
      error = err.message;
    }
    const latest = manifest && manifest.version ? String(manifest.version) : current;
    const available = manifest ? compareVersions(latest, current) > 0 : false;
    const result = {
      available,
      current,
      latest,
      notes: manifest ? manifest.notes || '' : '',
      publishedAt: manifest ? manifest.at || null : null,
      package: manifest ? manifest.package || null : null,
      sha256: manifest ? manifest.sha256 || null : null,
      source,
      error,
      checkedAt: now(),
      packages: this.listPackages(),
    };
    this.lastCheck = now();
    this.lastResult = result;
    return result;
  }

  /* ───────────────────────── применение ───────────────────────── */

  snapshotCode() {
    ensureDirs();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUP_DIR, `code-before-${stamp}.zip`);
    const entries = [];
    for (const dir of CODE_DIRS) {
      const abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      for (const entry of zip.walk(abs, ROOT)) entries.push(entry);
    }
    for (const name of ['server.js', 'package.json', 'version.json']) {
      const abs = path.join(ROOT, name);
      if (!fs.existsSync(abs)) continue;
      const st = fs.statSync(abs);
      entries.push({ name, data: fs.readFileSync(abs), mtime: st.mtimeMs });
    }
    const buf = zip.write(entries);
    fs.writeFileSync(file, buf);
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('code-before-')).sort();
    while (files.length > 3) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, files.shift())); } catch { break; }
    }
    return path.basename(file);
  }

  applyPackage(buf, user = null, { label = 'zip-пакет', skipSnapshot = false } = {}) {
    if (!Buffer.isBuffer(buf) || buf.length < 32) throw Object.assign(new Error('Пустой пакет обновления'), { status: 400 });
    if (!skipSnapshot) this.snapshotName = this.snapshotCode();
    let entries;
    try {
      entries = zip.read(buf);
    } catch (err) {
      throw Object.assign(new Error(`Не удалось прочитать ZIP: ${err.message}`), { status: 400 });
    }
    if (!entries.length) throw Object.assign(new Error('В архиве нет файлов'), { status: 400 });
    // вложенная папка пакета (omnidash-1.1.0/...) разворачивается
    const tops = new Set(entries.map((e) => e.name.split('/')[0]));
    const stripPrefix = tops.size === 1 && entries.every((e) => e.name.includes('/')) ? `${[...tops][0]}/` : '';

    let applied = 0;
    let skipped = 0;
    let touchesCore = false;
    try {
      for (const entry of entries) {
        let name = entry.name.replace(/\\/g, '/');
        if (stripPrefix && name.startsWith(stripPrefix)) name = name.slice(stripPrefix.length);
        if (!name || name.endsWith('/')) continue;
        if (PROTECTED.some((re) => re.test(name))) { skipped += 1; continue; }
        const target = path.resolve(ROOT, name);
        if (!target.startsWith(ROOT + path.sep)) { skipped += 1; continue; }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.data);
        applied += 1;
        if (name === 'server.js' || name.startsWith('core/')) touchesCore = true;
      }
      // новая версия из манифеста пакета
      const pkg = readJson(path.join(ROOT, 'package.json'), {});
      const versionFile = readJson(path.join(ROOT, 'version.json'), {});
      const version = versionFile.version || pkg.version || this.currentVersion();
      this.buildId = hashDir();
      this.restartRequired = touchesCore;
      this.history.unshift({
        at: now(), version, applied, skipped, label, by: user ? user.username : 'system', restartRequired: touchesCore,
      });
      this.history = this.history.slice(0, 10);
      db.audit({
        action: 'update.apply',
        actorId: user ? user.id : null,
        actorName: user ? user.username : 'system',
        target: `v${version}`,
        meta: { applied, skipped, label, restartRequired: touchesCore },
      });
      this.broadcast('reload', {
        reason: 'update',
        version,
        buildId: this.buildId,
        restartRequired: touchesCore,
      });
      return {
        applied, skipped, version, restartRequired: touchesCore, buildId: this.buildId,
        message: touchesCore
          ? 'Файлы обновлены. Интерфейс перезагружен, для изменений в ядре нужен перезапуск процесса панели.'
          : 'Файлы обновлены, интерфейс перезагружен.',
        backup: this.snapshotName,
      };
    } catch (err) {
      throw err;
    }
  }

  applyFromDisk(relFile, user = null) {
    ensureDirs();
    const clean = String(relFile || '').replace(/\\/g, '/').split('/').pop();
    if (!clean || !clean.endsWith('.zip')) throw Object.assign(new Error('Выберите .zip из папки updates/'), { status: 400 });
    const abs = path.join(UPDATES_DIR, clean);
    if (!fs.existsSync(abs)) throw Object.assign(new Error(`Файл updates/${clean} не найден`), { status: 404 });
    const buf = fs.readFileSync(abs);
    return this.applyPackage(buf, user, { label: `updates/${clean}` });
  }

  applyVerifiedUrlPackage(user = null) {
    return this.check().then(async (result) => {
      if (!result.available || !result.package) {
        throw Object.assign(new Error('Обновление недоступно: нет нового пакета'), { status: 409 });
      }
      if (!/^https?:\/\//i.test(result.package)) throw Object.assign(new Error('В манифесте нет ссылки на пакет'), { status: 400 });
      const buf = await new Promise((resolve, reject) => {
        const lib = result.package.startsWith('https:') ? https : http;
        lib.get(result.package, { timeout: 30000 }, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`Пакет недоступен: ${res.statusCode}`));
            res.resume();
            return;
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
      });
      if (result.sha256 && sha256(buf) !== result.sha256) {
        throw Object.assign(new Error('sha256 пакета не совпал — обновление отменено'), { status: 409 });
      }
      return this.applyPackage(buf, user, { label: result.package });
    });
  }

  /* ───────────────────────── автоперезагрузка ───────────────────────── */

  startWatcher() {
    const watchTargets = ['public', 'core', 'version.json', 'server.js'];
    const onChange = (file) => {
      if (!db.data.settings.devAutoReload) return;
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        const next = hashDir();
        if (next === this.buildId) return;
        this.buildId = next;
        this.broadcast('reload', {
          reason: 'file-change',
          file: String(file || ''),
          buildId: next,
          version: this.currentVersion(),
        });
      }, 350);
    };
    for (const target of watchTargets) {
      const abs = path.join(ROOT, target);
      try {
        const watcher = fs.watch(abs, { recursive: true }, (event, file) => {
          if (file && /(\.log$|\.zip$|\.tmp$|~$)/.test(file)) return;
          onChange(path.join(target, String(file || '')));
        });
        watcher.on('error', () => { });
        this.watchers.push(watcher);
      } catch { /* платформа без recursive — молча пропускаем */ }
    }
  }

  stop() {
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
  }
}

module.exports = { Updater, ROOT, UPDATES_DIR };
