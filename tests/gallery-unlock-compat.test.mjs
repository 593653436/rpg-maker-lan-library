// 图鉴解锁三件套（TitleExtra/CGGallery/EventGallery）浏览器化回归（合成夹具）。
// 三个插件原版 require('fs') 读写 save/<Name>_unlocks.json → 浏览器 ReferenceError
//（被各自 catch 吞掉）→ 标题按钮不显示 / 图鉴全锁。变换替换为 HTTP 桥。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { galleryUnlockBrowserCompat, UNLOCK_FILE_NAMES } from '../gallery-unlock-compat.mjs';

const readdirExtra = `function refreshGallery(entry) {
    var _unlockedFiles = [];
    if (_fs && _path) {
        try {
            var _files = _fs.readdirSync(_path.join(_base, 'img', 'pictures', entry.fileName));
            _unlockedFiles = _files.filter(function (fp) { return !!this._unlocks[fp]; }, this);
        } catch (e) {}
    }
    return _unlockedFiles;
    }
`;
const fixtureOf = (name) => `// ${name}.js（合成夹具：重现 fs/path 解锁文件读写形态，不含任何真实插件代码）
var _fs, _path, UNLOCK_FILE;
_fs = require('fs');
_path = require('path');
var _base = _path.dirname(process.mainModule.filename);
UNLOCK_FILE = _path.join(_base, 'save', '${name}_unlocks.json');
function _loadUnlocks() {
    var data = {};
    try {
        data = JSON.parse(_fs.readFileSync(UNLOCK_FILE, 'utf8') || '{}');
        } catch (e) { data = {}; }
    return data;
    }
function _saveUnlocks(data) {
    try {
        _fs.writeFileSync(UNLOCK_FILE, JSON.stringify(data || {}));
        } catch (e) {}
    }
${name === 'CGGallery' ? readdirExtra : ''}`;

const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const gid = 'testgame';

for (const name of ['TitleExtra', 'CGGallery', 'EventGallery']) {
  const src = fixtureOf(name);
  // 0) 夹具锚点：恰好两处 require（fs, path）
  assert.equal((src.match(/require\(/g) || []).length, 2, `${name}: expected exactly 2 require calls`);
  const out = galleryUnlockBrowserCompat(src, gid, name);
  assert.notEqual(out, src, `${name}: transform must apply`);
  assert.doesNotMatch(out, /require\s*\(/, `${name}: no require left`);
  assert.doesNotMatch(out, /process\.mainModule/, `${name}: no process.mainModule left`);
  assert.match(out, /__mistUnlockGet\(UNLOCK_FILE\)/, `${name}: load bridged`);
  assert.match(out, /__mistUnlockPut\(UNLOCK_FILE, data\)/, `${name}: save bridged`);
  assert.match(out, new RegExp(`UNLOCK_FILE = "${name}_unlocks\\.json"`), `${name}: unlock file name pinned`);
  assert.match(out, /api\/game-unlocks/, `${name}: bridge route referenced`);
  if (name === 'CGGallery') {
    assert.match(out, /__mistListPictureDir\(entry\.fileName\)/, 'CGGallery: readdir bridged');
  } else {
    assert.doesNotMatch(out, /__mistListPictureDir\(entry/, `${name}: no picture-dir call injected`);
  }
  assert.equal(galleryUnlockBrowserCompat(out, gid, name), out, `${name}: idempotent`);
  new vm.Script(out); // 语法校验
}

// 负样本
assert.equal(galleryUnlockBrowserCompat('var x = 1;', gid, 'TitleExtra'), 'var x = 1;');
assert.equal(galleryUnlockBrowserCompat('function _loadUnlocks(){return {}}', gid, 'Nope'), 'function _loadUnlocks(){return {}}');
assert.equal(UNLOCK_FILE_NAMES.has('CGGallery_unlocks.json'), true);

// server 接线
assert.match(server, /serveGalleryUnlockCompat/, 'serve compat missing');
assert.match(server, /game-unlocks/, 'unlock route missing');
assert.match(server, /picture-dir/, 'picture-dir route missing');
assert.match(server, /TitleExtra\|CGGallery\|EventGallery/, 'dispatch branch missing');
assert.match(server, /TitleExtra:'title-extra-1'/, 'version entry missing (TitleExtra)');
assert.match(server, /CGGallery:'cggallery-1'/, 'version entry missing (CGGallery)');
assert.match(server, /EventGallery:'eventgallery-1'/, 'version entry missing (EventGallery)');

// 行为仿真：桥可用时 load/save 走 XHR 桥
{
  const out = galleryUnlockBrowserCompat(fixtureOf('TitleExtra'), gid, 'TitleExtra');
  const loadM = out.match(/function _loadUnlocks\(\) \{[\s\S]*?\n    \}/);
  const saveM = out.match(/function _saveUnlocks\(data\) \{[\s\S]*?\n    \}/);
  assert.ok(loadM && saveM, 'bridge functions not extractable');
  const sb = {};
  sb.__mistUnlockGet = () => ({ 1: true });
  sb.__mistUnlockPut = (n, d) => { sb.__saved = n + '|' + JSON.stringify(d); };
  vm.createContext(sb);
  vm.runInContext(`var UNLOCK_FILE='TitleExtra_unlocks.json';` + loadM[0] + '\n' + saveM[0], sb);
  assert.equal(vm.runInContext('JSON.stringify(_loadUnlocks())', sb), '{"1":true}');
  vm.runInContext('_saveUnlocks({2:true})', sb);
  assert.equal(sb.__saved, 'TitleExtra_unlocks.json|{"2":true}');
}

console.log(JSON.stringify({ ok: true, titleExtra: true, cgGallery: true, eventGallery: true, noRequireLeft: true, idempotent: true, routesWired: true, versionsBumped: true, bridgeBehavior: true }));
