// Вкладки сервера: бэкапы, переменные, доступы, расписание, настройки.
import { api } from './api.js';
import { icon } from './icons.js';
import {
  esc, fmtBytes, fmtMb, fmtDateTime, timeAgo, avatar, emptyState, modal, toast,
  confirmDialog, serializeForm, statusPill, meter,
} from './ui.js';

const permLabels = {
  console: 'Консоль и команды',
  control: 'Старт / стоп / рестарт',
  files: 'Файловый менеджер',
  backups: 'Резервные копии',
  startup: 'Переменные запуска',
  settings: 'Переименование и описание',
  users: 'Управление доступами',
  schedule: 'Расписание задач',
  allocations: 'Порты и аллокации',
};

/* ═════════════════════════════ бэкапы ═════════════════════════════ */

export async function backupsTab(ctx, data) {
  const server = data.server;
  const res = await api.get(`/api/servers/${server.id}/backups`);
  const backups = res.backups || [];
  const limit = res.limit || 0;

  const rows = backups.map((b) => `
    <div class="backup-row">
      <span class="backup-icon">${icon('archive', 15)}</span>
      <div class="grow" style="min-width:0">
        <div style="font-weight:560" class="ellipsis">${esc(b.name)}</div>
        <div class="tiny dim">${fmtDateTime(b.createdAt)} · ${b.sizeLabel || fmtBytes(b.size)} · ${esc(b.createdBy || 'system')}</div>
      </div>
      <span class="chip mono tiny">${b.sha256 ? esc(b.sha256.slice(0, 8)) : '—'}</span>
      <div class="row" style="gap:2px">
        <button class="btn sm ghost" title="Скачать" data-bk-download="${b.id}">${icon('download', 13)}</button>
        <button class="btn sm ghost" title="Восстановить" data-bk-restore="${b.id}">${icon('rotate', 13)}</button>
        <button class="btn sm ghost" title="Удалить" data-bk-delete="${b.id}">${icon('trash', 13)}</button>
      </div>
    </div>`).join('');

  const html = `
  <div class="stack">
    <div class="card">
      <div class="card-head">
        <div class="panel-title">${icon('backup', 15)} Резервные копии <span class="chip">${backups.length} / ${limit}</span></div>
        <div class="row">
          <span class="tiny dim">${server.status === 'running' ? 'Сервер работает — бэкап без остановки' : 'ZIP-архив каталога сервера'}</span>
          <button class="btn sm primary" id="backup-create">${icon('plus', 13)} Создать бэкап</button>
        </div>
      </div>
      ${backups.length ? rows : emptyState('backup', 'Бэкапов нет', 'Создайте первый бэкап — архив сохранится на диске панели и переживёт обновления.')}
    </div>
    <div class="notice">${icon('info', 16)}<div>Восстановление перезаписывает каталог сервера. Перед восстановлением сервер должен быть остановлен. Бэкапы хранятся в <span class="mono">data/backups/&lt;сервер&gt;/</span> и не затрагиваются обновлением панели.</div></div>
  </div>`;

  return {
    html,
    mount(root) {
      const refresh = () => ctx.refresh();
      root.querySelector('#backup-create').addEventListener('click', async () => {
        const close = modal({
          title: 'Новый бэкап',
          subtitle: 'Будет создан ZIP всего каталога сервера',
          slim: true,
          body: `<div class="field"><label>Название</label><input class="input" id="bk-name" value="Бэкап ${new Date().toLocaleString('ru-RU')}" /></div>`,
          footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" id="bk-ok">${icon('backup', 14)} Создать</button>`,
          onMount: (overlay, closeFn) => {
            const input = overlay.querySelector('#bk-name');
            input.focus();
            input.select();
            overlay.querySelector('#bk-ok').addEventListener('click', async () => {
              try {
                const backup = await api.post(`/api/servers/${server.id}/backups`, { name: input.value });
                toast('Бэкап создан', `${backup.name} · ${fmtBytes(backup.size)}`, 'ok');
                closeFn();
                ctx.refresh();
              } catch (err) { toast('Ошибка', err.message, 'err'); }
            });
          },
        });
        return close;
      });

      root.querySelectorAll('[data-bk-download]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const b = backups.find((x) => x.id === btn.dataset.bkDownload);
          api.download(`/api/servers/${server.id}/backups/${b.id}/download`, `${server.name}-${b.name}.zip`.replace(/[\\/:*?"<>|]/g, '_'))
            .catch((err) => toast('Ошибка', err.message, 'err'));
        });
      });

      root.querySelectorAll('[data-bk-restore]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const b = backups.find((x) => x.id === btn.dataset.bkRestore);
          if (server.status === 'running' || server.status === 'starting') {
            toast('Сервер запущен', 'Остановите сервер перед восстановлением', 'warn');
            return;
          }
          const ok = await confirmDialog({
            title: 'Восстановить бэкап?',
            text: `«${b.name}» перезапишет все файлы сервера. Текущее состояние будет потеряно.`,
            confirmText: 'Восстановить',
            danger: true,
          });
          if (!ok) return;
          try {
            const result = await api.post(`/api/servers/${server.id}/backups/${b.id}/restore`);
            toast('Бэкап восстановлен', `${result.files} файлов`, 'ok');
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      });

      root.querySelectorAll('[data-bk-delete]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const b = backups.find((x) => x.id === btn.dataset.bkDelete);
          const ok = await confirmDialog({ title: 'Удалить бэкап?', text: `«${b.name}» будет удалён с диска.`, confirmText: 'Удалить', danger: true });
          if (!ok) return;
          try {
            await api.del(`/api/servers/${server.id}/backups/${b.id}`);
            toast('Бэкап удалён', '', 'ok');
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      });

      return () => { };
    },
  };
}

