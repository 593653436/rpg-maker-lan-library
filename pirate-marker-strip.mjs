// pirate-marker-strip.mjs — 响应层清理“盗版重打包注入标记”代码
//
// 某些盗版整合版会在插件文件（如 SRD_UltraBase.js）顶部插入一段 NW.js 专用代码：
//   const fs = require("fs");
//   const base64String = '<base64>';                    // 解码后是引流标记文件名（Telegram@xxx）
//   const originalString = Buffer.from(base64String, 'base64').toString('utf8');
//   if(!fs.existsSync(originalString)) { fs.openSync(originalString, 'w'); }
// 该代码在 NW.js 里会往游戏目录写标记文件；在浏览器里顶层执行时 `require` 未定义 →
// 整个插件 IIFE 中断 → 依赖它的插件连锁报错（如 SRD_HUDMakerUltra: addDataFile is not a function）→ 游戏黑屏。
//
// 本模块只识别“已知形态”并剥离；识别不到时不动原文件（返回 null，交由正常流程处理）。
const PIRATE_MARKER_RE = /(?:^|\r?\n)[ \t]*const[ \t]+fs[ \t]*=[ \t]*require[ \t]*\([ \t]*["']fs["'][ \t]*\)[ \t]*;[ \t]*\r?\n[ \t]*const[ \t]+base64String[ \t]*=[ \t]*["'][A-Za-z0-9+/=]{8,}["'][ \t]*;[ \t]*\r?\n[ \t]*const[ \t]+originalString[ \t]*=[ \t]*Buffer\.from[ \t]*\([ \t]*base64String[ \t]*,[ \t]*["']base64["'][ \t]*\)\.toString[ \t]*\([ \t]*["']utf8["'][ \t]*\)[ \t]*;[ \t]*\r?\n(?:[ \t]*\r?\n)?[ \t]*if[ \t]*\([ \t]*!fs\.existsSync[ \t]*\([ \t]*originalString[ \t]*\)[ \t]*\)[ \t]*\{[ \t]*\r?\n[ \t]*fs\.openSync[ \t]*\([ \t]*originalString[ \t]*,[ \t]*["']w["'][ \t]*\)[ \t]*;[ \t]*\r?\n[ \t]*\}[ \t]*\r?\n?/;

export function stripPirateMarkerCode(source) {
  if (typeof source !== 'string') return null;
  if (!source.includes('base64String') || !source.includes('openSync(')) return null;
  let out = source, matched = false;
  while (PIRATE_MARKER_RE.test(out)) {
    out = out.replace(PIRATE_MARKER_RE, '\n/* mist: stripped injected marker code (pirate repack) */\n');
    matched = true;
  }
  return matched ? out : null;
}
