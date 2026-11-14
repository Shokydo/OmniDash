'use strict';
/**
 * Демо-бот для OmniDash: показывает консоль, heartbeat, статистику и команды.
 * Реальный процесс Node.js — панель считает его CPU/RAM/uptime честно.
 */
const readline = require('readline');

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1];
}
const NAME = args.name || 'bot';
const C = { reset: '\u001b[0m', gray: '\u001b[90m', green: '\u001b[32m', cyan: '\u001b[36m', red: '\u001b[31m' };
const log = (l) => process.stdout.write(l + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopped = false;
let messages = 0;

const memoryHolder = Buffer.alloc(24 * 1024 * 1024, 3);
setInterval(() => { memoryHolder[Math.floor(Math.random() * memoryHolder.length)] = 1; }, 4000);

(async function boot() {
  log(`${C.gray}[boot] запуск демо-бота «${NAME}»${C.reset}`);
  await sleep(400);
  log(`${C.gray}[boot] загрузка модулей: discord.js, express, dotenv${C.reset}`);
  await sleep(500);
  log(`${C.green}[Bot ready] ${NAME} подключён к Discord (демо-режим)${C.reset}`);
  log(`${C.gray}[info] серверов: 3 | пользователей: 128 | команд: 14${C.reset}`);

  setInterval(() => {
    if (stopped) return;
    messages += Math.floor(Math.random() * 6) + 1;
    log(`${C.gray}[heartbeat] ping=${(Math.random() * 20 + 18).toFixed(0)}ms | guilds=3 | messages=${messages}${C.reset}`);
  }, 15000);
  setInterval(() => {
    if (stopped) return;
    log(`${C.cyan}[command] /play список -> 3 сервера онлайн${C.reset}`);
  }, 23000);
})();

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  const [cmd, ...rest] = line.split(/\s+/);
  const tail = rest.join(' ');
  if (cmd === 'stop' || cmd === 'shutdown') {
    stopped = true;
    log(`${C.red}[shutdown] остановка бота «${NAME}»${C.reset}`);
    setTimeout(() => process.exit(0), 400);
  } else if (cmd === 'say') {
    log(`${C.green}[say] ${tail}${C.reset}`);
  } else if (cmd === 'reload') {
    log(`${C.gray}[reload] команды перезагружены${C.reset}`);
  } else if (cmd === 'status') {
    log(`Бот: ${NAME} | uptime: ${Math.round(process.uptime())}с | rss: ${Math.round(process.memoryUsage().rss / 1048576)} МБ | сообщений: ${messages}`);
  } else if (cmd === 'help') {
    log('Команды: status, say <текст>, reload, help, stop');
  } else {
    log(`${C.gray}[console] неизвестная команда: ${line}${C.reset}`);
  }
});

process.on('SIGTERM', () => {
  log(`${C.gray}[shutdown] SIGTERM${C.reset}`);
  process.exit(0);
});
