// OmniDash SPA: оболочка, роутер, SSE, палитра команд, глобальные действия.
import { api } from './api.js';
import { icon, logoMark } from './icons.js';
import {
  esc, toast, modal, confirmDialog, copy, fmtDuration, avatar, statusPill, setPageTitle, serverIcon,
} from './ui.js';
import { loginView } from './views-auth.js';
import { dashboardView } from './views-dashboard.js';
import { serversView, openCreateServer } from './views-servers.js';
import { serverView } from './views-server.js';
import {
  usersView, rolesView, nodesView, allocationsView, eggsView, auditView, updatesView, settingsView, profileView,
} from './views-admin.js';

const S = {
  me: null,
  meta: null,
  consoles: new Map(),
  cmdHistory: [],
  route: null,
  cleanup: null,
  sse: null,
  pending: null,
  serversCount: 0,
  servers: [],
};

const NAV = [
  {
    section: 'Личное',
    items: [
      { id: 'dashboard', label: 'Обзор', icon: 'dash', href: '#/' },
      { id: 'servers', label: 'Серверы', icon: 'servers', href: '#/servers', badge: 'servers' },
      { id: 'profile', label: 'Профиль', icon: 'user', href: '#/profile' },
    ],
  },
  {
    section: 'Администрирование',
    admin: true,
    items: [
      { id: 'users', label: 'Пользователи', icon: 'users', href: '#/users' },
      { id: 'roles', label: 'Роли', icon: 'shield', href: '#/roles' },
      { id: 'nodes', label: 'Узлы', icon: 'node', href: '#/nodes' },
      { id: 'allocations', label: 'Аллокации', icon: 'network', href: '#/allocations' },
      { id: 'eggs', label: 'Шаблоны', icon: 'package', href: '#/eggs' },
    ],
  },
  {
    section: 'Система',
    admin: true,
    items: [
      { id: 'audit', label: 'Журнал', icon: 'activity', href: '#/audit' },
      { id: 'updates', label: 'Обновления', icon: 'cloudDownload', href: '#/updates' },
      { id: 'settings', label: 'Настройки', icon: 'settings', href: '#/settings' },
    ],
  },
];

const ROUTES = {
  '': 'dashboard',
  '/': 'dashboard',
  '/servers': 'servers',
  '/users': 'users',
  '/roles': 'roles',
  '/nodes': 'nodes',
  '/allocations': 'allocations',
  '/eggs': 'eggs',
  '/audit': 'audit',
  '/updates': 'updates',
  '/settings': 'settings',
  '/profile': 'profile',
};

const VIEWS = {
  dashboard: dashboardView,
  servers: serversView,
  server: serverView,
  users: usersView,
  roles: rolesView,
  nodes: nodesView,
  allocations: allocationsView,
  eggs: eggsView,
  audit: auditView,
  updates: updatesView,
  settings: settingsView,
  profile: profileView,
};

const ADMIN_ROUTES = new Set(['users', 'roles', 'nodes', 'allocations', 'eggs', 'audit', 'updates', 'settings']);
const isAdmin = () => S.me && S.me.role === 'admin';

