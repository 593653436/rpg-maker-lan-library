// SubFolderPicture.js 浏览器化回归（合成夹具）。
// listFolderImages 用 fs.readdirSync 枚举 img/pictures/<folder> → 浏览器返回 [] →
// showPicture(id, 'folder/undefined') → 1×1 占位图（回想内 HD CG 不显示）。
// 变换替换为 /api/picture-dir 目录列表桥（服务端做过滤/排序/剥扩展名/去重）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { subFolderPictureBrowserCompat } from '../gallery-unlock-compat.mjs';

const FIXTURE = `// SubFolderPicture.js（合成夹具）
function listFolderImages(folder) {
    var result = [];
    try {
        var _fs = require('fs');
        var _path = require('path');
        var base = _path.join(process.mainModule.path, 'img', 'pictures', folder);
        result = _fs.readdirSync(base).filter(function (f) { return /\\.png$/i.test(f); });
        } catch (e) {}
    return result;
    }
`;
const src = FIXTURE;
const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const gid = 'testgame';

// 0) 夹具锚点：恰好两处 require（fs, path）
assert.equal((src.match(/require\(/g) || []).length, 2, 'expected exactly 2 require calls');

const out = subFolderPictureBrowserCompat(src, gid);
assert.notEqual(out, src, 'transform must apply');
assert.doesNotMatch(out, /require\s*\(/, 'no require left');
assert.doesNotMatch(out, /process\.mainModule/, 'no process.mainModule left');
assert.match(out, /__mistListPictureDir\(folder\)/, 'readdir bridged');
assert.match(out, /api\/picture-dir/, 'bridge route referenced');
assert.equal(subFolderPictureBrowserCompat(out, gid), out, 'idempotent');
new vm.Script(out); // 语法校验

// 负样本
assert.equal(subFolderPictureBrowserCompat('var x = 1;', gid), 'var x = 1;');
assert.equal(subFolderPictureBrowserCompat(src, ''), src);

// server 接线
assert.match(server, /subFolderPictureBrowserCompat/, 'serve compat missing');
assert.match(server, /TitleExtra\|CGGallery\|EventGallery\|SubFolderPicture/, 'dispatch branch missing');
assert.match(server, /SubFolderPicture:'subfolder-picture-1'/, 'version entry missing');
assert.match(server, /jpe\?g/, 'picture-dir filter must cover jpg/jpeg');
assert.match(server, /seen\.has\(b\)/, 'picture-dir dedupe missing');

// 行为仿真：桥可用时返回 basename 数组（去 folder 前缀）
{
  const fnM = out.match(/function listFolderImages\(folder\) \{[\s\S]*?\n    \}/);
  assert.ok(fnM, 'listFolderImages not extractable');
  const sb = {};
  sb.console = { error() {} };
  sb.__mistListPictureDir = () => ['h_scene_02/01', 'h_scene_02/02', 'h_scene_02/03'];
  vm.createContext(sb);
  vm.runInContext(fnM[0], sb);
  assert.equal(vm.runInContext('JSON.stringify(listFolderImages("h_scene_02"))', sb), '["01","02","03"]');
  // 桥内部故障 → 保持原 catch 语义返回 []
  const sb2 = {};
  sb2.console = { error() {} };
  sb2.__mistListPictureDir = () => { throw new Error('down'); };
  vm.createContext(sb2);
  vm.runInContext(fnM[0], sb2);
  assert.equal(vm.runInContext('JSON.stringify(listFolderImages("h_scene_02"))', sb2), '[]');
}

console.log(JSON.stringify({ ok: true, subFolderPicture: true, noRequireLeft: true, idempotent: true, routesWired: true, versionBumped: true, bridgeBehavior: true }));
