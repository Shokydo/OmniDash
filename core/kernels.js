'use strict';
/**
 * Каталог ядер Minecraft (как в OmniPanel):
 * Paper / Folia / Purpur / Fabric / Vanilla / Velocity / Waterfall + custom.
 * Версии и ссылки берутся из внешних API, jar скачивается в каталог сервера.
 */
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const UA = { 'User-Agent': 'OmniDash/1.0 (+control plane)' };

async function getJson(url, timeout = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function download(url, destFile, onProgress = null) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers: UA, signal: ctrl.signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`Не удалось скачать: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  let received = 0;
  let lastTick = 0;
  const tmp = destFile + '.part';
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const stream = Readable.fromWeb(res.body);
  stream.on('data', (chunk) => {
    received += chunk.length;
    const now = Date.now();
    if (onProgress && (now - lastTick > 250 || received === total)) {
      lastTick = now;
      onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : null });
    }
  });
  await pipeline(stream, fs.createWriteStream(tmp));
  fs.renameSync(tmp, destFile);
  if (onProgress) onProgress({ received, total, percent: 100, done: true });
  return { file: destFile, size: received };
}

const PMC = 'https://fill.papermc.io/v3/projects';

const KERNELS = {
  paper: {
    id: 'paper', label: 'Paper', group: 'Оптимизированные',
    hint: 'Самый популярный оптимизированный сервер. Плагины Bukkit/Spigot.',
    recommended: true, javaMin: 21,
    async versions() {
      const data = await getJson(`${PMC}/paper/versions`);
      const list = [];
      for (const item of data.versions || []) {
        const v = item.version || {};
        if (!v.id) continue;
        list.push({ id: v.id, java: v.java?.version?.minimum || null });
      }
      return list;
    },
    async resolve(version) {
      const builds = await getJson(`${PMC}/paper/versions/${encodeURIComponent(version)}/builds`);
      const arr = Array.isArray(builds) ? builds : builds.builds || [];
      if (!arr.length) throw new Error('Для этой версии нет сборок Paper');
      const stable = arr.find((b) => (b.channel || 'STABLE') === 'STABLE') || arr[0];
      const dl = stable.downloads['server:default'] || Object.values(stable.downloads)[0];
      return { url: dl.url, fileName: dl.name || `paper-${version}.jar`, size: dl.size, build: stable.id };
    },
  },
  folia: {
    id: 'folia', label: 'Folia', group: 'Оптимизированные',
    hint: 'Многопоточный Paper для больших ферм. Многие плагины несовместимы.', javaMin: 21,
    async versions() {
      const data = await getJson(`${PMC}/folia/versions`);
      return (data.versions || []).map((i) => ({ id: i.version?.id })).filter((v) => v.id);
    },
    async resolve(version) {
      const builds = await getJson(`${PMC}/folia/versions/${encodeURIComponent(version)}/builds`);
      const arr = Array.isArray(builds) ? builds : builds.builds || [];
      const stable = arr.find((b) => (b.channel || 'STABLE') === 'STABLE') || arr[0];
      if (!stable) throw new Error('Нет сборок Folia для этой версии');
      const dl = stable.downloads['server:default'] || Object.values(stable.downloads)[0];
      return { url: dl.url, fileName: dl.name, size: dl.size, build: stable.id };
    },
  },
  purpur: {
    id: 'purpur', label: 'Purpur', group: 'Оптимизированные',
    hint: 'Форк Paper с кучей настроек геймплея.', javaMin: 21,
    async versions() {
      const data = await getJson('https://api.purpurmc.org/v2/purpur');
      return (data.versions || []).slice().reverse().map((v) => ({ id: v }));
    },
    async resolve(version) {
      return { url: `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/latest/download`, fileName: `purpur-${version}.jar` };
    },
  },
  fabric: {
    id: 'fabric', label: 'Fabric', group: 'Моды',
    hint: 'Лёгкий загрузчик модов. Подходит для клиент-серверных модпаков.', javaMin: 21,
    async versions() {
      const data = await getJson('https://meta.fabricmc.net/v2/versions/game');
      return data.filter((v) => v.stable).map((v) => ({ id: v.version }));
    },
    async resolve(version) {
      const [loaders, installers] = await Promise.all([
        getJson('https://meta.fabricmc.net/v2/versions/loader'),
        getJson('https://meta.fabricmc.net/v2/versions/installer'),
      ]);
      const loader = (loaders.find((l) => l.stable) || loaders[0]).version;
      const installer = (installers.find((i) => i.stable) || installers[0]).version;
      return {
        url: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${loader}/${installer}/server/jar`,
        fileName: 'fabric-server.jar',
      };
    },
  },
  vanilla: {
    id: 'vanilla', label: 'Vanilla', group: 'Официальные',
    hint: 'Чистый сервер от Mojang, без плагинов и модов.', javaMin: 21,
    async versions() {
      const data = await getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
      return (data.versions || []).filter((v) => v.type === 'release').map((v) => ({ id: v.id }));
    },
    async resolve(version) {
      const manifest = await getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
      const entry = (manifest.versions || []).find((v) => v.id === version);
      if (!entry) throw new Error('Версия не найдена в манифесте Mojang');
      const meta = await getJson(entry.url);
      const server = meta.downloads && meta.downloads.server;
      if (!server) throw new Error('У этой версии нет серверного jar');
      return { url: server.url, fileName: `minecraft_server-${version}.jar`, size: server.size };
    },
  },
  velocity: {
    id: 'velocity', label: 'Velocity', group: 'Прокси',
    hint: 'Современный прокси для сети серверов.', javaMin: 21, proxy: true,
    async versions() {
      const data = await getJson(`${PMC}/velocity/versions`);
      return (data.versions || []).map((i) => ({ id: i.version?.id })).filter((v) => v.id);
    },
    async resolve(version) {
      const builds = await getJson(`${PMC}/velocity/versions/${encodeURIComponent(version)}/builds`);
      const arr = Array.isArray(builds) ? builds : builds.builds || [];
      const stable = arr.find((b) => (b.channel || 'STABLE') === 'STABLE') || arr[0];
      if (!stable) throw new Error('Нет сборок Velocity для этой версии');
      const dl = stable.downloads['server:default'] || Object.values(stable.downloads)[0];
      return { url: dl.url, fileName: dl.name, size: dl.size, build: stable.id };
    },
  },
  waterfall: {
    id: 'waterfall', label: 'Waterfall', group: 'Прокси',
    hint: 'Прокси на базе Paper для BungeeCord-плагинов.', javaMin: 21, proxy: true,
    async versions() {
      const data = await getJson(`${PMC}/waterfall/versions`);
      return (data.versions || []).map((i) => ({ id: i.version?.id })).filter((v) => v.id);
    },
    async resolve(version) {
      const builds = await getJson(`${PMC}/waterfall/versions/${encodeURIComponent(version)}/builds`);
      const arr = Array.isArray(builds) ? builds : builds.builds || [];
      const stable = arr.find((b) => (b.channel || 'STABLE') === 'STABLE') || arr[0];
      if (!stable) throw new Error('Нет сборок Waterfall для этой версии');
      const dl = stable.downloads['server:default'] || Object.values(stable.downloads)[0];
      return { url: dl.url, fileName: dl.name, size: dl.size, build: stable.id };
    },
  },
  custom: {
    id: 'custom', label: 'Своя ссылка', group: 'Прочее',
    hint: 'Прямая http(s)-ссылка на jar-файл ядра.', custom: true,
    async versions() { return []; },
    async resolve() { throw new Error('Для custom укажите прямую ссылку'); },
  },
};