function applyAccent(color) {
  if (!/^#[0-9a-f]{6}$/i.test(String(color || ''))) return;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
}

/* ═════════════════════════════ авторизация ═════════════════════════════ */

async function boot() {
  try {
    S.meta = await api.get('/api/meta');
    applyAccent(S.meta.accent);
  } catch (err) {
    document.body.innerHTML = `<div class="center" style="min-height:100vh;padding:30px;text-align:center">
      <div><h2>Панель не отвечает</h2><p class="muted" style="margin-top:8px">${esc(err.message)}</p>
      <button class="btn primary" style="margin-top:16px" onclick="location.reload()">Повторить</button></div></div>`;
    return;
  }
  try {
    const me = await api.get('/api/auth/me');
    S.me = me.user;
    startApp();
  } catch {
    showLogin();
  }
}

function showLogin() {
  S.me = null;
  if (S.sse) { S.sse.close(); S.sse = null; }
  S.cleanup = null;
  document.body.innerHTML = '';
  const view = loginView({
    meta: S.meta,
    afterLogin: async () => {
      const me = await api.get('/api/auth/me');
      S.me = me.user;
      if (location.hash === '#/login') location.hash = '#/';
      startApp();
    },
  });
  document.body.innerHTML = view.html;
  view.mount(document.body);
  setPageTitle('Вход', S.meta);
}

let appStarted = false;

function startApp() {
  if (appStarted) { document.body.classList.remove('nav-open'); return; }
  appStarted = true;
  document.body.innerHTML = `
  <div class="app">
    <aside class="sidebar" id="sidebar">
      <div class="brand">
        <span class="brand-mark">${logoMark(32)}</span>
        <div>
          <div class="brand-name" id="brand-name">${esc(S.meta.name || 'OmniDash')}</div>
          <div class="brand-sub">control plane</div>
        </div>
      </div>
      <div class="sidebar-actions">
        <button class="side-action" id="logout-btn" title="Выйти из панели">${icon('logout', 15)}<span>Выйти</span></button>
      </div>
      <nav class="nav" id="nav"></nav>
      <div class="side-servers" id="side-servers">
        <div class="side-servers-head">
          <span>Серверы</span>
          <span class="count" id="side-servers-count">0</span>
        </div>
        <div class="side-servers-list" id="side-servers-list"></div>
        <button class="side-create" id="side-create">${icon('plus', 13)}<span>Создать сервер</span></button>
      </div>
      <div class="sidebar-foot">
        <div class="version-chip" id="version-chip">
          <span class="live-dot" id="live-dot"></span>
          <span>v${esc(S.meta.version)}</span>
          <span class="dim">·</span>
          ${isAdmin() ? '<a href="#/updates" style="color:inherit" title="Обновления">upd</a>' : '<span>core</span>'}
        </div>
        <button class="user-card" id="user-card">
          <span id="user-avatar"></span>
          <span class="meta">
            <span class="name" id="user-name"></span>
            <span class="role" id="user-role"></span>
          </span>
          ${icon('chevronRight', 14)}
        </button>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn mobile-only" id="nav-toggle" aria-label="Меню">${icon('menu', 18)}</button>
        <div class="crumbs" id="crumbs"></div>
        <div class="top-actions">
          <button class="search-btn" id="search-open">
            ${icon('search', 14)}<span>Поиск и команды</span><span class="kbd">⌘K</span>
          </button>
          <span class="chip" id="sse-status" style="height:30px"><span class="live-dot" id="live-dot-2"></span><span class="tiny">live</span></span>
          <a class="icon-btn" href="#/profile" id="profile-link" title="Профиль"></a>
        </div>
      </header>
      <main class="content" id="content"></main>
    </div>
  </div>
  <div class="toasts"></div>`;

  renderUserChrome();
  renderNav();
  connectSSE();
  document.getElementById('nav-toggle').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  document.getElementById('nav').addEventListener('click', () => document.body.classList.remove('nav-open'));
  document.getElementById('search-open').addEventListener('click', openPalette);
  document.getElementById('user-card').addEventListener('click', () => { location.hash = '#/profile'; });
  document.getElementById('logout-btn').addEventListener('click', () => logout());
  document.getElementById('side-create').addEventListener('click', () => openCreateServer({ me: S.me, meta: S.meta, refresh: () => route() }));
  document.getElementById('profile-link').addEventListener('click', (e) => { e.preventDefault(); location.hash = '#/profile'; });

  if (!location.hash) location.hash = '#/';
  route();
  refreshServerCount();
  setInterval(refreshServerCount, 30000);
}

function renderUserChrome() {
  const avatarEl = document.getElementById('user-avatar');
  const nameEl = document.getElementById('user-name');
  const roleEl = document.getElementById('user-role');
  if (!avatarEl) return;
  avatarEl.innerHTML = avatar(S.me);
  nameEl.textContent = S.me.username;
  roleEl.textContent = S.me.role === 'admin' ? 'администратор' : 'пользователь';
  document.getElementById('profile-link').innerHTML = avatar(S.me, 'sm');
  document.getElementById('brand-name').textContent = S.meta.name || 'OmniDash';
}

function navFor(routeName, hash) {
  return NAV.map((group) => {
    if (group.admin && !isAdmin()) return '';
    const items = group.items.filter((it) => !it.admin || isAdmin());
    if (!items.length) return '';
    return `
      <div class="nav-section">${esc(group.section)}</div>
      ${items.map((it) => {
        const active = routeName === it.id || (it.id === 'servers' && routeName === 'server');
        const badge = it.badge === 'servers' && S.serversCount ? `<span class="count">${S.serversCount}</span>` : '';
        const label = it.id === 'servers' && !isAdmin() ? 'Мои серверы' : it.label;
        return `<a class="nav-item ${active ? 'active' : ''}" href="${it.href}">
          ${icon(it.icon, 17)}<span>${esc(label)}</span>${badge}
        </a>`;
      }).join('')}`;
  }).join('');
}

function renderNav(hash = location.hash || '#/') {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const parsed = parseRoute(hash);
  nav.innerHTML = navFor(parsed.name, hash);
}

async function refreshServerCount() {
  try {
    const data = await api.get('/api/servers');
    S.servers = data.servers || [];
    S.serversCount = S.servers.length;
    renderNav();
    renderSideServers();
  } catch { /* ignore */ }
}

function renderSideServers() {
  const list = document.getElementById('side-servers-list');
  const count = document.getElementById('side-servers-count');
  if (!list) return;
  if (count) count.textContent = String(S.servers.length);
  const activeId = S.route && S.route.name === 'server' ? S.route.params.id : null;
  if (!S.servers.length) {
    list.innerHTML = '<div class="side-empty">Серверов нет</div>';
    return;
  }
  list.innerHTML = S.servers.map((s) => `
    <a class="side-server ${s.id === activeId ? 'active' : ''}" href="#/servers/${s.id}/console" title="${esc(s.name)}">
      ${serverIcon(s, 'sm')}
      <span class="ss-meta">
        <span class="ss-name">${esc(s.name)}</span>
        <span class="ss-sub">${esc((s.egg && s.egg.name) || 'сервер')}${s.allocation ? ` · :${esc(s.allocation.port)}` : ''}</span>
      </span>
      <span class="ss-dot ${esc(s.status)}" title="${esc(s.status)}"></span>
    </a>`).join('');
}

/* ═════════════════════════════ роутер ═════════════════════════════ */

function parseRoute(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart || '').entries());
  if (!parts.length) return { name: 'dashboard', params: {}, query };
  // серверные маршруты проверяем раньше простых: /servers/:id/:tab
  if (parts[0] === 'servers' && parts[1]) return { name: 'server', params: { id: parts[1], tab: parts[2] || 'console' }, query };
  const head = `/${parts[0]}`;
  if (ROUTES[head]) return { name: ROUTES[head], params: {}, query };
  if (parts[0] === 'login') return { name: 'login', params: {}, query };
  return { name: 'notfound', params: {}, query };
}

