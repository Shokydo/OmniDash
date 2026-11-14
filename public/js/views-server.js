// Страница сервера: консоль, управление, файлы + подключение остальных вкладок.
import { api } from './api.js';
import { icon } from './icons.js';
import {
  esc, fmtBytes, fmtMb, fmtDuration, fmtDateTime, statusPill, powerButtons, expiryChip,
  meter, emptyState, modal, toast, confirmDialog, ansiToHtml, copy, avatar, serializeForm,
} from './ui.js';
import { areaChart, ring, historyValues } from './charts.js';
import { backupsTab, startupTab, accessTab, scheduleTab, settingsTab } from './views-server-tabs.js';

const TAB_DEFS = [
  { id: 'console', label: 'Консоль', icon: 'terminal', perm: 'console' },
  { id: 'manage', label: 'Управление', icon: 'activity', perm: 'control' },
  { id: 'files', label: 'Файлы', icon: 'folder', perm: 'files' },
  { id: 'backups', label: 'Бэкапы', icon: 'backup', perm: 'backups' },
  { id: 'startup', label: 'Переменные', icon: 'sliders', perm: 'startup' },
  { id: 'access', label: 'Доступы', icon: 'users', perm: 'users' },
  { id: 'schedule', label: 'Расписание', icon: 'clock', perm: 'schedule' },
  { id: 'settings', label: 'Настройки', icon: 'settings', perm: 'settings' },
];

export async function serverView(ctx) {
  const data = await api.get(`/api/servers/${ctx.params.id}`);
  const server = data.server;
  const perms = new Set(server.permissions || []);
  const can = (p) => perms.has(p) || server.isAdmin;
  const availableTabs = TAB_DEFS.filter((t) => can(t.perm));
  const requested = ctx.params.tab || 'console';
  const tab = availableTabs.some((t) => t.id === requested) ? requested : (availableTabs[0] || { id: 'console' }).id;

  let tabResult;
  if (tab === 'console') tabResult = consoleTab(ctx, data);
  else if (tab === 'manage') tabResult = manageTab(ctx, data);
  else if (tab === 'files') tabResult = await filesTab(ctx, data);
  else if (tab === 'backups') tabResult = await backupsTab(ctx, data);
  else if (tab === 'startup') tabResult = startupTab(ctx, data);
  else if (tab === 'access') tabResult = await accessTab(ctx, data);
  else if (tab === 'schedule') tabResult = await scheduleTab(ctx, data);
  else if (tab === 'settings') tabResult = await settingsTab(ctx, data);
  else tabResult = { html: emptyState('alert', 'Нет доступа', 'У вас нет прав на эту вкладку.') };

  const heroChips = [
    `<span class="chip">${icon('user', 12)} ${esc((server.owner && server.owner.username) || '—')}</span>`,
    `<span class="chip">${icon('node', 12)} ${esc((server.node && server.node.name) || '—')}</span>`,
    `<span class="chip">${icon('package', 12)} ${esc((server.egg && server.egg.name) || '—')}</span>`,
    server.allocation ? `<span class="chip mono">${icon('network', 12)} ${esc(server.allocation.label)}</span>` : '',
    `<span class="chip mono" title="UUID сервера">${esc(server.uuid.slice(0, 8))}… ${''}</span>`,
    expiryChip(server.daysLeft),
    server.suspended ? `<span class="pill suspended"><i></i>приостановлен${server.suspendReason === 'expired' ? ' · срок истёк' : ''}</span>` : '',
  ].filter(Boolean).join('');

  const html = `
  <div class="page" data-server-id="${server.id}">
    <div class="row small dim" style="margin-bottom:12px;gap:6px">
      <a href="#/servers" style="color:var(--text-mute)">Серверы</a> ${icon('chevronRight', 12)} <span>${esc(server.name)}</span>
      <span class="right chip mono" title="UUID">${esc(server.uuid)}</span>
      <button class="icon-btn" data-copy="${esc(server.uuid)}" title="Скопировать UUID">${icon('copy', 14)}</button>
    </div>

    <div class="card pad" style="margin-bottom:16px">
      <div class="server-hero">
        <a class="server-icon hero-icon" href="#/servers">${icon('server', 24)}</a>
        <div class="grow" style="min-width:0">
          <div class="row" style="gap:10px;flex-wrap:wrap">
            <h1 style="font-size:23px">${esc(server.name)}</h1>
            <span class="hero-status">${statusPill(server.status)}</span>
            <span class="chip" title="Аптайм">${icon('clock', 12)} <span data-uptime>${server.usage.uptimeMs ? fmtDuration(server.usage.uptimeMs) : '—'}</span></span>
          </div>
          <p class="muted small" style="margin-top:5px">${esc(server.description || 'Без описания')}</p>
          <div class="hero-meta">${heroChips}</div>
        </div>
        <div class="hero-actions">
          ${can('control') ? powerButtons(server) : ''}
          ${can('settings') ? `<a class="btn sm" href="#/servers/${server.id}/settings">${icon('settings', 14)} Настройки</a>` : ''}
        </div>
      </div>
    </div>

    <div class="tabs" style="margin-bottom:16px">
      ${availableTabs.map((t) => `
        <a class="tab ${t.id === tab ? 'active' : ''}" href="#/servers/${server.id}/${t.id}">
          ${icon(t.icon, 14)} ${t.label}
          ${t.id === 'backups' && server.backups ? `<span class="n">${server.backups}</span>` : ''}
          ${t.id === 'access' && server.subusers.length ? `<span class="n">${server.subusers.length}</span>` : ''}
          ${t.id === 'schedule' && server.tasks ? `<span class="n">${server.tasks}</span>` : ''}
        </a>`).join('')}
    </div>

    <div id="tab-host">${tabResult.html}</div>
  </div>`;

  function mount(root) {
    const cleanups = [];
    if (tabResult.mount) {
      const c = tabResult.mount(root);
      if (typeof c === 'function') cleanups.push(c);
    }

    // аптайм в шапке
    const started = server.usage.startedAt;
    const uptimeEl = root.querySelector('[data-uptime]');
    if (started && ['running', 'starting'].includes(server.status) && uptimeEl) {
      const timer = setInterval(() => {
        if (!document.body.contains(uptimeEl)) return;
        uptimeEl.textContent = fmtDuration(Date.now() - started);
      }, 1000);
      cleanups.push(() => clearInterval(timer));
    }

    // смена статуса через SSE
    let lastStatus = server.status;
    const onState = (e) => {
      const d = e.detail || {};
      if (d.serverId !== server.id) return;
      const host = root.querySelector('.hero-status');
      if (host && d.status !== lastStatus) {
        host.innerHTML = statusPill(server.suspended ? 'suspended' : d.status);
        lastStatus = d.status;
        if (['crashed', 'offline'].includes(d.status)) {
          toast('Статус изменён', `${server.name}: ${d.status === 'crashed' ? 'процесс упал' : 'остановлен'}`, d.status === 'crashed' ? 'err' : 'info');
        }
      }
    };
    window.addEventListener('od:state', onState);
    cleanups.push(() => window.removeEventListener('od:state', onState));

    return () => cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  }

  return { html, mount, title: server.name };
}

