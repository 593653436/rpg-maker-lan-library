// ヤレるチケット（ed4734b8）幽灵存档槽修复回归。
// 背景：整合包只剩 file1.rpgsave，但 common 元数据（变量50）仍标记槽2有数据 →
// 游戏自定义读档 LoadStarting 守卫放行槽2 → loadGame(2) 文件缺失静默 false → 卡死。
// 修复 = 桥内对 load('common') 做槽位屏蔽：元数据非空但无 fileN 的槽 → '---'×5+''。
// 合成夹具模式：从 server.mjs 提取 mvSaveBridge 函数体，在 vm 沙箱以桩执行。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const serverSrc = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

// 1) 提取 mvSaveBridge 源码并编译
const start = serverSrc.indexOf('function mvSaveBridge');
const end = serverSrc.indexOf('function saveBridge');
assert.ok(start > 0 && end > start, 'mvSaveBridge 函数定位');
const fnSrc = serverSrc.slice(start, end).trim().replace(/}\s*$/, '}');
const bridgeFn = vm.runInNewContext('(' + fnSrc + ')');
assert.equal(typeof bridgeFn, 'function', 'mvSaveBridge 可编译');

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const unb64 = s => Buffer.from(s, 'base64').toString('utf8');

function runBridge({ files, commonJson }) {
  const bridgeCode = bridgeFn('testgame');
  let loadCb = null;
  const routes = {
    '/api/game-saves/testgame': JSON.stringify({ canSave: true, saves: Object.keys(files).map(name => ({ name })) }),
  };
  for (const [name, content] of Object.entries(files)) {
    routes['/api/game-saves/testgame/' + name] = b64(content);
  }
  class XHRStub {
    open(method, url) { this._url = url; }
    setRequestHeader() {}
    send() {
      const hit = routes[this._url];
      if (hit === undefined) { this.status = 404; this.responseText = 'not found'; return; }
      this.status = 200; this.responseText = hit;
    }
  }
  const sandbox = {
    console: { info() {}, warn() {}, error() {} },
    JSON, String, Number, Object, Date, Math, Set, Map, Buffer,
    LZString: { decompressFromBase64: unb64, compressToBase64: b64 },
    XMLHttpRequest: XHRStub,
    StorageManager: {},
    window: { parent: null, addEventListener: (t, fn) => { if (t === 'load') loadCb = fn; } },
    localStorage: {},
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(bridgeCode, sandbox);
  assert.equal(typeof loadCb, 'function', 'load 回调已注册');
  loadCb(); // 触发 install()
  return sandbox;
}

// 2) 正例：槽1有文件保留、槽2无文件屏蔽、其余键不受影响
const commonWith2 = JSON.stringify({
  gameSwitches: { 11: false },
  gameVariables: { 50: ['57日目 （平日A）', '08:35:23', '10-1-2-26', '', '---', '---', '57日目 （平日A）', '08:31:17', '10-1-2-26', '', '---', '---', '---', '---', '---', '---', '---', ''].join(','), 51: 0 },
});
const sb1 = runBridge({ files: { common: commonWith2, config: '{"a":1}', file1: '{"system":{}}', global: '[]' } });
const out1 = JSON.parse(sb1.StorageManager.load('common'));
let f1 = out1.gameVariables['50'].split(',');
assert.equal(f1[0], '57日目 （平日A）', '槽1名称保留');
assert.equal(f1[1], '08:35:23', '槽1时长保留');
assert.deepEqual(f1.slice(6, 12), ['---', '---', '---', '---', '---', ''], '槽2被屏蔽为空槽形态');
assert.equal(out1.gameVariables['51'], 0, '其他变量不动');
assert.equal(sb1.StorageManager.load('file1'), '{"system":{}}', 'file1 原样');
assert.equal(JSON.parse(sb1.StorageManager.load('config')).a, 1, 'config 原样');
assert.equal(sb1.StorageManager.load(1), sb1.StorageManager.load('file1'), '数字 id 走同一结果');
// 幂等
const again = JSON.parse(sb1.StorageManager.load('common')).gameVariables['50'];
assert.equal(again.split(',')[6], '---', '重复加载仍为空槽');

// 3) 反例：file2 存在时不得屏蔽
const sb2 = runBridge({ files: { common: commonWith2, file1: '{}', file2: '{}' } });
const f2 = JSON.parse(sb2.StorageManager.load('common')).gameVariables['50'].split(',');
assert.equal(f2[6], '57日目 （平日A）', 'file2 存在时槽2元数据保留');
assert.equal(f2[7], '08:31:17');

// 4) 指纹门槛：变量50 非槽位串（无 HH:MM:SS 槽）→ 不加戏
const commonPlain = JSON.stringify({ gameVariables: { 50: 'hello,world,foo' } });
const sb3 = runBridge({ files: { common: commonPlain } });
assert.equal(JSON.parse(sb3.StorageManager.load('common')).gameVariables['50'], 'hello,world,foo', '非槽位串不处理');

// 5) server 接线断言
assert.match(serverSrc, /maskCommonMeta=json=>/, 'helper 缺失');
assert.match(serverSrc, /json=\(key==='common'\)\?maskCommonMeta\(json\):json;cache\.set\(key,json\);return json\};/, 'load 挂钩缺失');
assert.match(serverSrc, /maskCommonMeta\(LZString\.decompressFromBase64\(request\(base\+'\/common'\)\.responseText\)\)/, 'loadCommonSave 挂钩缺失');

console.log(JSON.stringify({ ok: true, ghostSlotMasked: true, existingSlotKept: true, otherKeysIntact: true, idempotent: true, existsNoMask: true, fingerprintGate: true, routesWired: true }));