async function route() {
  if (!S.me) return;
  const parsed = parseRoute(location.hash);
  if (parsed.name === 'login') {
    location.hash = '#/';
    return;
  }
  if (parsed.name === 'notfound') {
    renderError('Страница не найдена', 'Проверьте адрес — такой страницы в панели нет.', false);
    return;
  }
  if (ADMIN_ROUTES.has(parsed.name) && !isAdmin()) {
    renderError('Доступ закрыт', 'Раздел доступен только администратору панели.', false);
    return;
  }
  S.route = parsed;
  renderNav();
  renderSideServers();
  renderCrumbs(parsed);

  const content = document.getElementById('content');
  if (!content) return;
  content.innerHTML = `<div class="page"><div class="skel" style="height:28px;width:220px;margin-bottom:16px"></div>
    <div class="grid stats"><div class="skel" style="height:118px"></div><div class="skel" style="height:118px"></div>
    <div class="skel" style="height:118px"></div><div class="skel" style="height:118px"></div></div>
    <div class="skel" style="height:280px;margin-top:16px"></div></div>`;

  const viewFn = VIEWS[parsed.name] || dashboardView;
  const ctx = {
    me: S.me,
    meta: S.meta,
    params: parsed.params,
    query: parsed.query,
    state: S,
    refresh: () => route(),
    logout,
    applySettings: (settings) => {
      if (settings.accent) { S.meta.accent = settings.accent; applyAccent(settings.accent); }
      if (settings.panelName) { S.meta.name = settings.panelName; renderUserChrome(); }
    },
    canCreateServer: isAdmin() || ((S.me.limits && S.me.limits.servers) > (S.me.usage && S.me.usage.servers)),
  };

  try {
    const view = await viewFn(ctx);
    // защита от гонки: пока грузили — могли уйти на другую страницу
    if (parseRoute(location.hash).name !== parsed.name) return;
    if (S.cleanup) {
      try { S.cleanup(); } catch { /* ignore */ }
      S.cleanup = null;
    }
    content.innerHTML = view.html;
    content.firstElementChild && content.firstElementChild.classList.add('page');
    if (view.mount) {
      const cleanup = view.mount(content);
      if (typeof cleanup === 'function') S.cleanup = cleanup;
    }
    setPageTitle(view.title, S.meta);
    if (S.pending) {
      const sel = S.pending;
      S.pending = null;
      const el = document.querySelector(sel);
      if (el) setTimeout(() => el.click(), 60);
    }
  } catch (err) {
    if (err.status === 401) {
      showLogin();
      return;
    }
    renderError('Не удалось загрузить страницу', err.message, true);
  }
}

