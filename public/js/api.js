// Тонкая обёртка над fetch: JSON, ошибки, загрузка файлов.
const BASE = '';

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function parse(res) {
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    const text = await res.text();
    throw new ApiError(text.slice(0, 300) || `HTTP ${res.status}`, res.status, 'NOT_JSON');
  }
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new ApiError(data.error || `HTTP ${res.status}`, res.status, data.code);
  }
  return data.data;
}

function qs(params) {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

export const api = {
  get: (path, params) => fetch(BASE + path + qs(params), { credentials: 'same-origin' }).then(parse),
  post: (path, body) => fetch(BASE + path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(parse),
  patch: (path, body) => fetch(BASE + path, {
    method: 'PATCH', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(parse),
  put: (path, body) => fetch(BASE + path, {
    method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(parse),
  del: (path) => fetch(BASE + path, { method: 'DELETE', credentials: 'same-origin' }).then(parse),
  upload: (path, blob, filename, dir = '') => fetch(BASE + path + qs({ name: filename, path: dir }), {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
  }).then(parse),
  async download(path, filename) {
    const res = await fetch(BASE + path, { credentials: 'same-origin' });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try { const j = await res.json(); message = j.error || message; } catch { /* ignore */ }
      throw new ApiError(message, res.status);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },
};
