// Список серверов + модалка создания (общая для нескольких страниц).
import { api } from './api.js';
import { icon } from './icons.js';
import {
  esc, fmtBytes, fmtMb, fmtDuration, fmtDateTime, statusPill, powerButtons, expiryChip,
  meter, emptyState, modal, toast, formDialog, serializeForm, avatar,
} from './ui.js';

export function serverCard(server) {
  const usage = server.usage || {};
  const memPct = server.limits.memory ? (usage.memory / 1024 / 1024 / server.limits.memory) * 100 : 0;
  const diskPct = server.limits.disk ? (usage.disk / 1024 / 1024 / server.limits.disk) * 100 : 0;
  return `
  <article class="card hoverable server-card" data-server-id="${server.id}">
    <div class="head">
      <a class="server-icon" href="#/servers/${server.id}/console">${icon('server', 19)}</a>
      <div class="grow" style="min-width:0">
        <a class="title ellipsis" style="display:block;color:var(--text)" href="#/servers/${server.id}/console">${esc(server.name)}</a>
        <div class="sub">
          ${esc((server.owner && server.owner.username) || '—')}
          <span class="dim">·</span> ${esc((server.egg && server.egg.name) || '—')}
          <span class="dim">·</span> <span class="mono">${server.allocation ? esc(server.allocation.port) : '—'}</span>
        </div>
      </div>
      ${statusPill(server.status)}
    </div>
    <div class="server-metrics">
      <div class="metric"><div class="k">CPU</div><div class="v">${(usage.cpu || 0).toFixed(1)}%</div></div>
      <div class="metric"><div class="k">RAM</div><div class="v">${fmtMb(Math.round((usage.memory || 0) / 1024 / 1024))}<span class="dim">/${server.limits.memory}</span></div></div>
      <div class="metric"><div class="k">Диск</div><div class="v">${fmtBytes(usage.disk || 0)}</div></div>
      <div class="metric"><div class="k">Аптайм</div><div class="v">${usage.uptimeMs ? fmtDuration(usage.uptimeMs) : '—'}</div></div>
      <div class="metric"><div class="k">Игроки</div><div class="v">${usage.players || 0}</div></div>
      <div class="metric"><div class="k">Бэкапы</div><div class="v">${server.backups || 0}</div></div>
    </div>
    <div>
      <div class="usage-line"><span>Память</span><b>${memPct.toFixed(0)}%</b></div>
      ${meter(memPct, memPct > 90 ? 'rose' : memPct > 70 ? 'amber' : 'green')}
      <div class="usage-line" style="margin-top:8px"><span>Диск</span><b>${diskPct.toFixed(0)}%</b></div>
      ${meter(diskPct, diskPct > 90 ? 'rose' : '')}
    </div>
    <div class="server-foot">
      ${powerButtons(server)}
      ${expiryChip(server.daysLeft)}
      <a class="btn sm ghost right" href="#/servers/${server.id}/console" style="margin-left:auto">Открыть ${icon('chevronRight', 13)}</a>
    </div>
  </article>`;
}

export function serverRow(server) {
  return `
  <tr class="clickable" data-href="#/servers/${server.id}/console" data-server-id="${server.id}">
    <td>
      <div class="row" style="gap:9px;min-width:0">
        <span class="avatar sm">${esc((server.name || '?').slice(0, 2))}</span>
        <div style="min-width:0">
          <div class="ellipsis" style="font-weight:560">${esc(server.name)}</div>
          <div class="tiny dim mono ellipsis">${esc(server.uuid.slice(0, 13))}</div>
        </div>
      </div>
    </td>
    <td>${statusPill(server.status)}</td>
    <td>
      <div class="row" style="gap:6px">${avatar(server.owner, 'sm')}<span class="small">${esc((server.owner && server.owner.username) || '—')}</span></div>
    </td>
    <td class="small">${esc((server.egg && server.egg.name) || '—')}</td>
    <td class="mono tiny">${server.allocation ? esc(server.allocation.port) : '—'}</td>
    <td class="small nowrap">${server.limits.memory} МБ · ${server.limits.disk / 1024} ГБ</td>
    <td>${expiryChip(server.daysLeft)}</td>
    <td class="right-cell"><div class="actions-cell">${powerButtons(server, true)}<a class="btn sm ghost" href="#/servers/${server.id}/console">${icon('chevronRight', 14)}</a></div></td>
  </tr>`;
}

