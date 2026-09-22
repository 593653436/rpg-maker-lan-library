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

test('parseTranslationJson：BOM 与整行注释容忍', () => {
  const src = /function parseTranslationJson\(text\) \{[\s\S]*?\n\}/.exec(server);
  assert.ok(src, 'parseTranslationJson source missing');
  const ctx = { JSON };
  vm.createContext(ctx); vm.runInContext(src[0], ctx);
  const out = ctx.parseTranslationJson('\uFEFF{\n// 注释行\n"a": "b"\n}\n');
  assert.equal(out.a, 'b');
  assert.throws(() => ctx.parseTranslationJson('not json'), SyntaxError);
});

test('knsRejectStopGuard：命中才注入，且不误伤', () => {
  const src = /function knsRejectStopGuard\(source\) \{[\s\S]*?\n\}/.exec(server);
  assert.ok(src, 'knsRejectStopGuard source missing');
  const ctx = { JSSON: null };
  vm.createContext(ctx); vm.runInContext(src[0], ctx);
  const hit = `SceneManager.onReject = function(event) { event.message = event.reason; };\nSceneManager.onError = function(event) { console.error(event); this.stop(); };`;
  const out = ctx.knsRejectStopGuard(hit);
  assert.match(out, /__mistRejectGuard/);
  assert.match(out, /__mistBridge/);
  assert.doesNotThrow(() => new vm.Script(out), '生成代码必须语法合法');
  assert.equal(ctx.knsRejectStopGuard('SceneManager.onReject = function(){};'), '');
  assert.equal(ctx.knsRejectStopGuard(''), '');
});

test('mzLocalFileWebNoopCompat：saveToLocalFile 注入浏览器静默分支', () => {
  const src = /function mzLocalFileWebNoopCompat\(source\) \{[\s\S]*?\n\}/.exec(server);
  assert.ok(src, 'mzLocalFileWebNoopCompat source missing');
  const ctx = {};
  vm.createContext(ctx); vm.runInContext(src[0], ctx);
  const hit = `StorageManager.saveToLocalFile = function(saveName, zip) {\n    const dirPath = this.fileDirectoryPath();\n    return dirPath;`;
  const out = ctx.mzLocalFileWebNoopCompat(hit);
  assert.notEqual(out, hit);
  assert.match(out, /typeof require !== "function"/);
  const raw = 'const x = 1;';
  assert.equal(ctx.mzLocalFileWebNoopCompat(raw), raw);
});

test('audioNullSaveCompat：playBgm/playBgs null 守卫', () => {
  const src = /function audioNullSaveCompat\(source\) \{[\s\S]*?\n\}/.exec(server);
  assert.ok(src, 'audioNullSaveCompat source missing');
  const ctx = { console: { log() {} } };
  vm.createContext(ctx); vm.runInContext(src[0], ctx);
  const hit = [
    'AudioManager.playBgm = function(bgm, pos) {',
    '    if (this.isCurrentBgm(bgm)) {',
    '        this.updateBgmParameters(bgm);',
    '    }',
    '};',
    'AudioManager.playBgs = function(bgs, pos) {',
    '    if (this.isCurrentBgs(bgs)) {',
    '        this.updateBgsParameters(bgs);',
    '    }',
    '};'
  ].join('\n');
  const out = ctx.audioNullSaveCompat(hit);
  assert.equal((out.match(/mist: null 存档安全/g) || []).length, 2);
  assert.doesNotThrow(() => new vm.Script(out));
  const raw = 'AudioManager.playBgm = function(bgm, pos) {\n};';
  assert.equal(ctx.audioNullSaveCompat(raw), raw);
});

test('nwjsGlobalShimCompat：pathShim 反斜杠归一化真实可用', () => {
  const ls = server.split('\n');
  const i0 = ls.findIndex(l => l.startsWith('function nwjsGlobalShimCompat('));
  assert.ok(i0 >= 0, 'nwjsGlobalShimCompat source missing');
  let bt = false, end = -1;
  for (let i = i0; i < ls.length; i++) {
    const line = ls[i];
    for (let k = 0; k < line.length; k++) { const ch = line[k]; if (ch === '\\') { k++; continue; } if (ch === '`') bt = !bt; }
    if (i > i0 && line === '}' && !bt) { end = i; break; }
  }
  assert.ok(end > 0, 'nwjsGlobalShimCompat 提取失败');
  const srcText = ls.slice(i0, end + 1).join('\n');
  const ctx = { JSON, console };
  vm.createContext(ctx); vm.runInContext(srcText, ctx);
  const out = ctx.nwjsGlobalShimCompat('x');
  assert.match(out, /const pathShim=/);
  const pline = out.split('\n').find(x => x.includes('const pathShim='));
  assert.ok(pline, 'pathShim 行缺失');
  const shim = { JSON };
  vm.createContext(shim);
  vm.runInContext(pline.trim() + '; psOut = pathShim;', shim);
  assert.equal(shim.psOut.join('a\\b', 'c'), 'a/b/c', '反斜杠必须被归一化（并保留后续路径段）');
  assert.equal(shim.psOut.join('x/y', 'z'), 'x/y/z');
});

