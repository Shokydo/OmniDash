// Smoke-тест интерфейса OmniDash в jsdom: рендер страниц, модалки, ошибки JS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_UI_PORT || 7790);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omnidash-ui-'));

// собственный сервер на временной БД, чтобы не трогать рабочие данные
const serverProc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), OMNIDASH_DATA: DATA, OMNIDASH_QUIET: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
serverProc.stdout.on('data', (c) => { serverLog += c.toString(); });
serverProc.stderr.on('data', (c) => { serverLog += c.toString(); });
const startedAt = Date.now();
while (Date.now() - startedAt < 20000) {
  try {
    if ((await fetch(BASE + '/api/health')).ok) break;
  } catch { /* ждём */ }
  await new Promise((r) => setTimeout(r, 200));
}

function finish(code) {
  try { serverProc.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(code);
}

execSync('npx esbuild public/js/app.js --bundle --format=iife --outfile=/tmp/omnidash-ui.bundle.js --log-level=warning', { cwd: ROOT });
const bundle = fs.readFileSync('/tmp/omnidash-ui.bundle.js', 'utf8');

// логин, получаем cookie
const loginRes = await fetch(BASE + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
  body: JSON.stringify({ username: 'admin', password: 'omnidash' }),
});
if (!loginRes.ok) {
  console.error('login failed', loginRes.status, await loginRes.text(), '\n', serverLog);
  finish(1);
}
const cookie = (loginRes.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
console.log('cookie:', cookie.slice(0, 20) + '…');

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.stack || e.message)));
virtualConsole.on('error', (...args) => errors.push('console.error: ' + args.map(String).join(' ')));

const dom = new JSDOM(fs.readFileSync('/home/user/OmniDash/public/index.html', 'utf8'), {
  url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
});
const { window } = dom;
window.addEventListener('error', (e) => errors.push('window.error: ' + (e.error?.stack || e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + (e.reason?.stack || e.reason)));

// fetch с cookie
window.fetch = async (url, opts = {}) => {
  const abs = String(url).startsWith('http') ? String(url) : BASE + String(url);
  const headers = { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) };
  return fetch(abs, { ...opts, headers });
};
window.EventSource = class {
  constructor(url) { this.url = url; this.listeners = {}; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  close() {}
};
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });

const ctxMethods = ['setTransform', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'bezierCurveTo', 'closePath', 'fill', 'stroke',
  'setLineDash', 'arc', 'fillText', 'fillRect', 'save', 'restore', 'rect', 'translate', 'scale', 'roundRect'];
const mockCtx = new Proxy({}, {
  get(target, prop) {
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (prop === 'measureText') return () => ({ width: 24 });
    if (ctxMethods.includes(prop)) return () => {};
    if (prop === 'canvas') return null;
    return target[prop];
  },
  set(t, p, v) { t[p] = v; return true; },
});
window.HTMLCanvasElement.prototype.getContext = () => mockCtx;

window.eval(bundle);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => window.document.querySelector(sel)?.textContent?.trim() || '';

async function waitFor(sel, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (window.document.querySelector(sel)) return true;
    await sleep(60);
  }
  return false;
}

async function check(name, fn) {
  const before = errors.length;
  try {
    await fn();
    const newErrors = errors.slice(before);
    if (newErrors.length) {
      console.log(`✗ ${name}`);
      newErrors.slice(0, 4).forEach((e) => console.log('   ', e.split('\n').slice(0, 4).join('\n    ')));
    } else {
      console.log(`✓ ${name}`);
    }
  } catch (err) {
    console.log(`✗ ${name} — exception: ${err.message}`);
    errors.push(err.stack || err.message);
  }
}

await sleep(1200);
await check('вход и оболочка', async () => {
  if (!(await waitFor('.app'))) throw new Error('оболочка .app не появилась');
  if (!(await waitFor('.content .page'))) throw new Error('контент не отрисован');
  if (!text('#profile-name').includes('admin')) throw new Error('нет имени пользователя в топбаре');
});

await check('dashboard', async () => {
  const h1 = text('.page-head h1');
  if (!h1) throw new Error('нет заголовка');
  const stats = window.document.querySelectorAll('.stat').length;
  if (stats < 4) throw new Error('мало стат-карточек: ' + stats);
  if (!window.document.querySelector('#dash-chart')) throw new Error('нет графика');
  console.log('    заголовок:', h1, '| статов:', stats, '| событий:', window.document.querySelectorAll('.timeline-item').length);
});

await check('создание сервера (модалка)', async () => {
  window.document.querySelector('[data-action="create-server"]')?.click();
  if (!(await waitFor('.overlay .modal'))) throw new Error('модалка не открылась');
  const names = [...window.document.querySelectorAll('.modal .field label')].map((l) => l.textContent.trim());
  console.log('    поля:', names.slice(0, 6).join(', '));
  window.document.querySelector('.overlay [data-close]')?.click();
});

