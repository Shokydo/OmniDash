'use strict';
/**
 * Шаблоны серверов («яйца» / eggs).
 * Формат шаблонов: стартовая команда с {{ПЕРЕМЕННЫМИ}},
 * переменные окружения, правила остановки, регулярки для статуса и игроков.
 */
const { id, uuid } = require('./util');

function base(partial) {
  return {
    id: id('egg'),
    uuid: uuid(),
    author: 'OmniDash',
    createdAt: Date.now(),
    allowStartupOverride: true,
    config: {
      stopCommand: 'stop',
      stopTimeout: 15,
      readyRegex: 'Done|Listening|готов|Bot ready|is online',
      playerJoinRegex: '',
      playerLeaveRegex: '',
    },
    variables: [],
    ...partial,
  };
}

function templates() {
  return [
    base({
      key: 'paper',
      name: 'Paper 1.21.4',
      description: 'Minecraft-сервер. В демо-режиме запускается эмулятор консоли и порта — весь функционал панели (консоль, порты, лимиты, бэкапы) работает по-настоящему.',
      category: 'minecraft',
      color: '#ffffff',
      startup: 'node "{{BASE}}/demo/minecraft-mock.js" --port {{PORT}} --memory {{MEMORY}} --name "{{SERVER_NAME}}" --seed {{SEED}}',
      image: 'ghcr.io/pterodactyl/yolks:java_21',
      config: {
        stopCommand: 'stop',
        stopTimeout: 15,
        readyRegex: 'Done \\(',
        playerJoinRegex: 'joined the game',
        playerLeaveRegex: 'left the game',
      },
      variables: [
        { env: 'SEED', label: 'Сид мира', default: 'omnidash', userEditable: true, rules: 'string' },
        { env: 'SERVER_TYPE', label: 'Тип ядра', default: 'paper', userEditable: true, rules: 'in:paper,vanilla,purpur' },
      ],
    }),
    base({
      key: 'node-bot',
      name: 'Node.js 22',
      description: 'Универсальный Node.js: боты Discord/Telegram, API, воркеры. Стартовая команда меняется, зависимости ставятся в файловом менеджере.',
      category: 'node',
      color: '#d4d4d4',
      startup: 'node "{{BASE}}/demo/bot-mock.js" --name "{{SERVER_NAME}}" --token "{{BOT_TOKEN}}"',
      image: 'ghcr.io/pterodactyl/yolks:nodejs_22',
      config: { stopCommand: 'stop', stopTimeout: 10, readyRegex: 'Bot ready|Bot online' },
      variables: [
        { env: 'BOT_TOKEN', label: 'Токен бота', default: 'demo-token', userEditable: true, rules: 'string' },
      ],
    }),
    base({
      key: 'python-bot',
      name: 'Python 3.12',
      description: 'Python-приложение: парсеры, боты, воркеры. Запускается в изолированном каталоге сервера.',
      category: 'python',
      color: '#a3a3a3',
      startup: 'python3 -u "{{BASE}}/demo/python-bot.py" --name "{{SERVER_NAME}}"',
      image: 'ghcr.io/pterodactyl/yolks:python_3.12',
      config: { stopCommand: 'stop', stopTimeout: 10, readyRegex: 'Bot online' },
      variables: [],
    }),
    base({
      key: 'generic',
      name: 'Универсальный (своя команда)',
      description: 'Для любого бинарника или скрипта: укажи стартовую команду. Работает всё, кроме специфичных для игры регулярок.',
      category: 'generic',
      color: '#737373',
      startup: 'node "{{BASE}}/demo/bot-mock.js" --name "{{SERVER_NAME}}"',
      image: 'ghcr.io/pterodactyl/yolks:debian',
      config: { stopCommand: 'stop', stopTimeout: 10, readyRegex: 'Bot ready|Bot online|listening' },
      variables: [],
    }),
  ];
}

/** Готовый egg_* из пользовательского JSON (вкладка «Шаблоны»). */
function fromSpec(spec) {
  const clean = base({
    key: spec.key || 'custom',
    name: String(spec.name || 'Свой шаблон').slice(0, 80),
    description: String(spec.description || '').slice(0, 600),
    category: spec.category || 'generic',
    color: spec.color || '#94a3b8',
    startup: String(spec.startup || 'echo hello').slice(0, 800),
    image: spec.image || 'ghcr.io/pterodactyl/yolks:debian',
    allowStartupOverride: spec.allowStartupOverride !== false,
  });
  clean.config = { ...clean.config, ...(spec.config || {}) };
  clean.variables = Array.isArray(spec.variables)
    ? spec.variables
      .filter((v) => v && v.env)
      .slice(0, 30)
      .map((v) => ({
        env: String(v.env).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 40),
        label: String(v.label || v.env).slice(0, 80),
        default: String(v.default ?? '').slice(0, 500),
        userEditable: v.userEditable !== false,
        rules: v.rules || 'string',
      }))
    : [];
  return clean;
}

module.exports = { templates, fromSpec };