test('readImageDims：明文 PNG 与 RPGMV/MZ 加密头尺寸解析', async () => {
  const src = /async function readImageDims\(file\)\{[\s\S]*?\n\}/.exec(server);
  assert.ok(src, 'readImageDims source missing');
  let fake = Buffer.alloc(48);
  const ctx = { Buffer, fsp: { open: async () => ({ read: async (b, off, len, pos) => { fake.copy(b, 0); return { bytesRead: 48 }; }, close: async () => {} }) } };
  vm.createContext(ctx); vm.runInContext(src[0], ctx);
  fake = Buffer.alloc(48); fake[0] = 0x89; fake.writeUInt32BE(640, 16); fake.writeUInt32BE(480, 20);
  const r1 = await ctx.readImageDims('a.png');
  assert.equal(r1.width, 640); assert.equal(r1.height, 480);
  fake = Buffer.alloc(48); fake.write('RPGMV', 0, 'latin1'); fake[40] = 8; fake[41] = 6; fake.writeUInt32BE(8192, 32); fake.writeUInt32BE(4096, 36);
  const r2 = await ctx.readImageDims('a.png_');
  assert.equal(r2.width, 8192); assert.equal(r2.height, 4096);
  fake = Buffer.alloc(48); for (let i = 0; i < 48; i++) fake[i] = (i * 37) % 256;
  assert.equal(await ctx.readImageDims('junk'), null);
});

test('serveCycloneSplashCompat：Steam 订阅门卫中和（路由变换）', async () => {
  const ls = server.split('\n');
  const i0 = ls.findIndex(l => l.startsWith('async function serveCycloneSplashCompat('));
  assert.ok(i0 >= 0, 'serveCycloneSplashCompat source missing');
  let end = -1;
  for (let i = i0 + 1; i < ls.length; i++) { if (ls[i] === '}') { end = i; break; } }
  const ctx = {
    fsp: { readFile: async () => 'if (!CycloneSteam.isSubscribedApp(1234)) { console.log("gated"); }' },
    path: { join: (...a) => a.join('/') },
    text: (res, code, msg) => ({ code, msg }),
    serveCompatBuffer: async (req, res, buf) => buf.toString('utf8'),
    Buffer, console
  };
  vm.createContext(ctx); vm.runInContext(ls.slice(i0, end + 1).join('\n'), ctx);
  const out = await ctx.serveCycloneSplashCompat({}, {}, 'root', null);
  assert.match(out, /if \(false\)/);
  assert.doesNotMatch(out, /!CycloneSteam\.isSubscribedApp/);
});

test('serveSakuraMapNameCompat：fs/path/process 浏览器 stub（路由变换）', async () => {
  const ls = server.split('\n');
  const i0 = ls.findIndex(l => l.startsWith('async function serveSakuraMapNameCompat('));
  assert.ok(i0 >= 0, 'serveSakuraMapNameCompat source missing');
  let end = -1, bt = false;
  for (let i = i0; i < ls.length; i++) {
    const line = ls[i];
    for (let k = 0; k < line.length; k++) { const ch = line[k]; if (ch === '\\') { k++; continue; } if (ch === '`') bt = !bt; }
    if (i > i0 && line === '}' && !bt) { end = i; break; }
  }
  const fixture = "  const fs = require('fs');\n  const path = require('path');\n  const getBasePath = () => path.dirname(process.mainModule.filename);";
  const ctx = {
    fsp: { readFile: async () => fixture },
    path: { join: (...a) => a.join('/') },
    text: (res, code, msg) => ({ code, msg }),
    serveCompatBuffer: async (req, res, buf) => buf.toString('utf8'),
    Buffer, console
  };
  vm.createContext(ctx); vm.runInContext(ls.slice(i0, end + 1).join('\n'), ctx);
  const out = await ctx.serveSakuraMapNameCompat({}, {}, 'root', null);
  assert.match(out, /mist: nwjs fs stub/);
  assert.match(out, /typeof require === 'function'/);
  assert.match(out, /process\.mainModule\) \? path\.dirname/);
});

test('serveSoRDataNoteCompat：data/SoRNote 内嵌为虚拟 fs（路由变换）', async () => {
  const ls = server.split('\n');
  const i0 = ls.findIndex(l => l.startsWith('async function serveSoRDataNoteCompat('));
  assert.ok(i0 >= 0, 'serveSoRDataNoteCompat source missing');
  let end = -1;
  for (let i = i0 + 1; i < ls.length; i++) { if (ls[i] === '}') { end = i; break; } }
  const fixture = "const fs = require('fs');\nconst Extended_NotePath = 'data/SoRNote/';\n(function() {\n  boot();\n})();";
  const ctx = {
    fsp: {
      readFile: async (f) => String(f).includes('_note') ? 'SYNTHNOTE' : fixture,
      readdir: async () => [{ name: 'boss_note', isFile: () => true }, { name: 'readme.txt', isFile: () => false }]
    },
    path: { join: (...a) => a.join('/') },
    text: (res, code, msg) => ({ code, msg }),
    serveCompatBuffer: async (req, res, buf) => buf.toString('utf8'),
    soRNoteCache: new Map(),
    JSON, Buffer, console
  };
  vm.createContext(ctx); vm.runInContext(ls.slice(i0, end + 1).join('\n'), ctx);
  const out = await ctx.serveSoRDataNoteCompat({}, {}, 'root', null);
  assert.match(out, /__mistSoRFS/);
  assert.match(out, /SYNTHNOTE/);
  assert.match(out, /const fs = __mistSoRFS;/);
});
