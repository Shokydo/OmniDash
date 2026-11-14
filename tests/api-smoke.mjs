#!/usr/bin/env node
/**
 * API smoke-тест OmniDash. Поднимает отдельный сервер на временной БД,
 * прогоняет основные сценарии и прибирает за собой. Зависимостей нет.
 *
 *   npm run test:api
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 7788);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omnidash-test-'));
const XFF = `10.77.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function cookieJar() {
  let cookie = '';
  const wrap = async (url, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.cookie = cookie;
    if (opts.auth) {
      headers.authorization = opts.auth;
      delete opts.auth;
    }
    const res = await fetch(BASE + url, { ...opts, headers });
    const set = res.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    return res;
  };
  return {
    get cookie() { return cookie; },
    async json(url, opts = {}) {
      const res = await wrap(url, opts);
      const data = await res.json();
      return { status: res.status, ...data, data: data.data };
    },
    async raw(url, opts = {}) { return wrap(url, opts); },
  };
}

const admin = cookieJar();
const steve = cookieJar();

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    OMNIDASH_DATA: DATA,
    OMNIDASH_QUIET: '1',
    OMNIDASH_LOG: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
child.stdout.on('data', (c) => { serverLog += c.toString(); });
child.stderr.on('data', (c) => { serverLog += c.toString(); });

async function waitReady() {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function cleanup(code) {
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 100);
}

async function main() {
  if (!(await waitReady())) {
    console.error('Сервер не поднялся:\n' + serverLog);
    cleanup(1);
    return;
  }
  console.log(`\nOmniDash API smoke · ${BASE} · data ${DATA}\n`);

  // ── служебное и авторизация ──
  let r = await admin.json('/api/meta');
  ok('GET /api/meta публичный', r.ok && r.data.name === 'OmniDash', `v${r.data.version}`);
  ok('демо-данные созданы', r.data.demo.logins.length === 2);

  r = await admin.json('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': XFF },
    body: JSON.stringify({ username: 'admin', password: 'omnidash' }),
  });
  ok('вход admin', r.ok && r.data.user.role === 'admin');
  ok('cookie сессии выставлена', admin.cookie.includes('od_sid='));

  r = await admin.json('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': XFF },
    body: JSON.stringify({ username: 'admin', password: 'wrong' }),
  });
  ok('неверный пароль отклонён', r.status === 401);

  r = await admin.json('/api/auth/me');
  ok('GET /api/auth/me', r.ok && r.data.user.username === 'admin');

  // ── дашборд и серверы ──
  r = await admin.json('/api/dashboard');
  ok('дашборд', r.ok && r.data.counts.servers >= 5, `${r.data.counts.servers} серверов, ${r.data.counts.nodes} узла`);

  r = await admin.json('/api/servers');
  const seeded = r.data.servers;
  ok('список серверов', r.ok && seeded.length >= 5);
  const world = seeded.find((s) => s.name === 'Мир Друзей');
  ok('аллокация выдана серверу', !!world.allocation && world.allocation.port >= 25565);
  ok('срок аренды посчитан', world.daysLeft !== null);

  r = await admin.json(`/api/servers/${world.id}`);
  ok('детали сервера', r.ok && Array.isArray(r.data.logs) && r.data.egg.name.includes('Paper'));
  ok('права владельца-админа', r.data.server.permissions.includes('console') && r.data.server.permissions.includes('users'));

  // ── питание и консоль ──
  r = await admin.json(`/api/servers/${world.id}/power`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) });
  ok('запуск сервера', r.ok, r.data?.state?.status);
  await new Promise((res) => setTimeout(res, 2200));

  r = await admin.json(`/api/servers/${world.id}/stats`);
  ok('сервер работает', ['running', 'starting'].includes(r.data.status), `pid ${r.data.pid}`);

  r = await admin.json(`/api/servers/${world.id}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'say api-smoke' }) });
  ok('команда отправлена', r.ok && r.data.sent === true);
  await new Promise((res) => setTimeout(res, 500));
  r = await admin.json(`/api/servers/${world.id}/logs?tail=20`);
  ok('вывод в консоли', r.data.logs.some((l) => l.line.includes('api-smoke')));

  // ── файлы ──
  r = await admin.json(`/api/servers/${world.id}/files?path=`);
  ok('файловый менеджер', r.ok && r.data.entries.some((e) => e.name === 'server.properties'));
  const props = await admin.json(`/api/servers/${world.id}/files/content?path=server.properties`);
  ok('чтение файла', props.ok && props.data.content.includes('motd='));

  r = await admin.json(`/api/servers/${world.id}/files/content`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'tests/api.txt', content: 'hello omnidash' }),
  });
  ok('запись файла', r.ok && r.data.size === 14);
  r = await admin.json(`/api/servers/${world.id}/files/mkdir`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '', name: 'smoke-dir' }) });
  ok('создание папки', r.ok);
  r = await admin.json(`/api/servers/${world.id}/files/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: ['smoke-dir', 'tests'] }) });
  ok('удаление файлов', r.ok && r.data.removed.length === 2);

  r = await admin.json(`/api/servers/${world.id}/files/upload?path=&name=upload.txt`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'uploaded content' });
  ok('загрузка файла', r.ok && r.data.size === 16);
  r = await admin.json(`/api/servers/${world.id}/files/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: ['upload.txt'] }) });

  // ── бэкапы ──
  r = await admin.json(`/api/servers/${world.id}/backups`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'API smoke backup' }) });
  ok('создание бэкапа', r.ok && r.data.size > 0, r.data.sizeLabel);
  const backup = r.data;
  const dl = await admin.raw(`/api/servers/${world.id}/backups/${backup.id}/download`);
  ok('скачивание бэкапа', dl.status === 200 && (dl.headers.get('content-type') || '').includes('zip'));
  r = await admin.json(`/api/servers/${world.id}/backups/${backup.id}`, { method: 'DELETE' });
  ok('удаление бэкапа', r.ok);

  // ── задачи ──
  r = await admin.json(`/api/servers/${world.id}/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Smoke task', action: 'command', payload: 'say task', schedule: { type: 'interval', minutes: 60 } }),
  });
  ok('создание задачи', r.ok && r.data.nextRunAt > Date.now());
  const taskId = r.data.id;
  r = await admin.json(`/api/servers/${world.id}/tasks/${taskId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  ok('выключение задачи', r.ok && r.data.enabled === false);
  r = await admin.json(`/api/servers/${world.id}/tasks/${taskId}`, { method: 'DELETE' });
  ok('удаление задачи', r.ok);

  // ── порты ──
  r = await admin.json(`/api/servers/${world.id}/allocations`);
  ok('свободные порты', r.ok && r.data.available.length > 0, `${r.data.available.length} свободных`);
  const freePort = r.data.available[0];
  r = await admin.json(`/api/servers/${world.id}/allocations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allocationId: freePort.id, primary: false }) });
  ok('добавление порта', r.ok);
  r = await admin.json(`/api/servers/${world.id}/allocations/${freePort.id}`, { method: 'DELETE' });
  ok('освобождение порта', r.ok);

  // ── создание/удаление сервера ──
  const eggs = await admin.json('/api/eggs');
  const nodes = await admin.json('/api/nodes');
  r = await admin.json('/api/servers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'API Smoke Server', eggId: eggs.data.eggs[0].id, nodeId: nodes.data.nodes[0].id, memory: 1024, disk: 2048, cpu: 100, expiresDays: 7 }),
  });
  ok('создание сервера', r.ok && r.data.name === 'API Smoke Server', r.data.allocation?.label);
  const newServer = r.data;
  r = await admin.json(`/api/servers/${newServer.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'API Smoke Renamed', limits: { memory: 1536 } }) });
  ok('изменение сервера', r.ok && r.data.name === 'API Smoke Renamed' && r.data.limits.memory === 1536);
  r = await admin.json(`/api/servers/${newServer.id}/power`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) });
  await new Promise((res) => setTimeout(res, 1200));
  r = await admin.json(`/api/servers/${newServer.id}/power`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) });
  ok('стоп нового сервера', r.ok);
  r = await admin.json(`/api/servers/${newServer.id}`, { method: 'DELETE' });
  ok('удаление сервера', r.ok);

  // ── доступы (чужой сервер, не принадлежащий steve) ──
  const bot = seeded.find((s) => s.owner && s.owner.username === 'mira');
  r = await admin.json('/api/users');
  const steveUser = r.data.users.find((u) => u.username === 'steve');
  r = await admin.json(`/api/servers/${bot.id}/subusers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: steveUser.id, perms: ['console', 'files'] }),
  });
  ok('выдача доступа', r.ok && r.data.subusers.some((s) => s.userId === steveUser.id));

  r = await steve.json('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': XFF + '9' },
    body: JSON.stringify({ username: 'steve', password: 'steve123' }),
  });
  ok('вход steve', r.ok);
  r = await steve.json('/api/servers');
  ok('steve видит свои и выданные серверы', r.ok && r.data.servers.some((s) => s.id === bot.id));
  const shared = r.data.servers.find((s) => s.id === bot.id);
  ok('права сабюзера ограничены', shared.permissions.includes('console') && !shared.permissions.includes('control'));

  r = await steve.json('/api/users');
  ok('steve не админ', r.status === 403);
  r = await steve.json(`/api/servers/${bot.id}/power`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'restart' }) });
  ok('steve без права control не управляет', r.status === 403);

  r = await admin.json(`/api/servers/${bot.id}/subusers/${steveUser.id}`, { method: 'DELETE' });
  ok('отзыв доступа', r.ok);

  // ── продление ──
  r = await steve.json(`/api/servers/${world.id}/request-renew`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 30, comment: 'smoke' }) });
  ok('запрос продления', r.ok);
  r = await admin.json('/api/renew-requests');
  const req = r.data.requests.find((x) => x.serverId === world.id && x.status === 'pending');
  ok('админ видит запрос', !!req);
  if (req) {
    r = await admin.json(`/api/renew-requests/${req.id}/approve`, { method: 'POST' });
    ok('продление одобрено', r.ok && r.data.approved);
  }

  // ── пользователи ──
  r = await admin.json('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'smokeuser', email: 'smoke@example.com', password: 'smoke12345', role: 'user', limits: { servers: 2, memory: 2048, disk: 4096, cpu: 100 } }),
  });
  ok('создание пользователя', r.ok && r.data.username === 'smokeuser');
  const smokeUser = r.data;
  r = await admin.json(`/api/users/${smokeUser.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limits: { servers: 5 }, suspended: true }) });
  ok('блокировка и лимиты', r.ok && r.data.suspended && r.data.limits.servers === 5);
  r = await admin.json(`/api/users/${smokeUser.id}/password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'newpass123' }) });
  ok('сброс пароля', r.ok);
  r = await admin.json(`/api/users/${smokeUser.id}`, { method: 'DELETE' });
  ok('удаление пользователя', r.ok);

  // ── узлы и аллокации ──
  r = await admin.json('/api/nodes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-node', fqdn: '127.0.0.1', memoryTotal: 4096, diskTotal: 10240, portStart: 31000, portEnd: 31100 }),
  });
  ok('создание узла', r.ok && r.data.name === 'test-node');
  const testNode = r.data;
  r = await admin.json('/api/allocations/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodeId: testNode.id, from: 31000, to: 31009 }) });
  ok('массовое создание портов', r.ok && r.data.created === 10);
  r = await admin.json('/api/allocations?node=' + testNode.id);
  const createdPort = r.data.allocations[0];
  r = await admin.json(`/api/allocations/${createdPort.id}`, { method: 'DELETE' });
  ok('удаление порта', r.ok);
  r = await admin.json(`/api/nodes/${testNode.id}`, { method: 'DELETE' });
  ok('удаление узла', r.ok);

  // ── шаблоны ──
  r = await admin.json('/api/eggs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Smoke Egg', startup: 'echo hello {{PORT}}', variables: [{ env: 'FOO', label: 'Foo', default: 'bar' }] }),
  });
  ok('создание шаблона', r.ok && r.data.name === 'Smoke Egg');
  const egg = r.data;
  r = await admin.json(`/api/eggs/${egg.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'updated' }) });
  ok('изменение шаблона', r.ok && r.data.description === 'updated');
  r = await admin.json(`/api/eggs/${egg.id}`, { method: 'DELETE' });
  ok('удаление шаблона', r.ok);

  // ── настройки, журнал, обновления ──
  r = await admin.json('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ motd: 'smoke motd', defaultLimits: { servers: 4 } }) });
  ok('настройки сохраняются', r.ok && r.data.settings.motd === 'smoke motd' && r.data.settings.defaultLimits.servers === 4);
  await admin.json('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ motd: '' }) });

  r = await admin.json('/api/audit?limit=300');
  ok('журнал пишется', r.ok && r.data.entries.some((e) => e.action === 'server.create'));

  r = await admin.json('/api/update');
  ok('модуль обновлений', r.ok && r.data.version === '1.0.0' && r.data.autoReload === true);
  r = await admin.json('/api/update/check', { method: 'POST' });
  ok('проверка обновлений', r.ok && r.data.available === false);

  // ── API-ключи ──
  r = await admin.json('/api/auth/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'smoke' }) });
  ok('создание API-ключа', r.ok && r.data.secret.startsWith('od_'));
  const apiKey = r.data;
  const keyed = await fetch(BASE + '/api/servers', { headers: { authorization: 'Bearer ' + apiKey.secret } });
  const keyedData = await keyed.json();
  ok('запрос по API-ключу', keyed.ok && keyedData.data.servers.length > 0);
  r = await admin.json(`/api/auth/keys/${apiKey.key.id}`, { method: 'DELETE' });
  ok('отзыв API-ключа', r.ok);

  // ── финал: гасим сервер ──
  r = await admin.json(`/api/servers/${world.id}/power`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) });
  await new Promise((res) => setTimeout(res, 1200));
  ok('остановка сервера', r.ok);

  console.log(`\n  Итого: ${passed} ok, ${failed} fail`);
  if (failed) console.log('  Провалено: ' + failures.join(', '));
  console.log(`  Логи сервера: ${serverLog.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 200)}`);
  cleanup(failed ? 1 : 0);
}

process.on('SIGINT', () => cleanup(1));
main().catch((err) => {
  console.error('Ошибка теста:', err);
  if (serverLog) console.error(serverLog.slice(-1200));
  cleanup(1);
});
