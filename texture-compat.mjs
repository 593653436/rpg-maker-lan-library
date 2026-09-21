// 移动端 WebGL 纹理上限兼容 —— 服务端降采样模块（纯函数，可单测）
//
// 背景：Android Chrome/WebView 的 MAX_TEXTURE_SIZE 常见 4096（Adreno 732 等），
// RPG Maker MV 的视差图/大图（如索尼娅催眠都市回想室地图 218 的 !kaisou_S 4320×2400）
// 超过上限时 WebGL texImage2D 静默失败（不抛 JS 错误）→ 整图不渲染 → 黑屏。
// 本模块：解析 PNG 尺寸 → 超限时面积加权降采样（premultiplied alpha，避免透明边缘色边）
// → 重编码 PNG；以及 RMMV 加密重封装（引擎 Decrypter.decryptArrayBuffer 的逆操作）。
//
// RMMV 加密格式（rpg_core.js Decrypter.decryptArrayBuffer）：
//   文件 = [16 字节头 RPGMV 签名/版本][明文数据，仅前 16 字节 XOR encryptionKey]
// 服务端 decryptRpgImage 已按同一格式解密，本模块只补重置与加密。

import { PNG } from 'pngjs';

export const RPG_HEADER = Buffer.from('5250474d560000000003010000000000', 'hex');