/* ═════════════════════════════ консоль ═════════════════════════════ */

function consoleTab(ctx, data) {
  const server = data.server;
  const suspended = server.suspended || server.status === 'suspended';
  const logs = (data.logs || []);
  const quick = ['help', 'list', 'tps', 'status', 'say Привет', 'save-all'];

  const html = `
  <div class="stack">
    ${suspended ? `<div class="banner danger">${icon('lock', 17)}<div>Сервер приостановлен${server.suspendReason === 'expired' ? ' — срок аренды истёк' : ''}. Консоль доступна только для чтения до разблокировки администратором.</div></div>` : ''}
    <div class="card console-card">
      <div class="console-bar">
        <div class="console-dots"><span></span><span></span><span></span></div>
        <span class="console-hint">stdout / stderr · ${logs.length} строк в буфере</span>
        <input class="input" id="console-filter" placeholder="Фильтр по тексту…" style="margin-left:auto;width:200px;height:27px;font-size:12px;font-family:var(--mono)" />
        <label class="switch" title="Автопрокрутка">
          <input type="checkbox" id="console-autoscroll" checked /><span class="track"></span>
        </label>
        <button class="btn sm ghost" id="console-clear" title="Очистить экран">${icon('eraser', 14)}</button>
        <button class="btn sm ghost" id="console-save" title="Скачать лог">${icon('download', 14)}</button>
        <button class="btn sm ghost" id="console-bottom" title="Вниз">${icon('down', 14)}</button>
      </div>
      <div class="term">
        <div class="term-body" id="term"></div>
      </div>
      <div class="quick-cmds">
        ${quick.map((q) => `<button data-cmd="${esc(q)}">${esc(q)}</button>`).join('')}
      </div>
      <form class="console-input" id="console-form" autocomplete="off">
        <span class="prompt">$</span>
        <input id="console-input" placeholder="${suspended ? 'сервер приостановлен' : server.status === 'running' || server.status === 'starting' ? 'введите команду и нажмите Enter…' : 'сервер не запущен — консоль недоступна'}" ${suspended ? 'disabled' : ''} />
        <button class="btn sm primary" type="submit" ${suspended ? 'disabled' : ''}>${icon('chevronRight', 13)} Отправить</button>
      </form>
    </div>
    <div class="grid three">
      <div class="card pad">
        <div class="panel-title">${icon('info', 15)} Подсказка</div>
        <p class="tiny dim" style="margin-top:8px;line-height:1.6">Команды уходят в stdin процесса. Для демо-шаблонов работают <b>help</b>, <b>list</b>, <b>tps</b>, <b>say текст</b>, <b>status</b>, <b>stop</b>.</p>
      </div>
      <div class="card pad">
        <div class="panel-title">${icon('terminal', 15)} Поток</div>
        <dl class="kv" style="margin-top:8px;grid-template-columns:80px 1fr">
          <dt>PID</dt><dd class="mono">${server.usage.pid || '—'}</dd>
          <dt>Порт</dt><dd class="mono">${esc(server.allocation ? server.allocation.label : '—')}</dd>
          <dt>Шаблон</dt><dd>${esc((server.egg && server.egg.name) || '—')}</dd>
        </dl>
      </div>
      <div class="card pad">
        <div class="panel-title">${icon('activity', 15)} Сейчас</div>
        <div class="row" style="gap:16px;margin-top:10px">
          <div><div class="tiny dim">CPU</div><div class="mono">${(server.usage.cpu || 0).toFixed(1)}%</div></div>
          <div><div class="tiny dim">RAM</div><div class="mono">${fmtMb(Math.round((server.usage.memory || 0) / 1024 / 1024))}</div></div>
          <div><div class="tiny dim">Игроки</div><div class="mono">${server.usage.players || 0}</div></div>
        </div>
        <div class="tiny dim" style="margin-top:10px">Uptime: <span data-uptime>${server.usage.uptimeMs ? fmtDuration(server.usage.uptimeMs) : '—'}</span></div>
      </div>
    </div>
  </div>`;

  function mount(root) {
    const term = root.querySelector('#term');
    const form = root.querySelector('#console-form');
    const input = root.querySelector('#console-input');
    const filterInput = root.querySelector('#console-filter');
    const autoscroll = root.querySelector('#console-autoscroll');
    const store = ctx.state.consoles;
    let lines = store.get(server.id) || [];
    if (!lines.length) {
      lines = logs.map((l) => ({ at: l.at, line: l.line }));
      store.set(server.id, lines);
    }
    let filter = '';
    let live = true;

    const atBottom = () => term.scrollHeight - term.scrollTop - term.clientHeight < 60;

    const lineHtml = (l) => {
      const time = new Date(l.at || Date.now()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `<div class="term-line"><span class="ts">${time}</span><span class="msg">${ansiToHtml(l.line)}</span></div>`;
    };

    const render = () => {
      const visible = filter ? lines.filter((l) => String(l.line).toLowerCase().includes(filter)) : lines;
      if (!visible.length) {
        term.innerHTML = `<div class="term-empty">${filter ? 'Ничего не найдено по фильтру.' : 'Консоль пуста. Запустите сервер — здесь появится вывод процесса.'}</div>`;
        return;
      }
      term.innerHTML = visible.slice(-900).map(lineHtml).join('');
      term.scrollTop = term.scrollHeight;
    };

    const append = (l) => {
      if (!live) return;
      lines.push(l);
      if (lines.length > 1200) lines.splice(0, lines.length - 1200);
      if (filter && !String(l.line).toLowerCase().includes(filter)) return;
      const shouldScroll = autoscroll.checked || atBottom();
      if (term.querySelector('.term-empty')) term.innerHTML = '';
      term.insertAdjacentHTML('beforeend', lineHtml(l));
      while (term.children.length > 900) term.firstElementChild.remove();
      if (shouldScroll) term.scrollTop = term.scrollHeight;
    };

    render();
    term.scrollTop = term.scrollHeight;

    const onLog = (e) => {
      const d = e.detail || {};
      if (d.serverId !== server.id) return;
      append({ at: d.at, line: d.line });
    };
    const onState = (e) => {
      const d = e.detail || {};
      if (d.serverId !== server.id) return;
      const running = ['running', 'starting'].includes(d.status);
      if (input && !suspended) {
        input.disabled = false;
        input.placeholder = running ? 'введите команду и нажмите Enter…' : 'сервер не запущен — команда будет отклонена';
      }
    };
    window.addEventListener('od:log', onLog);
    window.addEventListener('od:state', onState);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const command = input.value.trim();
      if (!command) return;
      input.value = '';
      input.disabled = true;
      try {
        await api.post(`/api/servers/${server.id}/command`, { command });
        if (!ctx.state.cmdHistory) ctx.state.cmdHistory = [];
        ctx.state.cmdHistory.push(command);
      } catch (err) {
        toast('Команда не отправлена', err.message, 'err');
      }
      input.disabled = false;
      input.focus();
    });

    // история команд стрелками
    const history = ctx.state.cmdHistory || [];
    let hIndex = history.length;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' && history.length) {
        hIndex = Math.max(0, hIndex - 1);
        input.value = history[hIndex] || '';
        e.preventDefault();
      } else if (e.key === 'ArrowDown' && history.length) {
        hIndex = Math.min(history.length, hIndex + 1);
        input.value = history[hIndex] || '';
        e.preventDefault();
      }
    });

    root.querySelectorAll('[data-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => {
        input.value = btn.dataset.cmd;
        input.focus();
      });
    });

    filterInput.addEventListener('input', () => {
      filter = filterInput.value.trim().toLowerCase();
      render();
    });

    root.querySelector('#console-clear').addEventListener('click', () => {
      lines = [];
      store.set(server.id, lines);
      render();
      toast('Консоль очищена', 'Буфер на экране сброшен', 'info', 2000);
    });

    root.querySelector('#console-save').addEventListener('click', () => {
      const text = lines.map((l) => `${new Date(l.at).toISOString()} ${String(l.line).replace(/\u001b\[[0-9;]*m/g, '')}`).join('\n');
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${server.name}-console.log`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });

    root.querySelector('#console-bottom').addEventListener('click', () => {
      term.scrollTop = term.scrollHeight;
    });

    // не даём фильтру сбивать обновления при пустом значении
    filterInput.addEventListener('change', render);

    const cleanup = () => {
      live = false;
      window.removeEventListener('od:log', onLog);
      window.removeEventListener('od:state', onState);
    };
    // сохраняем буфер в state при уходе со страницы
    const observerCleanup = () => {
      live = false;
      store.set(server.id, lines);
      window.removeEventListener('od:log', onLog);
      window.removeEventListener('od:state', onState);
    };
    return () => { cleanup(); observerCleanup(); };
  }

  return { html, mount };
}

/* ═════════════════════════════ управление ═════════════════════════════ */

function manageTab(ctx, data) {
  const server = data.server;
  const usage = server.usage;
  const html = `
  <div class="stack">
    <div class="grid stats">
      <div class="card stat">
        <div class="stat-top"><span class="stat-label">CPU</span><span class="stat-icon">${icon('cpu', 14)}</span></div>
        <div class="stat-value"><span id="stat-cpu">${(usage.cpu || 0).toFixed(1)}</span><small>%</small></div>
        <div class="stat-foot"><span>лимит ${server.limits.cpu}%</span></div>
        <div class="stat-spark"><canvas id="mini-cpu"></canvas></div>
      </div>
      <div class="card stat">
        <div class="stat-top"><span class="stat-label">Память</span><span class="stat-icon" style="background:rgba(255,255,255,.06);color:#a3a3a3;border-color:rgba(255,255,255,.18)">${icon('ram', 14)}</span></div>
        <div class="stat-value"><span id="stat-mem">${Math.round((usage.memory || 0) / 1024 / 1024)}</span><small>МБ / ${server.limits.memory}</small></div>
        <div class="stat-foot"><span id="stat-mem-pct">${((usage.memory || 0) / 1024 / 1024 / server.limits.memory * 100).toFixed(0)}% от лимита</span></div>
        ${meter(((usage.memory || 0) / 1024 / 1024 / server.limits.memory) * 100, '')}
      </div>
      <div class="card stat">
        <div class="stat-top"><span class="stat-label">Диск</span><span class="stat-icon" style="background:rgba(255,255,255,.06);color:#d4d4d4;border-color:rgba(255,255,255,.18)">${icon('harddrive', 14)}</span></div>
        <div class="stat-value">${fmtBytes(usage.disk || 0)}</div>
        <div class="stat-foot"><span>лимит ${server.limits.disk / 1024} ГБ</span></div>
        ${meter(((usage.disk || 0) / 1024 / 1024 / server.limits.disk) * 100)}
      </div>
      <div class="card stat">
        <div class="stat-top"><span class="stat-label">Поток</span><span class="stat-icon" style="background:rgba(255,255,255,.06);color:#fff;border-color:rgba(255,255,255,.18)">${icon('pulse', 14)}</span></div>
        <div class="stat-value" style="font-size:22px" data-uptime>${usage.uptimeMs ? fmtDuration(usage.uptimeMs) : '—'}</div>
        <div class="stat-foot"><span>PID ${usage.pid || '—'}</span><span>${usage.players || 0} игроков</span></div>
      </div>
    </div>

    <div class="grid split">
      <div class="card">
        <div class="card-head">
          <div class="panel-title">${icon('pulse', 15)} Живая нагрузка</div>
          <div class="row tiny dim"><span>CPU</span><span class="chip" style="padding:1px 6px">%</span><span>RAM</span><span class="chip" style="padding:1px 6px">МБ</span></div>
        </div>
        <div class="card-body" style="padding-top:10px"><canvas id="srv-chart"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><div class="panel-title">${icon('power', 15)} Управление питанием</div></div>
        <div class="card-body col" style="gap:8px">
          <button class="btn success block" data-power="start" ${['running', 'starting'].includes(server.status) || server.suspended ? 'disabled' : ''}>${icon('play', 15)} Запустить</button>
          <button class="btn block" data-power="restart" ${!['running', 'starting'].includes(server.status) || server.suspended ? 'disabled' : ''}>${icon('restart', 15)} Перезапустить</button>
          <button class="btn danger block" data-power="stop" ${!['running', 'starting'].includes(server.status) ? 'disabled' : ''}>${icon('stop', 15)} Остановить</button>
          <button class="btn ghost block" data-power="kill" ${!['running', 'starting'].includes(server.status) ? 'disabled' : ''}>${icon('power', 15)} Убить процесс (SIGKILL)</button>
          <div class="hint" style="margin-top:6px">Стоп отправляет команду «stop» из шаблона и ждёт до ${(data.egg && data.egg.config && data.egg.config.stopTimeout) || 15} с, затем SIGTERM / SIGKILL.</div>
        </div>
      </div>
    </div>

    <div class="grid two">
      <div class="card">
        <div class="card-head"><div class="panel-title">${icon('sliders', 15)} Лимиты и размещение</div>${server.isAdmin ? `<a class="btn sm ghost" href="#/servers/${server.id}/settings">Изменить</a>` : ''}</div>
        <div class="card-body">
          <dl class="kv">
            <dt>Память</dt><dd class="mono">${server.limits.memory} МБ</dd>
            <dt>Диск</dt><dd class="mono">${server.limits.disk} МБ (${(server.limits.disk / 1024).toFixed(1)} ГБ)</dd>
            <dt>CPU</dt><dd class="mono">${server.limits.cpu}%</dd>
            <dt>Узел</dt><dd>${esc((server.node && server.node.name) || '—')} <span class="dim">· ${esc((server.node && server.node.fqdn) || '')}</span></dd>
            <dt>Шаблон</dt><dd>${esc((server.egg && server.egg.name) || '—')}</dd>
            <dt>Контейнер</dt><dd class="mono tiny">${esc((data.egg && data.egg.image) || '—')}</dd>
            <dt>Создан</dt><dd>${fmtDateTime(server.createdAt)}</dd>
          </dl>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div class="panel-title">${icon('clock', 15)} Аренда и владелец</div></div>
        <div class="card-body">
          <dl class="kv">
            <dt>Владелец</dt><dd class="row" style="gap:6px">${avatar(server.owner, 'sm')} ${esc((server.owner && server.owner.username) || '—')}</dd>
            <dt>Срок</dt><dd>${server.expiresAt ? fmtDateTime(server.expiresAt) : 'бессрочно'} ${server.daysLeft !== null ? `<span class="chip ${server.daysLeft <= 3 ? 'amber' : ''}" style="margin-left:6px">${server.daysLeft} дн</span>` : ''}</dd>
            <dt>Продлений</dt><dd>${server.renewals || 0}</dd>
            <dt>Автозапуск</dt><dd>${server.autoStart ? 'включён' : 'выключен'}</dd>
            <dt>Доступы</dt><dd>${server.subusers.length} пользователей</dd>
          </dl>
          <div class="row" style="margin-top:14px;flex-wrap:wrap">
            ${server.isAdmin ? `<button class="btn sm" data-action="renew-server" data-id="${server.id}" data-days="30">${icon('calendar', 13)} Продлить на 30 дней</button>` : ''}
            ${server.isOwner && !server.isAdmin ? `<button class="btn sm" data-action="request-renew" data-id="${server.id}">${icon('bell', 13)} Запросить продление</button>` : ''}
          </div>
        </div>
      </div>
    </div>
  </div>`;

  return {
    html,
    mount(root) {
      const statCpu = root.querySelector('#stat-cpu');
      const statMem = root.querySelector('#stat-mem');
      const statMemPct = root.querySelector('#stat-mem-pct');
      const cpuValues = historyValues(usage.history, 'cpu', 45);
      const memValues = historyValues(usage.history, 'memory', 45).map((v) => Math.round(v / 1024 / 1024));
      if (root.querySelector('#mini-cpu')) {
        areaChart(root.querySelector('#mini-cpu'), {
          series: [{ values: cpuValues, color: '#ffffff' }], max: Math.max(10, server.limits.cpu), hideAxis: true, height: 36, format: (n) => `${Math.round(n)}%`,
        });
      }
      const chart = root.querySelector('#srv-chart');
      if (chart) {
        areaChart(chart, {
          series: [
            { values: cpuValues, color: '#ffffff', label: 'CPU %' },
            { values: memValues, color: '#a3a3a3', label: 'RAM МБ' },
          ],
          max: Math.max(server.limits.cpu, ...cpuValues),
          height: 210,
          format: (n) => String(Math.round(n)),
        });
      }
      const liveCpu = [];
      const liveMem = [];
      const onStats = (e) => {
        const d = e.detail || {};
        if (d.serverId !== server.id) return;
        if (statCpu) statCpu.textContent = (d.cpu || 0).toFixed(1);
        if (statMem) statMem.textContent = Math.round((d.memory || 0) / 1024 / 1024);
        if (statMemPct) statMemPct.textContent = `${(((d.memory || 0) / 1024 / 1024) / server.limits.memory * 100).toFixed(0)}% от лимита`;
        liveCpu.push(d.cpu || 0);
        liveMem.push(Math.round((d.memory || 0) / 1024 / 1024));
        if (liveCpu.length > 45) liveCpu.shift();
        if (liveMem.length > 45) liveMem.shift();
      };
      window.addEventListener('od:stats', onStats);
      return () => window.removeEventListener('od:stats', onStats);
    },
  };
}

/* ═════════════════════════════ файлы ═════════════════════════════ */

async function filesTab(ctx, data) {
  const server = data.server;
  const can = (p) => server.permissions.includes(p) || server.isAdmin;
  if (!can('files')) return { html: emptyState('lock', 'Нет доступа к файлам', 'Владелец сервера не выдал право «Файлы».') };
  const rootListing = await api.get(`/api/servers/${server.id}/files`, { path: '' });
  let state = { path: '', entries: rootListing.entries, usage: rootListing.usage };
  let selection = new Set();
  let treeEntries = [];
  let searchResults = null;
  let searchQuery = '';
  try {
    const treeRes = await api.get(`/api/servers/${server.id}/files/tree`);
    treeEntries = treeRes.entries || [];
  } catch { treeEntries = []; }

  const html = `
  <div class="files-layout">
    <aside class="card files-tree-card">
      <div class="files-tree-head">
        <span class="panel-title">${icon('folder', 14)} Дерево файлов</span>
        <span class="chip" id="tree-count">${treeEntries.length}</span>
      </div>
      <div class="files-tree" id="files-tree"></div>
    </aside>
    <div class="card files-main">
      <div class="files-bar">
        <div class="breadcrumbs" id="crumbs"></div>
        <div class="right row" style="gap:6px;margin-left:auto">
          <button class="btn sm" data-f="mkdir">${icon('folder', 13)} Папка</button>
          <button class="btn sm" data-f="touch">${icon('file', 13)} Файл</button>
          <button class="btn sm" data-f="upload">${icon('upload', 13)} Загрузить</button>
          <button class="btn sm ghost" data-f="refresh">${icon('refresh', 13)}</button>
        </div>
      </div>
      <div class="files-bar" style="padding-top:8px;padding-bottom:8px">
        <div class="search-box">
          ${icon('search', 13)}
          <input class="input" id="files-search" placeholder="Поиск по имени…" autocomplete="off" />
          <button class="btn sm ghost hidden" id="files-search-clear" title="Сбросить">${icon('x', 12)}</button>
        </div>
        <span class="tiny dim" id="files-meta"></span>
        <div class="file-toolbar right" style="margin-left:auto">
          <button class="btn sm ghost" data-f="archive" disabled>${icon('archive', 13)} В zip</button>
          <button class="btn sm ghost danger" data-f="delete" disabled>${icon('trash', 13)} Удалить</button>
        </div>
      </div>
      <div id="files-host"></div>
      <div class="row tiny dim" style="padding:10px 14px;border-top:1px solid var(--line);gap:14px">
        <span id="files-usage"></span>
        <span class="right">двойной клик по папке — переход · по файлу — редактор</span>
      </div>
    </div>
  </div>
  <input type="file" id="file-upload" multiple class="hidden" />`;

  function bindRows(host) {
    host.querySelectorAll('[data-dir]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.facts')) return;
        load(el.dataset.dir);
      });
    });
    host.querySelectorAll('[data-file]').forEach((el) => {
      el.addEventListener('dblclick', () => openEditor(el.dataset.file));
    });
    host.querySelectorAll('[data-check]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) selection.add(cb.dataset.check);
        else selection.delete(cb.dataset.check);
        const tbl = document.getElementById('files-host');
        tbl.querySelectorAll('[data-f="archive"], [data-f="delete"]').forEach((b) => { b.disabled = selection.size === 0; });
      });
    });
    host.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = btn.dataset.path;
        const act = btn.dataset.act;
        if (act === 'download') api.download(`/api/servers/${server.id}/files/download?path=${encodeURIComponent(p)}`, p.split('/').pop()).catch((err) => toast('Ошибка', err.message, 'err'));
        else if (act === 'edit') openEditor(p);
        else if (act === 'rename') renameEntry(p);
        else if (act === 'delete') removeEntries([p]);
        else if (act === 'extract') extractArchive(p);
      });
    });
  }

  function renderTree() {
    const treeEl = document.getElementById('files-tree');
    if (!treeEl) return;
    const countEl = document.getElementById('tree-count');
    if (countEl) countEl.textContent = String(treeEntries.length);
    if (!treeEntries.length) {
      treeEl.innerHTML = '<div class="tiny dim" style="padding:10px">Пусто</div>';
      return;
    }
    treeEl.innerHTML = treeEntries.map((e) => `
      <div class="tree-row ${e.dir ? 'dir' : ''} ${state.path === e.path ? 'active' : ''}" data-tree="${esc(e.path)}" data-dir="${e.dir ? '1' : ''}" style="padding-left:${8 + e.depth * 14}px" title="${esc(e.path)}">
        ${icon(e.dir ? 'folder' : 'file', 12)}<span class="ellipsis">${esc(e.name)}</span>
      </div>`).join('');
    treeEl.querySelectorAll('[data-tree]').forEach((el) => {
      el.addEventListener('click', () => {
        if (el.dataset.dir) load(el.dataset.tree);
        else openEditor(el.dataset.tree);
      });
    });
  }

  function render() {
    const crumbs = document.getElementById('crumbs');
    const host = document.getElementById('files-host');
    if (!crumbs || !host) return;
    renderTree();
    const parts = state.path ? state.path.split('/') : [];
    crumbs.innerHTML = `<button data-crumb="">${icon('harddrive', 12)} корень</button>` + parts.map((part, i) => `
      <span class="sep">/</span><button data-crumb="${esc(parts.slice(0, i + 1).join('/'))}">${esc(part)}</button>`).join('');
    crumbs.querySelectorAll('[data-crumb]').forEach((b) => b.addEventListener('click', () => { searchResults = null; load(b.dataset.crumb); }));

    if (searchResults) {
      host.innerHTML = searchResults.length ? searchResults.map((f) => `
        <div class="file-row ${f.dir ? 'dir' : ''}" ${f.dir ? `data-dir="${esc(f.path)}"` : `data-file="${esc(f.path)}"`}>
          <span style="width:16px;flex:none"></span>
          <div class="fname">
            ${icon(f.dir ? 'folder' : 'file', 15)}
            <span class="ellipsis">${esc(f.path)}</span>
          </div>
          <span class="fsize"></span>
          <span class="fdate"></span>
          <div class="facts">
            ${!f.dir ? `<button class="icon-btn" data-act="edit" data-path="${esc(f.path)}" title="Редактировать">${icon('edit', 14)}</button>` : ''}
            ${!f.dir ? `<button class="icon-btn" data-act="download" data-path="${esc(f.path)}" title="Скачать">${icon('download', 14)}</button>` : ''}
            <button class="icon-btn" data-act="rename" data-path="${esc(f.path)}" title="Переименовать">${icon('pencil', 14)}</button>
            <button class="icon-btn" data-act="delete" data-path="${esc(f.path)}" title="Удалить">${icon('trash', 14)}</button>
          </div>
        </div>`).join('') : emptyState('search', 'Ничего не найдено', `По запросу «${esc(searchQuery)}» файлов нет.`);
      selection = new Set();
      const meta = document.getElementById('files-meta');
      if (meta) meta.textContent = `поиск: ${searchResults.length} · «${searchQuery}»`;
      document.querySelectorAll('[data-f="archive"], [data-f="delete"]').forEach((b) => { b.disabled = true; });
      bindRows(host);
      host.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => fileAction(b.dataset.f)));
      return;
    }

    if (!state.entries.length) {
      host.innerHTML = emptyState('folder', 'Пусто', 'Здесь пока нет файлов. Загрузите файл или создайте папку.', `<button class="btn sm" data-f="upload">${icon('upload', 13)} Загрузить</button>`);
    } else {
      host.innerHTML = state.entries.map((f) => `
        <div class="file-row ${f.dir ? 'dir' : ''}" ${f.dir ? `data-dir="${esc(f.path)}"` : `data-file="${esc(f.path)}"`}>
          <input type="checkbox" data-check="${esc(f.path)}" style="accent-color:var(--accent)" />
          <div class="fname">
            ${icon(f.dir ? 'folder' : f.name.endsWith('.zip') ? 'archive' : f.name.match(/\.(js|json|yml|yaml|txt|md|properties|py|sh|conf|toml)$/) ? 'filetext' : 'file', 15)}
            <span class="ellipsis">${esc(f.name)}</span>
          </div>
          <span class="fsize">${f.dir ? '—' : fmtBytes(f.size)}</span>
          <span class="fdate">${fmtDateTime(f.mtime)}</span>
          <div class="facts">
            ${!f.dir && f.editable ? `<button class="icon-btn" data-act="edit" data-path="${esc(f.path)}" title="Редактировать">${icon('edit', 14)}</button>` : ''}
            ${!f.dir ? `<button class="icon-btn" data-act="download" data-path="${esc(f.path)}" title="Скачать">${icon('download', 14)}</button>` : ''}
            ${f.name.endsWith('.zip') ? `<button class="icon-btn" data-act="extract" data-path="${esc(f.path)}" title="Распаковать">${icon('package', 14)}</button>` : ''}
            <button class="icon-btn" data-act="rename" data-path="${esc(f.path)}" title="Переименовать">${icon('pencil', 14)}</button>
            <button class="icon-btn" data-act="delete" data-path="${esc(f.path)}" title="Удалить">${icon('trash', 14)}</button>
          </div>
        </div>`).join('');
    }
    selection = new Set();
    const meta = document.getElementById('files-meta');
    if (meta) meta.textContent = `${state.entries.length} объектов · ${state.path || '/'}`;
    const used = document.getElementById('files-usage');
    if (used && state.usage) {
      const pct = state.usage.limit ? Math.min(100, (state.usage.used / state.usage.limit) * 100) : 0;
      used.innerHTML = `Занято ${fmtBytes(state.usage.used)} из ${fmtBytes(state.usage.limit)} <span class="dim">(${pct.toFixed(0)}%)</span>`;
    }
    document.querySelectorAll('[data-f="archive"], [data-f="delete"]').forEach((b) => { b.disabled = true; });
    bindRows(host);
    host.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => fileAction(b.dataset.f)));
  }

  async function load(path) {
    try {
      const res = await api.get(`/api/servers/${server.id}/files`, { path });
      state = { path: res.path, entries: res.entries, usage: res.usage };
      render();
    } catch (err) {
      toast('Не удалось открыть папку', err.message, 'err');
    }
  }

  async function refreshTree() {
    try {
      const treeRes = await api.get(`/api/servers/${server.id}/files/tree`);
      treeEntries = treeRes.entries || [];
      renderTree();
    } catch { /* ignore */ }
  }

  let searchTimer = null;
  function bindSearch() {
    const input = document.getElementById('files-search');
    const clear = document.getElementById('files-search-clear');
    if (!input) return;
    input.addEventListener('input', () => {
      searchQuery = input.value.trim();
      clear.classList.toggle('hidden', !searchQuery);
      clearTimeout(searchTimer);
      if (!searchQuery) {
        searchResults = null;
        render();
        return;
      }
      searchTimer = setTimeout(async () => {
        try {
          const res = await api.get(`/api/servers/${server.id}/files/search`, { q: searchQuery });
          searchResults = res.results || [];
          render();
        } catch (err) {
          toast('Ошибка поиска', err.message, 'err');
        }
      }, 250);
    });
    if (clear) clear.addEventListener('click', () => {
      input.value = '';
      searchQuery = '';
      searchResults = null;
      clear.classList.add('hidden');
      render();
      input.focus();
    });
  }

  async function openEditor(path) {
    const name = path.split('/').pop();
    // картинки — превью
    if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(name)) {
      try {
        const img = await api.get(`/api/servers/${server.id}/files/image`, { path });
        modal({
          title: name,
          subtitle: `${path} · ${fmtBytes(img.size)}`,
          body: `<div style="display:grid;place-items:center;background:#000;border:1px solid var(--line);border-radius:3px;padding:10px;max-height:60vh;overflow:auto"><img src="${img.dataUrl}" alt="" style="max-width:100%;max-height:56vh;object-fit:contain" /></div>`,
          footer: `<button class="btn" data-close>Закрыть</button><button class="btn" id="img-download">${icon('download', 14)} Скачать</button>`,
          onMount: (overlay) => {
            overlay.querySelector('#img-download').addEventListener('click', () => {
              api.download(`/api/servers/${server.id}/files/download?path=${encodeURIComponent(path)}`, name).catch((err) => toast('Ошибка', err.message, 'err'));
            });
          },
        });
      } catch (err) {
        toast('Не удалось открыть картинку', err.message, 'err');
      }
      return;
    }
    // server.properties — редактор свойств
    if (name === 'server.properties') {
      openPropsEditor(path);
      return;
    }
    let file;
    try {
      file = await api.get(`/api/servers/${server.id}/files/content`, { path });
    } catch (err) {
      toast('Не удалось открыть файл', err.message, 'err');
      return;
    }
    if (file.binary) {
      toast('Бинарный файл', 'Редактирование недоступно, скачайте файл', 'warn');
      return;
    }
    const close = modal({
      title: path.split('/').pop(),
      subtitle: `${path} · ${fmtBytes(file.size)} · UTF-8`,
      wide: true,
      body: `
        <div class="editor-wrap" style="border:1px solid var(--line);border-radius:12px;overflow:hidden">
          <div class="editor-head">
            ${icon('code', 14)} <span class="mono tiny dim">${esc(path)}</span>
            <span class="right tiny dim" id="editor-status">не изменён</span>
          </div>
          <div class="editor-body">
            <pre class="editor-gutter" id="gutter"></pre>
            <textarea id="editor-area" spellcheck="false"></textarea>
          </div>
          <div class="editor-foot"><span>UTF-8</span><span>Enter — новая строка · Ctrl+S — сохранить</span><span class="right" id="editor-count"></span></div>
        </div>`,
      footer: `<button class="btn" data-close>Закрыть</button><button class="btn primary" id="editor-save">${icon('save', 14)} Сохранить</button>`,
      onMount: (overlay, closeFn) => {
        const area = overlay.querySelector('#editor-area');
        const gutter = overlay.querySelector('#gutter');
        const status = overlay.querySelector('#editor-status');
        const count = overlay.querySelector('#editor-count');
        area.value = file.content;
        let dirty = false;

        const updateGutter = () => {
          const lines = area.value.split('\n').length;
          gutter.innerHTML = Array.from({ length: lines }, (_, i) => i + 1).join('<br/>');
          count.textContent = `${lines} строк · ${area.value.length} символов`;
        };
        updateGutter();
        area.addEventListener('input', () => { dirty = true; status.textContent = 'есть изменения'; status.style.color = '#a3a3a3'; updateGutter(); });
        area.addEventListener('scroll', () => { gutter.scrollTop = area.scrollTop; });
        area.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            save();
          }
          if (e.key === 'Tab') {
            e.preventDefault();
            const start = area.selectionStart;
            area.setRangeText('  ', start, area.selectionEnd, 'end');
            updateGutter();
          }
        });

        const save = async () => {
          try {
            await api.put(`/api/servers/${server.id}/files/content`, { path, content: area.value });
            dirty = false;
            status.textContent = 'сохранено';
            status.style.color = '#ffffff';
            toast('Файл сохранён', path, 'ok', 2200);
            load(state.path);
          } catch (err) {
            toast('Не сохранено', err.message, 'err');
          }
        };
        overlay.querySelector('#editor-save').addEventListener('click', save);
        closeFn.onClose = () => { };
        setTimeout(() => area.focus(), 60);
      },
    });
    return close;
  }

  async function openPropsEditor(path) {
    let data;
    try {
      data = await api.get(`/api/servers/${server.id}/files/props`);
    } catch (err) {
      toast('Не удалось открыть server.properties', err.message, 'err');
      return;
    }
    const props = data.props || {};
    const keys = Object.keys(props);
    modal({
      title: 'server.properties',
      subtitle: data.exists ? `${keys.length} свойств · сохраните, чтобы применить` : 'Файл ещё не создан — заполните свойства и сохраните',
      wide: true,
      body: `
        <div class="stack">
          <div class="row" style="gap:8px">
            <input class="input mono" id="prop-key" placeholder="ключ" style="flex:1" />
            <input class="input mono" id="prop-value" placeholder="значение" style="flex:1" />
            <button class="btn sm" id="prop-add">${icon('plus', 13)} Добавить</button>
          </div>
          <div id="props-list" class="stack" style="gap:6px;max-height:46vh;overflow:auto">
            ${keys.length ? keys.map((k) => `
              <div class="row prop-row" style="gap:8px">
                <span class="mono small" style="width:180px;flex:none">${esc(k)}</span>
                <input class="input mono" data-prop="${esc(k)}" value="${esc(props[k])}" style="flex:1" />
                <button class="btn sm ghost danger" data-prop-del="${esc(k)}" title="Удалить">${icon('trash', 13)}</button>
              </div>`).join('') : '<div class="tiny dim">Свойств нет.</div>'}
          </div>
          <div class="hint">Значения с не-ASCII символами экранируются как \\uXXXX (как в OmniPanel).</div>
        </div>`,
      footer: `<button class="btn" data-close>Закрыть</button><button class="btn primary" id="props-save">${icon('save', 14)} Сохранить</button>`,
      onMount: (overlay, close) => {
        const list = overlay.querySelector('#props-list');
        const addRow = (key, value) => {
          const empty = list.querySelector('.tiny.dim');
          if (empty) empty.remove();
          const row = document.createElement('div');
          row.className = 'row prop-row';
          row.style.gap = '8px';
          row.innerHTML = `<span class="mono small" style="width:180px;flex:none">${esc(key)}</span><input class="input mono" data-prop="${esc(key)}" value="${esc(value)}" style="flex:1" /><button class="btn sm ghost danger" data-prop-del="${esc(key)}" title="Удалить">${icon('trash', 13)}</button>`;
          list.appendChild(row);
          row.querySelector('[data-prop-del]').addEventListener('click', () => row.remove());
        };
        overlay.querySelector('#prop-add').addEventListener('click', () => {
          const k = overlay.querySelector('#prop-key').value.trim();
          const v = overlay.querySelector('#prop-value').value;
          if (!k) return;
          addRow(k, v);
          overlay.querySelector('#prop-key').value = '';
          overlay.querySelector('#prop-value').value = '';
        });
        list.querySelectorAll('[data-prop-del]').forEach((btn) => {
          btn.addEventListener('click', () => btn.closest('.prop-row').remove());
        });
        overlay.querySelector('#props-save').addEventListener('click', async () => {
          const out = {};
          list.querySelectorAll('[data-prop]').forEach((input) => {
            out[input.dataset.prop] = input.value;
          });
          try {
            await api.put(`/api/servers/${server.id}/files/props`, { props: out });
            toast('server.properties сохранён', `${Object.keys(out).length} свойств`, 'ok');
            close();
            load(state.path);
            refreshTree();
          } catch (err) {
            toast('Ошибка', err.message, 'err');
          }
        });
      },
    });
  }

  function renameEntry(path) {
    modal({
      title: 'Переименовать',
      subtitle: path,
      slim: true,
      body: `<div class="field"><label>Новое имя</label><input class="input" id="rename-input" value="${esc(path.split('/').pop())}" /></div>`,
      footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" id="rename-ok">Сохранить</button>`,
      onMount: (overlay, close) => {
        const input = overlay.querySelector('#rename-input');
        input.focus();
        input.select();
        const go = async () => {
          try {
            await api.post(`/api/servers/${server.id}/files/rename`, { path, name: input.value });
            close();
            load(state.path);
            refreshTree();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        };
        overlay.querySelector('#rename-ok').addEventListener('click', go);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      },
    });
  }

  async function removeEntries(paths) {
    const ok = await confirmDialog({
      title: `Удалить ${paths.length > 1 ? `${paths.length} объекта` : 'файл'}?`,
      text: paths.slice(0, 3).join(', ') + (paths.length > 3 ? '…' : '') + ' — действие необратимо.',
      confirmText: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api.post(`/api/servers/${server.id}/files/delete`, { paths });
      toast('Удалено', `${res.removed.length} объектов`, 'ok');
      load(state.path);
      refreshTree();
    } catch (err) { toast('Ошибка', err.message, 'err'); }
  }

  async function extractArchive(path) {
    try {
      const res = await api.post(`/api/servers/${server.id}/files/extract`, { path });
      toast('Распаковано', `${res.files} файлов → ${res.path}`, 'ok');
      load(state.path);
      refreshTree();
    } catch (err) { toast('Ошибка распаковки', err.message, 'err'); }
  }

  async function fileAction(action) {
    if (action === 'refresh') return load(state.path);
    if (action === 'upload') {
      const input = document.getElementById('file-upload');
      input.value = '';
      input.click();
      return;
    }
    if (action === 'mkdir' || action === 'touch') {
      modal({
        title: action === 'mkdir' ? 'Новая папка' : 'Новый файл',
        subtitle: state.path || 'корень сервера',
        slim: true,
        body: `<div class="field"><label>Имя</label><input class="input" id="new-name" placeholder="${action === 'mkdir' ? 'plugins' : 'config.yml'}" /></div>`,
        footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" id="new-ok">Создать</button>`,
        onMount: (overlay, close) => {
          const input = overlay.querySelector('#new-name');
          input.focus();
          const go = async () => {
            if (!input.value.trim()) return;
            try {
              if (action === 'mkdir') await api.post(`/api/servers/${server.id}/files/mkdir`, { path: state.path, name: input.value.trim() });
              else await api.post(`/api/servers/${server.id}/files/touch`, { path: state.path, name: input.value.trim() });
              close();
              load(state.path);
              refreshTree();
            } catch (err) { toast('Ошибка', err.message, 'err'); }
          };
          overlay.querySelector('#new-ok').addEventListener('click', go);
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        },
      });
      return;
    }
    if (action === 'archive') {
      if (!selection.size) return;
      try {
        const res = await api.post(`/api/servers/${server.id}/files/archive`, { paths: [...selection] });
        toast('Архив создан', `${res.path} · ${fmtBytes(res.size)}`, 'ok');
        load(state.path);
        refreshTree();
      } catch (err) { toast('Ошибка', err.message, 'err'); }
      return;
    }
    if (action === 'delete') {
      if (selection.size) removeEntries([...selection]);
    }
  }

  return {
    html,
    mount() {
      render();
      bindSearch();
      const uploadInput = document.getElementById('file-upload');
      if (uploadInput) {
        uploadInput.addEventListener('change', async () => {
          const files = [...uploadInput.files];
          if (!files.length) return;
          for (const file of files) {
            try {
              await api.upload(`/api/servers/${server.id}/files/upload`, file, file.name, state.path);
              toast('Загружено', file.name, 'ok', 2000);
            } catch (err) {
              toast('Ошибка загрузки', `${file.name}: ${err.message}`, 'err');
            }
          }
          load(state.path);
          refreshTree();
        });
      }
      const host = document.querySelector('#tab-host');
      if (host) {
        host.addEventListener('dragover', (e) => { e.preventDefault(); });
        host.addEventListener('drop', async (e) => {
          e.preventDefault();
          const files = [...(e.dataTransfer?.files || [])];
          for (const file of files) {
            try {
              await api.upload(`/api/servers/${server.id}/files/upload`, file, file.name, state.path);
              toast('Загружено', file.name, 'ok', 2000);
            } catch (err) { toast('Ошибка загрузки', `${file.name}: ${err.message}`, 'err'); }
          }
          if (files.length) { load(state.path); refreshTree(); }
        });
      }
    },
  };
}
