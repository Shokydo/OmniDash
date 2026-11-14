'use strict';
/**
 * Dev-раннер OmniDash: `npm run dev`
 *
 * • серверная часть (server.js, core/**) — перезапуск процесса при изменении;
 * • интерфейс (public/**) — перезагрузка вкладок браузера через SSE-событие
 *   `reload`, которую рассылает core/updater.js (автообновление как в OmniPanel);
 * • ctrl+c останавливает и дочерний сервер, и процессы серверов панели.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER_FILES = ['server.js', path.join('core')];
const PORT = process.env.PORT || 7777;

let child = null;
let restarting = false;
let timer = null;

function start() {
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, OMNIDASH_DEV: '1', PORT },
  });
  child.on('exit', (code, signal) => {
    if (restarting) return;
    if (signal) return;
    if (code && code !== 0) {
      console.log(`\n[dev] сервер завершился с кодом ${code}, ждём изменений…`);
    }
    child = null;
  });
}

function restart(reason) {
  if (restarting) return;
  restarting = true;
  console.log(`\n[dev] изменение: ${reason} — перезапуск панели…`);
  const done = () => {
    setTimeout(() => {
      restarting = false;
      start();
    }, 350);
  };
  const proc = child;
  if (proc) {
    proc.once('exit', done);
    proc.kill('SIGTERM');
    setTimeout(() => {
      // важно: proc, а не child — иначе убьём уже перезапущенный процесс
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }, 3000);
  } else {
    done();
  }
}

function schedule(reason) {
  clearTimeout(timer);
  timer = setTimeout(() => restart(reason), 400);
}

const targets = [path.join(ROOT, 'server.js'), path.join(ROOT, 'core'), path.join(ROOT, 'version.json')];
for (const target of targets) {
  if (!fs.existsSync(target)) continue;
  try {
    fs.watch(target, { recursive: true }, (event, file) => {
      if (!file || /(\.log$|\.tmp$|~$|db\.json)/.test(String(file))) return;
      schedule(path.relative(ROOT, path.join(target, String(file))));
    });
  } catch (err) {
    console.log('[dev] не удалось следить за', target, err.message);
  }
}

process.on('SIGINT', () => {
  console.log('\n[dev] остановка…');
  if (child) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1200);
});
process.on('SIGTERM', () => {
  if (child) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1200);
});

console.log(`[dev] OmniDash dev-режим · http://localhost:${PORT} · следим за server.js и core/`);
start();
