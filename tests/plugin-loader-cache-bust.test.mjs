// 插件加载缓存击穿（路径式版本段）单测：从 server.mjs 提取 pluginLoaderCompat 并在 vm 中执行（纯合成）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const match = /function pluginLoaderCompat\(\)\{return `([\s\S]*?)`\}/.exec(server);
assert.ok(match, 'pluginLoaderCompat source missing');
const compat = match[1].replaceAll('\\n', '\n').replaceAll('\\`', '`');

test('loadScript 兜底分支：版本段插入路径、非版本化插件原样', () => {
  const calls = [];
  const context = { PluginManager: { _path: 'js/plugins/', loadScript(name) { calls.push(this._path + name); } } };
  vm.createContext(context); vm.runInContext(compat, context);
  context.PluginManager.loadScript('TS_ReplayMode.js');
  context.PluginManager.loadScript('TS_Decode.js');
  context.PluginManager.loadScript('CommonSave.js');
  context.PluginManager.loadScript('Unrelated.js');
  assert.deepEqual(calls, [
    'js/plugins/.mistv/replay-mode-2/TS_ReplayMode.js',
    'js/plugins/.mistv/scenario-decode-2/TS_Decode.js',
    'js/plugins/.mistv/common-save-1/CommonSave.js',
    'js/plugins/Unrelated.js'
  ]);
});

test('makeUrl 分支（MZ）：版本段路径、文件名保持干净、无查询串', () => {
  const mzCalls = [];
  const mz = { PluginManager: { makeUrl(name) { return 'js/plugins/' + encodeURIComponent(name) + '.js'; }, loadScript(name) { mzCalls.push(this.makeUrl(name)); } } };
  vm.createContext(mz); vm.runInContext(compat, mz);
  mz.PluginManager.loadScript('Movie');
  mz.PluginManager.loadScript('MoviePicture');
  mz.PluginManager.loadScript('TS_ReplayMode');
  mz.PluginManager.loadScript('Unrelated');
  assert.deepEqual(mzCalls, [
    'js/plugins/.mistv/movie-browser-1/Movie.js',
    'js/plugins/.mistv/mobile-media-5/MoviePicture.js',
    'js/plugins/.mistv/replay-mode-2/TS_ReplayMode.js',
    'js/plugins/Unrelated.js'
  ]);
  for (const url of mzCalls) {
    assert.doesNotMatch(url, /%3F|\?/);
    assert.doesNotMatch(url, /\.js\.js/);
  }
  assert.match(mzCalls[0], /^js\/plugins\/\.mistv\/[^/]+\/[^/]+\.js$/);
});

test('新增版本条目：CGMZ_SplashScreen / Sakura_MapNameExtend / SoR_DataNoteExtension_MZ', () => {
  const mzCalls = [];
  const mz = { PluginManager: { makeUrl(name) { return 'js/plugins/' + encodeURIComponent(name) + '.js'; }, loadScript(name) { mzCalls.push(this.makeUrl(name)); } } };
  vm.createContext(mz); vm.runInContext(compat, mz);
  mz.PluginManager.loadScript('CGMZ_SplashScreen');
  mz.PluginManager.loadScript('Sakura_MapNameExtend');
  mz.PluginManager.loadScript('SoR_DataNoteExtension_MZ');
  assert.deepEqual(mzCalls, [
    'js/plugins/.mistv/cyclone-steam-1/CGMZ_SplashScreen.js',
    'js/plugins/.mistv/mapname-1/Sakura_MapNameExtend.js',
    'js/plugins/.mistv/sornote-1/SoR_DataNoteExtension_MZ.js'
  ]);
});