/* ═════════════════════════════ переменные ═════════════════════════════ */

export function startupTab(ctx, data) {
  const server = data.server;
  const egg = data.egg || { variables: [], startup: '', config: {}, image: '' };
  const env = server.environment || {};
  const vars = egg.variables || [];

  const html = `
  <div class="grid split">
    <div class="stack">
      <form class="card" id="startup-form">
        <div class="card-head">
          <div class="panel-title">${icon('sliders', 15)} Переменные запуска</div>
          <span class="chip">${vars.length} переменных</span>
        </div>
        <div class="card-body stack">
          ${vars.length ? vars.map((v) => `
            <div class="field">
              <label>${esc(v.label || v.env)} <span class="mono dim" style="font-weight:400">${esc(v.env)}</span></label>
              <input class="input mono" name="env_${esc(v.env)}" value="${esc(env[v.env] !== undefined ? env[v.env] : v.default || '')}" ${v.userEditable === false && !server.isAdmin ? 'disabled' : ''} />
              ${v.rules && v.rules !== 'string' ? `<span class="hint">правило: ${esc(v.rules)}</span>` : ''}
            </div>`).join('') : `<div class="notice">${icon('info', 16)}<div>У этого шаблона нет переменных. Стартовую команду можно изменить ниже.</div></div>`}
          <div class="field">
            <label>Стартовая команда <span class="dim">— переопределение</span></label>
            <textarea class="textarea mono" name="startupOverride" rows="3" placeholder="${esc(egg.startup || '')}">${esc(server.startupOverride || '')}</textarea>
            <span class="hint">Оставьте пустым, чтобы использовать команду шаблона. Поддерживаются <span class="mono">{{PORT}}</span>, <span class="mono">{{MEMORY}}</span>, <span class="mono">{{SERVER_DIR}}</span>.</span>
          </div>
          <div class="row">
            <button class="btn primary" type="submit">${icon('save', 14)} Сохранить переменные</button>
            <span class="hint">Изменения применятся при следующем запуске.</span>
          </div>
        </div>
      </form>
    </div>
    <div class="stack">
      <div class="card">
        <div class="card-head"><div class="panel-title">${icon('code', 15)} Команда шаблона</div></div>
        <div class="card-body">
          <div class="code-block">${esc(egg.startup || '—')}</div>
          <dl class="kv" style="margin-top:14px">
            <dt>Контейнер</dt><dd class="mono tiny">${esc(egg.image || '—')}</dd>
            <dt>Стоп-команда</dt><dd class="mono tiny">${esc((egg.config && egg.config.stopCommand) || 'stop')}</dd>
            <dt>Таймаут</dt><dd class="mono tiny">${(egg.config && egg.config.stopTimeout) || 15} с</dd>
            <dt>Готовность</dt><dd class="mono tiny">${esc((egg.config && egg.config.readyRegex) || '—')}</dd>
          </dl>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div class="panel-title">${icon('terminal', 15)} Реальные переменные</div></div>
        <div class="card-body">
          <div class="code-block" style="max-height:210px">${esc([
            `PORT=${server.allocation ? server.allocation.port : ''}`,
            `MEMORY=${server.limits.memory}`,
            `SERVER_DIR=data/servers/${server.id}`,
            ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
          ].join('\n'))}</div>
        </div>
      </div>
    </div>
  </div>`;

  return {
    html,
    mount(root) {
      const form = root.querySelector('#startup-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const raw = serializeForm(form);
        const environment = {};
        Object.entries(raw).forEach(([k, v]) => {
          if (k.startsWith('env_')) environment[k.slice(4)] = v;
        });
        try {
          await api.post(`/api/servers/${server.id}/startup`, {
            environment,
            startupOverride: raw.startupOverride || null,
          });
          toast('Переменные сохранены', 'Применятся при следующем запуске', 'ok');
          ctx.refresh();
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });
      return () => { };
    },
  };
}

