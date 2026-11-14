// OmniDash — темы, стили, визуальные эффекты и звуки (как в OmniPanel).
// WebAudio без файлов, localStorage, без зависимостей.

export const THEMES = {
  dark: { label: 'Тёмная', bg: '#000000', panel: '#0a0a0a', text: '#f5f5f5', accent: '#ffffff' },
  graphite: { label: 'Графит', bg: '#0f0f10', panel: '#19191b', text: '#ededed', accent: '#c9c9cf' },
  contrast: { label: 'Контраст', bg: '#000000', panel: '#131313', text: '#ffffff', accent: '#ffffff' },
  gray: { label: 'Серая', bg: '#22262b', panel: '#31373e', text: '#dfe3e8', accent: '#ffffff' },
  navy: { label: 'Ночь', bg: '#0a0d14', panel: '#121722', text: '#e6ebf5', accent: '#6ea8fe' },
  ocean: { label: 'Океан', bg: '#08100f', panel: '#111c1b', text: '#e3f1ef', accent: '#4fc3b5' },
  forest: { label: 'Лес', bg: '#0b110d', panel: '#131b15', text: '#e6efe8', accent: '#63c98a' },
  amethyst: { label: 'Аметист', bg: '#0d0a14', panel: '#171225', text: '#ece9f6', accent: '#a78bfa' },
  sunset: { label: 'Закат', bg: '#120c10', panel: '#1d1419', text: '#f4e9ee', accent: '#f08a6c' },
  ember: { label: 'Уголь', bg: '#0d0c0a', panel: '#171614', text: '#f0efe9', accent: '#d9a13b' },
  steel: { label: 'Сталь', bg: '#0c1013', panel: '#151b20', text: '#e4edf2', accent: '#8fb8cc' },
  light: { label: 'Светлая', bg: '#f4f5f7', panel: '#ffffff', text: '#1a1c20', accent: '#111111' },
  paper: { label: 'Бумага', bg: '#f6f4ef', panel: '#ffffff', text: '#1b1a17', accent: '#111111' },
  snow: { label: 'Снег', bg: '#eef2f7', panel: '#ffffff', text: '#141a22', accent: '#1f6feb' },
  mint: { label: 'Мята', bg: '#eef5f1', panel: '#ffffff', text: '#12211a', accent: '#12855b' },
  sand: { label: 'Песок', bg: '#f5f1e8', panel: '#fffdf8', text: '#211d16', accent: '#a9743a' },
  custom: { label: 'Кастом', bg: '#0f1014', panel: '#181b22', text: '#e8eaf0', accent: '#8ab4ff' },
};

export const SOUND_PACKS = {
  soft: { label: 'Мягкие', type: 'sine', mul: 1, len: 1, gain: 1, cut: 2600 },
  mech: { label: 'Механические', type: 'square', mul: 0.62, len: 0.55, gain: 0.55, cut: 1500 },
  bell: { label: 'Колокольчики', type: 'triangle', mul: 1.9, len: 1.5, gain: 0.75, cut: 5200 },
  deep: { label: 'Низкие', type: 'sine', mul: 0.55, len: 1.35, gain: 1.25, cut: 1400 },
  pop: { label: 'Поп', type: 'triangle', mul: 1.25, len: 0.6, gain: 0.9, cut: 3200 },
};

const prefs = {
  sound: localStorage.getItem('od.sound') !== '0',
  fx: localStorage.getItem('od.fx') !== '0',
  volume: Number(localStorage.getItem('od.volume') ?? 45) / 100,
  theme: localStorage.getItem('od.theme') || 'dark',
  radius: localStorage.getItem('od.radius') || 'soft',
  density: localStorage.getItem('od.density') || 'normal',
  clickFx: localStorage.getItem('od.clickFx') || 'wave',
  soundPack: localStorage.getItem('od.soundPack') || 'soft',
  custom: JSON.parse(localStorage.getItem('od.custom') || 'null') || {
    bg: '#0f1014', panel: '#181b22', text: '#e8eaf0', accent: '#8ab4ff',
  },
  save() {
    localStorage.setItem('od.sound', this.sound ? '1' : '0');
    localStorage.setItem('od.fx', this.fx ? '1' : '0');
    localStorage.setItem('od.volume', String(Math.round(this.volume * 100)));
    localStorage.setItem('od.theme', this.theme);
    localStorage.setItem('od.radius', this.radius);
    localStorage.setItem('od.density', this.density);
    localStorage.setItem('od.clickFx', this.clickFx);
    localStorage.setItem('od.soundPack', this.soundPack);
    localStorage.setItem('od.custom', JSON.stringify(this.custom));
  },
};

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}