function renderCrumbs(parsed) {
  const crumbs = document.getElementById('crumbs');
  if (!crumbs) return;
  const home = `<a href="#/" style="color:var(--text-mute)">${esc(S.meta.name || 'OmniDash')}</a>`;
  const sep = icon('chevronRight', 12);
  const names = {
    dashboard: 'Обзор', servers: 'Серверы', server: 'Сервер', users: 'Пользователи',
    nodes: 'Узлы', allocations: 'Аллокации', eggs: 'Шаблоны', audit: 'Журнал',
    updates: 'Обновления', settings: 'Настройки', profile: 'Профиль',
  };
  if (parsed.name === 'dashboard') {
    crumbs.innerHTML = `${home} ${sep} <b>Обзор</b>`;
  } else if (parsed.name === 'server') {
    crumbs.innerHTML = `${home} ${sep} <a href="#/servers" style="color:var(--text-mute)">Серверы</a> ${sep} <b id="crumb-server">Сервер</b>`;
    const nameEl = document.getElementById('crumb-server');
    // имя сервера подставит страница через заголовок
    setTimeout(() => {
      const h1 = document.querySelector('.server-hero h1');
      if (h1 && nameEl) nameEl.textContent = h1.textContent;
    }, 120);
  } else {
    crumbs.innerHTML = `${home} ${sep} <b>${esc(names[parsed.name] || '')}</b>`;
  }
}

