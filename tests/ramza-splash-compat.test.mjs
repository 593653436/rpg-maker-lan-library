// Ramza PreTitleSplash 前导斜杠路径回归（合成夹具，不依赖真实游戏）。
// splash 参数 File 常写成 '/img/system/...'（作者文档示例即如此）→ 插件把 folder 拼成 '/img/system/'。
// NW.js 里 App 根=游戏根，绝对路径可解析；浏览器挂在 /games/<id>/ 下 → '/img/...' 落到柜根 404
// → 位图永不就绪 → Scene_Boot 卡死。修复 = 响应层把 folder 拼接结果去前导斜杠（相对路径）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const FIXTURE = `// Ramza_PreTitleSplash_MZ.js（合成夹具：仅保留取景路径拼接形态）
var Ramza = Ramza || {};
Ramza.PTS = Ramza.PTS || {};
Ramza.PTS.params = Ramza.PTS.params || {};
(function() {
    var params = PluginManager.parameters('Ramza_PreTitleSplash_MZ');
    Ramza.PTS.params.splashList = JSON.parse(params['Screens']).map(function (s) { return JSON.parse(s); });
    Ramza.PTS.params.splashList.forEach(function (splash, index) {
        var folder = this[index].File.join('/') + "/";
        var file = this[index].Name;
        ImageManager.loadBitmap(folder, file);
    }, Ramza.PTS.params.splashList);
})();
`;
const real = FIXTURE;
const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

// 0) 夹具锚点：拼接行确实存在
assert.match(real, /this\[index\]\.File\.join\('\/'\) \+ "\/"/, 'join line missing');

// 1) server 接线
assert.match(server, /function ramzaSplashPathCompat\(source\) \{/, 'pure transform missing');
assert.match(server, /Ramza_PreTitleSplash_MZ\.js'\)return await serveRamzaSplashCompat/, 'dispatch missing');
assert.match(server, /Ramza_PreTitleSplash_MZ:'ramza-splash-1'/, 'version entry missing');

// 2) 提取同款变换作用于夹具（单一事实源）
const m = server.match(/function ramzaSplashPathCompat\(source\) \{[\s\S]*?\n\}/);
assert.ok(m, 'ramzaSplashPathCompat not extractable');
const make = new Function(`${m[0]}\nreturn ramzaSplashPathCompat;`)();
const out = make(real);
assert.notEqual(out, real, 'fixture must hit the transform');
assert.match(out, /\(this\[index\]\.File\.join\('\/'\) \+ "\/"\)\.replace\(\/\^\\\/\+\/, ""\)/, 'leading slash strip must be injected');
assert.equal(make(out), out, 'idempotent');
assert.equal(make('var x = 1;'), 'var x = 1;', 'non-matching source untouched');
new vm.Script(out);

// 3) 行为仿真：取参数初始化 + forEach 块执行，看 folder 结果
const snippetOf = (src) => {
  const start = src.indexOf("Ramza.PTS.params.splashList = JSON.parse(params['Screens'])");
  const end = src.indexOf('}, Ramza.PTS.params.splashList)', start);
  assert.ok(start > 0 && end > start, 'snippet not found');
  return src.slice(start, end + '}, Ramza.PTS.params.splashList)'.length);
};
const runSnippet = (src) => {
  const captured = {};
  const sb = {
    console,
    JSON,
    PluginManager: { parameters: () => ({ Screens: JSON.stringify([JSON.stringify({ Type: 'Image', File: ['', 'img', 'system'], Name: 'Splash_saikey', CustomHold: '120' })]) }) },
    ImageManager: { loadBitmap: (folder, file) => { captured.folder = folder; captured.file = file; return { fake: true }; } },
  };
  vm.createContext(sb);
  vm.runInContext(`var params = PluginManager.parameters('x');\nRamza = { PTS: { params: {} } };\n` + snippetOf(src), sb);
  return captured;
};
// 3a) 原始：folder 带前导斜杠（复现根路径 404 根因）
const before = runSnippet(real);
assert.equal(before.folder, '/img/system/', 'original must compute root-absolute folder');
assert.equal(before.file, 'Splash_saikey');
// 3b) 修复后：folder 相对
const after = runSnippet(out);
assert.equal(after.folder, 'img/system/', 'patched must compute relative folder');
assert.equal(after.file, 'Splash_saikey');

console.log(JSON.stringify({ ok: true, fixtureAnchorMatched: true, transformApplied: true, idempotent: true, folderNormalized: true, routesWired: true, versionBumped: true }));
