// TS_CommonSave 浏览器化回归（合成夹具）。
// 浏览器无 require（try 内被 catch），随后 `if (json)` 引用未声明的 json → ReferenceError
// 逃出 try → DataManager.createGameObjects 崩 → Scene_Boot 启动失败（加载报错）。
// 修复：load/save 改走 mist MV 存档桥（StorageManager.saveCommonSave/loadCommonSave）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { tsCommonSaveBrowserCompat } from '../common-save-compat.mjs';

const FIXTURE = `// TS_CommonSave（合成夹具：fs 读写 + load 中未声明 json 赋值）
var CommonSave = function() {};
CommonSave.prototype.save = function() {
    var data = JSON.stringify(this._mData);
    var _fs = require('fs');
    _fs.writeFileSync(StorageManager.localFilePath(), LZString.compressToBase64(data));
};
CommonSave.prototype.load = function() {
    try {
        var _fs = require('fs');
        var raw = _fs.readFileSync(StorageManager.localFilePath(), 'utf8');
        json = LZString.decompressFromBase64(raw);
    } catch (e) {
        console.error(e);
    }
    if (json) {
        this._mData = JSON.parse(json);
    } else {
        this._mData = {};
    }
};
CommonSave.prototype.localFilePath = function() { return 'save/common.rmmzsave'; };
$CommonSave = new CommonSave();
`;
const real = FIXTURE;
const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

// 0) 夹具锚点：load 里 `json` 是未声明赋值（无 var）
assert.match(real, /CommonSave\.prototype\.load = function\(\) \{/, 'load anchor missing');
assert.match(real, /require\('fs'\)/, 'fs require missing');
assert.match(real, /\n[ \t]*json = LZString\.decompressFromBase64/, 'undeclared json assignment missing');

// 1) server 接线：导入 + 路由函数 + 分发 + 版本段
assert.match(server, /tsCommonSaveBrowserCompat/, 'import missing');
assert.match(server, /async function serveTSCommonSaveCompat\(req,res,gameRoot,loadSession\)/, 'serve fn missing');
assert.match(server, /if\(sub==='\/js\/plugins\/TS_CommonSave\.js'\)return await serveTSCommonSaveCompat\(/, 'dispatch missing');
assert.match(server, /TS_CommonSave:'tscommonsave-1'/, 'version entry missing');

// 2) 变换作用于夹具
const out = tsCommonSaveBrowserCompat(real);
assert.notEqual(out, real, 'fixture must hit the transform');
assert.doesNotMatch(out, /require\s*\(\s*['"]fs['"]\s*\)/, 'require removed');
assert.match(out, /StorageManager\.saveCommonSave\(json\)/);
assert.match(out, /StorageManager\.loadCommonSave\(\)/);
assert.match(out, /var json = null/);
assert.match(out, /__mistTSCommonSaveBrowserCompat = true/);
assert.equal(tsCommonSaveBrowserCompat(out), out, 'idempotent');
assert.equal(tsCommonSaveBrowserCompat('var x = 1;'), 'var x = 1;', 'unrelated untouched');

// 3) 行为仿真
const grabMethod = (src, name) => {
  const m = src.match(new RegExp(`CommonSave\\.prototype\\.${name} = function\\(\\) \\{[\\s\\S]*?\\n[ \\t]*\\};`));
  assert.ok(m, `${name} not extractable`);
  return m[0];
};
const makeCtx = (bridge) => {
  const sb = {
    StorageManager: bridge, console, JSON,
    LZString: { compressToBase64: (s) => 'ZZ' + s, decompressFromBase64: (s) => String(s).startsWith('ZZ') ? String(s).slice(2) : null },
  };
  vm.createContext(sb);
  vm.runInContext('var CommonSave = function() {};', sb);
  return sb;
};
// 3a) 原始 load（浏览器，无 require）→ 必须抛（复现启动崩）
{
  const sb = makeCtx({ localFilePath: () => '/tmp/' });
  vm.runInContext(grabMethod(real, 'load'), sb);
  const cs = new sb.CommonSave();
  assert.throws(() => cs.load(), /json|require/, 'original must throw');
}
// 3b) 修复后 load + 桥中有数据 → 正常解析
{
  const sb = makeCtx({ localFilePath: () => '/tmp/', loadCommonSave: () => '{"flag01":true}' });
  vm.runInContext(grabMethod(out, 'load'), sb);
  const cs = new sb.CommonSave();
  cs.load();
  assert.deepEqual(JSON.parse(JSON.stringify(cs._mData)), { flag01: true });
}
// 3c) 修复后 load + 桥中无数据 → 空对象（不再崩）
{
  const sb = makeCtx({ localFilePath: () => '/tmp/', loadCommonSave: () => null });
  vm.runInContext(grabMethod(out, 'load'), sb);
  const cs = new sb.CommonSave();
  cs.load();
  assert.deepEqual(JSON.parse(JSON.stringify(cs._mData)), {});
}
// 3d) 修复后 save → 以纯 JSON 调桥
{
  let saved = null;
  const sb = makeCtx({ saveCommonSave: (j) => { saved = j; }, loadCommonSave: () => null });
  vm.runInContext(grabMethod(out, 'save'), sb);
  const cs = new sb.CommonSave();
  cs._mData = { a: 1 };
  cs.save();
  assert.equal(saved, '{"a":1}');
}

console.log(JSON.stringify({
  ok: true, fixtureAnchorMatched: true, requireRemoved: true, versionEntry: true, dispatch: true,
  originalCrashReproduced: true, bridgeLoadRoundTrip: true, bridgeEmptyFallback: true, bridgeSavePlainJson: true
}));