// API: список серверов и id
const serversData = await (await fetch(BASE + '/api/servers', { headers: { cookie } })).json();
const servers = serversData.data.servers;
const server = servers.find((s) => s.status === 'offline') || servers[0];
console.log('    тестовый сервер:', server.name, server.status);

await check('список серверов', async () => {
  window.location.hash = '#/servers';
  if (!(await waitFor('.server-card'))) throw new Error('карточки не отрисованы');
  console.log('    карточек:', window.document.querySelectorAll('.server-card').length);
});

const TAB_NAMES = { console: 'Консоль', manage: 'Управление', files: 'Файлы', connections: 'Подключения', backups: 'Бэкапы', startup: 'Переменные', access: 'Доступы', schedule: 'Расписание', settings: 'Настройки' };
for (const tab of Object.keys(TAB_NAMES)) {
  await check(`сервер → ${tab}`, async () => {
    window.location.hash = `#/servers/${server.id}/${tab}`;
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && !text('.tab.active').includes(TAB_NAMES[tab])) await sleep(90);
    if (!window.document.querySelector('.server-hero')) throw new Error('нет шапки сервера');
    if (!text('.tab.active').includes(TAB_NAMES[tab])) throw new Error('активная вкладка: ' + text('.tab.active'));
    const host = text('#tab-host');
    if (!host || host.length < 20) throw new Error('пустая вкладка');
    console.log('    вкладка:', text('.tab.active'), '| элементов:', window.document.querySelectorAll('#tab-host *').length, '|', host.slice(0, 60).replace(/\s+/g, ' '));
  });
}

await check('профиль', async () => {
  window.location.hash = '#/profile';
  const t0 = Date.now();
  while (Date.now() - t0 < 4000 && !text('.page-head h1').includes('Профиль')) await sleep(80);
  if (!text('.page-head h1').includes('Профиль')) throw new Error('неверный заголовок: ' + text('.page-head h1'));
});

for (const [hash, title] of [['#/users', 'Пользователи'], ['#/nodes', 'Узлы'], ['#/allocations', 'Аллокации'], ['#/eggs', 'Шаблоны'], ['#/audit', 'Журнал'], ['#/updates', 'Обновления'], ['#/settings', 'Настройки']]) {
  await check(hash, async () => {
    window.location.hash = hash;
    const t0 = Date.now();
    while (Date.now() - t0 < 4000 && !text('.page-head h1').includes(title)) await sleep(80);
    const h = text('.page-head h1');
    if (!h.includes(title)) throw new Error(`ожидали «${title}», получили «${h}»`);
    const rows = window.document.querySelectorAll('tbody tr, .timeline-item, .card').length;
    console.log('    элементов:', rows);
  });
}

await check('модалка пользователя', async () => {
  window.location.hash = '#/users';
  await sleep(600);
  window.document.querySelector('[data-edit-user]')?.click();
  if (!(await waitFor('.overlay .modal'))) throw new Error('не открылась');
  console.log('    заголовок:', text('.modal-head h3'));
  window.document.querySelector('.overlay [data-close]')?.click();
});

await check('палитра команд', async () => {
  window.document.getElementById('search-open')?.click();
  if (!(await waitFor('.palette-box'))) throw new Error('палитра не открылась');
  const items = window.document.querySelectorAll('.palette-item').length;
  console.log('    команд:', items);
  window.document.querySelector('.palette')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
});

await check('вкладка «Серверы» для пользователя steve', async () => {
  const steve = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ username: 'steve', password: 'steve123' }),
  });
  const steveCookie = (steve.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const res = await fetch(BASE + '/api/dashboard', { headers: { cookie: steveCookie } });
  const d = await res.json();
  console.log('    steve видит серверов:', d.data.counts.servers, '| лимиты:', JSON.stringify(d.data.limits));
});


/* ───────────── интерактивные проверки ───────────── */

await check('питание: запуск сервера', async () => {
  window.location.hash = `#/servers/${server.id}/console`;
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !text('.tab.active').includes('Консоль')) await sleep(90);
  // берём свободный порт узла, чтобы не пересечься с другими запущенными панелями
  const portsRes = await (await fetch(BASE + `/api/servers/${server.id}/allocations`, { headers: { cookie } })).json();
  const free = (portsRes.data?.available || []).find((p) => p.port !== server.allocation?.port);
  if (free) {
    await fetch(BASE + `/api/servers/${server.id}/allocations`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ allocationId: free.id, primary: true }),
    });
  }
  const btn = window.document.querySelector('[data-power="start"]:not([disabled])');
  if (!btn) throw new Error('кнопка «Запустить» недоступна (сервер уже работает?)');
  btn.click();
  await sleep(2600);
  const st = await (await fetch(BASE + `/api/servers/${server.id}/stats`, { headers: { cookie } })).json();
  if (!st.data || !['running', 'starting'].includes(st.data.status)) throw new Error('статус после старта: ' + JSON.stringify(st.data));
  console.log('    статус:', st.data.status, '| pid:', st.data.pid);
});