/* ═════════════════════════════ доступы ═════════════════════════════ */

export async function accessTab(ctx, data) {
  const server = data.server;
  const res = await api.get(`/api/servers/${server.id}/subusers`);
  const subusers = res.subusers || [];
  const allPerms = res.allPerms || Object.keys(permLabels);
  const users = res.users || [];
  const ownerId = server.owner && server.owner.id;
  const candidates = users.filter((u) => u.id !== ownerId && !subusers.some((s) => s.userId === u.id));

  const html = `
  <div class="stack">
    <div class="card">
      <div class="card-head">
        <div class="panel-title">${icon('users', 15)} Пользователи с доступом <span class="chip">${subusers.length}</span></div>
        ${server.permissions.includes('users') || server.isAdmin ? `<button class="btn sm primary" id="add-subuser" ${!candidates.length ? 'disabled' : ''}>${icon('plus', 13)} Выдать доступ</button>` : ''}
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Пользователь</th><th>Права</th><th>Выдан</th><th></th></tr></thead>
          <tbody>
            <tr>
              <td><div class="row">${avatar(server.owner)}<div><div class="bold">${esc((server.owner && server.owner.username) || '—')}</div><div class="tiny dim">владелец</div></div></div></td>
              <td><span class="pill accent">все права</span></td>
              <td class="tiny dim">${fmtDateTime(server.createdAt)}</td>
              <td></td>
            </tr>
            ${subusers.map((s) => `
              <tr>
                <td><div class="row">${avatar({ username: s.username })}<div><div class="bold">${esc(s.username)}</div><div class="tiny dim">${esc(s.email || '')}</div></div></div></td>
                <td><div class="row wrap" style="gap:4px">${s.perms.map((p) => `<span class="tag user">${esc(permLabels[p] || p)}</span>`).join('') || '<span class="dim tiny">нет прав</span>'}</div></td>
                <td class="tiny dim">${fmtDateTime(s.addedAt)}</td>
                <td class="right-cell"><button class="btn sm ghost danger" data-remove-sub="${s.userId}">${icon('trash', 13)}</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div class="grid split-even">
      <div class="card pad">
        <div class="panel-title">${icon('shield', 15)} Как это работает</div>
        <p class="tiny dim" style="margin-top:8px;line-height:1.65">Сабпользователь входит в панель под своим аккаунтом и видит сервер во вкладке «Серверы». Права выдаются по группам: консоль, питание, файлы, бэкапы, переменные, доступы, расписание. Владелец всегда имеет полный доступ.</p>
      </div>
      <div class="card pad">
        <div class="panel-title">${icon('key', 15)} Матрица прав</div>
        <div class="row wrap" style="gap:5px;margin-top:10px">
          ${allPerms.map((p) => `<span class="chip">${esc(permLabels[p] || p)}</span>`).join('')}
        </div>
      </div>
    </div>
  </div>`;

  return {
    html,
    mount(root) {
      const addBtn = root.querySelector('#add-subuser');
      if (addBtn) {
        addBtn.addEventListener('click', () => {
          modal({
            title: 'Выдать доступ к серверу',
            subtitle: server.name,
            body: `
              <div class="stack">
                <div class="field"><label>Пользователь</label>
                  <select class="select" id="su-user">${candidates.map((u) => `<option value="${u.id}">${esc(u.username)}</option>`).join('')}</select>
                </div>
                <div class="field"><label>Права</label>
                  <div class="stack sm">
                    ${allPerms.map((p) => `
                      <label class="check"><input type="checkbox" value="${p}" ${['console', 'control'].includes(p) ? 'checked' : ''} />
                        <span><span class="check-title">${esc(permLabels[p] || p)}</span><span class="check-desc mono">${p}</span></span>
                      </label>`).join('')}
                  </div>
                </div>
              </div>`,
            footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" id="su-ok">Выдать доступ</button>`,
            onMount: (overlay, close) => {
              overlay.querySelector('#su-ok').addEventListener('click', async () => {
                const userId = overlay.querySelector('#su-user').value;
                const perms = [...overlay.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
                if (!perms.length) { toast('Выберите права', 'Минимум одно право', 'warn'); return; }
                try {
                  await api.post(`/api/servers/${server.id}/subusers`, { userId, perms });
                  toast('Доступ выдан', '', 'ok');
                  close();
                  ctx.refresh();
                } catch (err) { toast('Ошибка', err.message, 'err'); }
              });
            },
          });
        });
      }

      root.querySelectorAll('[data-remove-sub]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const ok = await confirmDialog({ title: 'Отозвать доступ?', text: 'Пользователь потеряет доступ к серверу.', confirmText: 'Отозвать', danger: true });
          if (!ok) return;
          try {
            await api.del(`/api/servers/${server.id}/subusers/${btn.dataset.removeSub}`);
            toast('Доступ отозван', '', 'ok');
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      });
      return () => { };
    },
  };
}

