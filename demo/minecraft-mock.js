'use strict';
/**
 * Демо-сервер Minecraft для OmniDash.
 * Полноценная эмуляция консоли: старт, TPS, игроки, команды, graceful stop.
 * Реально слушает выделенный панелью порт, поэтому аллокации и лимиты
 * проверяются по-настоящему. Java для просмотра панели не нужна.
 */
const net = require('net');
const readline = require('readline');

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) args[arg.slice(2)] = process.argv[i + 1];
}
const PORT = Number(args.port || 25565);
const MEMORY = Math.max(256, Number(args.memory || 1024));
const NAME = args.name || 'world';
const SEED = args.seed || 'omnidash';

const C = {
  reset: '\u001b[0m', gray: '\u001b[90m', green: '\u001b[32m', yellow: '\u001b[33m',
  red: '\u001b[31m', cyan: '\u001b[36m', bold: '\u001b[1m',
};
const log = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stopping = false;
let players = [];
let tps = 20;
let tickCount = 0;
let allocated = 0;

// Реальный расход памяти — чтобы графики RAM были не нарисованными.
function allocate() {
  const target = Math.min(96 * 1024 * 1024, Math.floor(MEMORY * 1024 * 1024 * 0.18));
  try {
    allocated = Buffer.alloc(target, 7);
  } catch {
    allocated = Buffer.alloc(0);
  }
  setInterval(() => {
    if (!allocated.length) return;
    // трогаем страницы, чтобы RSS не схлопывался
    allocated[Math.floor(Math.random() * allocated.length)] = tickCount & 0xff;
  }, 3000);
}

const server = net.createServer((socket) => {
  socket.on('error', () => { });
  socket.end(`OmniDash demo endpoint: ${NAME} (Paper 1.21.4 emulation)\n`);
});
server.on('error', (err) => {
  log(`${C.red}[ERROR] Не удалось занять порт ${PORT}: ${err.message}${C.reset}`);
  process.exit(1);
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  const [cmd, ...rest] = line.split(/\s+/);
  const tail = rest.join(' ');
  switch (cmd.toLowerCase()) {
    case 'stop':
      if (stopping) return;
      stopping = true;
      log(`${C.yellow}[${new Date().toLocaleTimeString('ru-RU')}] INFO]: Остановка сервера${C.reset}`);
      setTimeout(() => {
        log(`${C.gray}Сервер остановлен. Сохранение мира "${SEED}"...${C.reset}`);
        server.close();
        rl.close();
        process.exit(0);
      }, 700);
      break;
    case 'say':
      log(`${C.green}[Server] ${tail}${C.reset}`);
      break;
    case 'list':
      log(`${C.gray}Игроков онлайн: ${players.length} из 20${C.reset}`);
      log(players.length ? players.map((p) => `- ${p}`).join('\n') : 'Список пуст');
      break;
    case 'tps':
      log(`TPS from last 1m, 5m, 15m: ${tps.toFixed(2)}, ${(tps - 0.3).toFixed(2)}, ${(tps - 0.6).toFixed(2)}`);
      break;
    case 'help':
      log(`${C.cyan}Доступные команды: help, list, say <текст>, tps, op <ник>, kick <ник>, status, seed, stop${C.reset}`);
      break;
    case 'status':
      log(`Мир: ${NAME} | Сид: ${SEED} | Порт: ${PORT} | TPS: ${tps.toFixed(2)} | Память: ${Math.round(allocated / 1048576)} МБ / ${MEMORY} МБ`);
      break;
    case 'seed':
      log(`Seed: [${SEED}]`);
      break;
    case 'op':
    case 'deop':
    case 'whitelist':
    case 'ban':
      log(`${C.gray}Команда "${cmd} ${tail}" выполнена${C.reset}`);
      break;
    case 'kick': {
      const idx = players.findIndex((p) => p.toLowerCase() === tail.toLowerCase());
      if (idx >= 0) {
        const [p] = players.splice(idx, 1);
        log(`Kicked ${p}: Кикнут администратором`);
      } else {
        log(`${C.red}Игрок ${tail} не найден${C.reset}`);
      }
      break;
    }
    default:
      log(`${C.red}Unknown command. Type "help" for help.${C.reset}`);
  }
});

const NAMES = ['Steve', 'Alex', 'Notch', 'Herobrine', 'Dinnerbone', 'xX_Dark_Xx', 'Kotik', 'Mira', 'Vlad', 'Sashok', 'EnderKing', 'CreeperFan'];
const randomName = () => NAMES[Math.floor(Math.random() * NAMES.length)];

function joinRandom() {
  if (players.length >= 12) return;
  const name = randomName();
  if (players.includes(name)) return;
  players.push(name);
  log(`${C.gray}[${new Date().toLocaleTimeString('ru-RU')}] INFO]: ${name} joined the game${C.reset}`);
}
function leaveRandom() {
  if (!players.length) return;
  const name = players[Math.floor(Math.random() * players.length)];
  players = players.filter((p) => p !== name);
  log(`${C.gray}[${new Date().toLocaleTimeString('ru-RU')}] INFO]: ${name} left the game${C.reset}`);
}

(async function boot() {
  allocate();
  log(`${C.gray}Загрузка Paper 1.21.4 (эмулятор OmniDash)...${C.reset}`);
  await sleep(350);
  log(`Starting org.bukkit.craftbukkit.Main`);
  log(`${C.gray}System Info: Java 21 (emulation) | ${MEMORY} MB heap${C.reset}`);
  await sleep(500);
  log(`Loading libraries, please wait...`);
  await sleep(600);
  log(`[${new Date().toLocaleTimeString('ru-RU')} INFO]: Preparing level "${NAME}" (seed: ${SEED})`);
  await sleep(700);
  server.listen(PORT, '0.0.0.0', () => {
    log(`[${new Date().toLocaleTimeString('ru-RU')} INFO]: Starting Minecraft server on 0.0.0.0:${PORT}`);
  });
  await sleep(600);
  log(`[${new Date().toLocaleTimeString('ru-RU')} INFO]: Done (2.614s)! For help, type "help"`);

  setInterval(() => {
    tickCount += 1;
    tps = Math.min(20, Math.max(18.2, tps + (Math.random() - 0.45) * 0.35));
    if (tickCount % 7 === 0) log(`[${new Date().toLocaleTimeString('ru-RU')} INFO]: TPS: ${tps.toFixed(2)} | Players: ${players.length} | RAM: ${Math.round(allocated / 1048576)} MB`);
    if (tickCount % 9 === 0) log(`${C.gray}[${new Date().toLocaleTimeString('ru-RU')} INFO]: Saving chunks...${C.reset}`);
  }, 15000);

  setInterval(() => {
    if (stopping) return;
    if (players.length < 3 || Math.random() > 0.55) joinRandom();
    else leaveRandom();
  }, 22000);

  ['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => {
    log(`${C.yellow}[OmniDash] получен ${sig}, сохраняем мир...${C.reset}`);
    server.close();
    process.exit(0);
  }));
})();
