// 兼容变换单测：从 server.mjs 提取纯函数在 vm 中执行（纯合成，无真实游戏）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

test('textureMaxForRequest：显式配置 > 客户端探针 > 移动 UA > 桌面兜底', () => {
  const src = /const MAX_TEXTURE_SIZE_CONFIG = Number\(config\.maxTextureSize \|\| 0\) \|\| 0;[\s\S]*?function textureMaxForRequest\(req\)\{[\s\S]*?\n\}/.exec(server);
  assert.ok(src, 'textureMaxForRequest source missing');
  const ctx = { config: {} };
  vm.createContext(ctx);
  vm.runInContext(src[0], ctx);
  const call = (headers) => ctx.textureMaxForRequest({ headers });
  assert.equal(call({}), 16384, '无提示桌面兜底');
  assert.equal(call({ 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/126 Mobile' }), 4096, '移动 UA 兜底');
  assert.equal(call({ cookie: 'a=1; mistmts=8192; b=2' }), 8192, '客户端探针');
  assert.equal(call({ cookie: 'mistmts=4096', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' }), 4096, '探针优先于 UA');
});

test('fileExistsGuardFix：产出可编译代码且含分支语义修复', () => {
  const src = /function fileExistsGuardFix\(gameId\)\{return `[\s\S]*?`\}/.exec(server);
  assert.ok(src, 'fileExistsGuardFix source missing');
  const ctx = { path: { posix: { join: (...a) => a.join('/') } } };
  vm.createContext(ctx);
  vm.runInContext(src[0], ctx);
  const out = ctx.fileExistsGuardFix('abc-123');
  assert.match(out, /__mistExists/);
  assert.match(out, /"\/games\/abc-123"/);
  assert.match(out, /_branch\[this\._indent\]/, '条件处理器必须还原分支语义');
  assert.match(out, /skipBranch/, '假分支必须跳过');
  assert.match(out, /mistprobe=1/);
  assert.doesNotThrow(() => new vm.Script(out), '生成代码必须语法合法');
});
