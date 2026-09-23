// JsScript64Set 覆写与接线回归（合成夹具，不依赖真实游戏）。
// JsScript64Set.js（Thirop ParticleEditor 开发工具）与 JsScript76Set 字节级同一坏块
//（帮助模板 2 处未闭合字符串）→ 整个插件 SyntaxError。修复 = 复用同一修复器；插件本体在
// 三重 isNwjs/test 守卫后惰性，浏览器侧修复不引入行为差。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixJsScript76Set } from '../js-script-fix.mjs';

// 与模块中一致的损坏形态
const BAD = "var file = '/*'+':\\n * @help \r\n        file += '\\n * @requiredAssets img/particles/'+images[i];\r\n    }";
const GOOD = "var file = '/*'+':\\n * @help \\n';";
test('JsScript64Set 同款坏块（2 处）→ 修复器全文替换且幂等', () => {
  const source = `// JsScript64Set（合成夹具）\nfunction writeHelpFile(){ ${BAD} };\nfunction writeHelpFile2(){ ${BAD} };`;
  const out = fixJsScript76Set(source);
  assert.notEqual(out, source);
  assert.equal(out.split(GOOD).length - 1, 2, '两处 GOOD 替换');
  assert.equal(fixJsScript76Set(out), out, '幂等');
  assert.equal(fixJsScript76Set('var x=1;'), 'var x=1;', '非命中不动');
});

test('server 接线：serve 函数 / 分发 / 版本项', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /async function serveJsScript64SetCompat\(req,res,gameRoot,loadSession\)/, 'serve 函数缺失');
  assert.match(server, /JsScript64Set\.js'\)return await serveJsScript64SetCompat/, 'dispatch 缺失');
  assert.match(server, /JsScript64Set:'jsscript64-1'/, '版本项缺失');
});

console.log(JSON.stringify({ ok: true, jsscript64Fix: true, routesWired: true, versionBumped: true }));
