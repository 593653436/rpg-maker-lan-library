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
