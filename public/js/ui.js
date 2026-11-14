// UI-кит OmniDash: форматирование, тосты, модалки, бейджи, ANSI.
import { icon } from './icons.js';

export const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const fmtBytes = (bytes) => {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
};

export const fmtMb = (mb) => {
  const n = Number(mb) || 0;
  return n >= 1024 ? `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)} ГБ` : `${n} МБ`;
};

export const fmtDuration = (ms) => {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}д ${h}ч`;
  if (h) return `${h}ч ${m}м`;
  if (m) return `${m}м ${sec}с`;
  return `${sec}с`;
};

export const fmtNum = (n) => new Intl.NumberFormat('ru-RU').format(Number(n) || 0);
export const fmtPct = (n) => `${(Number(n) || 0).toFixed(Number(n) % 1 === 0 ? 0 : 1)}%`;

export const fmtDate = (value, opts = {}) => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric', ...opts });
};

export const fmtDateTime = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
};

export const timeAgo = (value) => {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 0) return 'скоро';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} дн назад`;
  return fmtDate(value);
};

export const daysLabel = (days) => {
  if (days === null || days === undefined) return 'бессрочно';
  if (days < 0) return `просрочен на ${Math.abs(days)} дн`;
  if (days === 0) return 'истекает сегодня';
  return `${days} дн`;
};

const STATUS_LABELS = {
  running: 'работает',
  starting: 'запускается',
  stopping: 'останавливается',
  offline: 'остановлен',
  crashed: 'ошибка',
  suspended: 'приостановлен',
};

export const statusLabel = (status) => STATUS_LABELS[status] || status || 'неизвестно';

export const statusPill = (status) => {
  const s = ['running', 'starting', 'stopping', 'offline', 'crashed', 'suspended'].includes(status) ? status : 'offline';
  return `<span class="pill ${s}"><i></i>${statusLabel(s)}</span>`;
};

export const avatar = (user, size = '') => {
  const name = (user && (user.username || user.name)) || '?';
  const img = user && user.avatarImage;
  if (img) return `<span class="avatar ${size} has-img"><img src="${esc(img)}" alt="" /></span>`;
  return `<span class="avatar ${size}">${esc(name.slice(0, 2))}</span>`;
};

export const emptyState = (iconName, title, text, action = '') => `
  <div class="empty">
    ${icon(iconName, 34)}
    <h3>${esc(title)}</h3>
    <p>${text}</p>
    ${action}
  </div>`;

export const meter = (percent, tone = '') => {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  return `<div class="meter ${tone}"><i style="width:${clamped}%"></i></div>`;
};

/* ───────────────────────────── тосты ───────────────────────────── */
function toastHost() {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    document.body.appendChild(host);
  }
  return host;
}

const TOAST_ICONS = { ok: 'check', err: 'alert', info: 'info', warn: 'alert' };

export function toast(title, text = '', kind = 'ok', timeout = 4200) {
  try { window.dispatchEvent(new CustomEvent('od:sound', { detail: kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : 'nav' })); } catch { /* ignore */ }
  const host = toastHost();
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `
    <span class="t-icon">${icon(TOAST_ICONS[kind] || 'info', 12)}</span>
    <div class="t-body">
      <div class="t-title">${esc(title)}</div>
      ${text ? `<div class="t-text">${esc(text)}</div>` : ''}
    </div>
    <button class="close" aria-label="Закрыть">${icon('x', 13)}</button>`;
  host.appendChild(el);
  const remove = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };
  el.querySelector('.close').addEventListener('click', remove);
  if (timeout) setTimeout(remove, timeout);
  return remove;
}

/* ───────────────────────────── модалки ───────────────────────────── */
const activeModals = [];

export function closeTopModal() {
  const m = activeModals[activeModals.length - 1];
  if (m) m();
}

export function modal({ title, subtitle = '', body = '', footer = '', wide = false, slim = false, onMount, onClose }) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''} ${slim ? 'slim' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div class="grow">
          <h3>${esc(title)}</h3>
          ${subtitle ? `<p>${subtitle}</p>` : ''}
        </div>
        <button class="icon-btn" data-close aria-label="Закрыть">${icon('x', 16)}</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    const idx = activeModals.indexOf(close);
    if (idx >= 0) activeModals.splice(idx, 1);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && activeModals[activeModals.length - 1] === close) {
      e.stopPropagation();
      close();
    }
  };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  activeModals.push(close);
  if (onMount) setTimeout(() => onMount(overlay, close), 0);
  return close;
}

export function confirmDialog({ title, text = '', confirmText = 'Подтвердить', cancelText = 'Отмена', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const close = modal({
      title,
      subtitle: text,
      slim: true,
      body: '',
      footer: `
        <button class="btn" data-cancel>${esc(cancelText)}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(confirmText)}</button>`,
      onClose: () => { if (!settled) { settled = true; resolve(false); } },
      onMount: (overlay) => {
        overlay.querySelector('[data-ok]').addEventListener('click', () => {
          settled = true;
          resolve(true);
          close();
        });
        overlay.querySelector('[data-cancel]').addEventListener('click', () => {
          settled = true;
          resolve(false);
          close();
        });
        overlay.querySelector('[data-ok]').focus();
      },
    });
  });
}