/* ═════════════════════════════ расписание ═════════════════════════════ */

const ACTION_LABELS = {
  command: 'Команда в консоль',
  power_start: 'Запустить',
  power_stop: 'Остановить',
  power_restart: 'Перезапустить',
  backup: 'Создать бэкап',
};

function scheduleLabel(s = {}) {
  if (s.type === 'interval') return `каждые ${s.minutes} мин`;
  if (s.type === 'daily') return `ежедневно в ${s.time}`;
  if (s.type === 'once') return s.at ? `один раз ${fmtDateTime(s.at)}` : 'один раз';
  return '—';
}

export async function scheduleTab(ctx, data) {
  const server = data.server;
  const res = await api.get(`/api/servers/${server.id}/tasks`);
  const tasks = res.tasks || [];

  const html = `
  <div class="stack">
    <div class="card">
      <div class="card-head">
        <div class="panel-title">${icon('clock', 15)} Задачи по расписанию <span class="chip">${tasks.length}</span></div>
        <button class="btn sm primary" id="task-add">${icon('plus', 13)} Добавить задачу</button>
      </div>
      ${tasks.length ? tasks.map((t) => `
        <div class="task-row" data-task="${t.id}">
          <span class="timeline-dot">${icon(t.action === 'backup' ? 'backup' : t.action === 'command' ? 'terminal' : 'power', 13)}</span>
          <div class="grow" style="min-width:0">
            <div style="font-weight:560">${esc(t.name)}</div>
            <div class="tiny dim">${esc(ACTION_LABELS[t.action] || t.action)}${t.payload ? ` · <span class="mono">${esc(t.payload)}</span>` : ''} · ${esc(scheduleLabel(t.schedule))}</div>
            <div class="tiny dim">${t.lastRunAt ? `последний запуск ${timeAgo(t.lastRunAt)}` : 'ещё не запускалась'}${t.nextRunAt ? ` · следующий ${fmtDateTime(t.nextRunAt)}` : ''}${t.lastResult && t.lastResult !== 'ok' ? ` · <span style="color:#fda4af">${esc(t.lastResult)}</span>` : ''}</div>
          </div>
          <label class="switch" title="Включена"><input type="checkbox" data-task-toggle="${t.id}" ${t.enabled ? 'checked' : ''}/><span class="track"></span></label>
          <button class="btn sm ghost" data-task-run="${t.id}" title="Выполнить сейчас">${icon('play', 13)}</button>
          <button class="btn sm ghost" data-task-del="${t.id}" title="Удалить">${icon('trash', 13)}</button>
        </div>`).join('') : emptyState('clock', 'Задач нет', 'Настройте автоматический рестарт, бэкапы или команды по расписанию.')}
    </div>
    <div class="notice">${icon('info', 16)}<div>Планировщик проверяет задачи каждые 20 секунд. Время — локальное для панели. Включение и выключение задачи не удаляет её настройки.</div></div>
  </div>`;

  return {
    html,
    mount(root) {
      const refresh = () => ctx.refresh();

      root.querySelectorAll('[data-task-toggle]').forEach((cb) => {
        cb.addEventListener('change', async () => {
          try {
            await api.patch(`/api/servers/${server.id}/tasks/${cb.dataset.taskToggle}`, { enabled: cb.checked });
            toast(cb.checked ? 'Задача включена' : 'Задача выключена', '', 'ok', 1800);
            refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      });
      root.querySelectorAll('[data-task-run]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api.post(`/api/servers/${server.id}/tasks/${btn.dataset.taskRun}/run`);
            toast('Задача выполнена', '', 'ok');
            refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      });
      root.querySelectorAll('[data-task-del]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const ok = await confirmDialog({ title: 'Удалить задачу?', confirmText: 'Удалить', danger: true });
          if (!ok) return;
          try {
            await api.del(`/api/servers/${server.id}/tasks/${btn.dataset.taskDel}`);
            toast('Задача удалена', '', 'ok');
            refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      });

      root.querySelector('#task-add').addEventListener('click', () => {
        modal({
          title: 'Новая задача',
          subtitle: 'Действие выполнится автоматически по расписанию',
          wide: true,
          body: `<form class="stack" id="task-form">
            <div class="form-grid">
              <div class="field span-2"><label>Название</label><input class="input" name="name" value="Автобэкап" /></div>
              <div class="field"><label>Действие</label>
                <select class="select" name="action">${Object.entries(ACTION_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
              </div>
              <div class="field"><label>Параметр / команда</label><input class="input mono" name="payload" placeholder="say Сохранение…" /></div>
              <div class="field"><label>Тип расписания</label>
                <select class="select" name="type"><option value="interval">Интервал</option><option value="daily">Ежедневно</option><option value="once">Один раз</option></select>
              </div>
              <div class="field"><label>Каждые, минут</label><input class="input" type="number" name="minutes" value="360" min="1" /></div>
              <div class="field"><label>Время (HH:MM)</label><input class="input" name="time" value="04:00" /></div>
              <div class="field"><label>Один раз (дата и время)</label><input class="input" type="datetime-local" name="at" /></div>
            </div>
          </form>`,
          footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" id="task-ok">Создать</button>`,
          onMount: (overlay, close) => {
            overlay.querySelector('#task-ok').addEventListener('click', async () => {
              const values = serializeForm(overlay.querySelector('#task-form'));
              const payload = {
                name: values.name,
                action: values.action,
                payload: values.payload,
                schedule: {
                  type: values.type,
                  minutes: values.minutes,
                  time: values.time,
                  at: values.at ? new Date(values.at).getTime() : null,
                },
              };
              try {
                await api.post(`/api/servers/${server.id}/tasks`, payload);
                toast('Задача создана', '', 'ok');
                close();
                ctx.refresh();
              } catch (err) { toast('Ошибка', err.message, 'err'); }
            });
          },
        });
      });
      return () => { };
    },
  };
}

/* ═════════════════════════════ настройки ═════════════════════════════ */

export async function settingsTab(ctx, data) {
  const server = data.server;
  const isAdmin = server.isAdmin;
  const ports = data.availablePorts || [];
  const assigned = server.allocations || [];
  let users = [];
  if (isAdmin) {
    try { users = (await api.get('/api/users')).users; } catch { users = []; }
  }

  const html = `
  <div class="stack">
    <div class="grid split-even">
      <form class="card" id="general-form">
        <div class="card-head"><div class="panel-title">${icon('settings', 15)} Основное</div></div>
        <div class="card-body stack">
          <div class="field"><label>Название</label><input class="input" name="name" value="${esc(server.name)}" /></div>
          <div class="field"><label>Описание</label><textarea class="textarea" name="description" rows="2">${esc(server.description || '')}</textarea></div>
          <div class="field"><label>Заметки для админа</label><textarea class="textarea" name="notes" rows="3" placeholder="внутренние заметки">${esc(server.notes || '')}</textarea></div>
          <label class="switch"><input type="checkbox" name="autoStart" ${server.autoStart ? 'checked' : ''}/><span class="track"></span><span class="switch-text">Автозапуск при старте панели</span></label>
          <div class="row"><button class="btn primary" type="submit">${icon('save', 14)} Сохранить</button></div>
        </div>
      </form>

      <div class="card">
        <div class="card-head"><div class="panel-title">${icon('network', 15)} Порты и аллокации</div><span class="chip">${assigned.length} / ${(ctx.me.limits && ctx.me.limits.ports) || 2}</span></div>
        <div class="card-body stack">
          ${assigned.map((a) => `
            <div class="row" style="padding:8px 10px;border:1px solid var(--line);border-radius:9px">
              <span class="mono">${esc(a.ip)}:${esc(a.port)}</span>
              ${a.primary ? '<span class="pill accent" style="height:20px">основной</span>' : ''}
              <span class="right row" style="gap:4px">
                ${!a.primary ? `<button class="btn sm ghost" data-port-primary="${a.id}" title="Сделать основным">${icon('flag', 13)}</button>` : ''}
                ${!a.primary ? `<button class="btn sm ghost danger" data-port-remove="${a.id}" title="Освободить">${icon('x', 13)}</button>` : ''}
              </span>
            </div>`).join('')}
          <div class="row">
            <select class="select" id="port-select" style="flex:1" ${ports.filter((p) => !p.assigned).length ? '' : 'disabled'}>
              ${ports.filter((p) => !p.assigned).map((p) => `<option value="${p.id}">${esc(p.ip)}:${esc(p.port)}</option>`).join('') || '<option>Свободных портов нет</option>'}
            </select>
            <button class="btn" id="port-add" ${ports.filter((p) => !p.assigned).length ? '' : 'disabled'}>${icon('plus', 14)} Добавить</button>
          </div>
          <div class="hint">Основной порт задаёт переменную <span class="mono">{{PORT}}</span> в команде запуска. Дополнительные порты — для плагинов, RCON и веб-панелей.</div>
        </div>
      </div>
    </div>

    ${isAdmin ? `
    <div class="grid split-even">
      <form class="card" id="limits-form">
        <div class="card-head"><div class="panel-title">${icon('sliders', 15)} Лимиты ресурсов</div><span class="chip">админ</span></div>
        <div class="card-body stack">
          <div class="form-grid">
            <div class="field"><label>Память (МБ)</label><input class="input" type="number" name="memory" value="${server.limits.memory}" min="128" step="128" /></div>
            <div class="field"><label>Диск (МБ)</label><input class="input" type="number" name="disk" value="${server.limits.disk}" min="64" step="256" /></div>
            <div class="field"><label>CPU (%)</label><input class="input" type="number" name="cpu" value="${server.limits.cpu}" min="5" max="1600" step="5" /></div>
            <div class="field"><label>Срок аренды</label>
              <div class="input-group"><input class="input" type="number" name="expiresDays" placeholder="+ дней" min="1" /><span class="input-suffix">дней</span></div>
            </div>
          </div>
          <div class="row wrap">
            <button class="btn primary" type="submit">${icon('save', 14)} Сохранить</button>
            <button class="btn" type="button" id="renew-30">${icon('calendar', 14)} Продлить на 30 дней</button>
            <button class="btn" type="button" id="renew-90">${icon('calendar', 14)} +90 дней</button>
          </div>
          <div class="hint">Срок: ${server.expiresAt ? `до ${fmtDateTime(server.expiresAt)} (${server.daysLeft} дн)` : 'бессрочно'}.</div>
        </div>
      </form>

      <div class="card">
        <div class="card-head"><div class="panel-title">${icon('shield', 15)} Административные действия</div></div>
        <div class="card-body stack">
          <div class="row wrap">
            ${server.suspended
              ? `<button class="btn success" id="unsuspend">${icon('check', 14)} Разблокировать</button>`
              : `<button class="btn danger" id="suspend">${icon('lock', 14)} Приостановить</button>`}
            <button class="btn" id="transfer">${icon('users', 14)} Передать владельцу</button>
          </div>
          <hr />
          <div class="field"><label>Владелец</label>
            <div class="row">${avatar(server.owner)} <b>${esc((server.owner && server.owner.username) || '—')}</b></div>
          </div>
          <div class="notice warn">${icon('alert', 16)}<div><b>Опасная зона.</b> Удаление сервера остановит процесс и удалит файлы, бэкапы и доступы без возможности восстановления.</div></div>
          <button class="btn danger" id="delete-server">${icon('trash', 14)} Удалить сервер</button>
        </div>
      </div>
    </div>` : ''}
  </div>`;

  return {
    html,
    mount(root) {
      const general = root.querySelector('#general-form');
      general.addEventListener('submit', async (e) => {
        e.preventDefault();
        const values = serializeForm(general);
        try {
          await api.patch(`/api/servers/${server.id}`, {
            name: values.name, description: values.description, notes: values.notes, autoStart: !!values.autoStart,
          });
          toast('Сохранено', 'Настройки сервера обновлены', 'ok');
          ctx.refresh();
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });

      const portAdd = root.querySelector('#port-add');
      if (portAdd) {
        portAdd.addEventListener('click', async () => {
          const select = root.querySelector('#port-select');
          try {
            await api.post(`/api/servers/${server.id}/allocations`, { allocationId: select.value });
            toast('Порт добавлен', '', 'ok');
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      }
      root.querySelectorAll('[data-port-primary]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api.post(`/api/servers/${server.id}/allocations`, { allocationId: btn.dataset.portPrimary, primary: true });
            toast('Основной порт обновлён', '', 'ok');
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      });
      root.querySelectorAll('[data-port-remove]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api.del(`/api/servers/${server.id}/allocations/${btn.dataset.portRemove}`);
            toast('Порт освобождён', '', 'ok');
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      });

      if (!isAdmin) return () => { };

      const limitsForm = root.querySelector('#limits-form');
      limitsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const values = serializeForm(limitsForm);
        try {
          if (values.expiresDays) {
            await api.patch(`/api/servers/${server.id}`, { expiresDays: values.expiresDays });
          }
          await api.patch(`/api/servers/${server.id}`, {
            limits: { memory: values.memory, disk: values.disk, cpu: values.cpu },
          });
          toast('Лимиты сохранены', '', 'ok');
          ctx.refresh();
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });

      root.querySelector('#renew-30').addEventListener('click', async () => {
        try {
          await api.post(`/api/servers/${server.id}/renew`, { days: 30 });
          toast('Продлено на 30 дней', '', 'ok');
          ctx.refresh();
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });
      root.querySelector('#renew-90').addEventListener('click', async () => {
        try {
          await api.post(`/api/servers/${server.id}/renew`, { days: 90 });
          toast('Продлено на 90 дней', '', 'ok');
          ctx.refresh();
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });

      const suspendBtn = root.querySelector('#suspend');
      if (suspendBtn) {
        suspendBtn.addEventListener('click', async () => {
          const ok = await confirmDialog({ title: 'Приостановить сервер?', text: 'Процесс будет остановлен, доступ к консоли заблокирован.', confirmText: 'Приостановить', danger: true });
          if (!ok) return;
          try {
            await api.post(`/api/servers/${server.id}/suspend`, { reason: 'manual' });
            toast('Сервер приостановлен', '', 'ok');
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      }
      const unsuspendBtn = root.querySelector('#unsuspend');
      if (unsuspendBtn) {
        unsuspendBtn.addEventListener('click', async () => {
          try {
            await api.post(`/api/servers/${server.id}/unsuspend`);
            toast('Сервер разблокирован', '', 'ok');
            ctx.refresh();
          } catch (err) { toast('Ошибка', err.message, 'err'); }
        });
      }

      root.querySelector('#transfer').addEventListener('click', () => {
        modal({
          title: 'Передать сервер',
          subtitle: 'Сервер перейдёт другому пользователю вместе с файлами и доступами',
          body: `<div class="field"><label>Новый владелец</label><select class="select" id="transfer-user">
            ${users.filter((u) => u.id !== (server.owner && server.owner.id)).map((u) => `<option value="${u.id}">${esc(u.username)} · ${esc(u.role)}</option>`).join('')}
          </select></div>`,
          footer: `<button class="btn" data-close>Отмена</button><button class="btn primary" id="transfer-ok">Передать</button>`,
          onMount: (overlay, close) => {
            overlay.querySelector('#transfer-ok').addEventListener('click', async () => {
              try {
                await api.post(`/api/servers/${server.id}/transfer`, { userId: overlay.querySelector('#transfer-user').value });
                toast('Сервер передан', '', 'ok');
                close();
                ctx.refresh();
              } catch (err) { toast('Ошибка', err.message, 'err'); }
            });
          },
        });
      });

      root.querySelector('#delete-server').addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: `Удалить «${server.name}»?`,
          text: 'Процесс будет убит, файлы, бэкапы и доступы — удалены. Отменить это нельзя.',
          confirmText: 'Удалить навсегда',
          danger: true,
        });
        if (!ok) return;
        try {
          await api.del(`/api/servers/${server.id}`);
          toast('Сервер удалён', '', 'ok');
          window.location.hash = '#/servers';
        } catch (err) { toast('Ошибка', err.message, 'err'); }
      });

      return () => { };
    },
  };
}
