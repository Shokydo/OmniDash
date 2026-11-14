'use strict';
/**
 * OmniDash — панель управления игровыми и обычными серверами.
 * Точка входа: HTTP-сервер, статика, REST API и SSE.
 *
 * Запуск:  node server.js        (или npm start)
 * Порт:    PORT=7777 по умолчанию, слушает 0.0.0.0
 * Данные:  ./data  (можно изменить через OMNIDASH_DATA)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const db = require('./core/db');
const { Daemon } = require('./core/daemon');
const { Scheduler } = require('./core/scheduler');
const { Updater } = require('./core/updater');
const { createApi } = require('./core/api');
const sftp = require('./core/sftp');
const { seed } = require('./core/seed');

const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const startedAt = Date.now();

/* ────────────────────────────── инициализация ────────────────────────────── */
db.load();
const seeded = seed();
const daemon = new Daemon();
const scheduler = new Scheduler(daemon);

const updater = new Updater();
const api = createApi({ daemon, scheduler, updater });
// Updater создаётся раньше API, чтобы маршруты обновлений были доступны сразу;
// broadcast подключаем после — так SSE-события обновлений доходят до клиентов.
updater.broadcast = api.broadcast;

daemon.boot();
scheduler.start();
sftp.start();
updater.startWatcher();

/* ────────────────────────────── статика ────────────────────────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(400);
    res.end('Bad path');
    return;
  }
  fs.stat(abs, (err, stat) => {
    if (!err && stat.isFile()) {
      const ext = path.extname(abs).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(abs).pipe(res);
      return;
    }
    // SPA-роутинг: любой неизвестный путь отдаёт index.html
    if (!path.extname(rel)) {
      const index = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(index, (e2, buf) => {
        if (e2) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Не найден public/index.html');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(buf);
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — файл не найден');
  });
}

/* ────────────────────────────── сервер ────────────────────────────── */
const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  try {
    if (url.startsWith('/api/')) {
      const handled = await api.handle(req, res);
      if (!handled && !res.writableEnded) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Не найдено' }));
      }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Метод не поддерживается');
      return;
    }
    const pathname = url.split('?')[0];
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, uptime: Date.now() - startedAt, version: updater.currentVersion() }));
      return;
    }
    serveStatic(req, res, pathname);
  } catch (err) {
    console.error('[http]', err);
    if (!res.writableEnded) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Внутренняя ошибка' }));
    }
  }
});

server.on('upgrade', (req, socket) => {
  // WebSocket не используется: консоль работает через SSE.
  socket.destroy();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[OmniDash] Порт ${PORT} занят. Запустите с другим портом: PORT=${PORT + 1} node server.js\n`);
    process.exit(1);
  }
  console.error('[OmniDash] ошибка сервера:', err);
});

server.listen(PORT, HOST, () => {
  const release = updater.currentVersion();
  const lines = [
    '',
    '\u001b[1m  OmniDash\u001b[0m  — панель управления серверами',
    `  версия   \u001b[36mv${release}\u001b[0m · сборка ${updater.buildId} · Node ${process.version}`,
    `  адрес    \u001b[4mhttp://localhost:${PORT}\u001b[0m  (слушает ${HOST})`,
    `  данные   ${db.DATA_DIR}`,
    `  обновл.  ${db.data.settings.devAutoReload ? 'автоперезагрузка включена' : 'автоперезагрузка выключена'}${seeded ? ' · демо-данные созданы' : ''}`,
    '',
    '  Вход: \u001b[1madmin\u001b[0m / omnidash   ·   steve / steve123',
    '',
  ];
  console.log(lines.join('\n'));
  if (process.env.OMNIDASH_QUIET !== '1') {
    console.log(`  платформа: ${os.type()} ${os.release()} · CPU ${os.cpus().length} ядер · RAM ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} ГБ`);
  }
});

/* ────────────────────────────── остановка ────────────────────────────── */
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[OmniDash] ${signal}: останавливаем процессы серверов...`);
  updater.stop();
  scheduler.stop();
  daemon.shutdown();
  db.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[OmniDash] необработанная ошибка:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[OmniDash] необработанный rejection:', err);
});
