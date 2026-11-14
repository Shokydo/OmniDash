// Административные страницы, журнал, обновления, настройки, профиль.
import { api } from './api.js';
import { icon } from './icons.js';
import {
  esc, fmtBytes, fmtMb, fmtNum, fmtDateTime, fmtDuration, timeAgo, statusPill, avatar,
  meter, emptyState, modal, toast, confirmDialog, serializeForm, copy, fileToDataUrl,
} from './ui.js';
import { actionMeta, TONE_COLORS } from './labels.js';
import { openCreateServer } from './views-servers.js';

const LIMIT_FIELDS = [
  ['servers', 'Серверы', 'шт'],
  ['memory', 'Память', 'МБ'],
  ['disk', 'Диск', 'МБ'],
  ['cpu', 'CPU / сервер', '%'],
  ['backups', 'Бэкапы', 'шт'],
  ['ports', 'Порты / сервер', 'шт'],
];

/* ═════════════════════════════ пользователи ═════════════════════════════ */

export async function usersView(ctx) {
  const data = await api.get('/api/users');
  const users = data.users || [];
  const defaults = data.defaults || {};
  let roles = [];
  try {
    const rData = await api.get('/api/roles');
    roles = rData.roles || [];
  } catch { roles = []; }
  let search = '';

  const html = `
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">администрирование</div>
        <h1>Пользователи</h1>
        <p class="sub">Аккаунты, роли и выдача серверов. Лимиты задаются на каждом сервере. Пароли хранятся только в виде scrypt-хеша.</p>
      </div>
      <div class="page-actions">
        <button class="btn ghost" data-action="refresh">${icon('refresh', 15)} Обновить</button>
        <button class="btn primary" id="create-user">${icon('plus', 15)} Создать пользователя</button>
      </div>
    </div>

    <div class="grid stats" style="margin-bottom:16px">
      <div class="card stat"><div class="stat-top"><span class="stat-label">Всего</span><span class="stat-icon">${icon('users', 14)}</span></div><div class="stat-value">${users.length}</div><div class="stat-foot"><span>аккаунтов</span></div></div>
      <div class="card stat"><div class="stat-top"><span class="stat-label">Админы</span><span class="stat-icon">${icon('shield', 14)}</span></div><div class="stat-value">${users.filter((u) => u.role === 'admin').length}</div><div class="stat-foot"><span>полный доступ</span></div></div>
      <div class="card stat"><div class="stat-top"><span class="stat-label">Онлайн</span><span class="stat-icon" style="background:rgba(255,255,255,.06);color:#fff;border-color:rgba(255,255,255,.18)">${icon('pulse', 14)}</span></div><div class="stat-value">${users.filter((u) => u.lastLoginAt && Date.now() - u.lastLoginAt < 900000).length}</div><div class="stat-foot"><span>за 15 минут</span></div></div>
      <div class="card stat"><div class="stat-top"><span class="stat-label">Заблокированы</span><span class="stat-icon" style="background:rgba(255,255,255,.06);color:#a3a3a3;border-color:rgba(255,255,255,.18)">${icon('lock', 14)}</span></div><div class="stat-value">${users.filter((u) => u.suspended).length}</div><div class="stat-foot"><span>аккаунтов</span></div></div>
    </div>

    <div class="toolbar" style="margin-bottom:14px">
      <div class="search">${icon('search', 14)}<input class="input" id="users-search" placeholder="Поиск по логину или e-mail…" /></div>
      <span class="chip right">лимиты — на серверах</span>
    </div>

    <div class="card table-wrap">
      <table class="table">
        <thead><tr><th>Пользователь</th><th>Роль</th><th>Подключённые серверы</th><th>Последний вход</th><th></th></tr></thead>
        <tbody id="users-body"></tbody>
      </table>
    </div>
  </div>`;

  const renderRows = (host) => {
    const filtered = users.filter((u) => !search || `${u.username} ${u.email || ''}`.toLowerCase().includes(search));
    host.innerHTML = filtered.map((u) => {
      const usage = u.usage || {};
      const srvNames = (u.serverNames || []).slice(0, 3).join(', ');
      return `
      <tr data-user="${u.id}">
        <td>
          <div class="row" style="gap:9px">
            ${avatar(u)}
            <div style="min-width:0">
              <div class="bold">${esc(u.username)} ${u.suspended ? '<span class="tag suspended">заблокирован</span>' : ''}</div>
              <div class="tiny dim">${esc(u.email || 'без e-mail')}</div>
            </div>
          </div>
        </td>
        <td><span class="tag ${u.role}">${esc(u.roleName || (u.role === 'admin' ? 'админ' : 'пользователь'))}</span></td>
        <td class="small"><b>${usage.servers || 0}</b> ${srvNames ? `<span class="dim">· ${esc(srvNames)}${(u.serverNames || []).length > 3 ? '…' : ''}</span>` : '<span class="dim">· нет серверов</span>'}</td>
        <td class="tiny dim">${u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'никогда'}</td>
        <td class="right-cell"><div class="actions-cell">
          <button class="btn sm ghost" data-edit-user="${u.id}" title="Изменить">${icon('edit', 13)}</button>
          <button class="btn sm ghost" data-user-servers="${u.id}" title="Серверы">${icon('server', 13)}</button>
        </div></td>
      </tr>`;
    }).join('') || `<tr><td colspan="5">${emptyState('users', 'Нет пользователей', 'Создайте первый аккаунт.')}</td></tr>`;

    host.querySelectorAll('[data-edit-user]').forEach((btn) => {
      btn.addEventListener('click', () => editUser(users.find((u) => u.id === btn.dataset.editUser)));
    });
    host.querySelectorAll('[data-user-servers]').forEach((btn) => {
      btn.addEventListener('click', () => userServers(users.find((u) => u.id === btn.dataset.userServers)));
    });
  };

  function userServers(user) {
    api.get(`/api/users/${user.id}`).then((detail) => {
      const list = detail.servers || [];
      modal({
        title: `Серверы ${user.username}`,
        subtitle: `${list.length} собственных · ${detail.shared.length} по доступу`,
        wide: true,
        body: `<div class="stack">
          ${list.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Сервер</th><th>Статус</th><th>Лимиты</th><th></th></tr></thead><tbody>
            ${list.map((s) => `<tr><td><b>${esc(s.name)}</b><div class="tiny dim">${esc(s.uuid.slice(0, 13))}</div></td><td>${statusPill(s.status)}</td><td class="tiny mono">${s.limits.memory} МБ · ${s.limits.disk / 1024} ГБ</td><td class="right-cell"><a class="btn sm ghost" href="#/servers/${s.id}/console">открыть ${icon('chevronRight', 12)}</a></td></tr>`).join('')}
          </tbody></table></div>` : `<div class="notice">${icon('info', 16)}<div>У пользователя нет собственных серверов.</div></div>`}
          ${detail.shared.length ? `<div><div class="label" style="margin-bottom:6px">Доступ по приглашению</div>${detail.shared.map((s) => `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)"><a href="#/servers/${s.id}/console">${esc(s.name)}</a><span class="right row" style="gap:4px">${s.perms.map((p) => `<span class="tag user">${esc(p)}</span>`).join('')}</span></div>`).join('')}</div>` : ''}
        </div>`,
        footer: `<button class="btn" data-close>Закрыть</button><button class="btn primary" id="give-server">${icon('plus', 14)} Выдать сервер</button>`,
        onMount: (overlay, close) => {
          overlay.querySelector('#give-server').addEventListener('click', () => {
            close();
            openCreateServer(ctx, { ownerId: user.id });
          });
        },
      });
    }).catch((err) => toast('Ошибка', err.message, 'err'));
  }

  function createUser() {
    modal({
      title: 'Новый пользователь',
      subtitle: 'Аккаунт с лимитами. Серверы выдаются отдельно.',
      wide: true,
      body: `<form class="stack" id="user-form">
        <div class="form-grid">
          <div class="field"><label>Логин</label><input class="input" name="username" placeholder="nickname" required /></div>
          <div class="field"><label>E-mail</label><input class="input" name="email" type="email" placeholder="user@example.com" /></div>
          <div class="field"><label>Пароль</label><input class="input" name="password" type="text" value="${Math.random().toString(36).slice(2, 10)}" /></div>
          <div class="field"><label>Роль</label><select class="select" name="role"><option value="user">Пользователь</option><option value="admin">Администратор</option></select></div>
          <div class="field"><label>Кастомная роль</label><select class="select" name="roleId"><option value="">— без кастомной роли —</option>${roles.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select></div>
        </div>
        <div class="notice">${icon('info', 16)}<div>Лимиты задаются на каждом сервере (вкладка «Настройки» сервера). У пользователя — только аккаунт, роль и список подключённых серверов.</div></div>
      </form>`,
      footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" id="user-ok">${icon('plus', 14)} Создать</button>`,
      onMount: (overlay, close) => {
        overlay.querySelector('#user-ok').addEventListener('click', async () => {
          const form = overlay.querySelector('#user-form');
          const v = serializeForm(form);
          try {
            await api.post('/api/users', { username: v.username, email: v.email, password: v.password, role: v.role, roleId: v.roleId || null });
            toast('Пользователь создан', v.username, 'ok');
            close();
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      },
    });
  }

  function editUser(user) {
    if (!user) return;
    modal({
      title: `Пользователь ${user.username}`,
      subtitle: `Создан ${fmtDateTime(user.createdAt)} · вход ${user.lastLoginAt ? timeAgo(user.lastLoginAt) : '—'}`,
      wide: true,
      body: `<div class="stack">
        <form class="stack" id="edit-user-form">
          <div class="form-grid">
            <div class="field"><label>E-mail</label><input class="input" name="email" value="${esc(user.email || '')}" /></div>
            <div class="field"><label>Роль</label><select class="select" name="role" ${user.id === ctx.me.id ? 'disabled' : ''}>
              <option value="user" ${user.role === 'user' ? 'selected' : ''}>Пользователь</option>
              <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Администратор</option>
            </select></div>
            <div class="field"><label>Кастомная роль</label><select class="select" name="roleId">
              <option value="">— без кастомной роли —</option>
              ${roles.map((r) => `<option value="${esc(r.id)}" ${user.roleId === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
            </select></div>
          </div>
          <div class="notice">${icon('info', 16)}<div>Лимиты задаются на каждом сервере (вкладка «Настройки» сервера).</div></div>
          <div class="row">
            <button class="btn primary" type="submit">${icon('save', 14)} Сохранить</button>
            <button class="btn" type="button" id="reset-pass">${icon('key', 14)} Сбросить пароль</button>
            ${user.id !== ctx.me.id ? `<button class="btn ${user.suspended ? 'success' : 'danger'}" type="button" id="toggle-suspend">${icon(user.suspended ? 'check' : 'lock', 14)} ${user.suspended ? 'Разблокировать' : 'Заблокировать'}</button>` : ''}
          </div>
        </form>
        <hr />
        <div class="row">
          <button class="btn" id="give-server">${icon('server', 14)} Выдать сервер</button>
          <button class="btn ghost danger right" id="delete-user" ${user.id === ctx.me.id ? 'disabled' : ''}>${icon('trash', 14)} Удалить аккаунт</button>
        </div>
      </div>`,
      footer: `<button class="btn" data-close>Закрыть</button>`,
      onMount: (overlay, close) => {
        const form = overlay.querySelector('#edit-user-form');
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const v = serializeForm(form);
          try {
            await api.patch(`/api/users/${user.id}`, { email: v.email, role: v.role, roleId: v.roleId || null });
            toast('Сохранено', '', 'ok');
            close();
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });

        overlay.querySelector('#reset-pass').addEventListener('click', () => {
          const password = Math.random().toString(36).slice(2, 10);
          confirmDialog({
            title: 'Сбросить пароль?',
            text: `Новый пароль: ${password}`,
            confirmText: 'Сбросить',
            danger: true,
          }).then(async (ok) => {
            if (!ok) return;
            try {
              await api.post(`/api/users/${user.id}/password`, { password });
              copy(password, 'Пароль скопирован в буфер');
              close();
            } catch (err) { toast('Ошибка', err.message, 'err'); }
          });
        });

        const suspendBtn = overlay.querySelector('#toggle-suspend');
        if (suspendBtn) {
          suspendBtn.addEventListener('click', async () => {
            try {
              await api.patch(`/api/users/${user.id}`, { suspended: !user.suspended });
              toast(user.suspended ? 'Пользователь разблокирован' : 'Пользователь заблокирован', '', 'ok');
              close();
              ctx.refresh();
            } catch (err) { toast('Ошибка', err.message, 'err'); }
          });
        }

        overlay.querySelector('#give-server').addEventListener('click', () => {
          close();
          openCreateServer(ctx, { ownerId: user.id });
        });

        overlay.querySelector('#delete-user').addEventListener('click', async () => {
          const ok = await confirmDialog({ title: `Удалить ${user.username}?`, text: 'Аккаунт удалится, если у него нет собственных серверов.', confirmText: 'Удалить', danger: true });
          if (!ok) return;
          try {
            await api.del(`/api/users/${user.id}`);
            toast('Пользователь удалён', '', 'ok');
            close();
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      },
    });
  }

  return {
    html,
    mount(root) {
      const body = root.querySelector('#users-body');
      renderRows(body);
      root.querySelector('#users-search').addEventListener('input', (e) => {
        search = e.target.value.trim().toLowerCase();
        renderRows(body);
      });
      root.querySelector('#create-user').addEventListener('click', createUser);
      return () => { };
    },
    title: 'Пользователи',
  };
}

/* ═════════════════════════════ роли ═════════════════════════════ */

export async function rolesView(ctx) {
  const data = await api.get('/api/roles');
  const roles = data.roles || [];
  const permissions = data.permissions || [];

  const html = `
  <div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">администрирование</div>
        <h1>Роли</h1>
        <p class="sub">Наборы разрешений для панели. Назначаются пользователям в разделе «Пользователи». Встроенные роли удалить нельзя.</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" id="create-role">${icon('plus', 15)} Создать роль</button>
      </div>
    </div>
    <div class="card table-wrap">
      <table class="table">
        <thead><tr><th>Роль</th><th>Разрешений</th><th>Тип</th><th></th></tr></thead>
        <tbody id="roles-body"></tbody>
      </table>
    </div>
  </div>`;

  function permCheckboxes(selected = []) {
    return permissions.map((p) => `
      <label class="switch" style="display:flex;align-items:center;gap:8px;padding:6px 0">
        <input type="checkbox" name="perm_${esc(p.id)}" ${selected.includes(p.id) ? 'checked' : ''} />
        <span class="switch-text">${esc(p.label)} <span class="mono dim" style="font-weight:400">${esc(p.id)}</span></span>
      </label>`).join('');
  }

  function roleForm(role) {
    const isNew = !role;
    modal({
      title: isNew ? 'Новая роль' : `Роль ${role.name}`,
      subtitle: isNew ? 'Выберите разрешения для новой роли.' : 'Измените название и разрешения.',
      wide: true,
      body: `<form class="stack" id="role-form">
        <div class="field"><label>Название роли</label><input class="input" name="name" value="${esc(role ? role.name : '')}" placeholder="Модератор, Хелпер…" required /></div>
        <div>
          <div class="label" style="margin-bottom:6px">Разрешения</div>
          ${permCheckboxes(role ? role.permissions : [])}
        </div>
      </form>`,
      footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" id="role-ok">${icon('save', 14)} Сохранить</button>`,
      onMount: (overlay, close) => {
        overlay.querySelector('#role-ok').addEventListener('click', async () => {
          const form = overlay.querySelector('#role-form');
          const v = serializeForm(form);
          const perms = permissions.filter((p) => v[`perm_${p.id}`]).map((p) => p.id);
          try {
            if (isNew) await api.post('/api/roles', { name: v.name, permissions: perms });
            else await api.patch(`/api/roles/${role.id}`, { name: v.name, permissions: perms });
            toast('Роль сохранена', v.name, 'ok');
            close();
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      },
    });
  }

  function renderRows(host) {
    host.innerHTML = roles.map((r) => `
      <tr>
        <td><b>${esc(r.name)}</b>${r.builtin ? ' <span class="tag user">встроенная</span>' : ''}</td>
        <td class="small">${(r.permissions || []).length} из ${permissions.length}</td>
        <td class="tiny dim">${esc((r.permissions || []).slice(0, 3).join(', '))}${(r.permissions || []).length > 3 ? '…' : ''}</td>
        <td class="right-cell"><div class="actions-cell">
          <button class="btn sm ghost" data-edit-role="${esc(r.id)}" title="Изменить">${icon('edit', 13)}</button>
          ${!r.builtin ? `<button class="btn sm ghost danger" data-del-role="${esc(r.id)}" title="Удалить">${icon('trash', 13)}</button>` : ''}
        </div></td>
      </tr>`).join('') || `<tr><td colspan="4">${emptyState('shield', 'Ролей нет', 'Создайте первую роль.')}</td></tr>`;
    host.querySelectorAll('[data-edit-role]').forEach((btn) => {
      btn.addEventListener('click', () => roleForm(roles.find((r) => r.id === btn.dataset.editRole)));
    });
    host.querySelectorAll('[data-del-role]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const role = roles.find((r) => r.id === btn.dataset.delRole);
        const ok = await confirmDialog({ title: `Удалить роль ${role.name}?`, text: 'Если роль назначена пользователям, удаление будет отклонено.', confirmText: 'Удалить', danger: true });
        if (!ok) return;
        try {
          await api.del(`/api/roles/${role.id}`);
          toast('Роль удалена', role.name, 'ok');
          ctx.refresh();
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });
    });
  }

  return {
    html,
    mount(root) {
      renderRows(root.querySelector('#roles-body'));
      root.querySelector('#create-role').addEventListener('click', () => roleForm(null));
      return () => { };
    },
    title: 'Роли',
  };
}

/* ═════════════════════════════ узлы ═════════════════════════════ */

export async function nodesView(ctx) {
  const data = await api.get('/api/nodes');
  const nodes = data.nodes || [];

  const html = `
  <div class="page">
    <div class="page-head">
      <div><div class="eyebrow">инфраструктура</div><h1>Узлы</h1>
        <p class="sub">Узлы — серверы, на которых запускаются процессы. Локальный узел (fqdn localhost) исполняет процессы по-настоящему.</p></div>
      <div class="page-actions">
        <button class="btn ghost" data-action="refresh">${icon('refresh', 15)}</button>
        <button class="btn primary" id="add-node">${icon('plus', 15)} Добавить узел</button>
      </div>
    </div>
    <div class="grid cards">
      ${nodes.map((n) => {
        const usage = n.usage || {};
        const memPct = usage.memoryTotal ? (usage.memory / usage.memoryTotal) * 100 : 0;
        const diskPct = usage.diskTotal ? (usage.disk / usage.diskTotal) * 100 : 0;
        const online = n.status === 'online';
        return `
        <article class="card hoverable node-card">
          <div class="node-head">
            <span class="node-flag">${esc(n.flag || '🌍')}</span>
            <div class="grow" style="min-width:0">
              <div class="row" style="gap:6px"><span class="bold">${esc(n.name)}</span>${n.local ? '<span class="tag admin">local</span>' : ''}</div>
              <div class="tiny dim">${esc(n.location || '—')} · <span class="mono">${esc(n.fqdn)}</span></div>
            </div>
            <span class="pill ${online ? 'running' : 'offline'}"><i></i>${online ? 'online' : n.status === 'maintenance' ? 'обслуживание' : 'offline'}</span>
          </div>
          <div class="stack sm">
            <div>
              <div class="usage-line"><span>Память</span><b>${fmtMb(usage.memory)} / ${fmtMb(usage.memoryTotal)}</b></div>
              ${meter(memPct, memPct > 90 ? 'rose' : memPct > 70 ? 'amber' : '')}
            </div>
            <div>
              <div class="usage-line"><span>Диск</span><b>${fmtMb(usage.disk)} / ${fmtMb(usage.diskTotal)}</b></div>
              ${meter(diskPct, diskPct > 90 ? 'rose' : '')}
            </div>
          </div>
          <div class="grid three" style="gap:8px">
            <div class="metric"><div class="k">Серверы</div><div class="v">${usage.servers}</div></div>
            <div class="metric"><div class="k">Порты</div><div class="v">${usage.portsUsed}/${usage.ports}</div></div>
            <div class="metric"><div class="k">Диапазон</div><div class="v">${n.portStart}–${n.portEnd}</div></div>
          </div>
          <div class="row" style="gap:6px;margin-top:auto">
            <a class="btn sm" href="#/allocations?node=${n.id}">${icon('network', 13)} Порты</a>
            <button class="btn sm ghost" data-node-edit="${n.id}">${icon('edit', 13)} Изменить</button>
            <button class="btn sm ghost danger right" data-node-del="${n.id}" ${usage.servers ? 'disabled' : ''}>${icon('trash', 13)}</button>
          </div>
        </article>`;
      }).join('') || emptyState('node', 'Узлов нет', 'Добавьте узел, чтобы создать серверы.')}
    </div>
    <div class="notice" style="margin-top:16px">${icon('info', 16)}<div>Процессы запускаются на узле с fqdn <span class="mono">localhost</span> или <span class="mono">127.0.0.1</span>. Удалённые узлы в этой версии — задел под агент Wings; их серверы видны, но питание недоступно.</div></div>
  </div>`;

  function nodeForm(node) {
    const isNew = !node;
    const n = node || {};
    modal({
      title: isNew ? 'Новый узел' : `Узел ${n.name}`,
      subtitle: 'Параметры размещения и диапазон портов',
      wide: true,
      body: `<form class="stack" id="node-form">
        <div class="form-grid">
          <div class="field"><label>Название</label><input class="input" name="name" value="${esc(n.name || '')}" placeholder="ru-2 · Санкт-Петербург" /></div>
          <div class="field"><label>Локация</label><input class="input" name="location" value="${esc(n.location || '')}" placeholder="Москва, RU" /></div>
          <div class="field"><label>FQDN / IP</label><input class="input mono" name="fqdn" value="${esc(n.fqdn || 'localhost')}" /></div>
          <div class="field"><label>Статус</label><select class="select" name="status">
            ${['online', 'offline', 'maintenance'].map((s) => `<option value="${s}" ${n.status === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select></div>
          <div class="field"><label>Флаг</label><input class="input" name="flag" value="${esc(n.flag || '🌍')}" maxlength="4" /></div>
          <div class="field"><label>Порт панели узла</label><input class="input" type="number" name="port" value="${n.port || 8080}" /></div>
          <div class="field"><label>RAM (МБ)</label><input class="input" type="number" name="memoryTotal" value="${n.memoryTotal || 16384}" /></div>
          <div class="field"><label>Диск (МБ)</label><input class="input" type="number" name="diskTotal" value="${n.diskTotal || 102400}" /></div>
          <div class="field"><label>Порты с</label><input class="input" type="number" name="portStart" value="${n.portStart || 25565}" /></div>
          <div class="field"><label>Порты по</label><input class="input" type="number" name="portEnd" value="${n.portEnd || 25600}" /></div>
          <div class="field span-2"><label>Описание</label><input class="input" name="description" value="${esc(n.description || '')}" /></div>
        </div>
      </form>`,
      footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" id="node-ok">${isNew ? 'Добавить узел' : 'Сохранить'}</button>`,
      onMount: (overlay, close) => {
        overlay.querySelector('#node-ok').addEventListener('click', async () => {
          const v = serializeForm(overlay.querySelector('#node-form'));
          try {
            if (isNew) await api.post('/api/nodes', v);
            else await api.patch(`/api/nodes/${n.id}`, v);
            toast(isNew ? 'Узел добавлен' : 'Узел сохранён', '', 'ok');
            close();
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      },
    });
  }

  return {
    html,
    mount(root) {
      root.querySelector('#add-node').addEventListener('click', () => nodeForm(null));
      root.querySelectorAll('[data-node-edit]').forEach((b) => b.addEventListener('click', () => nodeForm(nodes.find((n) => n.id === b.dataset.nodeEdit))));
      root.querySelectorAll('[data-node-del]').forEach((b) => {
        b.addEventListener('click', async () => {
          const node = nodes.find((n) => n.id === b.dataset.nodeDel);
          const ok = await confirmDialog({ title: `Удалить ${node.name}?`, text: 'Узел и его порты будут удалены.', confirmText: 'Удалить', danger: true });
          if (!ok) return;
          try {
            await api.del(`/api/nodes/${node.id}`);
            toast('Узел удалён', '', 'ok');
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      });
      return () => { };
    },
    title: 'Узлы',
  };
}

/* ═════════════════════════════ аллокации ═════════════════════════════ */

export async function allocationsView(ctx) {
  const data = await api.get('/api/allocations');
  const allocations = data.allocations || [];
  const nodes = data.nodes || [];
  let nodeFilter = ctx.query.node || '';
  let statusFilter = '';
  let search = '';

  const renderRows = () => {
    const host = document.getElementById('alloc-body');
    if (!host) return;
    const filtered = allocations.filter((a) => {
      if (nodeFilter && a.nodeId !== nodeFilter) return false;
      if (statusFilter === 'free' && a.server) return false;
      if (statusFilter === 'used' && !a.server) return false;
      if (search && !String(a.port).includes(search) && !(a.server && a.server.name.toLowerCase().includes(search))) return false;
      return true;
    });
    host.innerHTML = filtered.map((a) => `
      <tr>
        <td class="mono">${esc(a.ip)}:${esc(a.port)}</td>
        <td class="small">${esc(a.nodeName)}</td>
        <td>${a.server ? `<a href="#/servers/${a.server.id}/console">${esc(a.server.name)}</a>` : '<span class="pill green" style="height:20px"><i></i>свободен</span>'}</td>
        <td class="tiny dim">${esc(a.notes || '—')}</td>
        <td class="right-cell"><button class="btn sm ghost danger" data-alloc-del="${a.id}" ${a.server ? 'disabled' : ''}>${icon('trash', 13)}</button></td>
      </tr>`).join('') || `<tr><td colspan="5">${emptyState('network', 'Нет аллокаций', 'Создайте порты для узла.')}</td></tr>`;
    host.querySelectorAll('[data-alloc-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Удалить порт?', confirmText: 'Удалить', danger: true });
        if (!ok) return;
        try {
          await api.del(`/api/allocations/${b.dataset.allocDel}`);
          toast('Порт удалён', '', 'ok');
          ctx.refresh();
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });
    });
    const count = document.getElementById('alloc-count');
    if (count) count.textContent = `${filtered.length} портов`;
  };

  const html = `
  <div class="page">
    <div class="page-head">
      <div><div class="eyebrow">сеть</div><h1>Аллокации</h1>
        <p class="sub">Порты узлов. Свободный порт можно выдать серверу — он станет переменной <span class="mono">{{PORT}}</span>.</p></div>
      <div class="page-actions">
        <button class="btn" id="bulk-ports">${icon('layers', 15)} Диапазон</button>
        <button class="btn primary" id="add-port">${icon('plus', 15)} Порт</button>
      </div>
    </div>
    <div class="toolbar" style="margin-bottom:14px">
      <div class="search">${icon('search', 14)}<input class="input" id="alloc-search" placeholder="Порт или сервер…" /></div>
      <select class="select" id="alloc-node" style="width:auto"><option value="">Все узлы</option>${nodes.map((n) => `<option value="${n.id}" ${nodeFilter === n.id ? 'selected' : ''}>${esc(n.name)}</option>`).join('')}</select>
      <div class="segmented" id="alloc-status"><button class="active" data-s="">Все</button><button data-s="free">Свободные</button><button data-s="used">Занятые</button></div>
      <span class="chip right" id="alloc-count">${allocations.length} портов</span>
    </div>
    <div class="card table-wrap">
      <table class="table"><thead><tr><th>Адрес</th><th>Узел</th><th>Сервер</th><th>Заметка</th><th></th></tr></thead>
      <tbody id="alloc-body"></tbody></table>
    </div>
  </div>`;

  return {
    html,
    mount(root) {
      renderRows();
      root.querySelector('#alloc-search').addEventListener('input', (e) => { search = e.target.value.trim().toLowerCase(); renderRows(); });
      root.querySelector('#alloc-node').addEventListener('change', (e) => { nodeFilter = e.target.value; renderRows(); });
      root.querySelectorAll('#alloc-status button').forEach((b) => {
        b.addEventListener('click', () => {
          statusFilter = b.dataset.s;
          root.querySelectorAll('#alloc-status button').forEach((x) => x.classList.toggle('active', x === b));
          renderRows();
        });
      });

      root.querySelector('#add-port').addEventListener('click', () => {
        modal({
          title: 'Новый порт',
          slim: true,
          body: `<form class="stack" id="port-form">
            <div class="field"><label>Узел</label><select class="select" name="nodeId">${nodes.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join('')}</select></div>
            <div class="field"><label>IP</label><input class="input mono" name="ip" value="0.0.0.0" /></div>
            <div class="field"><label>Порт</label><input class="input" type="number" name="port" value="${25565 + Math.floor(Math.random() * 60)}" /></div>
            <div class="field"><label>Заметка</label><input class="input" name="notes" placeholder="например, rcon" /></div>
          </form>`,
          footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" id="port-ok">Добавить</button>`,
          onMount: (overlay, close) => {
            overlay.querySelector('#port-ok').addEventListener('click', async () => {
              try {
                await api.post('/api/allocations', serializeForm(overlay.querySelector('#port-form')));
                toast('Порт создан', '', 'ok');
                close();
                ctx.refresh();
              } catch (err) { toast('Ошибка', err.message, 'err'); }
            });
          },
        });
      });

      root.querySelector('#bulk-ports').addEventListener('click', () => {
        modal({
          title: 'Создать диапазон портов',
          subtitle: 'До 500 портов за раз, дубликаты пропускаются',
          body: `<form class="stack" id="bulk-form">
            <div class="field"><label>Узел</label><select class="select" name="nodeId">${nodes.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join('')}</select></div>
            <div class="form-grid">
              <div class="field"><label>С порта</label><input class="input" type="number" name="from" value="25600" /></div>
              <div class="field"><label>По порт</label><input class="input" type="number" name="to" value="25650" /></div>
            </div>
          </form>`,
          footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" id="bulk-ok">Создать</button>`,
          onMount: (overlay, close) => {
            overlay.querySelector('#bulk-ok').addEventListener('click', async () => {
              try {
                const res = await api.post('/api/allocations/bulk', serializeForm(overlay.querySelector('#bulk-form')));
                toast('Порты созданы', `${res.created} новых`, 'ok');
                close();
                ctx.refresh();
              } catch (err) { toast('Ошибка', err.message, 'err'); }
            });
          },
        });
      });
      return () => { };
    },
    title: 'Аллокации',
  };
}

/* ═════════════════════════════ шаблоны ═════════════════════════════ */

export async function eggsView(ctx) {
  const data = await api.get('/api/eggs');
  const eggs = data.eggs || [];

  const html = `
  <div class="page">
    <div class="page-head">
      <div><div class="eyebrow">шаблоны</div><h1>Шаблоны серверов</h1>
        <p class="sub">Egg = стартовая команда с переменными, правила остановки и образ — без YAML-магии.</p></div>
      <div class="page-actions"><button class="btn primary" id="add-egg">${icon('plus', 15)} Новый шаблон</button></div>
    </div>
    <div class="grid cards">
      ${eggs.map((e) => `
        <article class="card hoverable" style="padding:16px;display:flex;flex-direction:column;gap:12px">
          <div class="row">
            <span class="server-icon">${icon('package', 18)}</span>
            <div class="grow" style="min-width:0">
              <div class="bold ellipsis">${esc(e.name)}</div>
              <div class="tiny dim mono">${esc(e.key || e.category)}</div>
            </div>
            <span class="chip">${e.servers} серв.</span>
          </div>
          <p class="tiny dim" style="line-height:1.55;min-height:48px">${esc(e.description || 'Без описания')}</p>
          <div class="code-block" style="max-height:78px;font-size:10.5px">${esc(e.startup)}</div>
          <div class="row tiny dim">
            <span class="chip">${e.variables.length} перем.</span>
            <span class="chip">${esc(e.category)}</span>
            <span class="right row" style="gap:2px">
              <button class="btn sm ghost" data-egg-view="${e.id}">${icon('eye', 13)}</button>
              <button class="btn sm ghost" data-egg-edit="${e.id}">${icon('edit', 13)}</button>
              <button class="btn sm ghost danger" data-egg-del="${e.id}" ${e.servers ? 'disabled' : ''}>${icon('trash', 13)}</button>
            </span>
          </div>
        </article>`).join('') || emptyState('package', 'Шаблонов нет', 'Создайте шаблон из JSON.')}
    </div>
  </div>`;

  function eggModal(egg) {
    const isNew = !egg;
    const spec = egg ? {
      name: egg.name, key: egg.key, category: egg.category, description: egg.description,
      startup: egg.startup, image: egg.image, variables: egg.variables, config: egg.config,
      color: egg.color,
    } : {
      name: 'Мой шаблон',
      key: 'custom',
      category: 'generic',
      description: 'Описание шаблона',
      startup: 'node "{{BASE}}/demo/bot-mock.js" --name "{{SERVER_NAME}}"',
      image: 'ghcr.io/pterodactyl/yolks:nodejs_22',
      color: '#94a3b8',
      variables: [{ env: 'EXAMPLE', label: 'Пример', default: 'value', userEditable: true, rules: 'string' }],
      config: { stopCommand: 'stop', stopTimeout: 10, readyRegex: 'ready|listening' },
    };
    modal({
      title: isNew ? 'Новый шаблон' : `Шаблон ${egg.name}`,
      subtitle: 'JSON-спецификация. Переменные подставляются в команду как {{ENV}}.',
      wide: true,
      body: `<form class="stack" id="egg-form">
        <div class="form-grid">
          <div class="field"><label>Название</label><input class="input" name="name" value="${esc(spec.name)}" /></div>
          <div class="field"><label>Категория</label><input class="input" name="category" value="${esc(spec.category)}" /></div>
        </div>
        <div class="field"><label>JSON шаблона</label><textarea class="textarea mono" name="json" rows="16" spellcheck="false">${esc(JSON.stringify(spec, null, 2))}</textarea></div>
      </form>`,
      footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" id="egg-ok">${isNew ? 'Создать' : 'Сохранить'}</button>`,
      onMount: (overlay, close) => {
        overlay.querySelector('#egg-ok').addEventListener('click', async () => {
          const v = serializeForm(overlay.querySelector('#egg-form'));
          let json;
          try { json = JSON.parse(v.json); } catch { toast('Ошибка JSON', 'Проверьте синтаксис', 'err'); return; }
          try {
            if (isNew) await api.post('/api/eggs', { ...json, name: v.name, category: v.category });
            else await api.patch(`/api/eggs/${egg.id}`, { ...json, name: v.name });
            toast(isNew ? 'Шаблон создан' : 'Шаблон сохранён', '', 'ok');
            close();
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      },
    });
  }

  return {
    html,
    mount(root) {
      root.querySelector('#add-egg').addEventListener('click', () => eggModal(null));
      root.querySelectorAll('[data-egg-edit]').forEach((b) => b.addEventListener('click', () => eggModal(eggs.find((e) => e.id === b.dataset.eggEdit))));
      root.querySelectorAll('[data-egg-view]').forEach((b) => {
        b.addEventListener('click', () => {
          const e = eggs.find((x) => x.id === b.dataset.eggView);
          modal({
            title: e.name,
            subtitle: e.description,
            wide: true,
            body: `<div class="stack">
              <div><div class="label">Стартовая команда</div><div class="code-block">${esc(e.startup)}</div></div>
              <div><div class="label">Переменные</div>
                ${(e.variables || []).length ? `<table class="table"><thead><tr><th>ENV</th><th>Название</th><th>По умолчанию</th><th>Правило</th></tr></thead><tbody>
                  ${e.variables.map((v) => `<tr><td class="mono">${esc(v.env)}</td><td>${esc(v.label)}</td><td class="mono">${esc(v.default)}</td><td class="tiny dim">${esc(v.rules || 'string')}</td></tr>`).join('')}
                </tbody></table>` : '<div class="tiny dim">Нет переменных</div>'}
              </div>
              <div><div class="label">JSON</div><div class="code-block" style="max-height:220px">${esc(JSON.stringify({ config: e.config, image: e.image }, null, 2))}</div></div>
            </div>`,
            footer: `<button class="btn" data-close>Закрыть</button>`,
          });
        });
      });
      root.querySelectorAll('[data-egg-del]').forEach((b) => {
        b.addEventListener('click', async () => {
          const ok = await confirmDialog({ title: 'Удалить шаблон?', confirmText: 'Удалить', danger: true });
          if (!ok) return;
          try {
            await api.del(`/api/eggs/${b.dataset.eggDel}`);
            toast('Шаблон удалён', '', 'ok');
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      });
      return () => { };
    },
    title: 'Шаблоны',
  };
}

/* ═════════════════════════════ журнал ═════════════════════════════ */

export async function auditView(ctx) {
  const data = await api.get('/api/audit', { limit: 200 });
  const entries = data.entries || [];
  let search = '';

  const rows = (list) => list.map((e) => {
    const meta = actionMeta(e.action);
    return `
      <div class="timeline-item">
        <span class="timeline-dot" style="color:${TONE_COLORS[meta.tone] || '#93b4ff'}">${icon(meta.icon, 13)}</span>
        <div class="timeline-main">
          <div class="row" style="gap:8px;flex-wrap:wrap">
            <span class="timeline-title"><b>${esc(meta.label)}</b>${e.target ? ` <span class="dim">·</span> ${esc(e.target)}` : ''}</span>
            <span class="chip mono tiny right">${esc(e.action)}</span>
          </div>
          <div class="timeline-meta">
            <span>${esc(e.actorName || 'system')}</span><span>·</span><span>${fmtDateTime(e.at)}</span>
            ${e.meta && Object.keys(e.meta).length ? `<span>·</span><span class="mono" style="opacity:.8">${esc(JSON.stringify(e.meta).slice(0, 130))}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  const html = `
  <div class="page">
    <div class="page-head">
      <div><div class="eyebrow">безопасность</div><h1>Журнал действий</h1>
        <p class="sub">Каждое действие в панели: входы, серверы, доступы, бэкапы, настройки. ${fmtNum(data.total)} записей.</p></div>
      <div class="page-actions"><button class="btn ghost" data-action="refresh">${icon('refresh', 15)} Обновить</button></div>
    </div>
    <div class="toolbar" style="margin-bottom:14px">
      <div class="search">${icon('search', 14)}<input class="input" id="audit-search" placeholder="Действие, автор, сервер…" /></div>
      <span class="chip right">${entries.length} последних</span>
    </div>
    <div class="card"><div class="card-body"><div class="timeline" id="audit-list">${rows(entries)}</div></div></div>
  </div>`;

  return {
    html,
    mount(root) {
      const list = root.querySelector('#audit-list');
      root.querySelector('#audit-search').addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        const filtered = entries.filter((x) => `${x.action} ${x.actorName} ${x.target || ''} ${JSON.stringify(x.meta || {})}`.toLowerCase().includes(q));
        list.innerHTML = rows(filtered) || emptyState('search', 'Ничего не найдено', 'Измените запрос.');
      });
      return () => { };
    },
    title: 'Журнал',
  };
}

/* ═════════════════════════════ обновления ═════════════════════════════ */

export async function updatesView(ctx) {
  const info = await api.get('/api/update');
  let checkResult = info.lastResult;
  const history = info.history || [];
  const packages = info.packages || [];

  const html = `
  <div class="page">
    <div class="page-head">
      <div><div class="eyebrow">обслуживание</div><h1>Обновления</h1>
        <p class="sub">Автообновление без GitHub: локальные пакеты и свой канал по URL.</p></div>
      <div class="page-actions"><button class="btn" id="build-update">${icon('package', 15)} Собрать пакет</button><button class="btn primary" id="check-update">${icon('cloudDownload', 15)} Проверить обновления</button></div>
    </div>

    ${info.restartRequired ? `<div class="banner" style="margin-bottom:16px">${icon('alert', 17)}<div class="grow"><b>Нужен перезапуск панели</b> — обновление затронуло ядро (core/ или server.js). Интерфейс уже обновлён, но код ядра применится после перезапуска процесса.</div><button class="btn sm primary" id="restart-panel">${icon('restart', 13)} Перезапустить панель</button></div>` : ''}

    <div class="grid split">
      <div class="card">
        <div class="card-head"><div class="panel-title">${icon('sparkles', 15)} Текущая сборка</div><span class="pill running"><i></i>${esc(info.mode)}</span></div>
        <div class="card-body">
          <div class="row" style="align-items:flex-end;gap:16px;flex-wrap:wrap">
            <div><div class="tiny dim">Версия</div><div style="font-size:34px;font-weight:680;letter-spacing:-.03em">v${esc(info.version)}</div></div>
            <div class="chip mono">${esc(info.buildId)}</div>
            <div class="chip">${esc(info.channel)}</div>
          </div>
          <dl class="kv" style="margin-top:16px">
            <dt>Канал</dt><dd class="mono tiny">${esc(info.updateUrl || 'updates/update.json (локально)')}</dd>
            <dt>Автоперезагрузка</dt><dd>${info.autoReload ? 'включена — интерфейс перезагружается сам' : 'выключена'}</dd>
            <dt>Проверка</dt><dd>${info.lastCheck ? fmtDateTime(info.lastCheck) : 'ещё не выполнялась'}</dd>
            <dt>Перезапуск</dt><dd>${info.restartRequired ? '<b>нужен для изменений ядра</b>' : 'не требуется'}</dd>
          </dl>
          ${info.notes ? `<div class="notice" style="margin-top:14px">${icon('info', 16)}<div>${esc(info.notes)}</div></div>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="panel-title">${icon('search', 15)} Результат проверки</div></div>
        <div class="card-body" id="check-panel">
          ${checkResult ? `
            <div class="stack sm">
              <div class="row"><span class="label">Доступно</span><span class="right">${checkResult.available ? `<span class="pill amber"><i></i>v${esc(checkResult.latest)}</span>` : `<span class="pill green"><i></i>актуально</span>`}</span></div>
              <dl class="kv" style="grid-template-columns:120px 1fr">
                <dt>Сейчас</dt><dd class="mono">v${esc(checkResult.current)}</dd>
                <dt>Канал</dt><dd class="mono tiny">${esc(checkResult.latest)}</dd>
                <dt>Источник</dt><dd class="mono tiny">${esc(checkResult.source || '—')}</dd>
              </dl>
              ${checkResult.error ? `<div class="banner danger">${icon('alert', 16)}<div>${esc(checkResult.error)}</div></div>` : ''}
              ${checkResult.notes ? `<div class="tiny dim" style="line-height:1.6">${esc(checkResult.notes)}</div>` : ''}
              ${checkResult.available && checkResult.package ? `<div class="row" style="margin-top:4px"><button class="btn primary" id="apply-update">${icon('download', 14)} Применить обновление v${esc(checkResult.latest)}</button><span class="tiny dim mono">${esc(checkResult.package)}</span></div>` : ''}
            </div>` : `<div class="tiny dim">Нажмите «Проверить обновления». Панель прочитает <span class="mono">updates/update.json</span> или ваш URL.</div>`}
        </div>
      </div>
    </div>

    <div class="grid split" style="margin-top:16px">
      <div class="card">
        <div class="card-head"><div class="panel-title">${icon('package', 15)} Пакеты в updates/</div><span class="chip">${packages.length}</span></div>
        <div class="card-body stack">
          ${packages.length ? packages.map((p) => `
            <div class="row" style="padding:9px 0;border-bottom:1px solid var(--line)">
              <span class="backup-icon">${icon('archive', 15)}</span>
              <div class="grow" style="min-width:0"><div class="mono small ellipsis">${esc(p.file)}</div><div class="tiny dim">${fmtBytes(p.size)} · ${fmtDateTime(p.mtime)}</div></div>
              <button class="btn sm" data-apply="${esc(p.file)}">${icon('download', 13)} Применить</button>
              <a class="btn sm ghost" href="/api/update/packages/${encodeURIComponent(p.file)}" title="Скачать пакет">${icon('download', 13)}</a>
              <button class="btn sm ghost danger" data-del-pkg="${esc(p.file)}" title="Удалить пакет">${icon('trash', 13)}</button>
            </div>`).join('') : `<div class="empty" style="padding:20px">${icon('package', 28)}<h3>Пакетов нет</h3><p>Положите zip-архив в папку <span class="mono">updates/</span> — он появится здесь.</p></div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div class="panel-title">${icon('upload', 15)} Загрузить обновление</div></div>
        <div class="card-body stack">
          <label class="dropzone" id="update-drop">
            ${icon('cloudDownload', 26)}
            <div style="margin-top:8px">Перетащите <b>.zip</b> сюда или нажмите, чтобы выбрать</div>
            <div class="tiny dim" style="margin-top:4px">ZIP с server.js / core / public. Данные не трогаются.</div>
            <input type="file" id="update-file" accept=".zip" class="hidden" />
          </label>
          <div class="notice">${icon('shield', 16)}<div>Перед применением панель делает ZIP-бэкап кода в <span class="mono">data/updates/</span>, игнорирует <span class="mono">data/</span> и <span class="mono">updates/</span> и перезагружает интерфейс.</div></div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><div class="panel-title">${icon('clock', 15)} История обновлений</div></div>
      ${history.length ? history.map((h) => `
        <div class="backup-row">
          <span class="backup-icon">${icon('check', 15)}</span>
          <div class="grow"><div class="bold">v${esc(h.version)}</div><div class="tiny dim">${fmtDateTime(h.at)} · ${esc(h.label || '')} · ${h.applied} файлов${h.skipped ? ` · ${h.skipped} пропущено` : ''}</div></div>
          <span class="chip">${esc(h.by || 'system')}</span>
        </div>`).join('') : `<div class="empty">${icon('clock', 28)}<h3>Обновлений ещё не было</h3><p>История появится после первого применения пакета.</p></div>`}
    </div>
  </div>`;

  return {
    html,
    mount(root) {
      root.querySelector('#check-update').addEventListener('click', async () => {
        const btn = root.querySelector('#check-update');
        btn.disabled = true;
        try {
          const result = await api.post('/api/update/check');
          checkResult = result;
          toast(result.available ? `Доступна версия ${result.latest}` : 'Обновлений нет', result.available ? 'Можно применить пакет' : 'Панель актуальна', result.available ? 'info' : 'ok');
          ctx.refresh();
        } catch (err) {
          toast('Ошибка проверки', err.message, 'err');
        }
        btn.disabled = false;
      });

      const applyBtn = root.querySelector('#apply-update');
      if (applyBtn) {
        applyBtn.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: 'Применить обновление?',
            text: `Будет применена версия ${checkResult.latest}. Сначала панель сделает ZIP-бэкап кода. Данные (data/) не трогаются.`,
            confirmText: 'Применить',
          });
          if (!ok) return;
          applyBtn.disabled = true;
          try {
            const res = await api.post('/api/update/apply');
            toast('Обновление применено', res.message, 'ok', 7000);
            setTimeout(() => window.location.reload(), 1200);
          } catch (err) { toast('Ошибка', err.message, 'err'); }
          applyBtn.disabled = false;
        });
      }

      const buildBtn = root.querySelector('#build-update');
      if (buildBtn) {
        buildBtn.addEventListener('click', () => {
          modal({
            title: 'Собрать пакет обновления',
            subtitle: 'ZIP с текущим кодом панели + манифест в updates/. Потом его можно применить кнопкой «Применить».',
            body: `<form class="stack" id="build-form">
              <div class="field"><label>Новая версия (необязательно)</label><input class="input mono" name="bump" placeholder="например 1.0.1 — пусто = текущая" /></div>
              <div class="field"><label>Канал</label><select class="select" name="channel"><option value="">текущий</option><option>stable</option><option>beta</option><option>dev</option></select></div>
              <div class="field"><label>Описание изменений</label><textarea class="textarea" name="notes" rows="3" placeholder="что нового в этой версии"></textarea></div>
            </form>`,
            footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" id="build-ok">${icon('package', 14)} Собрать</button>`,
            onMount: (overlay, close) => {
              overlay.querySelector('#build-ok').addEventListener('click', async () => {
                const v = serializeForm(overlay.querySelector('#build-form'));
                try {
                  const res = await api.post('/api/update/build', { bump: v.bump || '', notes: v.notes || '', channel: v.channel || '' });
                  toast('Пакет собран', `${res.file} · ${fmtBytes(res.size)} · ${res.files} файлов`, 'ok', 7000);
                  close();
                  ctx.refresh();
                } catch (err) { toast('Ошибка сборки', err.message, 'err'); }
              });
            },
          });
        });
      }

      const restartBtn = root.querySelector('#restart-panel');
      if (restartBtn) {
        restartBtn.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: 'Перезапустить панель?',
            text: 'Процесс панели завершится и стартует заново. Если панель запущена без супервизора (systemd/pm2), её нужно будет запустить вручную: node server.js. Открытые вкладки переподключатся сами.',
            confirmText: 'Перезапустить',
          });
          if (!ok) return;
          try {
            await api.post('/api/update/restart');
            toast('Перезапуск…', 'Панель перезапускается, обновите страницу через несколько секунд', 'info', 7000);
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      }

      root.querySelectorAll('[data-del-pkg]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: 'Удалить пакет?',
            text: `Файл updates/${btn.dataset.delPkg} будет удалён с диска.`,
            confirmText: 'Удалить',
            danger: true,
          });
          if (!ok) return;
          try {
            await api.del(`/api/update/packages/${encodeURIComponent(btn.dataset.delPkg)}`);
            toast('Пакет удалён', btn.dataset.delPkg, 'ok');
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      });

      root.querySelectorAll('[data-apply]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: 'Применить обновление?',
            text: `Пакет ${btn.dataset.apply} заменит файлы панели. Сначала будет создан бэкап кода.`,
            confirmText: 'Применить',
          });
          if (!ok) return;
          try {
            const res = await api.post('/api/update/from-file', { file: btn.dataset.apply });
            toast('Обновление применено', res.message, 'ok', 7000);
            setTimeout(() => window.location.reload(), 1200);
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      });

      const drop = root.querySelector('#update-drop');
      const input = root.querySelector('#update-file');
      const send = async (file) => {
        if (!file) return;
        try {
          const res = await api.upload('/api/update/upload', file, file.name);
          toast('Обновление применено', res.message, 'ok', 7000);
          setTimeout(() => window.location.reload(), 1200);
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      };
      drop.addEventListener('click', () => input.click());
      input.addEventListener('change', () => send(input.files[0]));
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        send(e.dataTransfer.files[0]);
      });
      return () => { };
    },
    title: 'Обновления',
  };
}

/* ═════════════════════════════ настройки ═════════════════════════════ */

export async function settingsView(ctx) {
  const data = await api.get('/api/settings');
  const s = data.settings;
  const accents = ['#ffffff', '#d4d4d4', '#a3a3a3', '#737373', '#262626', '#000000', '#e5e5e5'];

  const html = `
  <div class="page">
    <div class="page-head">
      <div><div class="eyebrow">конфигурация</div><h1>Настройки панели</h1>
        <p class="sub">Имя, регистрация, лимиты по умолчанию, сроки, безопасность и канал обновлений.</p></div>
      <div class="page-actions"><span class="chip mono">v${esc(data.version)}</span></div>
    </div>
    <form class="stack" id="settings-form">
      <div class="grid split-even">
        <div class="form-section">
          <h3>Общие</h3>
          <p class="hint">Так панель выглядит в шапке и на экране входа.</p>
          <div class="stack">
            <div class="field"><label>Название панели</label><input class="input" name="panelName" value="${esc(s.panelName)}" /></div>
            <div class="field"><label>Компания / бренд</label><input class="input" name="company" value="${esc(s.company)}" /></div>
            <div class="field"><label>Сообщение для пользователей</label><textarea class="textarea" name="motd" rows="2" placeholder="например: плановые работы в воскресенье">${esc(s.motd || '')}</textarea></div>
          </div>
        </div>

        <div class="form-section">
          <h3>Доступ</h3>
          <p class="hint">Регистрация и лимиты для новых аккаунтов.</p>
          <div class="stack">
            <label class="switch"><input type="checkbox" name="registrationOpen" ${s.registrationOpen ? 'checked' : ''}/><span class="track"></span><span class="switch-text">Открытая регистрация</span></label>
            <div class="field"><label>Время жизни сессии</label>
              <div class="input-group"><input class="input" type="number" name="sessionTtlHours" value="${s.sessionTtlHours}" min="1" /><span class="input-suffix">часов</span></div>
            </div>
            <div class="label" style="margin-top:4px">Лимиты по умолчанию</div>
            <div class="form-grid">
              ${LIMIT_FIELDS.map(([key, label, unit]) => `<div class="field"><label>${label}</label><div class="input-group"><input class="input" type="number" name="def_${key}" value="${s.defaultLimits[key]}" min="0" /><span class="input-suffix">${unit}</span></div></div>`).join('')}
            </div>
          </div>
        </div>

        <div class="form-section">
          <h3>Сроки аренды</h3>
          <p class="hint">Автоматическая приостановка и напоминания.</p>
          <div class="stack">
            <div class="field"><label>Срок нового сервера</label>
              <div class="input-group"><input class="input" type="number" name="expiryDays" value="${s.expiryDays}" /><span class="input-suffix">дней</span></div>
            </div>
            <div class="field"><label>Напоминать за</label>
              <div class="input-group"><input class="input" type="number" name="warnBeforeExpiryDays" value="${s.warnBeforeExpiryDays}" /><span class="input-suffix">дней</span></div>
            </div>
            <label class="switch"><input type="checkbox" name="autoSuspendExpired" ${s.autoSuspendExpired ? 'checked' : ''}/><span class="track"></span><span class="switch-text">Приостанавливать истёкшие серверы</span></label>
            <div class="notice">${icon('info', 16)}<div>Проверка сроков — каждые 20 секунд. При истечении процесс останавливается, консоль блокируется до продления.</div></div>
          </div>
        </div>

        <div class="form-section">
          <h3>Обновления и вид</h3>
          <p class="hint">Автообновление интерфейса и акцентный цвет.</p>
          <div class="stack">
            <label class="switch"><input type="checkbox" name="devAutoReload" ${s.devAutoReload ? 'checked' : ''}/><span class="track"></span><span class="switch-text">Автоперезагрузка при изменении файлов</span></label>
            <label class="switch"><input type="checkbox" name="compact" ${s.compact ? 'checked' : ''}/><span class="track"></span><span class="switch-text">Компактные таблицы</span></label>
            <div class="field"><label>Канал обновлений (URL манифеста)</label><input class="input mono" name="updateUrl" value="${esc(s.updateUrl || '')}" placeholder="пусто = updates/update.json" /></div>
            <div class="field"><label>Канал</label><select class="select" name="updateChannel">${['stable', 'beta', 'dev'].map((c) => `<option ${s.updateChannel === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
            <div class="field"><label>Акцент</label>
              <div class="row wrap" style="gap:6px">
                ${accents.map((c) => `<button type="button" class="icon-btn" data-accent="${c}" style="width:26px;height:26px;border-radius:8px;background:${c};border:2px solid ${s.accent === c ? '#fff' : 'transparent'}"></button>`).join('')}
                <input class="input mono" name="accent" value="${esc(s.accent)}" style="width:110px" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="row">
        <button class="btn primary" type="submit">${icon('save', 15)} Сохранить настройки</button>
        <span class="hint">Некоторые изменения применяются сразу, другие — после перезагрузки интерфейса.</span>
      </div>
    </form>
  </div>`;

  return {
    html,
    mount(root) {
      root.querySelectorAll('[data-accent]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const input = root.querySelector('input[name="accent"]');
          input.value = btn.dataset.accent;
          root.querySelectorAll('[data-accent]').forEach((b) => { b.style.borderColor = 'transparent'; });
          btn.style.borderColor = '#fff';
        });
      });

      const form = root.querySelector('#settings-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = serializeForm(form);
        const defaultLimits = {};
        for (const [key] of LIMIT_FIELDS) defaultLimits[key] = v[`def_${key}`];
        try {
          const res = await api.patch('/api/settings', {
            panelName: v.panelName,
            company: v.company,
            motd: v.motd,
            registrationOpen: v.registrationOpen,
            sessionTtlHours: v.sessionTtlHours,
            expiryDays: v.expiryDays,
            warnBeforeExpiryDays: v.warnBeforeExpiryDays,
            autoSuspendExpired: v.autoSuspendExpired,
            devAutoReload: v.devAutoReload,
            compact: v.compact,
            updateUrl: v.updateUrl,
            updateChannel: v.updateChannel,
            accent: v.accent,
            defaultLimits,
          });
          toast('Настройки сохранены', '', 'ok');
          ctx.applySettings && ctx.applySettings(res.settings);
          ctx.refresh();
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });
      return () => { };
    },
    title: 'Настройки',
  };
}

/* ═════════════════════════════ профиль ═════════════════════════════ */

export async function profileView(ctx) {
  const me = await api.get('/api/auth/me');
  const keys = await api.get('/api/auth/keys');
  const serversData = await api.get('/api/servers');
  const myServers = serversData.servers || [];
  const user = me.user;

  const html = `
  <div class="page">
    <div class="page-head">
      <div><div class="eyebrow">аккаунт</div><h1>Профиль</h1><p class="sub">Данные аккаунта, пароль, API-ключи и подключённые серверы.</p></div>
      <div class="page-actions"><span class="tag ${user.role}">${user.role === 'admin' ? 'администратор' : 'пользователь'}</span></div>
    </div>
    <div class="grid split">
      <div class="stack">
        <div class="card">
          <div class="card-body stack">
            <div class="row" style="gap:14px">
              ${avatar(user, 'lg')}
              <div class="grow">
                <div style="font-size:18px;font-weight:640">${esc(user.username)}</div>
                <div class="tiny dim">${esc(user.email || 'e-mail не указан')} · создан ${fmtDateTime(user.createdAt)}</div>
                <div class="row tiny dim" style="margin-top:6px;gap:8px">
                  <span>последний вход: ${user.lastLoginAt ? timeAgo(user.lastLoginAt) : '—'}</span>
                  ${user.suspended ? '<span class="tag suspended">заблокирован</span>' : ''}
                </div>
              </div>
            </div>
            <div>
              <div class="label" style="margin-bottom:8px">Аватар</div>
              <div class="row wrap" style="gap:6px">
                ${['#262626', '#404040', '#595959', '#737373', '#8c8c8c', '#a6a6a6', '#ffffff'].map((c) => `<button type="button" class="icon-btn" data-avatar-color="${c}" title="${c}" style="width:26px;height:26px;border-radius:3px;background:${c};border:2px solid ${user.avatarColor === c ? '#fff' : 'transparent'}"></button>`).join('')}
              </div>
              <div class="row wrap" style="gap:8px;margin-top:10px">
                <label class="btn sm" for="avatar-file" style="cursor:pointer">${icon('image', 13)} Загрузить картинку</label>
                <input type="file" id="avatar-file" accept="image/*" hidden />
                ${user.avatarImage ? '<button class="btn sm ghost danger" type="button" id="avatar-remove">Убрать картинку</button>' : ''}
              </div>
              <div class="hint" style="margin-top:6px">Картинка до 2 МБ. Без картинки — цветной квадрат с инициалами.</div>
            </div>
          </div>
        </div>

        <form class="card" id="profile-form">
          <div class="card-head"><div class="panel-title">${icon('user', 15)} Данные аккаунта</div></div>
          <div class="card-body stack">
            <div class="field"><label>E-mail</label><input class="input" name="email" value="${esc(user.email || '')}" /></div>
            <div class="row"><button class="btn primary" type="submit">${icon('save', 14)} Сохранить</button></div>
          </div>
        </form>

        <form class="card" id="password-form">
          <div class="card-head"><div class="panel-title">${icon('lock', 15)} Смена пароля</div></div>
          <div class="card-body stack">
            <div class="form-grid">
              <div class="field"><label>Текущий пароль</label><input class="input" type="password" name="currentPassword" autocomplete="current-password" /></div>
              <div class="field"><label>Новый пароль</label><input class="input" type="password" name="newPassword" autocomplete="new-password" /></div>
            </div>
            <div class="row"><button class="btn primary" type="submit">${icon('key', 14)} Изменить пароль</button><span class="hint">Остальные сессии будут завершены.</span></div>
          </div>
        </form>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div class="panel-title">${icon('key', 15)} API-ключи</div><button class="btn sm primary" id="add-key">${icon('plus', 13)} Создать</button></div>
          <div class="card-body stack">
            ${keys.keys.length ? keys.keys.map((k) => `
              <div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)">
                <span class="timeline-dot">${icon('key', 13)}</span>
                <div class="grow" style="min-width:0"><div class="small">${esc(k.name)}</div><div class="tiny dim mono">${esc(k.prefix)}… · создан ${fmtDateTime(k.createdAt)}${k.lastUsedAt ? ` · использован ${timeAgo(k.lastUsedAt)}` : ''}</div></div>
                <button class="btn sm ghost danger" data-key-del="${k.id}">${icon('trash', 13)}</button>
              </div>`).join('') : `<div class="tiny dim">Ключей нет. API-ключ работает как <span class="mono">Authorization: Bearer …</span>.</div>`}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="panel-title">${icon('servers', 15)} Мои серверы</div><span class="chip">${myServers.length}</span></div>
          <div class="card-body stack">
            ${myServers.length ? myServers.map((s) => `
              <div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)">
                <div class="grow" style="min-width:0">
                  <div class="small"><b>${esc(s.name)}</b> ${s.isOwner ? '<span class="tag user">владелец</span>' : '<span class="tag user">доступ</span>'}</div>
                  <div class="tiny dim mono">${esc(s.limits.memory)} МБ · ${esc(Math.round(s.limits.disk / 1024))} ГБ · CPU ${esc(s.limits.cpu)}%${s.allocation ? ` · ${esc(s.allocation.label)}` : ''}</div>
                </div>
                ${statusPill(s.status)}
                <a class="btn sm ghost" href="#/servers/${s.id}/console">открыть ${icon('chevronRight', 12)}</a>
              </div>`).join('') : `<div class="tiny dim">Серверов нет. Попросите администратора выдать сервер.</div>`}
            <div class="tiny dim">Лимиты задаются на каждом сервере — вкладка «Настройки» сервера.</div>
          </div>
        </div>

        <div class="card pad">
          <div class="panel-title">${icon('logout', 15)} Сессия</div>
          <p class="tiny dim" style="margin-top:8px;line-height:1.6">Вход по cookie, HttpOnly + SameSite=Lax. Пароли — scrypt (N=16384). Ключи можно отозвать в любой момент.</p>
          <button class="btn sm danger" id="logout-btn" style="margin-top:12px">${icon('logout', 13)} Выйти из панели</button>
        </div>
      </div>
    </div>
  </div>`;

  return {
    html,
    mount(root) {
      root.querySelectorAll('[data-avatar-color]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api.patch('/api/auth/me', { avatarColor: btn.dataset.avatarColor, avatarImage: null });
            toast('Цвет аватара обновлён', '', 'ok');
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      });
      const avatarFile = root.querySelector('#avatar-file');
      if (avatarFile) avatarFile.addEventListener('change', async () => {
        try {
          const dataUrl = await fileToDataUrl(avatarFile.files[0]);
          await api.patch('/api/auth/me', { avatarImage: dataUrl });
          toast('Аватар обновлён', '', 'ok');
          ctx.refresh();
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });
      const avatarRemove = root.querySelector('#avatar-remove');
      if (avatarRemove) avatarRemove.addEventListener('click', async () => {
        try {
          await api.patch('/api/auth/me', { avatarImage: null });
          toast('Картинка убрана', '', 'ok');
          ctx.refresh();
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });

      root.querySelector('#profile-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api.patch('/api/auth/me', { email: root.querySelector('input[name="email"]').value });
          toast('Профиль обновлён', '', 'ok');
          ctx.refresh();
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });

      root.querySelector('#password-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        try {
          await api.patch('/api/auth/me', {
            currentPassword: form.currentPassword.value,
            newPassword: form.newPassword.value,
          });
          toast('Пароль изменён', 'Другие сессии завершены', 'ok');
          form.reset();
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });

      root.querySelector('#add-key').addEventListener('click', () => {
        modal({
          title: 'Новый API-ключ',
          subtitle: 'Ключ показывается один раз — сохраните его',
          slim: true,
          body: `<div class="field"><label>Название</label><input class="input" id="key-name" placeholder="CI / мониторинг" /></div>`,
          footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" id="key-ok">Создать</button>`,
          onMount: (overlay, close) => {
            overlay.querySelector('#key-name').focus();
            overlay.querySelector('#key-ok').addEventListener('click', async () => {
              try {
                const res = await api.post('/api/auth/keys', { name: overlay.querySelector('#key-name').value || 'API-ключ' });
                close();
                modal({
                  title: 'Ключ создан',
                  subtitle: 'Скопируйте его сейчас — повторно он не показывается',
                  body: `<div class="field"><label>Секрет</label><input class="input mono" readonly value="${esc(res.secret)}" /></div>`,
                  footer: `<button class="btn primary" id="key-copy">${icon('copy', 14)} Скопировать</button>`,
                  onMount: (o2, c2) => {
                    o2.querySelector('#key-copy').addEventListener('click', () => { copy(res.secret, 'Ключ скопирован'); c2(); ctx.refresh(); });
                  },
                });
              } catch (err) { toast('Ошибка', err.message, 'err'); }
            });
          },
        });
      });

      root.querySelectorAll('[data-key-del]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const ok = await confirmDialog({ title: 'Отозвать ключ?', text: 'Интеграции с этим ключом перестанут работать.', confirmText: 'Отозвать', danger: true });
          if (!ok) return;
          try {
            await api.del(`/api/auth/keys/${btn.dataset.keyDel}`);
            toast('Ключ отозван', '', 'ok');
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      });

      root.querySelector('#logout-btn').addEventListener('click', () => ctx.logout());
      return () => { };
    },
    title: 'Профиль',
  };
}
