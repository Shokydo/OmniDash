'use strict';
/**
 * Первичное наполнение панели демо-данными.
 * Запускается один раз — если в базе ещё нет пользователей.
 * Пароли: admin / omnidash, steve / steve123, mira / mira123.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const auth = require('./auth');
const eggsCore = require('./eggs');
const serversCore = require('./servers');
const backups = require('./backups');
const { makeTask } = require('./scheduler');
const { uuid, now, id } = require('./util');

const minutes = (m) => m * 60000;
const days = (d) => d * 86400000;

function writeFiles(serverId, files) {
  const dir = db.serverDir(serverId);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function seed() {
  if (db.data.users.length) return false;
  const t = now();

  /* ─────────────── пользователи ─────────────── */
  const admin = db.newUser({
    username: 'admin',
    email: 'admin@omnidash.local',
    role: 'admin',
    ...auth.hashPassword('omnidash'),
    limits: { memory: 65536, disk: 524288, cpu: 1600, servers: 100, backups: 50 },
  });
  admin.avatarColor = '#262626';

  const steve = db.newUser({
    username: 'steve',
    email: 'steve@example.com',
    role: 'user',
    ...auth.hashPassword('steve123'),
    limits: { memory: 8192, disk: 40960, cpu: 300, servers: 4, backups: 5 },
  });
  const mira = db.newUser({
    username: 'mira',
    email: 'mira@example.com',
    role: 'user',
    ...auth.hashPassword('mira123'),
    limits: { memory: 4096, disk: 20480, cpu: 200, servers: 2, backups: 3 },
  });
  const kotik = db.newUser({
    username: 'kotik',
    email: 'kotik@example.com',
    role: 'user',
    ...auth.hashPassword('kotik123'),
    limits: { memory: 2048, disk: 10240, cpu: 150, servers: 2, backups: 2 },
  });

  /* ─────────────── узлы ─────────────── */
  const nodeRu = {
    id: uuid(),
    name: 'ru-1 · Москва',
    description: 'Основной локальный узел. Реальные процессы, порты и лимиты.',
    fqdn: 'localhost',
    scheme: 'http',
    port: 8080,
    location: 'Москва, RU',
    flag: '🇷🇺',
    memoryTotal: 16384,
    diskTotal: 102400,
    portStart: 25565,
    portEnd: 25640,
    status: 'online',
    maintenance: false,
    createdAt: t,
    token: id('node').replace('node_', ''),
  };
  const nodeDe = {
    id: uuid(),
    name: 'de-1 · Франкфурт',
    description: 'Узел-заглушка для демонстрации мультиузловости. Процессы на нём не запускаются — запуск только на локальном узле.',
    fqdn: 'de1.omnidash.local',
    scheme: 'https',
    port: 8443,
    location: 'Франкфурт, DE',
    flag: '🇩🇪',
    memoryTotal: 32768,
    diskTotal: 204800,
    portStart: 30000,
    portEnd: 30040,
    status: 'offline',
    maintenance: false,
    createdAt: t,
    token: id('node').replace('node_', ''),
  };
  db.data.nodes.push(nodeRu, nodeDe);

  /* ─────────────── шаблоны ─────────────── */
  db.data.eggs.push(...eggsCore.templates());
  const egg = (key) => db.data.eggs.find((e) => e.key === key);
  db.data.settings.defaultEggId = egg('paper').id;

  /* ─────────────── аллокации ─────────────── */
  for (let port = nodeRu.portStart; port <= nodeRu.portStart + 11; port += 1) {
    db.data.allocations.push({
      id: uuid(), nodeId: nodeRu.id, ip: '0.0.0.0', port, serverId: null, createdAt: t,
      notes: port === 25565 ? 'основной игровой порт' : '',
    });
  }
  for (let port = nodeDe.portStart; port <= nodeDe.portStart + 4; port += 1) {
    db.data.allocations.push({
      id: uuid(), nodeId: nodeDe.id, ip: '0.0.0.0', port, serverId: null, createdAt: t, notes: '',
    });
  }

  /* ─────────────── серверы ─────────────── */
  const withEgg = (owner, node, eggKey, data) => {
    const server = serversCore.createServer({
      owner,
      egg: egg(eggKey),
      node,
      name: data.name,
      description: data.description,
      limits: data.limits,
      expiresDays: null,
      actor: admin,
      autoStart: false,
    });
    server.expiresAt = data.expiresAt ?? now() + days(30);
    server.createdAt = t - days(data.ageDays || 12);
    server.renewals = data.renewals || 0;
    if (data.suspended) {
      server.suspended = true;
      server.suspendReason = data.suspendReason || 'manual';
    }
    db.save();
    return server;
  };

  const world = withEgg(steve, nodeRu, 'paper', {
    name: 'Мир Друзей',
    description: 'Ванильный Paper с плагинами: EssentialsX, LuckPerms, WorldEdit.',
    limits: { memory: 3072, disk: 20480, cpu: 250 },
    expiresAt: now() + days(12),
    ageDays: 34,
    renewals: 2,
  });
  const skyblock = withEgg(steve, nodeRu, 'paper', {
    name: 'SkyBlock',
    description: 'Сезон 3. IslandTop, кастомные крафты, магазин.',
    limits: { memory: 2048, disk: 10240, cpu: 150 },
    expiresAt: now() + days(4),
    ageDays: 21,
    renewals: 1,
  });
  const bot = withEgg(mira, nodeRu, 'node-bot', {
    name: 'Discord Bot',
    description: 'Музыкальный бот для сервера сообщества. Node.js 22.',
    limits: { memory: 512, disk: 2048, cpu: 80 },
    expiresAt: now() + days(23),
    ageDays: 8,
  });
  const parser = withEgg(mira, nodeRu, 'python-bot', {
    name: 'Price Parser',
    description: 'Сбор цен и выгрузка в Google Sheets каждые 15 минут.',
    limits: { memory: 768, disk: 4096, cpu: 100 },
    expiresAt: now() + days(40),
    ageDays: 5,
  });
  const expired = withEgg(kotik, nodeRu, 'paper', {
    name: 'Тестовый Paper',
    description: 'Песочница для проверки плагинов. Срок аренды истёк.',
    limits: { memory: 1024, disk: 5120, cpu: 100 },
    expiresAt: now() - days(2),
    ageDays: 40,
    suspended: true,
    suspendReason: 'expired',
  });
  const deProxy = withEgg(steve, nodeDe, 'generic', {
    name: 'EU Proxy',
    description: 'Прокси для европейских игроков на узле de-1.',
    limits: { memory: 1024, disk: 5120, cpu: 100 },
    expiresAt: now() + days(60),
    ageDays: 3,
  });

  /* ─────────────── доступы ─────────────── */
  serversCore.setSubuser(world, kotik.id, ['console', 'control']);
  serversCore.setSubuser(skyblock, mira.id, ['console', 'files']);

  /* ─────────────── файлы на серверах ─────────────── */
  writeFiles(world.id, {
    'server.properties': [
      '#Minecraft server properties',
      'server-port=25565',
      'motd=\u00a7bМир Друзей \u00a77| \u00a7aOmniDash',
      'max-players=20',
      'online-mode=true',
      'difficulty=hard',
      'view-distance=10',
      'pvp=true',
      'level-seed=omnidash',
    ].join('\n'),
    'ops.json': JSON.stringify([{ uuid: uuid(), name: 'Steve', level: 4, bypassesPlayerLimit: false }], null, 2),
    'plugins/README.txt': 'Плагины: EssentialsX 2.20.1, LuckPerms 5.4, WorldEdit 7.3, CoreProtect 22.4\nОбновляются через /plugins → Update в игре.',
    'start.sh': '#!/usr/bin/env sh\njava -Xms512M -Xmx{{MEMORY}}M -jar server.jar nogui\n',
    'whitelist.json': '[]',
  });
  writeFiles(skyblock.id, {
    'server.properties': 'server-port=25566\nmotd=\u00a7dSkyBlock \u00a78| Сезон 3\nmax-players=30\nlevel-type=flat\n',
    'plugins/SkyBlock/config.yml': 'island:\n  height: 120\n  radius: 64\nseason: 3\n',
    'README.md': '# SkyBlock\n\nСезон 3. Бэкап каждые 6 часов задачей панели.\n',
  });
  writeFiles(bot.id, {
    'package.json': JSON.stringify({ name: 'discord-bot', version: '2.4.1', main: 'index.js', dependencies: { 'discord.js': '^22.0.0' } }, null, 2),
    'index.js': "// Демо-бот OmniDash\nconsole.log('Bot ready');\n",
    '.env': 'TOKEN=demo-token\nGUILD_ID=123456789\n',
    'README.md': '# Discord Bot\n\nЗапускается стартовой командой шаблона «Node.js 22».\nКонсоль в панели — это stdout процесса.\n',
  });
  writeFiles(parser.id, {
    'requirements.txt': 'requests==2.32.3\nbeautifulsoup4==4.12.3\n',
    'main.py': "import os\nprint('Bot online')\n",
    'config.json': JSON.stringify({ interval: 15, sheet: 'prices!A1' }, null, 2),
  });
  writeFiles(expired.id, {
    'server.properties': '# тестовый сервер\nserver-port=25567\n',
    'README.md': 'Срок истёк — продлите сервер в панели или удалите его.\n',
  });
  writeFiles(deProxy.id, {
    'config.yml': 'bind: 0.0.0.0:30004\nmotd: EU Proxy\nservers:\n  - ru-1\n',
    'README.md': 'Узел de-1 сейчас офлайн. Запуск недоступен.\n',
  });

  /* ─────────────── бэкапы ─────────────── */
  backups.create(world, { name: 'Перед обновлением плагинов' });
  backups.create(skyblock, { name: 'Сезон 3 · старт' });
  backups.create(bot, { name: 'v2.4.1' });

  /* ─────────────── задачи ─────────────── */
  world.tasks.push(makeTask({ name: 'Ежедневный рестарт', action: 'power_restart', schedule: { type: 'daily', time: '05:00' } }));
  world.tasks.push(makeTask({ name: 'Бэкап мира', action: 'backup', payload: 'Авто-бэкап', schedule: { type: 'interval', minutes: 360 } }));
  skyblock.tasks.push(makeTask({ name: 'Сохранение', action: 'command', payload: 'save-all', schedule: { type: 'interval', minutes: 120 } }));

  /* ─────────────── запросы продления ─────────────── */
  db.data.renewRequests.push({
    id: id('renew'),
    serverId: skyblock.id,
    userId: steve.id,
    days: 30,
    comment: 'Продлите, пожалуйста, ещё на месяц — сезон ещё идёт.',
    at: now() - minutes(90),
    status: 'pending',
  });

  /* ─────────────── журнал ─────────────── */
  const entries = [
    { action: 'server.start', actorName: 'steve', target: 'Мир Друзей', meta: { via: 'panel' } },
    { action: 'server.access.grant', actorName: 'steve', target: 'Мир Друзей', meta: { user: 'kotik', perms: ['console', 'control'] } },
    { action: 'backup.create', actorName: 'steve', target: 'Мир Друзей', meta: { name: 'Перед обновлением плагинов' } },
    { action: 'server.renew', actorName: 'admin', target: 'SkyBlock', meta: { days: 30 } },
    { action: 'user.create', actorName: 'admin', target: 'mira', meta: { role: 'user' } },
    { action: 'server.suspend', actorName: 'system', target: 'Тестовый Paper', meta: { reason: 'expired' } },
  ];
  entries.forEach((e, i) => {
    db.data.audit.push({ id: id('log'), at: now() - minutes(18 * (i + 1)), ...e });
  });

  db.data.meta.seededAt = now();
  db.data.meta.demo = true;
  db.save();
  console.log('[seed] демо-данные созданы: 4 пользователя, 6 серверов, 2 узла');
  return true;
}

module.exports = { seed };