function catalog() {
  return Object.values(KERNELS).map((k) => ({
    id: k.id, label: k.label, group: k.group, hint: k.hint,
    recommended: !!k.recommended, proxy: !!k.proxy, custom: !!k.custom, javaMin: k.javaMin || null,
  }));
}

async function versions(kernelId) {
  const k = KERNELS[kernelId];
  if (!k) throw new Error('Неизвестное ядро: ' + kernelId);
  const list = await k.versions();
  return list.slice(0, 60);
}

async function resolve(kernelId, version) {
  const k = KERNELS[kernelId];
  if (!k) throw new Error('Неизвестное ядро: ' + kernelId);
  return k.resolve(version);
}

/**
 * Скачивает ядро в каталог сервера и возвращает имя jar.
 * opts: { kernel, version, customUrl, customName, dir }
 */
async function installToDir(opts, onProgress = () => {}) {
  const { kernel, version, customUrl, customName, dir } = opts;
  if (!dir) throw new Error('Не указана папка для сервера');
  fs.mkdirSync(dir, { recursive: true });
  let resolved;
  if (kernel === 'custom') {
    if (!customUrl || !/^https?:\/\//i.test(customUrl)) throw new Error('Нужна прямая http(s)-ссылка на jar');
    let fileName = customName && customName.trim() ? customName.trim() : '';
    if (!fileName) {
      try {
        const u = new URL(customUrl);
        const base = decodeURIComponent(path.basename(u.pathname) || '');
        fileName = /\.jar$/i.test(base) ? base : 'server.jar';
      } catch { fileName = 'server.jar'; }
    }
    if (!/\.jar$/i.test(fileName)) fileName += '.jar';
    resolved = { url: customUrl, fileName };
  } else {
    if (!version) throw new Error('Не выбрана версия');
    onProgress({ stage: 'resolve', text: `Ищу сборку ${kernel} ${version}…` });
    resolved = await resolve(kernel, version);
  }
  const jarPath = path.join(dir, resolved.fileName);
  if (fs.existsSync(jarPath) && fs.statSync(jarPath).size > 0) {
    onProgress({ stage: 'download', text: `Файл уже есть: ${resolved.fileName}`, percent: 100 });
  } else {
    onProgress({ stage: 'download', text: `Скачиваю ${resolved.fileName}…`, percent: 0 });
    await download(resolved.url, jarPath, (p) => {
      onProgress({ stage: 'download', text: `Скачиваю ${resolved.fileName}`, percent: p.percent, received: p.received, total: p.total });
    });
  }
  onProgress({ stage: 'done', text: 'Ядро готово', percent: 100 });
  return { jar: resolved.fileName, kernel, version: version || null };
}

module.exports = { catalog, versions, resolve, installToDir, download, KERNELS };
