// 重新生成 compat-signatures.mjs（内容指纹表）。
// 运行：node scripts/gen-compat-signatures.mjs
// 前置：config.json 中配置 compatGames（规则键 -> 本机游戏 ID 列表，见 config.example.json），
//       且 data/games.json 中已有对应游戏记录（sourcePath/webRoot 指向可读取的游戏目录）。
// 产物：compat-signatures.mjs —— 只含内容指纹，不含任何游戏 ID，可安全提交。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_FILE = process.env.RPG_CONFIG ? path.resolve(process.env.RPG_CONFIG) : path.join(ROOT, 'config.json');
const GAMES_FILE = path.join(ROOT, 'data', 'games.json');
const OUT_FILE = path.join(ROOT, 'compat-signatures.mjs');

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const RULES = config.compatGames || {};
if (!Object.keys(RULES).length) {
  console.error('config.compatGames 为空：先在 config.json 中配置规则键 -> 游戏 ID 列表。');
  process.exit(1);
}

function fingerprint(game) {
  const root = game.webRoot && game.webRoot !== '.' ? path.join(game.sourcePath, game.webRoot) : game.sourcePath;
  const read = (f) => fs.readFileSync(path.join(root, f));
  let index = null, main = null;
  try { index = read('index.html'); main = read('js/main.js'); } catch {}
  if (index && main) {
    return 'sha256:' + crypto.createHash('sha256').update(String(index.length) + '|').update(index).update('|').update(String(main.length)).update('|').update(main).digest('hex');
  }
  // KRKR（data.xp3）等无 index.html 的游戏：data.xp3 头部指纹（大小 + 前 256KB）。
  const head = Buffer.alloc(262144);
  const fd = fs.openSync(path.join(root, 'data.xp3'), 'r');
  try {
    const bytesRead = fs.readSync(fd, head, 0, head.length, 0);
    const stat = fs.fstatSync(fd);
    return 'krkr-sha256:' + crypto.createHash('sha256').update(String(stat.size) + '|').update(head.subarray(0, bytesRead)).digest('hex');
  } finally { fs.closeSync(fd); }
}

const games = JSON.parse(fs.readFileSync(GAMES_FILE, 'utf8'));
const byId = new Map(games.map((g) => [g.id, g]));
const table = {};
const missing = [];
for (const [key, ids] of Object.entries(RULES)) {
  const sigs = [];
  for (const id of ids) {
    const game = byId.get(id);
    if (!game) { missing.push(`${key}: ${id}`); continue; }
    try { sigs.push(fingerprint(game)); }
    catch (e) { missing.push(`${key}: ${id} (${e.code || e.message})`); }
  }
  if (sigs.length) table[key] = [...new Set(sigs)].sort();
}
const lines = [
  '// 兼容规则内容指纹表（由 scripts/gen-compat-signatures.mjs 生成，勿手改）。',
  '// 值 = 游戏 index.html + js/main.js 的 SHA-256（带长度分隔）；任何用户导入同一版本游戏即命中。',
  'export const COMPAT_SIGNATURES = ' + JSON.stringify(table, null, 2) + ';\n',
];
fs.writeFileSync(OUT_FILE, lines.join('\n'));
console.log(`written ${OUT_FILE}`);
console.log('rules:', Object.keys(table).length, 'signatures:', Object.values(table).reduce((a, b) => a + b.length, 0));
if (missing.length) console.log('missing/unreadable:', missing.join('; '));