function renderError(title, text, retry = true) {
  const content = document.getElementById('content');
  if (!content) return;
  content.innerHTML = `<div class="page"><div class="card" style="padding:48px;text-align:center;max-width:560px;margin:40px auto">
    <div class="center" style="width:52px;height:52px;border-radius:14px;background:rgba(251,113,133,.1);color:#fda4af;margin:0 auto 14px">${icon('alert', 24)}</div>
    <h2>${esc(title)}</h2>
    <p class="muted small" style="margin-top:8px;line-height:1.6">${esc(text)}</p>
    <div class="row" style="justify-content:center;margin-top:18px">
      ${retry ? `<button class="btn" onclick="location.reload()">${icon('refresh', 14)} Обновить</button>` : ''}
      <a class="btn primary" href="#/">${icon('arrowLeft', 14)} На обзор</a>
    </div>
  </div></div>`;
}

/* ═════════════════════════════ SSE ═════════════════════════════ */

function setLive(online) {
  document.querySelectorAll('#live-dot, #live-dot-2').forEach((dot) => dot.classList.toggle('off', !online));
  const status = document.getElementById('sse-status');
  if (status) status.title = online ? 'Соединение с панелью активно' : 'Соединение потеряно — переподключение…';
}

function connectSSE() {
  if (S.sse) S.sse.close();
  const es = new EventSource('/api/events');
  S.sse = es;
  es.onopen = () => setLive(true);
  es.onerror = () => setLive(false);

  const bind = (name, handler) => es.addEventListener(name, (e) => {
    let data = {};
    try { data = JSON.parse(e.data); } catch { /* ignore */ }
    handler(data);
  });

  bind('hello', () => setLive(true));
  bind('ping', () => setLive(true));
  bind('heartbeat', () => setLive(true));

  bind('log', (data) => {
    const list = S.consoles.get(data.serverId) || [];
    list.push({ at: data.at || Date.now(), line: data.line });
    if (list.length > 1200) list.splice(0, list.length - 1200);
    S.consoles.set(data.serverId, list);
    window.dispatchEvent(new CustomEvent('od:log', { detail: data }));
  });

  bind('state', (data) => window.dispatchEvent(new CustomEvent('od:state', { detail: data })));
  bind('stats', (data) => window.dispatchEvent(new CustomEvent('od:stats', { detail: data })));
  bind('servers', (data) => {
    refreshServerCount();
    window.dispatchEvent(new CustomEvent('od:servers', { detail: data }));
  });

  bind('notify', (data) => {
    const map = {
      'server-start': ['Сервер запускается', data.name, 'info'],
      'server-stop': ['Сервер остановлен', data.name, 'info'],
      'server-expired': ['Срок аренды истёк', `${data.name} приостановлен`, 'warn'],
      'server-expiring': ['Срок истекает', `${data.name}: осталось ${data.days} дн`, 'warn'],
      'renew-request': ['Запрос на продление', `${data.username} · ${data.serverName}`, 'info'],
      error: ['Ошибка', data.text, 'err'],
    };
    const [title, text, kind] = map[data.type] || ['Событие', data.type, 'info'];
    toast(title, text || '', kind, 6000);
    if (data.type === 'server-expired' || data.type === 'renew-request') window.dispatchEvent(new CustomEvent('od:servers', { detail: data }));
  });

  bind('reload', (data) => {
    const isUpdate = data.reason === 'update';
    toast(isUpdate ? 'Панель обновлена' : 'Интерфейс обновлён',
      isUpdate ? `Версия ${data.version} · перезагрузка…` : 'Файлы изменились — перезагружаем вкладку', 'info', 3000);
    const key = 'od:lastReload';
    const stamp = `${data.buildId}:${data.reason}`;
    if (sessionStorage.getItem(key) === stamp) return;
    sessionStorage.setItem(key, stamp);
    setTimeout(() => location.reload(), isUpdate ? 1100 : 750);
  });
}

/* ═════════════════════════════ палитра команд ═════════════════════════════ */