function mix(a, b, ratio) {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * ratio));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

function themePalette() {
  if (prefs.theme === 'custom') {
    const c = prefs.custom || {};
    const base = THEMES.custom;
    return { bg: c.bg || base.bg, panel: c.panel || base.panel, text: c.text || base.text, accent: c.accent || base.accent };
  }
  const t = THEMES[prefs.theme] || THEMES.dark;
  return { bg: t.bg, panel: t.panel, text: t.text, accent: t.accent };
}

export function applyTheme() {
  const pal = themePalette();
  const root = document.documentElement;
  root.style.setProperty('--bg', pal.bg);
  root.style.setProperty('--surface', pal.panel);
  root.style.setProperty('--surface-2', mix(pal.panel, pal.text, 0.06));
  root.style.setProperty('--surface-3', mix(pal.panel, pal.text, 0.1));
  root.style.setProperty('--text', pal.text);
  root.style.setProperty('--text-dim', mix(pal.text, pal.bg, 0.25));
  root.style.setProperty('--text-mute', mix(pal.text, pal.bg, 0.45));
  root.style.setProperty('--accent', pal.accent);
  const rgb = hexToRgb(pal.accent);
  root.style.setProperty('--accent-rgb', rgb.join(', '));
  root.style.setProperty('--accent-ink', pal.bg);
  root.style.setProperty('--line', mix(pal.text, pal.bg, 0.88));
  root.style.setProperty('--line-strong', mix(pal.text, pal.bg, 0.75));
  const isLight = ['light', 'paper', 'snow', 'mint', 'sand'].includes(prefs.theme);
  root.style.setProperty('color-scheme', isLight ? 'light' : 'dark');
  document.body.dataset.theme = prefs.theme;
  document.body.dataset.radius = prefs.radius;
  document.body.dataset.density = prefs.density;
}

/* ─────────────────────────── звуки ─────────────────────────── */

const Sound = {
  ctx: null,
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  },
  pack() {
    return SOUND_PACKS[prefs.soundPack] || SOUND_PACKS.soft;
  },
  tone({ freq = 520, to = null, dur = 0.09, type = null, gain = 0.02, delay = 0 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const vol = Math.max(0, Math.min(1, prefs.volume));
    if (vol <= 0) return;
    const pk = this.pack();
    freq *= pk.mul;
    if (to) to *= pk.mul;
    dur *= pk.len;
    gain *= pk.gain;
    type = type && pk.type === 'sine' ? type : pk.type;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = pk.cut;
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(40, to), t0 + dur);
    const peak = gain * vol;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.03, dur * 0.35));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(lp).connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  },
  play(kind) {
    if (!prefs.sound) return;
    switch (kind) {
      case 'click': this.tone({ freq: 540, to: 470, dur: 0.07, gain: 0.016 }); break;
      case 'nav': this.tone({ freq: 400, to: 460, dur: 0.1, gain: 0.014 }); break;
      case 'start':
        this.tone({ freq: 392, to: 523, dur: 0.16, gain: 0.022 });
        this.tone({ freq: 523, to: 659, dur: 0.2, gain: 0.018, delay: 0.12 });
        break;
      case 'stop':
        this.tone({ freq: 494, to: 349, dur: 0.18, gain: 0.02 });
        this.tone({ freq: 349, to: 262, dur: 0.22, gain: 0.016, delay: 0.13 });
        break;
      case 'ok':
        this.tone({ freq: 587, dur: 0.11, gain: 0.02 });
        this.tone({ freq: 880, dur: 0.16, gain: 0.016, delay: 0.09 });
        break;
      case 'err': this.tone({ freq: 262, to: 196, dur: 0.28, gain: 0.022 }); break;
      default: break;
    }
  },
};

/* ─────────────────────────── эффект от клика ─────────────────────────── */

function fxLayer() {
  let layer = document.getElementById('fxLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'fxLayer';
    layer.className = 'fx-layer';
    document.body.appendChild(layer);
  }
  return layer;
}

function clickFxAt(x, y, kind) {
  if (!prefs.fx || !kind || kind === 'off' || kind === 'wave') return;
  const el = document.createElement('span');
  el.className = 'cfx cfx-' + kind;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  fxLayer().appendChild(el);
  setTimeout(() => el.remove(), 640);
}

export function initThemeFx() {
  applyTheme();
  document.addEventListener('click', (e) => {
    clickFxAt(e.clientX, e.clientY, prefs.clickFx);
    if (e.target.closest('button, a, .nav-item, .topnav-item')) Sound.play('click');
  }, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest('input, textarea')) Sound.play('nav');
  });
}

export { prefs, Sound };
