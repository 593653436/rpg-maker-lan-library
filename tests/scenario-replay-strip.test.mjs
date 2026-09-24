// mist: TS_ReplayMode 残留死代码剥离（stripVestigialFsRequires）合成单测 + 版本推进守卫。
// 从 scenario-compat.mjs 提取真实函数在 vm 中执行（纯合成，无真实游戏）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const scenario = fs.readFileSync(new URL('../scenario-compat.mjs', import.meta.url), 'utf8');

test('stripVestigialFsRequires removes the dead fs require only in the exact adjacent form', () => {
  const src = /function stripVestigialFsRequires\(source\) \{[\s\S]*?\n\}/.exec(scenario);
  assert.ok(src, 'stripVestigialFsRequires source missing');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src[0], ctx);
  // 精确相邻形态：fs 行 + filepath 行 + 注释死读 + ADV 桥读取 → 整行移除
  const vestigial = '        var fs = require(\'fs\');\n' +
    '        var filepath = this.localFileDirectoryPath() + \'scene.txt\';\n' +
    '        // var file_data = fs.readFileSync(filepath, \'utf-8\');\n' +
    '        var file_data = ADV_System.prototype.fileLoad(filename);';
  const out = ctx.stripVestigialFsRequires(vestigial);
  assert.doesNotMatch(out, /require\s*\(\s*['"]fs['"]\s*\)/, '死代码 fs 行应被移除');
  assert.match(out, /ADV_System\.prototype\.fileLoad/, '实际桥读取应保留');
  assert.match(out, /var filepath = this\.localFileDirectoryPath\(\)/, 'filepath 行应保留');
  // 形态不符（无注释死读行）→ 原样返回，不误伤真读取
  const notVestigial = '        var fs = require(\'fs\');\n        var filepath = \'x\';\n        var file_data = 1;';
  assert.equal(ctx.stripVestigialFsRequires(notVestigial), notVestigial, '非精确形态不应改动');
});

test('plugin version table advances TS_ReplayMode to replay-mode-4 (drift guard)', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /TS_ReplayMode:'replay-mode-4'/);
});