function openPalette() {
  if (document.querySelector('.palette')) return;
  const commands = [
    { label: 'Обзор', group: 'Перейти', icon: 'dash', run: () => { location.hash = '#/'; } },
    { label: 'Серверы', group: 'Перейти', icon: 'servers', run: () => { location.hash = '#/servers'; } },
    { label: isAdmin() ? 'Пользователи' : 'Профиль', group: 'Перейти', icon: isAdmin() ? 'users' : 'user', run: () => { location.hash = isAdmin() ? '#/users' : '#/profile'; } },
    ...(isAdmin() ? [
      { label: 'Узлы', group: 'Перейти', icon: 'node', run: () => { location.hash = '#/nodes'; } },
      { label: 'Аллокации', group: 'Перейти', icon: 'network', run: () => { location.hash = '#/allocations'; } },
      { label: 'Шаблоны', group: 'Перейти', icon: 'package', run: () => { location.hash = '#/eggs'; } },
      { label: 'Журнал действий', group: 'Перейти', icon: 'activity', run: () => { location.hash = '#/audit'; } },
      { label: 'Обновления', group: 'Перейти', icon: 'cloudDownload', run: () => { location.hash = '#/updates'; } },
      { label: 'Настройки панели', group: 'Перейти', icon: 'settings', run: () => { location.hash = '#/settings'; } },
      { label: 'Создать сервер', group: 'Действие', icon: 'plus', run: () => openCreateServer(currentCtx()) },
      { label: 'Создать пользователя', group: 'Действие', icon: 'user', run: () => { location.hash = '#/users'; S.pending = '#create-user'; } },
    ] : [
      { label: 'Профиль', group: 'Перейти', icon: 'user', run: () => { location.hash = '#/profile'; } },
    ]),
    { label: 'Выйти из панели', group: 'Аккаунт', icon: 'logout', run: () => logout() },
  ];

  const overlay = document.createElement('div');
  overlay.className = 'palette';
  overlay.innerHTML = `
    <div class="palette-box">
      <div class="palette-input">${icon('search', 16)}<input id="palette-input" placeholder="Куда перейти или что сделать…" autocomplete="off" /></div>
      <div class="palette-list" id="palette-list"></div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#palette-input');
  const list = overlay.querySelector('#palette-list');
  let items = commands;
  let sel = 0;

  const paint = () => {
    list.innerHTML = items.map((c, i) => `
      <button class="palette-item ${i === sel ? 'sel' : ''}">
        ${icon(c.icon, 15)}<span>${esc(c.label)}</span><span class="g">${esc(c.group)}</span>
      </button>`).join('') || `<div class="palette-empty">Ничего не найдено</div>`;
    list.querySelectorAll('.palette-item').forEach((el, i) => {
      el.addEventListener('mouseenter', () => { sel = i; paint(); });
      el.addEventListener('click', () => { const cmd = items[i]; close(); cmd.run(); });
    });
  };

  const filter = () => {
    const q = input.value.trim().toLowerCase();
    items = commands.filter((c) => c.label.toLowerCase().includes(q));
    sel = 0;
    paint();
  };

  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
    else if (e.key === 'Enter' && items[sel]) { const cmd = items[sel]; close(); cmd.run(); }
  };
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  input.addEventListener('input', filter);
  paint();
  setTimeout(() => input.focus(), 40);
}

function currentCtx() {
  return {
    me: S.me,
    meta: S.meta,
    state: S,
    refresh: () => route(),
    logout,
    params: S.route ? S.route.params : {},
    query: S.route ? S.route.query : {},
    applySettings: () => {},
  };
}

/* ═════════════════════════════ глобальные действия ═════════════════════════════ */

async function powerAction(serverId, action) {
  if (action === 'kill') {
    const ok = await confirmDialog({
      title: 'Убить процесс?',
      text: 'SIGKILL без сохранения мира. Используйте, если сервер завис.',
      confirmText: 'Убить',
      danger: true,
    });
    if (!ok) return;
  }
  try {
    const res = await api.post(`/api/servers/${serverId}/power`, { action });
    const labels = { start: 'Запуск', stop: 'Остановка', restart: 'Перезапуск', kill: 'Процесс убит' };
    toast(labels[action] || 'Готово', res.server.name, action === 'start' ? 'ok' : 'info', 2500);
    window.dispatchEvent(new CustomEvent('od:power', { detail: { serverId, action, state: res.state } }));
  } catch (err) {
    toast('Не удалось выполнить', err.message, 'err');
  }
}

async function logout() {
  try { await api.post('/api/auth/logout'); } catch { /* ignore */ }
  if (S.sse) { S.sse.close(); S.sse = null; }
  appStarted = false;
  S.cleanup = null;
  location.hash = '';
  showLogin();
}

function renewModal(serverId, days = 30) {
  modal({
    title: 'Продлить сервер',
    subtitle: 'Срок добавляется к текущей дате окончания',
    slim: true,
    body: `<div class="field"><label>Количество дней</label><div class="input-group">
      <input class="input" type="number" id="renew-days" value="${days}" min="1" max="3650" /><span class="input-suffix">дней</span></div></div>`,
    footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" id="renew-ok">${icon('calendar', 14)} Продлить</button>`,
    onMount: (overlay, close) => {
      overlay.querySelector('#renew-ok').addEventListener('click', async () => {
        const value = Number(overlay.querySelector('#renew-days').value) || 30;
        try {
          await api.post(`/api/servers/${serverId}/renew`, { days: value });
          toast('Срок продлён', `+${value} дней`, 'ok');
          close();
          route();
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });
    },
  });
}

