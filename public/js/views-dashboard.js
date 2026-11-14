// Обзор: статистика, живая нагрузка, узлы, внимание, активность.
import { api } from './api.js';
import { icon } from './icons.js';
import {
  esc, fmtBytes, fmtMb, fmtNum, fmtDateTime, timeAgo, statusPill, avatar,
  meter, emptyState, expiryChip, toast,
} from './ui.js';
import { areaChart, sparkline } from './charts.js';
import { actionMeta, TONE_COLORS } from './labels.js';

const greeting = () => {
  const h = new Date().getHours();
  if (h < 5) return 'Доброй ночи';
  if (h < 12) return 'Доброе утро';
  if (h < 18) return 'Добрый день';
  return 'Добрый вечер';
};

function nodeRow(node) {
  const memPct = node.memoryTotal ? (node.memoryUsed / node.memoryTotal) * 100 : 0;
  const online = node.status === 'online';
  return `
  <div class="stack sm" style="padding:12px 0;border-bottom:1px solid var(--line)">
    <div class="row">
      <span style="font-size:16px">${esc(node.flag || '🌍')}</span>
      <div class="grow" style="min-width:0">
        <div class="row" style="gap:6px">
          <span class="bold" style="font-size:12.5px">${esc(node.name)}</span>
          <span class="pill ${online ? 'running' : 'offline'}" style="height:18px;font-size:9.5px"><i></i>${online ? 'онлайн' : 'офлайн'}</span>
        </div>
        <div class="tiny dim">${esc(node.location || node.fqdn)} · ${node.servers} серв.</div>
      </div>
      <span class="mono tiny dim">${Math.round(memPct)}%</span>
    </div>
    <div>
      <div class="usage-line"><span>RAM</span><b>${fmtMb(node.memoryUsed)} / ${fmtMb(node.memoryTotal)}</b></div>
      ${meter(memPct, memPct > 88 ? 'rose' : memPct > 70 ? 'amber' : '')}
    </div>
    <div class="row tiny dim" style="gap:14px">
      <span class="row" style="gap:4px">${icon('network', 11)} ${node.portsUsed}/${node.ports} портов</span>
      <span class="row" style="gap:4px">${icon('server', 11)} ${node.servers} серверов</span>
    </div>
  </div>`;
}

function activityItem(entry) {
  const meta = actionMeta(entry.action);
  return `
  <div class="timeline-item">
    <span class="timeline-dot" style="color:${TONE_COLORS[meta.tone] || '#93b4ff'}">${icon(meta.icon, 13)}</span>
    <div class="timeline-main">
      <div class="timeline-title"><b>${esc(meta.label)}</b>${entry.target ? ` <span class="dim">·</span> <span class="muted">${esc(entry.target)}</span>` : ''}</div>
      <div class="timeline-meta">
        <span>${esc(entry.actorName || 'system')}</span><span>·</span><span>${timeAgo(entry.at)}</span>
      </div>
    </div>
  </div>`;
}

