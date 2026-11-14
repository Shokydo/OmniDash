'use strict';
/**
 * Сборка пакета обновления OmniDash — без GitHub, как и обещано.
 *
 *   npm run update                              # пересобрать текущую версию
 *   npm run update -- --notes "что нового"      # с описанием
 *   npm run update -- --bump 1.0.1 --notes "…"  # поднять версию и собрать
 *   npm run update -- --bump 1.1.0 --channel beta
 *
 * Результат:
 *   updates/omnidash-<версия>.zip   — код панели (без data/ и node_modules/)
 *   updates/update.json             — манифест для проверки обновлений
 *
 * Дальше: Настройки → Обновления → «Проверить обновления» → «Применить».
 * Панель сделает ZIP-бэкап кода в data/updates/ и перезагрузит интерфейс.
 */
const fs = require('fs');
const path = require('path');
const zip = require('../core/zip');
const { sha256, fmtBytes } = require('../core/util');

const ROOT = path.join(__dirname, '..');
const UPDATES = path.join(ROOT, 'updates');
const args = process.argv.slice(2);

function arg(name, fallback = '') {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return fallback;
  return args[idx + 1] || fallback;
}
const has = (name) => args.includes(`--${name}`);

const pkgFile = path.join(ROOT, 'package.json');
const versionFile = path.join(ROOT, 'version.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const release = JSON.parse(fs.readFileSync(versionFile, 'utf8'));

const bump = arg('bump', '');
if (bump) {
  if (!/^\d+\.\d+\.\d+$/.test(bump)) {
    console.error('Версия должна быть в формате X.Y.Z, например --bump 1.0.1');
    process.exit(1);
  }
  pkg.version = bump;
  release.version = bump;
  release.at = new Date().toISOString();
  if (arg('notes')) release.notes = arg('notes');
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(versionFile, JSON.stringify(release, null, 2) + '\n');
  console.log(`версия поднята → v${bump}`);
}

const version = release.version || pkg.version;
const notes = arg('notes', release.notes || '');
const channel = arg('channel', release.channel || 'stable');
const at = new Date().toISOString();

const includeFiles = ['server.js', 'package.json', 'version.json', 'README.md'];
const includeDirs = ['core', 'public', 'demo', 'tools', 'docs'];
const ignore = [
  /^data\//, /^updates\//, /^node_modules\//, /^tests\//, /^\.git/,
  /(^|\/)\.DS_Store$/, /\.log$/, /\.zip$/, /(^|\/)tmp\//,
];

fs.mkdirSync(UPDATES, { recursive: true });
const entries = [];

for (const name of includeFiles) {
  const abs = path.join(ROOT, name);
  if (!fs.existsSync(abs)) continue;
  const stat = fs.statSync(abs);
  entries.push({ name, data: fs.readFileSync(abs), mtime: stat.mtimeMs });
}

for (const dir of includeDirs) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const entry of zip.walk(abs, ROOT, [], (full, rel) => !ignore.some((re) => re.test(rel)))) {
    if (entry.dir) continue;
    entries.push(entry);
  }
}

if (!entries.some((e) => e.name === 'server.js')) {
  console.error('Не найден server.js — запустите скрипт из корня проекта');
  process.exit(1);
}

const buf = zip.write(entries);
const fileName = `omnidash-${version}.zip`;
fs.writeFileSync(path.join(UPDATES, fileName), buf);

const manifest = {
  version,
  channel,
  at,
  notes,
  package: `updates/${fileName}`,
  size: buf.length,
  sha256: sha256(buf),
};
fs.writeFileSync(path.join(UPDATES, 'update.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log('');
console.log('  OmniDash · пакет обновления');
console.log(`  версия   v${version} (${channel})`);
console.log(`  файлов   ${entries.length}`);
console.log(`  размер   ${fmtBytes(buf.length)}`);
console.log(`  файл     updates/${fileName}`);
console.log(`  sha256   ${manifest.sha256.slice(0, 16)}…`);
console.log(`  манифест updates/update.json`);
console.log('');
console.log('  Применить: панель → Обновления → «Проверить обновления» → «Применить».');
if (has('bump')) console.log('  Не забудьте перезапустить процесс, если менялись core/ или server.js.');
