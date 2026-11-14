// Графики OmniDash на canvas: аккуратные, без библиотек, с живым тултипом.
import { fmtBytes, fmtDuration } from './ui.js';

const DPR = () => Math.min(window.devicePixelRatio || 1, 2);

function niceMax(value) {
  if (!value || value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  const norm = value / pow;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * pow;
}

function pathSmooth(ctx, points) {
  if (!points.length) return;
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const cx = (p0.x + p1.x) / 2;
    ctx.bezierCurveTo(cx, p0.y, cx, p1.y, p1.x, p1.y);
  }
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{series:{values:number[], color:string, fill?:string, label?:string}[], max?:number,
 *          format?:(n:number)=>string, height?:number, labels?:string[], hideAxis?:boolean, smooth?:boolean}} opts
 */
export function areaChart(canvas, opts) {
  if (!canvas) return;
  const parent = canvas.parentElement;
  const height = opts.height || canvas.clientHeight || 200;

  const draw = (hoverIndex = -1) => {
    const width = canvas.clientWidth || parent.clientWidth || 600;
    const dpr = DPR();
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const padL = 6;
    const padR = opts.hideAxis ? 6 : 46;
    const padT = 10;
    const padB = opts.hideAxis ? 6 : 22;
    const w = width - padL - padR;
    const h = height - padT - padB;

    const series = (opts.series || []).map((s) => ({
      ...s,
      values: (s.values || []).map((v) => Number(v) || 0),
    })).filter((s) => s.values.length);
    const count = Math.max(2, ...series.map((s) => s.values.length));
    const dataMax = Math.max(0, ...series.flatMap((s) => s.values));
    const max = niceMax(opts.max || dataMax);

    // сетка
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgba(154,163,182,.6)';
    for (let i = 0; i <= 3; i += 1) {
      const y = padT + (h * i) / 3;
      ctx.beginPath();
      ctx.setLineDash([2, 4]);
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + w, y);
      ctx.stroke();
      if (!opts.hideAxis) {
        const value = max - (max * i) / 3;
        ctx.textAlign = 'right';
        ctx.fillText((opts.format || ((n) => String(Math.round(n))))(value), width - 4, y + 3);
      }
    }
    ctx.setLineDash([]);

    for (const s of series) {
      const values = s.values.length === 1 ? [s.values[0], s.values[0]] : s.values;
      const points = values.map((value, i) => ({
        x: padL + (w * i) / Math.max(1, values.length - 1),
        y: padT + h - (Math.min(value, max) / max) * h,
      }));
      const color = s.color || '#7c8cff';
      // заливка
      const gradient = ctx.createLinearGradient(0, padT, 0, padT + h);
      gradient.addColorStop(0, s.fill || `${color}33`);
      gradient.addColorStop(1, `${color}00`);
      ctx.beginPath();
      pathSmooth(ctx, points);
      ctx.lineTo(points[points.length - 1].x, padT + h);
      ctx.lineTo(points[0].x, padT + h);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
      // линия
      ctx.beginPath();
      pathSmooth(ctx, points);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    // подписи времени
    const labels = opts.labels || [];
    if (!opts.hideAxis && labels.length) {
      ctx.fillStyle = 'rgba(100,109,129,.85)';
      ctx.textAlign = 'left';
      ctx.fillText(labels[0], padL, height - 4);
      ctx.textAlign = 'right';
      ctx.fillText(labels[labels.length - 1], padL + w, height - 4);
    }

    // ховер
    if (hoverIndex >= 0 && series.length) {
      const i = Math.round((hoverIndex / Math.max(1, w)) * (count - 1));
      const x = padL + (w * i) / Math.max(1, count - 1);
      ctx.strokeStyle = 'rgba(255,255,255,.16)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + h);
      ctx.stroke();
      ctx.setLineDash([]);
      series.forEach((s) => {
        const val = s.values[Math.min(i, s.values.length - 1)] || 0;
        const y = padT + h - (Math.min(val, max) / max) * h;
        ctx.beginPath();
        ctx.arc(x, y, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = s.color || '#7c8cff';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    }
    canvas._chartState = { count, series, width, padL, w, height, padT, h };
  };

  draw();

  // тултип
  let tooltip = parent.querySelector('.chart-tip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'chart-tip';
    tooltip.style.cssText = 'position:absolute;pointer-events:none;background:#12151d;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:7px 9px;font-size:11px;line-height:1.5;box-shadow:0 12px 26px rgba(0,0,0,.45);opacity:0;transition:opacity .12s;z-index:5;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;color:#c8cfdd';
    parent.style.position = 'relative';
    parent.appendChild(tooltip);
  }

  const onMove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    draw(x);
    const state = canvas._chartState;
    if (!state) return;
    const idx = Math.round(((x - state.padL) / Math.max(1, state.w)) * (state.count - 1));
    const clamped = Math.max(0, Math.min(state.count - 1, idx));
    const rows = state.series.map((s) => {
      const val = s.values[Math.min(clamped, s.values.length - 1)] || 0;
      return `<div style="display:flex;align-items:center;gap:6px"><span style="width:6px;height:6px;border-radius:50%;background:${s.color || '#7c8cff'}"></span>${s.label || ''} <b style="margin-left:auto;color:#e9ecf4">${(opts.format || ((n) => String(Math.round(n))))(val)}</b></div>`;
    }).join('');
    const timeLabel = (opts.tooltipLabel && opts.tooltipLabel(clamped)) || '';
    tooltip.innerHTML = `${timeLabel ? `<div style="color:#646d81;margin-bottom:4px">${timeLabel}</div>` : ''}${rows}`;
    const tw = tooltip.offsetWidth || 140;
    const left = Math.min(Math.max(6, x - tw / 2), state.width - tw - 6);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `8px`;
    tooltip.style.opacity = '1';
  };
  const onLeave = () => {
    tooltip.style.opacity = '0';
    draw();
  };
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);

  if (!canvas._chartRO) {
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    canvas._chartRO = ro;
  }
  canvas._redraw = () => draw();
}

export function sparkline(canvas, values, color = '#7c8cff', height = 36) {
  if (!canvas) return;
  const width = canvas.clientWidth || 180;
  const dpr = DPR();
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const arr = values && values.length ? values : [0, 0];
  const max = Math.max(...arr, 1);
  const pts = arr.map((v, i) => ({
    x: (width * i) / Math.max(1, arr.length - 1),
    y: height - 3 - (v / max) * (height - 8),
  }));
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, `${color}44`);
  gradient.addColorStop(1, `${color}00`);
  ctx.beginPath();
  pathSmooth(ctx, pts);
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.beginPath();
  pathSmooth(ctx, pts);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

export function ring(element, percent, { color = '#7c8cff', size = 74, stroke = 6, label = '' } = {}) {
  if (!element) return;
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  element.innerHTML = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="${stroke}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
        stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c - (c * value) / 100}"
        transform="rotate(-90 ${size / 2} ${size / 2})" style="transition:stroke-dashoffset .6s cubic-bezier(.2,.7,.3,1)"/>
      <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#e9ecf4"
        font-size="${size / 4.4}" font-family="ui-monospace, Menlo, monospace">${label || Math.round(value) + '%'}</text>
    </svg>`;
}

export const historyValues = (history, key, limit = 45) => {
  const list = (history || []).slice(-limit);
  const values = list.map((p) => p[key] || 0);
  while (values.length < 2) values.unshift(0);
  return values;
};

export const formatMemory = (n) => fmtBytes(n);
export const formatUptime = (n) => fmtDuration(n);