export async function serversView(ctx) {
  const data = await api.get('/api/servers');
  const isAdmin = ctx.me.role === 'admin';
  const servers = data.servers || [];
  const view = localStorage.getItem('od:servers-view') || 'cards';
  let filter = 'all';
  let search = '';
  let owner = '';

  const renderList = () => {
    const filtered = servers.filter((s) => {
      if (search) {
        const q = search.toLowerCase();
        const hay = `${s.name} ${(s.owner && s.owner.username) || ''} ${(s.egg && s.egg.name) || ''} ${s.allocation ? s.allocation.port : ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (owner && (s.owner && s.owner.username) !== owner) return false;
      if (filter === 'running') return s.status === 'running' || s.status === 'starting';
      if (filter === 'offline') return s.status === 'offline' || s.status === 'crashed';
      if (filter === 'suspended') return s.status === 'suspended';
      return true;
    });
    const host = document.getElementById('servers-list');
    if (!host) return;
    if (!filtered.length) {
      host.innerHTML = `<div class="card">${emptyState('server', 'Ничего не найдено',
        servers.length ? 'Измените фильтр или поисковый запрос.' : 'Создайте первый сервер — панель выдаст порт, каталог и консоль.',
        ctx.canCreateServer ? `<button class="btn primary" data-action="create-server">${icon('plus', 15)} Создать сервер</button>` : '')}</div>`;
    } else if (view === 'table') {
      host.innerHTML = `<div class="card table-wrap"><table class="table"><thead><tr>
        <th>Сервер</th><th>Статус</th><th>Владелец</th><th>Шаблон</th><th>Порт</th><th>Лимиты</th><th>Срок</th><th></th>
      </tr></thead><tbody>${filtered.map(serverRow).join('')}</tbody></table></div>`;
    } else {
      host.innerHTML = `<div class="grid cards">${filtered.map(serverCard).join('')}</div>`;
    }
    bindRows(host);
    document.getElementById('servers-count').textContent = `${filtered.length} из ${servers.length}`;
  };

  const bindRows = (host) => {
    host.querySelectorAll('tr[data-href]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('a')) return;
        window.location.hash = row.dataset.href;
      });
    });
  };

  const owners = [...new Set(servers.map((s) => s.owner && s.owner.username).filter(Boolean))];

  const html = `
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">инфраструктура</div>
        <h1>Серверы</h1>
        <p class="sub">Запуск, консоль, файлы, бэкапы и доступы. <span id="servers-count" class="chip" style="vertical-align:middle">${servers.length}</span></p>
      </div>
      <div class="page-actions">
        <div class="segmented" id="view-toggle">
          <button data-view="cards" class="${view === 'cards' ? 'active' : ''}">${icon('grid', 13)}</button>
          <button data-view="table" class="${view === 'table' ? 'active' : ''}">${icon('list', 13)}</button>
        </div>
        ${ctx.canCreateServer ? `<button class="btn primary" data-action="create-server">${icon('plus', 15)} Создать сервер</button>` : ''}
      </div>
    </div>

    <div class="toolbar" style="margin-bottom:16px">
      <div class="search">
        ${icon('search', 14)}
        <input class="input" id="servers-search" placeholder="Поиск по имени, владельцу, порту…" />
      </div>
      <div class="segmented" id="status-filter">
        <button data-status="all" class="active">Все</button>
        <button data-status="running">Работают</button>
        <button data-status="offline">Остановлены</button>
        <button data-status="suspended">Заморожены</button>
      </div>
      ${isAdmin && owners.length > 1 ? `<select class="select" id="owner-filter" style="width:auto"><option value="">Все владельцы</option>${owners.map((o) => `<option>${esc(o)}</option>`).join('')}</select>` : ''}
      <button class="btn ghost sm right" data-action="refresh">${icon('refresh', 14)} Обновить</button>
    </div>

    <div id="servers-list"></div>
  </div>`;

  function mount(root) {
    renderList();

    const searchInput = root.querySelector('#servers-search');
    searchInput.addEventListener('input', () => {
      search = searchInput.value;
      renderList();
    });
    root.querySelectorAll('#status-filter button').forEach((btn) => {
      btn.addEventListener('click', () => {
        filter = btn.dataset.status;
        root.querySelectorAll('#status-filter button').forEach((b) => b.classList.toggle('active', b === btn));
        renderList();
      });
    });
    const ownerSelect = root.querySelector('#owner-filter');
    if (ownerSelect) ownerSelect.addEventListener('change', () => { owner = ownerSelect.value; renderList(); });
    root.querySelectorAll('#view-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        localStorage.setItem('od:servers-view', btn.dataset.view);
        window.location.reload();
      });
    });

    const onServers = () => ctx.refresh();
    window.addEventListener('od:servers', onServers);
    return () => window.removeEventListener('od:servers', onServers);
  }

  return { html, mount, title: 'Серверы' };
}

/* ─────────────────────── создание сервера ─────────────────────── */

export async function openCreateServer(ctx, opts = {}) {
  const [eggsData, nodesData, usersData] = await Promise.all([
    api.get('/api/eggs').catch(() => ({ eggs: [] })),
    ctx.me.role === 'admin' ? api.get('/api/nodes').catch(() => ({ nodes: [] })) : Promise.resolve({ nodes: [] }),
    ctx.me.role === 'admin' ? api.get('/api/users').catch(() => ({ users: [] })) : Promise.resolve({ users: [] }),
  ]);
  const eggs = eggsData.eggs || [];
  let kernels = [];
  try {
    const kData = await api.get('/api/kernels');
    kernels = kData.kernels || [];
  } catch { kernels = []; }
  const localNodes = (nodesData.nodes || []).filter((n) => n.local);
  const users = usersData.users || [];
  const limits = ctx.me.limits || {};

  const body = `
  <form class="stack" data-create-server>
    <div class="form-grid">
      <div class="field span-2">
        <label>Название сервера</label>
        <input class="input" name="name" placeholder="Мир Друзей" required maxlength="60" autofocus />
      </div>
      ${ctx.me.role === 'admin' ? `
      <div class="field">
        <label>Владелец</label>
        <select class="select" name="ownerId" id="cs-owner">
          ${users.map((u) => `<option value="${u.id}" ${opts.ownerId === u.id ? 'selected' : ''}>${esc(u.username)}${u.role === 'admin' ? ' (админ)' : ''}</option>`).join('')}
        </select>
      </div>` : ''}
      <div class="field">
        <label>Шаблон (egg)</label>
        <select class="select" name="eggId">
          ${eggs.map((e) => `<option value="${e.id}" ${e.key === 'paper' ? 'selected' : ''}>${esc(e.name)} · ${esc(e.category)}</option>`).join('')}
        </select>
      </div>
      <div class="field span-2">
        <label>Ядро Minecraft <span class="dim">— подгрузка из внешнего API</span></label>
        <div class="row" style="gap:8px">
          <select class="select" name="kernel" id="cs-kernel" style="flex:1">
            <option value="">Без ядра (демо-шаблон)</option>
            ${kernels.map((k) => `<option value="${esc(k.id)}">${esc(k.label)} · ${esc(k.group)}${k.recommended ? ' ★' : ''}</option>`).join('')}
          </select>
          <select class="select" name="kernelVersion" id="cs-kernel-version" style="flex:1" disabled>
            <option value="">Сначала выберите ядро</option>
          </select>
        </div>
        <div class="row" style="gap:8px;margin-top:8px" id="cs-custom-row" hidden>
          <input class="input mono" name="customUrl" placeholder="https://…/server.jar" style="flex:1" />
          <input class="input mono" name="customName" placeholder="имя.jar" style="width:150px" />
        </div>
        <span class="hint" id="cs-kernel-hint">Версии подгружаются с fill.papermc.io / api.purpurmc.org / meta.fabricmc.net / piston-meta.mojang.com. Jar скачается в каталог сервера при создании.</span>
      </div>
      ${ctx.me.role === 'admin' && localNodes.length ? `
      <div class="field">
        <label>Узел</label>
        <select class="select" name="nodeId">
          ${localNodes.map((n) => `<option value="${n.id}">${esc(n.name)} (локальный)</option>`).join('')}
        </select>
      </div>` : ''}
      <div class="field">
        <label>Срок аренды</label>
        <div class="input-group">
          <input class="input" type="number" name="expiresDays" value="${ctx.me.role === 'admin' ? 30 : (ctx.meta && ctx.meta.expiryDays) || 30}" min="1" max="3650" />
          <span class="input-suffix">дней</span>
        </div>
      </div>
      <div class="field">
        <label>Память (МБ)</label>
        <input class="input" type="number" name="memory" value="${Math.min(2048, limits.memory || 2048)}" min="128" step="128" />
      </div>
      <div class="field">
        <label>Диск (МБ)</label>
        <input class="input" type="number" name="disk" value="${Math.min(10240, limits.disk || 10240)}" min="64" step="256" />
      </div>
      <div class="field">
        <label>CPU (%)</label>
        <input class="input" type="number" name="cpu" value="${Math.min(100, limits.cpu || 100)}" min="5" max="1600" step="5" />
      </div>
      <div class="field span-2">
        <label>Описание <span class="dim">— необязательно</span></label>
        <input class="input" name="description" placeholder="Для чего этот сервер" maxlength="200" />
      </div>
      <div class="field span-2">
        <label class="switch"><input type="checkbox" name="startNow" checked /><span class="track"></span><span class="switch-text">Запустить сразу после создания</span></label>
      </div>
    </div>
    <div class="notice">${icon('info', 16)}<div>Порт будет выдан автоматически из диапазона узла. Каталог сервера создаётся на диске панели, консоль сразу доступна.</div></div>
  </form>`;

  const close = modal({
    title: 'Новый сервер',
    subtitle: 'Сервер получит отдельный каталог, порт, лимиты и консоль.',
    wide: true,
    body,
    footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" data-create>${icon('plus', 15)} Создать сервер</button>`,
    onMount: (overlay) => {
      const form = overlay.querySelector('[data-create-server]');
      const kernelSelect = overlay.querySelector('#cs-kernel');
      const versionSelect = overlay.querySelector('#cs-kernel-version');
      const customRow = overlay.querySelector('#cs-custom-row');
      const kernelHint = overlay.querySelector('#cs-kernel-hint');
      if (kernelSelect) {
        kernelSelect.addEventListener('change', async () => {
          const kernelId = kernelSelect.value;
          customRow.hidden = kernelId !== 'custom';
          versionSelect.disabled = true;
          versionSelect.innerHTML = '<option value="">Загрузка версий…</option>';
          if (!kernelId || kernelId === 'custom') {
            versionSelect.innerHTML = kernelId === 'custom' ? '<option value="">Своя ссылка — версия не нужна</option>' : '<option value="">Сначала выберите ядро</option>';
            if (kernelId === 'custom') kernelHint.textContent = 'Укажите прямую ссылку на jar и его имя.';
            return;
          }
          const kernel = kernels.find((k) => k.id === kernelId);
          if (kernel) kernelHint.textContent = kernel.hint || '';
          try {
            const res = await api.get(`/api/kernels/${kernelId}/versions`);
            const versions = res.versions || [];
            versionSelect.innerHTML = versions.length
              ? versions.map((v) => `<option value="${esc(v.id)}">${esc(v.id)}${v.java ? ` · Java ${v.java}` : ''}</option>`).join('')
              : '<option value="">Версий нет</option>';
            versionSelect.disabled = !versions.length;
          } catch (err) {
            versionSelect.innerHTML = '<option value="">Не удалось загрузить версии</option>';
            kernelHint.textContent = `Ошибка загрузки версий: ${err.message}`;
          }
        });
      }
      overlay.querySelector('[data-create]').addEventListener('click', async () => {
        const btn = overlay.querySelector('[data-create]');
        const values = serializeForm(form);
        if (!values.name || values.name.trim().length < 2) {
          toast('Укажите название', 'Минимум 2 символа', 'warn');
          return;
        }
        btn.disabled = true;
        try {
          const server = await api.post('/api/servers', {
            name: values.name.trim(),
            ownerId: values.ownerId,
            eggId: values.eggId,
            nodeId: values.nodeId,
            memory: values.memory,
            disk: values.disk,
            cpu: values.cpu,
            expiresDays: values.expiresDays,
            description: values.description,
            start: !!values.startNow,
          });
          const kernelId = values.kernel;
          if (kernelId) {
            try {
              toast('Скачиваю ядро', `${kernelId} ${values.kernelVersion || ''}…`, 'info');
              const installed = await api.post('/api/kernels/install', {
                serverId: server.id,
                kernel: kernelId,
                version: values.kernelVersion || null,
                customUrl: values.customUrl || null,
                customName: values.customName || null,
              });
              toast('Ядро установлено', `${installed.jar} — команда запуска обновлена`, 'ok');
            } catch (err) {
              toast('Ядро не скачалось', err.message, 'warn');
            }
          }
          toast('Сервер создан', `${server.name} · порт ${server.allocation ? server.allocation.port : '—'}`, 'ok');
          close();
          window.location.hash = `#/servers/${server.id}/console`;
        } catch (err) {
          toast('Не удалось создать сервер', err.message, 'err');
          btn.disabled = false;
        }
      });
    },
  });
  return close;
}