function requestRenewModal(serverId) {
  modal({
    title: 'Запрос продления',
    subtitle: 'Администратор увидит запрос и продлит сервер',
    slim: true,
    body: `<div class="stack">
      <div class="field"><label>На сколько дней</label><div class="input-group"><input class="input" type="number" id="req-days" value="30" min="1" /><span class="input-suffix">дней</span></div></div>
      <div class="field"><label>Комментарий</label><textarea class="textarea" id="req-comment" rows="2" placeholder="Коротко, зачем продление"></textarea></div>
    </div>`,
    footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" id="req-ok">Отправить запрос</button>`,
    onMount: (overlay, close) => {
      overlay.querySelector('#req-ok').addEventListener('click', async () => {
        try {
          await api.post(`/api/servers/${serverId}/request-renew`, {
            days: Number(overlay.querySelector('#req-days').value) || 30,
            comment: overlay.querySelector('#req-comment').value,
          });
          toast('Запрос отправлен', 'Администратор получит уведомление', 'ok');
          close();
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });
    },
  });
}

document.addEventListener('click', (e) => {
  const copyTarget = e.target.closest('[data-copy]');
  if (copyTarget) {
    e.preventDefault();
    copy(copyTarget.dataset.copy);
    return;
  }
  const powerBtn = e.target.closest('[data-power]');
  if (powerBtn && !powerBtn.disabled) {
    const host = powerBtn.closest('[data-server-id]');
    if (host) {
      e.preventDefault();
      powerAction(host.dataset.serverId, powerBtn.dataset.power);
    }
    return;
  }
  const actionBtn = e.target.closest('[data-action]');
  if (actionBtn) {
    const action = actionBtn.dataset.action;
    if (action === 'refresh') {
      route();
    } else if (action === 'create-server') {
      openCreateServer(currentCtx());
    } else if (action === 'create-user') {
      if (S.route && S.route.name === 'users') {
        const btn = document.getElementById('create-user');
        if (btn) btn.click();
      } else {
        S.pending = '#create-user';
        location.hash = '#/users';
      }
    } else if (action === 'renew-server') {
      renewModal(actionBtn.dataset.id, Number(actionBtn.dataset.days) || 30);
    } else if (action === 'request-renew') {
      requestRenewModal(actionBtn.dataset.id);
    }
    return;
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (S.me) openPalette();
  }
});

window.addEventListener('hashchange', () => { if (S.me) route(); });

// применяем акцент из meta до загрузки оболочки
boot();
