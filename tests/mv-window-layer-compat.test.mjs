// mv-window-layer-compat 回归：手机端 WindowLayer 直绘注入（ヤレるチケット ed4734b8 案例）。
// 背景：MV1.6 core 的 WindowLayer.renderWebGL 用 VoidFilter 强制 FBO 合成；部分手机 WebView
// 上该通道整层丢失 → 对话文字不显示（名字框/气泡图片正常）。响应层对手机 UA 注入直绘分支。
// 合成夹具：可执行的迷你 WindowLayer 桩源码 → 变换后于 vm 执行，断言直绘/回退行为与顺序。
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { isMobileUserAgent, windowLayerDirectCompat, windowLayerDirectFlag } from '../mv-window-layer-compat.mjs';

// ---------- 1) UA 判定 ----------
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; PJX110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
assert.equal(isMobileUserAgent(ANDROID_UA), true, 'Android 手机 UA');
assert.equal(isMobileUserAgent(IPHONE_UA), true, 'iPhone UA');
assert.equal(isMobileUserAgent(IPAD_UA), true, 'iPad UA');
assert.equal(isMobileUserAgent(DESKTOP_UA), false, '桌面 Chrome UA 不注入');
assert.equal(isMobileUserAgent(''), false);
assert.equal(isMobileUserAgent(undefined), false);

// ---------- 2) 变换（合成夹具） ----------
const FIXTURE = [
  'function WindowLayer() {}',
  'WindowLayer.prototype.renderWebGL = function(renderer) {',
  '    if (!this.visible || !this.renderable) {',
  '        return;',
  '    }',
  '    if (this.children.length==0) {',
  '        return;',
  '    }',
  '    renderer.flush();',
  '    this.filterArea.copy(this);',
  '    renderer.filterManager.pushFilter(this, this.filters);',
  '};',
  'WindowLayer.voidFilter = new PIXI.filters.VoidFilter();',
  ''
].join('\n');

const out = windowLayerDirectCompat(FIXTURE);
assert.ok(out, 'fixture 可识别');
assert.ok(out.includes('WindowLayer.prototype.renderWebGL = function(renderer) {\n    if (Graphics._mistDirectWindowLayer) {'), '直绘分支紧跟方法头');
assert.ok(out.indexOf('if (Graphics._mistDirectWindowLayer) {') < out.indexOf('renderer.filterManager.pushFilter(this, this.filters);'), '分支先于原体');
assert.ok(out.includes('renderer.filterManager.pushFilter(this, this.filters);'), '原体保留（回退可用）');
assert.equal(windowLayerDirectCompat(out), null, '幂等：二次变换不重复注入');
assert.equal(windowLayerDirectCompat('var x=1;'), null, '无锚点 fail-soft');
assert.equal(windowLayerDirectCompat(FIXTURE.replace('WindowLayer.voidFilter = new PIXI.filters.VoidFilter();', '')), null, '缺 voidFilter 指纹 fail-soft');
assert.equal(windowLayerDirectCompat(FIXTURE.replace('renderer.filterManager.pushFilter(this, this.filters);', '')), null, '缺 pushFilter 指纹 fail-soft');

// CRLF 源（NAS 常见）行尾保持一致
const crlfOut = windowLayerDirectCompat(FIXTURE.split('\n').join('\r\n'));
assert.ok(crlfOut.includes('\r\n    if (Graphics._mistDirectWindowLayer) {\r\n'), 'CRLF 源：注入行尾为 CRLF');

// ---------- 3) vm 行为（变换后源码可执行、顺序与过滤正确） ----------
function mkContext(flag) {
  const sandbox = { Graphics: { _mistDirectWindowLayer: flag }, PIXI: { filters: { VoidFilter: function () {} } }, console };
  vm.createContext(sandbox);
  return sandbox;
}
function mkEnv() {
  const log = [];
  const renderer = { flush: () => log.push('flush'), filterManager: { pushFilter: () => log.push('pushFilter') } };
  const mk = (name, o = {}) => Object.assign({ name, _isWindow: true, visible: true, openness: 255, renderWebGL: () => log.push(name) }, o);
  return { log, renderer, mk };
}
function mkWalls(env) {
  return [env.mk('winA'), env.mk('winB', { openness: 0 }), env.mk('winC', { visible: false }), env.mk('sprite', { _isWindow: false }), env.mk('bgSprite', { _isWindow: false, visible: false })];
}
const directSrc = windowLayerDirectCompat(FIXTURE);
{
  const sb = mkContext(true);
  vm.runInContext(directSrc, sb);
  const env = mkEnv();
  const layer = Object.create(sb.WindowLayer.prototype);
  layer.visible = true; layer.renderable = true;
  layer.filterArea = { copy() {} };
  layer.children = mkWalls(env);
  layer.renderWebGL(env.renderer);
  assert.deepEqual(env.log, ['flush', 'winA', 'sprite', 'bgSprite'], '直绘：跳过关闭/隐藏窗口；非窗口殿后且不过滤（与原实现同）');
}
{
  const sb = mkContext(false);
  vm.runInContext(directSrc, sb);
  const env = mkEnv();
  const layer = Object.create(sb.WindowLayer.prototype);
  layer.visible = true; layer.renderable = true;
  layer.filterArea = { copy() {} };
  layer.children = mkWalls(env);
  layer.renderWebGL(env.renderer);
  assert.deepEqual(env.log, ['flush', 'pushFilter'], '回退：标志未置位时走原体（FBO 路径）');
  assert.ok(!env.log.includes('winA'), '回退时不误用直绘');
}
{
  const sb = mkContext(true);
  vm.runInContext(directSrc, sb);
  const env = mkEnv();
  const layer = Object.create(sb.WindowLayer.prototype);
  layer.visible = false; layer.renderable = true;
  layer.children = mkWalls(env);
  layer.renderWebGL(env.renderer);
  assert.deepEqual(env.log, [], '不可见层不绘制');
}

// ---------- 4) 标志辅助 ----------
{
  const snippet = windowLayerDirectFlag();
  assert.ok(snippet.includes('_mistDirectWindowLayer'), 'snippet 含标志名');
  const sb = { Graphics: {} };
  vm.createContext(sb);
  vm.runInContext(snippet, sb);
  assert.equal(sb.Graphics._mistDirectWindowLayer, true, '置位成功');
  const sb2 = {}; // Graphics 未定义：不抛
  vm.createContext(sb2);
  vm.runInContext(snippet, sb2);
}
console.log('mv-window-layer-compat: all assertions passed');
