// Chimaki_Lang (MZ 多言語 CSV 插件) 浏览器化回归（合成夹具：迷你 webpack 包）。
// webpack 内联模块 823 = require("fs")：浏览器中 parseLang 调 __webpack_require__(823) 同步
// ReferenceError → CSV 字典永不载入 → 含 \T[KEY] 的 UI 文本查表崩。修复 = fs 模块换 XHR shim。
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { chimakiLangFsCompat } from '../chimaki-lang-compat.mjs';

const FIXTURE = 'var __webpack_modules__={823:a=>{a.exports=require("fs")}},__webpack_module_cache__={};';
const src = FIXTURE;

// 0) 夹具锚点
assert.ok(src.includes('a.exports=require("fs")'), 'fs module anchor missing');

// 1) 变换
const out = chimakiLangFsCompat(src);
assert.notEqual(out, src, 'transform must apply');
assert.ok(!out.includes('require("fs")') && !out.includes("require('fs')"), 'require("fs") must be gone');
assert.ok(out.includes('__mistChimakiFs'), 'xhr shim missing');
assert.equal(chimakiLangFsCompat(out), out, 'idempotent');
assert.equal(chimakiLangFsCompat('var x=1;'), 'var x=1;', 'non-matching untouched');

// 2) 提取模块 823 工厂并在沙箱行为仿真
const a1 = out.indexOf('823:a=>{') + '823:a=>{'.length;
const a2 = out.indexOf('}},__webpack_module_cache__', a1);
assert.ok(a1 > 0 && a2 > a1, 'module 823 not extractable');
const body = out.slice(a1, a2);
assert.ok(body.includes('__mistChimakiFs'), 'module body must carry shim');

const sb = { console };
sb.open_calls = [];
sb.XMLHttpRequest = function () {
  const self = this;
  this.open = function (m, u, as) { self._u = u; sb.open_calls.push([m, u, as]); };
  this.send = function () {
    if (String(self._u).includes('missing')) { self.status = 404; self.responseText = ''; }
    else { self.status = 200; self.responseText = 'id,who,tw,cn,en\nSIS1036,コマンド,初めから,新游戏,New game'; }
  };
};
vm.createContext(sb);
vm.runInContext('mod = {exports:{}}; (new Function("a", ' + JSON.stringify(body) + '))(mod);', sb);
assert.ok(sb.mod.exports.readFile && sb.mod.exports.readFileSync, 'shim exports missing');

vm.runInContext('mod.exports.readFile("./csv/UI.csv","utf8",function(e,d){ __ok=[e,d]; });', sb);
assert.equal(sb.__ok[0], null);
assert.match(sb.__ok[1], /SIS1036/);
assert.equal(sb.open_calls[0][1], 'csv/UI.csv', 'leading ./ must be stripped');
assert.equal(sb.open_calls[0][2], false, 'must be synchronous');

vm.runInContext('mod.exports.readFile("./csv/missing.csv","utf8",function(e,d){ __err=[e,d]; });', sb);
assert.equal(sb.__err[0] && sb.__err[0].message, 'HTTP 404', 'error path must pass err to callback');
assert.equal(vm.runInContext('mod.exports.readFileSync("./csv/UI.csv")', sb).includes('SIS1036'), true);
assert.equal(vm.runInContext('mod.exports.readFileSync("./csv/missing.csv")', sb), '');

// 3) server 接线
const fs = await import('node:fs');
const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
assert.match(server, /import \{ chimakiLangFsCompat \} from '\.\/chimaki-lang-compat\.mjs';/, 'import missing');
assert.match(server, /Chimaki_Lang\.js'\)return await serveChimakiLangCompat/, 'dispatch missing');
assert.match(server, /Chimaki_Lang:'chimaki-lang-1'/, 'version entry missing');

console.log(JSON.stringify({ ok: true, fixtureAnchorMatched: true, transformApplied: true, idempotent: true, syncXhrShim: true, leadingSlashStripped: true, errorPath: true, routesWired: true, versionBumped: true }));