export async function dashboardView(ctx) {
  const data = await api.get('/api/dashboard');
  const isAdmin = data.scope === 'admin';
  const limits = data.limits;
  const usedServers = data.counts.servers;
  const maxServers = isAdmin ? null : (limits && limits.servers);
  const memSpark = (data.history || []).map((h) => h.memory || 0);
  const cpuSpark = (data.history || []).map((h) => h.cpu || 0);
  let requests = [];
  if (isAdmin) {
    try {
      const r = await api.get('/api/renew-requests');
      requests = (r.requests || []).filter((x) => x.status === 'pending');
    } catch { /* не критично */ }
  }
  const attention = [
    ...requests.map((r) => ({ kind: 'renew', ...r })),
    ...(data.expiring || []).map((s) => ({ kind: 'expire', ...s })),
  ];

  const html = `
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">обзор инфраструктуры</div>
        <h1>${greeting()}, ${esc(data.user.username)}</h1>
        <p class="sub">${isAdmin
          ? `Под управлением ${data.counts.servers} серверов на ${data.counts.nodes} узлах. Живые метрики обновляются каждые 2 секунды.`
          : `У вас ${data.counts.servers} сервер(ов), ${data.counts.online} работает. Лимиты и сроки — в карточках ниже.`}</p>
      </div>
      <div class="page-actions">
        <button class="btn ghost" data-action="refresh">${icon('refresh', 15)} Обновить</button>
        ${isAdmin ? `<button class="btn" data-action="create-server">${icon('plus', 15)} Сервер</button>` : ''}
        ${isAdmin ? `<button class="btn primary" data-action="create-user">${icon('users', 15)} Пользователь</button>` : ''}
      </div>
    </div>

    ${attention.length ? `
    <div class="banner" style="margin-bottom:16px">
      ${icon('alert', 17)}
      <div class="grow">
        <b>${attention.length}</b> ${attention.length === 1 ? 'пункт требует' : 'пунктов требуют'} внимания:
        ${attention.slice(0, 2).map((a) => esc(a.kind === 'renew' ? `${a.serverName} — запрос продления` : `${a.name} — осталось ${a.daysLeft} дн`)).join(' · ')}
      </div>
      <a class="btn sm" href="#/servers">Открыть серверы</a>
    </div>` : ''}

    <div class="grid stats">
      <div class="card stat">
        <div class="stat-top">
          <span class="stat-label">Серверы</span>
          <span class="stat-icon">${icon('servers', 14)}</span>
        </div>
        <div class="stat-value">${data.counts.online}<small>/ ${data.counts.servers} онлайн</small></div>
        <div class="stat-foot">
          <span>${data.counts.suspended} приостановлено</span>
          <span class="delta up">${data.counts.servers ? Math.round((data.counts.online / data.counts.servers) * 100) : 0}% активны</span>
        </div>
      </div>
      <div class="card stat">
        <div class="stat-top">
          <span class="stat-label">${isAdmin ? 'Пользователи' : 'Мои серверы'}</span>
          <span class="stat-icon" style="background:rgba(255,255,255,.06);color:#fff;border-color:rgba(255,255,255,.18)">${icon(isAdmin ? 'users' : 'server', 14)}</span>
        </div>
        <div class="stat-value">${isAdmin ? fmtNum(data.counts.users) : `${usedServers}<small>/ ${maxServers ?? '∞'}</small>`}</div>
        <div class="stat-foot">
          <span>${isAdmin ? `${data.counts.usersOnline} онлайн сейчас` : `${data.counts.online} запущено`}</span>
          <span class="delta ${isAdmin ? 'flat' : 'up'}">${isAdmin ? `${data.counts.nodesOnline}/${data.counts.nodes} узлов` : 'лимит аккаунта'}</span>
        </div>
      </div>
      <div class="card stat">
        <div class="stat-top">
          <span class="stat-label">CPU</span>
          <span class="stat-icon" style="background:rgba(255,255,255,.06);color:#d4d4d4;border-color:rgba(255,255,255,.18)">${icon('cpu', 14)}</span>
        </div>
        <div class="stat-value">${data.usage.cpu.toFixed(1)}<small>%</small></div>
        <div class="stat-foot">
          <span>${data.system.cpus} ядер · load ${data.system.load1}</span>
          <span class="delta ${data.usage.cpu > 70 ? 'down' : 'up'}">${data.counts.online ? 'live' : 'idle'}</span>
        </div>
        <div class="stat-spark"><canvas data-spark="cpu"></canvas></div>
      </div>
      <div class="card stat">
        <div class="stat-top">
          <span class="stat-label">Память</span>
          <span class="stat-icon" style="background:rgba(255,255,255,.06);color:#a3a3a3;border-color:rgba(255,255,255,.18)">${icon('ram', 14)}</span>
        </div>
        <div class="stat-value">${fmtMb(Math.round(data.usage.memory / 1024 / 1024))}<small>из ${fmtMb(data.usage.memoryLimit)}</small></div>
        <div class="stat-foot">
          <span>${data.usage.memoryLimit ? Math.round((data.usage.memory / 1024 / 1024 / data.usage.memoryLimit) * 100) : 0}% аллокаций</span>
          <span class="delta flat">${fmtBytes(data.usage.disk)} на диске</span>
        </div>
        <div class="stat-spark"><canvas data-spark="mem"></canvas></div>
      </div>
    </div>

    <div class="grid split" style="margin-top:16px">
      <div class="card">
        <div class="card-head">
          <div class="panel-title">${icon('pulse', 15)} Нагрузка в реальном времени</div>
          <div class="row">
            <span class="chip" style="gap:5px"><i style="width:6px;height:6px;border-radius:1px;background:#ffffff;display:inline-block"></i>CPU</span>
            <span class="chip" style="gap:5px"><i style="width:6px;height:6px;border-radius:1px;background:#a3a3a3;display:inline-block"></i>RAM</span>
            <span class="pill running" style="height:22px"><i></i>live</span>
          </div>
        </div>
        <div class="card-body" style="padding-top:8px">
          <div style="position:relative"><canvas id="dash-chart"></canvas></div>
          <div class="row tiny dim" style="justify-content:space-between;margin-top:8px">
            <span>последние ~3 минуты</span>
            <span>${data.usage.players} игроков онлайн · ${fmtBytes(data.usage.disk)} занято данными</span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="panel-title">${icon('node', 15)} Узлы</div>
          ${isAdmin ? `<a class="btn sm ghost" href="#/nodes">Все ${icon('chevronRight', 13)}</a>` : ''}
        </div>
        <div class="card-body" style="padding-top:4px;padding-bottom:8px">
          ${(data.nodes || []).length ? data.nodes.slice(0, 3).map(nodeRow).join('') : emptyState('node', 'Нет узлов', 'Добавьте узел, чтобы размещать серверы.')}
          <div class="row tiny dim" style="padding-top:12px;gap:16px;flex-wrap:wrap">
            <span class="row" style="gap:5px">${icon('cpu', 12)} ${data.system.cpus} ядер хоста</span>
            <span class="row" style="gap:5px">${icon('ram', 12)} ${fmtBytes(data.system.totalMemory)} RAM</span>
            <span class="row" style="gap:5px">${icon('monitor', 12)} ${esc(data.system.platform)}</span>
          </div>
        </div>
      </div>
    </div>

    ${attention.length ? `
    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div class="panel-title">${icon('alert', 15)} Требуют внимания</div>
        <span class="chip">${attention.length}</span>
      </div>
      <div class="card-body stack sm">
        ${requests.length ? requests.map((r) => `
          <div class="row" style="gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;flex-wrap:wrap">
            <span class="timeline-dot" style="color:#d4d4d4">${icon('bell', 13)}</span>
            <div class="grow" style="min-width:0">
              <div style="font-weight:560">Запрос продления · ${esc(r.serverName)}</div>
              <div class="tiny dim">${esc(r.username)} просит +${r.days} дн · ${timeAgo(r.at)}${r.comment ? ` · «${esc(r.comment)}»` : ''}</div>
            </div>
            <button class="btn sm success" data-approve="${esc(r.id)}">${icon('check', 13)} Продлить</button>
            <button class="btn sm ghost" data-reject="${esc(r.id)}">Отклонить</button>
          </div>`).join('') : ''}
        ${(data.expiring || []).map((s) => `
          <div class="row" style="gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;flex-wrap:wrap">
            <span class="timeline-dot" style="color:#a3a3a3">${icon('calendar', 13)}</span>
            <div class="grow" style="min-width:0">
              <div style="font-weight:560">${esc(s.name)}</div>
              <div class="tiny dim">срок истекает через ${s.daysLeft} дн · ${fmtDateTime(s.expiresAt)}</div>
            </div>
            <a class="btn sm" href="#/servers/${s.id}/manage">Открыть</a>
            ${isAdmin ? `<button class="btn sm primary" data-action="renew-server" data-id="${s.id}" data-days="30">${icon('calendar', 13)} +30 дней</button>` : ''}
          </div>`).join('')}
      </div>
    </div>` : ''}

    <div class="grid split-even" style="margin-top:16px">
      <div class="card">
        <div class="card-head">
          <div class="panel-title">${icon('servers', 15)} Последние серверы</div>
          <a class="btn sm ghost" href="#/servers">Все серверы ${(data.counts.servers)} ${icon('chevronRight', 13)}</a>
        </div>
        <div class="table-wrap">
          <table class="table clickable">
            <thead><tr><th>Сервер</th><th>Статус</th><th>Порт</th><th class="right-cell">Срок</th></tr></thead>
            <tbody>
              ${(data.recent || []).length ? data.recent.map((s) => `
                <tr data-goto="#/servers/${s.id}/console">
                  <td>
                    <div class="row" style="gap:9px;min-width:0">
                      <span class="avatar sm">${esc((s.name || '?').slice(0, 2))}</span>
                      <div style="min-width:0">
                        <div class="ellipsis" style="font-weight:560">${esc(s.name)}</div>
                        <div class="tiny dim ellipsis">${esc((s.owner && s.owner.username) || '—')} · ${esc((s.egg && s.egg.name) || '—')}</div>
                      </div>
                    </div>
                  </td>
                  <td>${statusPill(s.status)}</td>
                  <td class="mono tiny">${s.allocation ? esc(s.allocation.port) : '—'}</td>
                  <td class="right-cell">${expiryChip(s.daysLeft)}</td>
                </tr>`).join('') : `<tr><td colspan="4">${emptyState('server', 'Серверов пока нет', 'Создайте первый сервер — это займёт полминуты.')}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="panel-title">${icon('activity', 15)} Последние события</div>
          ${isAdmin ? `<a class="btn sm ghost" href="#/audit">Журнал ${icon('chevronRight', 13)}</a>` : ''}
        </div>
        <div class="card-body" style="padding-top:6px">
          <div class="timeline">
            ${(data.activity || []).length ? data.activity.slice(0, 7).map(activityItem).join('') : emptyState('activity', 'Событий нет', 'Здесь появится история действий.')}
          </div>
        </div>
      </div>
    </div>

    ${!isAdmin && data.limits ? `
    <div class="card" style="margin-top:16px">
      <div class="card-head"><div class="panel-title">${icon('sliders', 15)} Лимиты аккаунта</div><a class="btn sm ghost" href="#/profile">Профиль ${icon('chevronRight', 13)}</a></div>
      <div class="card-body grid three">
        <div>
          <div class="usage-line"><span>Серверы</span><b>${usedServers} / ${data.limits.servers}</b></div>
          ${meter((usedServers / Math.max(1, data.limits.servers)) * 100)}
        </div>
        <div>
          <div class="usage-line"><span>Память</span><b>${fmtMb(data.usage.memoryLimit)} / ${fmtMb(data.limits.memory)}</b></div>
          ${meter((data.usage.memoryLimit / Math.max(1, data.limits.memory)) * 100)}
        </div>
        <div>
          <div class="usage-line"><span>Диск</span><b>${fmtMb(data.usage.diskLimit)} / ${fmtMb(data.limits.disk)}</b></div>
          ${meter((data.usage.diskLimit / Math.max(1, data.limits.disk)) * 100)}
        </div>
      </div>
    </div>` : ''}
  </div>`;

  function mount(root) {
    const chart = root.querySelector('#dash-chart');
    const labels = (data.history || []).map((h) => new Date(h.t || Date.now()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    const cpu = (data.history || []).map((h) => h.cpu || 0);
    const mem = (data.history || []).map((h) => (data.usage.memoryLimit ? ((h.memory || 0) / 1024 / 1024 / data.usage.memoryLimit) * 100 : 0));
    while (cpu.length < 2) { cpu.unshift(0); mem.unshift(0); }
    areaChart(chart, {
      series: [
        { values: cpu, color: '#ffffff', label: 'CPU' },
        { values: mem, color: '#a3a3a3', label: 'RAM' },
      ],
      max: Math.max(100, ...cpu),
      format: (n) => `${Math.round(n)}%`,
      height: 218,
      labels,
      tooltipLabel: (i) => labels[i] || '',
    });

    const spark = (name, values, color) => {
      const el = root.querySelector(`[data-spark="${name}"]`);
      if (el) sparkline(el, values, color, 36);
    };
    spark('cpu', cpu.length ? cpu : [0, 0], '#ffffff');
    spark('mem', mem.length ? mem : [0, 0], '#a3a3a3');

    // живые метрики: суммируем SSE-статистику по видимым серверам
    const serverIds = new Set((data.recent || []).map((s) => s.id));
    const live = new Map();
    let tickAt = 0;
    const onStats = (e) => {
      const d = e.detail || {};
      if (!serverIds.has(d.serverId)) return;
      live.set(d.serverId, { cpu: d.cpu || 0, memory: d.memory || 0 });
      if (Date.now() - tickAt < 2000) return;
      tickAt = Date.now();
      let totalCpu = 0;
      let totalMem = 0;
      for (const v of live.values()) { totalCpu += v.cpu; totalMem += v.memory; }
      cpu.push(totalCpu);
      mem.push(data.usage.memoryLimit ? (totalMem / 1024 / 1024 / data.usage.memoryLimit) * 100 : 0);
      if (cpu.length > 45) cpu.shift();
      if (mem.length > 45) mem.shift();
      if (chart && chart._redraw) chart._redraw();
    };
    window.addEventListener('od:stats', onStats);

    root.querySelectorAll('[data-goto]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        window.location.hash = row.dataset.goto;
      });
    });

    root.querySelectorAll('[data-approve]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api.post(`/api/renew-requests/${btn.dataset.approve}/approve`);
          toast('Сервер продлён', '', 'ok');
          ctx.refresh();
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });
    });
    root.querySelectorAll('[data-reject]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api.post(`/api/renew-requests/${btn.dataset.reject}/reject`);
          toast('Запрос отклонён', '', 'info');
          ctx.refresh();
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });
    });

    return () => window.removeEventListener('od:stats', onStats);
  }

  return { html, mount, title: 'Обзор' };
}
