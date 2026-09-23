// NW.js 工具条尾部块浏览器守卫回归（合成夹具，不依赖真实游戏）。
// 汉化/整合组常在 main.js 末尾追加 (function(){var gui=require('nw.gui');...})() 工具条。
// 浏览器无 require → 同步 ReferenceError → main.js onWindowError 记录 → window load 时
// 跳过 SceneManager.run → 黑屏。守卫仅当确认处于 NW.js（require 与 nw 同时存在）才执行该块。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const FIXTURE = `// 合成夹具：重现"整合包尾部工具条"形态（不含任何真实游戏代码）
var someFlag = false;
// ========== 完整版 ==========
(function() {
    var gui = require('nw.gui');
    var win = gui.Window.get();
    setTimeout(function(){ win.show(); }, 100);
})();
`;
const real = FIXTURE;
const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

// 0) 夹具必须命中变换锚点形态
assert.match(real, /\(function\(\) \{\n    var gui = require\('nw\.gui'\);/, 'fixture must contain the NW.js tail block');

// 1) server 必须包含守卫函数与接线
assert.match(server, /function nwGuiTailGuardCompat\(source\)\{/, 'guard function missing');
assert.match(server, /nwGuiTailGuardCompat\(hirokaMainCompat\(/, 'route wiring missing');

// 2) 提取同款变换并作用于夹具（单一事实源）
const m = server.match(/function nwGuiTailGuardCompat\(source\)\{[\s\S]*?\n\}/);
assert.ok(m, 'nwGuiTailGuardCompat not extractable');
const make = new Function(`${m[0]}\nreturn nwGuiTailGuardCompat;`)();
const out = make(real);
assert.notEqual(out, real, 'fixture must hit the transform');
assert.match(out, /\(function\(\) \{\n    if\(typeof require!=="function"\|\|typeof nw==="undefined"\)return; \/\* mist: 浏览器跳过 NW\.js 工具条 \*\/\n    var gui = require\('nw\.gui'\);/, 'guard line must sit right after the IIFE header');
assert.equal(make(out), out, 'transform must be idempotent');
assert.equal(make('var x = 1;'), 'var x = 1;', 'non-matching source untouched');

// 3) 行为仿真：取文件中工具条 IIFE 块执行
const blockOf = (src) => {
  const i = src.indexOf('(function() {');
  assert.ok(i > 0, 'tail IIFE not found');
  return src.slice(i);
};
// 3a) 原始块（浏览器环境）→ 必须 ReferenceError（复现黑屏根因）
{
  const sb = { setTimeout() {} };
  vm.createContext(sb);
  assert.throws(() => vm.runInContext(blockOf(real), sb), /require/, 'original tail must throw without require');
}
// 3b) 修复后块（浏览器环境）→ 不抛错，直接跳过
{
  const sb = { setTimeout() {} };
  vm.createContext(sb);
  assert.doesNotThrow(() => vm.runInContext(blockOf(out), sb), 'patched tail must not throw in browser');
}
// 3c) 修复后块（NW.js 环境）→ 原逻辑仍可达（require 被调用）
{
  let requireCalled = false;
  const sb = {
    require: (id) => { requireCalled = true; assert.equal(id, 'nw.gui'); return { Window: { get: () => ({ show() {} }) } }; },
    nw: {},
    setTimeout() {},
  };
  vm.createContext(sb);
  assert.doesNotThrow(() => vm.runInContext(blockOf(out), sb), 'patched tail must stay functional under NW.js');
  assert.ok(requireCalled, 'NW.js path must still call require');
}

console.log(JSON.stringify({ ok: true, fixtureAnchorMatched: true, guardInjected: true, idempotent: true, originalCrashReproduced: true, browserSkipsTail: true, desktopNwjsPreserved: true }));
