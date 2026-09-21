// mist: 损坏发布的插件源码修复测试（合成夹具，不包含任何真实商业插件代码）。
// 部分游戏用代码生成工具时，把“帮助文本模板”误写回自身源码，留下未终止字符串 +
// 多余片段 → 整个插件文件不解析 → 引擎启动中断。响应层精确替换损坏段（全部出现处）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixJsScript76Set } from '../js-script-fix.mjs';

// 与模块中一致的损坏形态（JS 转义层相同）
const BAD = "var file = '/*'+':\\n * @help \r\n        file += '\\n * @requiredAssets img/particles/'+images[i];\r\n    }";
const GOOD = "var file = '/*'+':\\n * @help \\n';";

test('replaces every corrupted block copy (2 sites) and keeps the rest intact', () => {
  const source = `function writeHelpFile(){ ${BAD} };\nconst ok = true;\nfunction writeHelpFile2(){ ${BAD} };`;
  const output = fixJsScript76Set(source);
  assert.ok(!output.includes(BAD), '损坏段应全部替换');
  assert.equal(output.split(GOOD).length - 1, 2, '应有两处替换');
  assert.ok(output.includes('const ok = true;'), '其余代码应保留');
});

test('sources without the corruption are returned unchanged', () => {
  const clean = 'function writeHelpFile(){ var file = ""; return file; }';
  assert.equal(fixJsScript76Set(clean), clean);
});