await check('консоль: отправка команды', async () => {
  const input = window.document.querySelector('#console-input');
  const form = window.document.querySelector('#console-form');
  if (!input || !form) throw new Error('нет консоли');
  input.value = 'say smoke-test';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(900);
  const logs = await (await fetch(BASE + `/api/servers/${server.id}/logs?tail=20`, { headers: { cookie } })).json();
  const lines = (logs.data.logs || []).map((l) => l.line).join('\n');
  if (!lines.includes('smoke-test')) throw new Error('команда не попала в лог');
  console.log('    последние:', (logs.data.logs || []).slice(-2).map((l) => l.line).join(' / ').slice(0, 100));
});

await check('файлы: редактор и сохранение', async () => {
  window.location.hash = `#/servers/${server.id}/files`;
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !text('.tab.active').includes('Файлы')) await sleep(90);
  let editBtn = null;
  for (let i = 0; i < 40; i += 1) {
    editBtn = window.document.querySelector('[data-act="edit"]');
    if (editBtn) break;
    await sleep(100);
  }
  if (!editBtn) throw new Error('нет файлов для редактирования');
  const targetPath = editBtn.dataset.path;
  if (!targetPath) throw new Error('нет пути файла');
  editBtn.click();
  await sleep(250);
  if (!(await waitFor('#editor-area'))) throw new Error('редактор не открылся');
  const area = window.document.querySelector('#editor-area');
  const original = area.value;
  area.value = original + '\n# smoke test ' + Date.now();
  window.document.querySelector('#editor-save').click();
  await sleep(800);
  const f = await (await fetch(BASE + `/api/servers/${server.id}/files/content?path=${encodeURIComponent(targetPath)}`, { headers: { cookie } })).json();
  if (!f.data?.content?.includes('smoke test')) throw new Error('файл не сохранился');
  area.value = original;
  window.document.querySelector('#editor-save').click();
  await sleep(400);
  window.document.querySelector('.overlay [data-close]')?.click();
  console.log('    сохранение работает, размер файла:', f.data.size);
});

await check('бэкапы: создание через модалку', async () => {
  window.location.hash = `#/servers/${server.id}/backups`;
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !text('.tab.active').includes('Бэкапы')) await sleep(90);
  window.document.querySelector('#backup-create').click();
  if (!(await waitFor('#bk-name'))) throw new Error('модалка бэкапа не открылась');
  window.document.querySelector('#bk-name').value = 'smoke backup';
  await sleep(200);
  window.document.querySelector('#bk-ok').click();
  let made = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(120);
    const list = await (await fetch(BASE + `/api/servers/${server.id}/backups`, { headers: { cookie } })).json();
    made = (list.data.backups || []).find((b) => b.name === 'smoke backup');
    if (made) break;
  }
  if (!made) throw new Error('бэкап не создан');
  await fetch(BASE + `/api/servers/${server.id}/backups/${made.id}`, { method: 'DELETE', headers: { cookie } });
  console.log('    бэкап создан и удалён:', made.sizeLabel);
});

await check('пользователи: создание через модалку', async () => {
  window.location.hash = '#/users';
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !window.document.querySelector('#create-user')) await sleep(90);
  window.document.querySelector('#create-user').click();
  if (!(await waitFor('#user-form'))) throw new Error('форма не открылась');
  const form = window.document.querySelector('#user-form');
  form.querySelector('input[name="username"]').value = 'smoketest';
  form.querySelector('input[name="password"]').value = 'smoketest123';
  await sleep(200);
  window.document.querySelector('#user-ok').click();
  let created = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(120);
    const users = await (await fetch(BASE + '/api/users', { headers: { cookie } })).json();
    created = (users.data.users || []).find((u) => u.username === 'smoketest');
    if (created) break;
  }
  if (!created) throw new Error('пользователь не создан');
  await fetch(BASE + '/api/users/' + created.id, { method: 'DELETE', headers: { cookie } });
  console.log('    пользователь создан и удалён:', created.username);
});

await check('остановка сервера', async () => {
  window.location.hash = `#/servers/${server.id}/manage`;
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !text('.tab.active').includes('Управление')) await sleep(90);
  const btn = window.document.querySelector('[data-power="stop"]:not([disabled])');
  if (!btn) throw new Error('кнопка «Остановить» недоступна');
  btn.click();
  await sleep(2500);
  const st = await (await fetch(BASE + `/api/servers/${server.id}/stats`, { headers: { cookie } })).json();
  if (!st.data || !['offline', 'stopping'].includes(st.data.status)) throw new Error('статус после стопа: ' + JSON.stringify(st.data));
  console.log('    статус:', st.data.status);
});

await sleep(200);
console.log('\nВсего ошибок:', errors.length);
if (errors.length) {
  console.log(errors.slice(0, 6).join('\n---\n'));
  process.exitCode = 1;
}
dom.window.close();
finish(process.exitCode || 0);
