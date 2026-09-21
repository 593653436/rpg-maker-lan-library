// mist: 回归测试 —— 旧游戏插件 hook DataManager.loadDataFile 时使用
// `src.contains(...)`（Firefox 旧别名，Chromium/Node 均无）→ 首个调用即 TypeError →
// 数据库加载循环中断 → 卡 Scene_Boot。
// server.mjs 通过 legacyStringPolyfillCompat() 向核心脚本注入别名。本测试复现崩溃并验证修复。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

test('missing String.prototype.contains reproduces the crash; the polyfill fixes it', () => {
  const ctx = vm.createContext({});
  vm.runInContext(`delete String.prototype.contains;`, ctx);
  let threw = false, errName = '';
  try {
    vm.runInContext(`('System.json').contains('Test_TrpParticles')`, ctx);
  } catch (e) {
    threw = true;
    errName = e && e.name; // 跨 realm 时 instanceof 恒 false，用 name 判定
  }
  assert.ok(threw, 'expected a TypeError without the alias');
  assert.equal(errName, 'TypeError');

  const snippet = `if(typeof String!=='undefined'&&!String.prototype.contains){String.prototype.contains=String.prototype.includes}`;
  vm.runInContext(snippet, ctx);
  assert.equal(vm.runInContext(`('Test_TrpParticles.json').contains('Test_TrpParticles')`, ctx), true);
  assert.equal(vm.runInContext(`('System.json').contains('Test_TrpParticles')`, ctx), false);
  // 幂等：重复执行不报错、不覆盖
  vm.runInContext(snippet, ctx);
  assert.equal(vm.runInContext(`('abc').contains('b')`, ctx), true);
});

test('server.mjs defines the polyfill and injects it into the core compat chain', () => {
  const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('function legacyStringPolyfillCompat()'), 'server.mjs 缺少函数定义');
  assert.ok(src.includes('String.prototype.contains=String.prototype.includes'), '缺少 polyfill 片段');
  assert.ok(src.includes('Buffer.from(legacyStringPolyfillCompat())'), '注入链未引用 polyfill');
});