export function formDialog({ title, subtitle, fields, submitText = 'Сохранить', wide = false, onSubmit, footerExtra = '' }) {
  const body = `<form class="stack" data-dialog-form>${fields}</form>`;
  let close;
  const footer = `<div class="left">${footerExtra}</div>
    <button class="btn" data-close>Отмена</button>
    <button class="btn primary" data-submit>${esc(submitText)}</button>`;
  close = modal({
    title, subtitle, wide, body, footer,
    onMount: (overlay) => {
      const form = overlay.querySelector('[data-dialog-form]');
      const submit = async () => {
        const btn = overlay.querySelector('[data-submit]');
        if (btn.disabled) return;
        btn.disabled = true;
        const data = serializeForm(form);
        try {
          await onSubmit(data, overlay);
          close();
        } catch (err) {
          toast('Не удалось сохранить', err.message, 'err');
          btn.disabled = false;
        }
      };
      overlay.querySelector('[data-submit]').addEventListener('click', submit);
      form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    },
  });
  return close;
}

export function serializeForm(form) {
  const out = {};
  if (!form) return out;
  for (const el of form.querySelectorAll('input, select, textarea')) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

export function copy(text, message = 'Скопировано') {
  const done = () => toast(message, '', 'ok', 1800);
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallback());
  } else fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { /* ignore */ }
    ta.remove();
  }
}

export const debounce = (fn, wait = 250) => {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
};

/* ───────────────────────────── ANSI → HTML ───────────────────────────── */
const ANSI_RE = /\u001b\[([0-9;]*)m/g;

export function ansiToHtml(input) {
  const text = String(input ?? '');
  let out = '';
  let open = 0;
  let last = 0;
  let match;
  ANSI_RE.lastIndex = 0;
  const pushText = (chunk) => {
    if (!chunk) return;
    out += esc(chunk);
  };
  while ((match = ANSI_RE.exec(text))) {
    pushText(text.slice(last, match.index));
    last = ANSI_RE.lastIndex;
    const codes = (match[1] || '0').split(';').filter(Boolean).map(Number);
    if (!codes.length || codes.includes(0)) {
      if (open) { out += '</span>'; open = 0; }
      continue;
    }
    for (const code of codes) {
      if (code === 1) { out += '<span class="ansi-bold">'; open += 1; }
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        out += `<span class="ansi-${code}">`;
        open += 1;
      }
    }
  }
  pushText(text.slice(last));
  out += '</span>'.repeat(open);
  return out;
}

/* ───────────────────────────── иконки действий ───────────────────────────── */
export const powerButtons = (server, compact = false) => {
  const running = ['running', 'starting'].includes(server.status);
  const busy = ['starting', 'stopping'].includes(server.status);
  return `<div class="power-btns">
    <button class="play" data-power="start" title="Запустить" ${running || server.suspended ? 'disabled' : ''}>${icon('play', 12)}</button>
    <button data-power="restart" title="Перезапустить" ${!running || busy || server.suspended ? 'disabled' : ''}>${icon('restart', 12)}</button>
    <button class="stop" data-power="stop" title="Остановить" ${!running || server.suspended ? 'disabled' : ''}>${icon('stop', 12)}</button>
    ${compact ? '' : `<button data-power="kill" title="Принудительно убить" ${!running || server.suspended ? 'disabled' : ''}>${icon('power', 12)}</button>`}
  </div>`;
};

export const expiryChip = (days) => {
  if (days === null || days === undefined) return `<span class="chip expiry-chip">${icon('calendar', 12)}<span>бессрочно</span></span>`;
  const tone = days < 0 ? 'rose' : days <= 5 ? 'amber' : '';
  return `<span class="chip expiry-chip ${tone}" title="Срок аренды">${icon('calendar', 12)}<span>${days < 0 ? `просрочен` : `осталось ${days} дн`}</span></span>`;
};

export const fileToDataUrl = (file, maxBytes = 8 * 1024 * 1024) => new Promise((resolve, reject) => {
  if (!file) return reject(new Error('Файл не выбран'));
  if (file.size > maxBytes) return reject(new Error(`Файл слишком большой (макс. ${Math.round(maxBytes / 1024 / 1024)} МБ)`));
  if (!String(file.type || '').startsWith('image/')) return reject(new Error('Нужна картинка (png, jpg, webp)'));
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('Не удалось прочитать картинку'));
    img.src = reader.result;
  };
  reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
  reader.readAsDataURL(file);
});

export const serverIcon = (server, cls = '') => {
  const img = server && server.avatarImage;
  if (img) return `<span class="server-icon has-img ${cls}"><img src="${esc(img)}" alt="" /></span>`;
  return `<span class="server-icon ${cls}">${icon('server', 19)}</span>`;
};

export const copyBtn = (text, label = '') => `<button class="btn sm ghost" data-copy="${esc(text)}">${icon('copy', 13)}${label ? esc(label) : ''}</button>`;

export function setPageTitle(title, meta) {
  document.title = title ? `${title} · ${meta?.name || 'OmniDash'}` : 'OmniDash';
}

export function openExternal(url) {
  window.open(url, '_blank', 'noopener');
}