// 从 PNG 字节流读取 IHDR 尺寸（无需完整解码）
export function pngDimensions(buffer) {
  if (!buffer || buffer.length < 33) return null;
  if (!(buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
        buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// 面积加权 box filter 降采样（RGBA 8bit，4 字节/像素）；色值按 alpha 预乘加权平均，
// 避免半透明边缘与深色背景平均后出现色边；输出 alpha 为未预乘平均值。
export function resizePngPixels(src, sw, sh, dst, dw, dh) {
  const sxr = sw / dw, syr = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    const ys0 = dy * syr, ys1 = Math.min(sh, (dy + 1) * syr);
    const iy0 = Math.floor(ys0), iy1 = Math.min(sh, Math.ceil(ys1));
    for (let dx = 0; dx < dw; dx++) {
      const xs0 = dx * sxr, xs1 = Math.min(sw, (dx + 1) * sxr);
      const ix0 = Math.floor(xs0), ix1 = Math.min(sw, Math.ceil(xs1));
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let iy = iy0; iy < iy1; iy++) {
        const wy = Math.min(ys1, iy + 1) - Math.max(ys0, iy);
        if (wy <= 0) continue;
        for (let ix = ix0; ix < ix1; ix++) {
          const wx = Math.min(xs1, ix + 1) - Math.max(xs0, ix);
          if (wx <= 0) continue;
          const w = wx * wy, si = (iy * sw + ix) << 2, sa = src[si + 3];
          r += src[si] * sa * w;
          g += src[si + 1] * sa * w;
          b += src[si + 2] * sa * w;
          a += sa * w;
          wsum += w;
        }
      }
      const di = (dy * dw + dx) << 2;
      if (a > 0) {
        dst[di] = Math.round(r / a);
        dst[di + 1] = Math.round(g / a);
        dst[di + 2] = Math.round(b / a);
      }
      dst[di + 3] = Math.round(a / wsum);
    }
  }
}

// 若 PNG 任一维超过 maxSize → 等比降采样并重编码 PNG；否则返回 null（无需处理）。
export function downscalePng(buffer, maxSize) {
  const dim = pngDimensions(buffer);
  if (!dim) return null;
  if (dim.width <= maxSize && dim.height <= maxSize) return null;
  const scale = Math.min(maxSize / dim.width, maxSize / dim.height);
  const nw = Math.max(1, Math.round(dim.width * scale));
  const nh = Math.max(1, Math.round(dim.height * scale));
  const src = PNG.sync.read(buffer);
  const dst = new PNG({ width: nw, height: nh });
  resizePngPixels(src.data, dim.width, dim.height, dst.data, nw, nh);
  return PNG.sync.write(dst);
}

// 将明文 PNG 重封装为 RMMV 加密 .rpgmvp（引擎解密算法的逆操作）
export function encryptRpgPng(pngBuffer, key) {
  if (!key || key.length !== 16) throw new Error('需要 16 字节 RMMV 加密密钥');
  const body = Buffer.from(pngBuffer);
  for (let i = 0; i < 16 && i < body.length; i++) body[i] ^= key[i];
  return Buffer.concat([RPG_HEADER, body]);
}

// 模拟引擎解密（校验头 + XOR 前 16 字节），测试与自检用
export function decryptRpgPngForTest(encrypted, key) {
  if (!encrypted || encrypted.length < 32) return null;
  if (!encrypted.subarray(0, 16).equals(RPG_HEADER)) return null;
  const body = Buffer.from(encrypted.subarray(16));
  for (let i = 0; i < 16 && i < body.length; i++) body[i] ^= key[i];
  return body;
}

// ── spine .atlas 坐标等比缩放（与 downscalePng 配套，服务端与小纹理上限客户端一致）──
// 与 pixi-spine 解析器语义对齐（已对源验证）：
//   - size 存储的是"逻辑（未旋转、含裁剪）尺寸"；(x,y) 与 swap 后的帧为图集空间像素
//   - rotate=true 时帧为 (x, y, size1, size0)，即 x 向 extent = size1、y 向 extent = size0
//   - updateOffset 的布局数学为 this.w/orig.w、region.w/orig.w 等比例式：orig/offset/宽高
//     全部按同一比例缩放后，比例不变 → 布局完全不变，只是纹理像素变软（等比缩）。
// pageScales: { 'CG3.png': { scale, width, height } }（width/height 为缩后像素尺寸）
export function atlasScaleFor(width, height, maxSize) {
  if (width <= maxSize && height <= maxSize) return null;
  const scale = Math.min(maxSize / width, maxSize / height);
  return { scale, width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function scaleRegionLines(lines, sc) {
  const get = (re) => { for (const l of lines) { const m = l.match(re); if (m) return m; } return null; };
  const rotM = get(/^\s*rotate\s*:\s*(.+?)\s*$/i);
  const xyM = get(/^\s*xy\s*:\s*(\d+)\s*,\s*(\d+)/i);
  const sizeM = get(/^\s*size\s*:\s*(\d+)\s*,\s*(\d+)/i);
  const origM = get(/^\s*orig\s*:\s*(\d+)\s*,\s*(\d+)/i);
  const offM = get(/^\s*offset\s*:\s*(\d+)\s*,\s*(\d+)/i);
  if (!rotM || !xyM || !sizeM) return lines;
  const rv = rotM[1].toLowerCase();
  const rotate = rv === 'true' ? true : rv === 'false' ? false : ((720 - parseFloat(rv)) % 360) / 45 % 4 !== 0;
  const s = sc.scale, nw = sc.width, nh = sc.height;
  const q = (v) => Math.max(0, Math.round(v * s));
  let size0 = Math.max(1, q(parseInt(sizeM[1], 10)));
  let size1 = Math.max(1, q(parseInt(sizeM[2], 10)));
  let extW = rotate ? size1 : size0; // 图集空间 x 向 extent
  let extH = rotate ? size0 : size1;
  let x = Math.min(q(parseInt(xyM[1], 10)), Math.max(0, nw - extW));
  let y = Math.min(q(parseInt(xyM[2], 10)), Math.max(0, nh - extH));
  if (x < 0) x = 0; if (y < 0) y = 0;
  extW = Math.max(1, Math.min(extW, nw - x));
  extH = Math.max(1, Math.min(extH, nh - y));
  size0 = rotate ? extH : extW;
  size1 = rotate ? extW : extH;
  const ow = origM ? Math.max(1, q(parseInt(origM[1], 10))) : null;
  const oh = origM ? Math.max(1, q(parseInt(origM[2], 10))) : null;
  const ox = offM ? q(parseInt(offM[1], 10)) : null;
  const oy = offM ? q(parseInt(offM[2], 10)) : null;
  return lines.map((l) => {
    let m;
    if ((m = l.match(/^(\s*xy\s*:\s*)\d+\s*,\s*\d+/i))) return m[1] + x + ', ' + y;
    if ((m = l.match(/^(\s*size\s*:\s*)\d+\s*,\s*\d+/i))) return m[1] + size0 + ', ' + size1;
    if (ow !== null && (m = l.match(/^(\s*orig\s*:\s*)\d+\s*,\s*\d+/i))) return m[1] + ow + ', ' + oh;
    if (ox !== null && (m = l.match(/^(\s*offset\s*:\s*)\d+\s*,\s*\d+/i))) return m[1] + ox + ', ' + oy;
    return l;
  });
}

export function scaleAtlasText(text, pageScales) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const src = text.split(/\r?\n/);
  const out = [];
  let sc = null;      // 当前页缩放参数或 null
  let buf = null;     // 区域块缓冲
  const isPageName = (t) => /\.(png|jpe?g|webp)$/i.test(t);
  const isOption = (t) => /^(size|format|filter|repeat|pma)\s*:/i.test(t);
  const flush = () => {
    if (buf === null) return;
    out.push(...(sc ? scaleRegionLines(buf, sc) : buf));
    buf = null;
  };
  for (const line of src) {
    const t = line.trim();
    if (t === '') { flush(); sc = null; out.push(line); continue; }
    const indented = /^\s/.test(line);
    if (indented) {
      if (buf !== null) buf.push(line); else out.push(line);
      continue;
    }
    flush();
    if (isPageName(t)) { sc = pageScales[t] || null; out.push(line); }
    else if (sc && /^size\s*:/i.test(t)) out.push('size: ' + sc.width + ', ' + sc.height);
    else if (isOption(t)) out.push(line);
    else buf = [line]; // 区域名行
  }
  flush();
  return out.join(nl);
}
