// mist: 盗版重打包“引流标记”代码剥离测试。
// 部分盗版整合会在插件内注入写标记文件的 NW.js 代码（base64 文件名 + fs.openSync）；
// 浏览器顶层执行 `require` 未定义 → 整个插件 IIFE 中断 → 依赖它的插件连锁崩溃。
// 响应层用 stripPirateMarkerCode 精确识别该已知形态并剥离。夹具为原创合成代码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripPirateMarkerCode } from '../pirate-marker-strip.mjs';

const FIXTURE = [
  'a();',
  'const fs = require("fs");',
  "const base64String = 'VGVsZWdyYW1AcXV6aW1pbmd5dWU=';",
  "const originalString = Buffer.from(base64String, 'base64').toString('utf8');",
  '',
  'if(!fs.existsSync(originalString)) {',
  "    fs.openSync(originalString, 'w');",
  '}',
  'b();',
  ''
].join('\n');

test('strips the known marker block and preserves surrounding code', () => {
  const output = stripPirateMarkerCode(FIXTURE);
  assert.ok(output, '应检测到标记');
  assert.ok(!output.includes('base64String') && !output.includes('openSync('), '标记应被剥离');
  assert.ok(output.includes('a();') && output.includes('b();'), '前后代码应保留');
});

test('sources without the complete marker shape are left untouched (null)', () => {
  assert.equal(stripPirateMarkerCode('function x(){ return require("fs").existsSync("a"); }'), null);
  assert.equal(stripPirateMarkerCode('const base64String = "dGVzdA==";'), null, '部分特征不足以触发');
  assert.equal(stripPirateMarkerCode(''), null);
});

test('idempotent on already-stripped output', () => {
  const once = stripPirateMarkerCode(FIXTURE);
  assert.equal(stripPirateMarkerCode(once), null);
});
