// mist: 手机端 WindowLayer 直绘兼容（ヤレるチケット ed4734b8 案例，2026-09）。
//
// 现象：手机浏览器里对话文字全部不显示（人名框、气泡图片、立绘、地图均正常）。
// 根因（真机 CDP 逐层拆解）：MV1.6 core 的 WindowLayer.renderWebGL 走「VoidFilter 强制 FBO 通道 +
// 逐窗口剪刀清除 + popFilter 合成回屏」渲染整层窗口；部分手机 WebView 上该 FBO 合成产出为空 →
// WindowLayer 整层（消息窗 = 全部对白正文）不渲染；桌面 Chrome 正常。
// 验证证据：场景根窗口可见、WindowLayer 内测试窗口不可见、live 帧缓冲文字区无墨迹、提取同样为空。
//
// 修复（服务端响应层，NAS 零改动）：仅对手机 UA 注入直绘分支——
// 跳过 pushFilter/popFilter 与剪刀清除，其余顺序不变（先窗口：可见且 openness>0；后非窗口子级）。
// 常规场景与 FBO 版视觉等价（每帧背缓冲整体重绘，逐窗口一次性绘制，无跨帧残影）。
// 桌面 UA 原样返回，零影响。
const MOBILE_UA_RE = /Android|iPhone|iPad|iPod|Mobile/i; // 与 textureMaxForRequest 判定一致
const FLAG = '_mistDirectWindowLayer';
const ANCHOR = 'WindowLayer.prototype.renderWebGL = function(renderer) {';
const FP_VOID = 'WindowLayer.voidFilter = new PIXI.filters.VoidFilter();';
const FP_PUSH = 'renderer.filterManager.pushFilter(this, this.filters);';

export function isMobileUserAgent(ua) {
  return typeof ua === 'string' && MOBILE_UA_RE.test(ua);
}

// 注入直绘分支；无法识别/已注入时返回 null（fail-soft，不改动原文）。
export function windowLayerDirectCompat(source) {
  if (typeof source !== 'string') return null;
  if (source.includes(FLAG)) return null; // 幂等
  const at = source.indexOf(ANCHOR);
  if (at < 0) return null;
  if (!source.includes(FP_VOID) || !source.includes(FP_PUSH)) return null; // 指纹：MV1.6 FBO 版
  const pos = at + ANCHOR.length;
  const nl = source.startsWith('\r\n', pos) ? '\r\n' : '\n'; // 行尾自适应（NAS 文件多为 CRLF）
  const guard = [
    '',
    `    if (Graphics.${FLAG}) {`,
    '        // mist: 手机端直绘模式——跳过 FBO 滤镜合成（部分 WebView 上该通道整层丢失）',
    '        if (!this.visible || !this.renderable) {',
    '            return;',
    '        }',
    '        if (this.children.length == 0) {',
    '            return;',
    '        }',
    '        renderer.flush();',
    '        for (var i = 0; i < this.children.length; i++) {',
    '            var child = this.children[i];',
    '            if (child._isWindow && child.visible && child.openness > 0) {',
    '                child.renderWebGL(renderer);',
    '            }',
    '        }',
    '        for (var j = 0; j < this.children.length; j++) {',
    '            if (!this.children[j]._isWindow) {',
    '                this.children[j].renderWebGL(renderer);',
    '            }',
    '        }',
    '        return;',
    '    }'
  ].join(nl);
  return source.slice(0, pos) + guard + source.slice(pos);
}

// 置位标志（追加在 rpg_core.js 末尾、所有类定义之后执行）。
export function windowLayerDirectFlag() {
  return `\n;(function(){try{if(typeof Graphics!=="undefined"){Graphics.${FLAG}=true;console.info("[雾灯兼容] WindowLayer 直绘模式已启用（规避 WebView FBO 合成缺失）");}}catch(e){}})();\n`;
}
