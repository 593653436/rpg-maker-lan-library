// mist: 移动端音频桥 —— 把 RPG Maker MV 的 .ogg 转码为 .m4a(AAC) 供手机加载。
// 背景：MV 的 AudioManager.audioFileExt 在 isMobileDevice()（安卓/iOS）时一律返回 '.m4a'，
// 仅打包 .ogg 的游戏在手机上全部音频 404 → 静音。本模块负责转码本身（server.mjs 负责路由与缓存）。
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// 转码参数：AAC-LC、44100Hz、双声道，兼容 iOS Safari(webkitAudioContext) 与 Android Chrome。
// 码率 160k 对游戏 BGM/SE 足够，体积约为原 ogg 的 60~80%。
// 注意必须 -f ipod（M4A 容器）：临时文件扩展名是 .tmp，ffmpeg 无法靠扩展名猜容器，否则 EINVAL。
export const M4A_TRANSCODE_ARGS = ['-y', '-i', '%IN%', '-vn', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', '-f', 'ipod', '%OUT%'];

// mist: 规范化 m4a 缓存相对路径：输入为无前导斜杠的 .ogg 相对路径（如 Audio/se/Cursor1.ogg），
// 输出为同位置 .m4a。统一由 server 与工具使用，避免路径拼接歧义。
export function oggRelToCacheRel(rel) {
  return String(rel || '').replace(/\.ogg$/i, '.m4a');
}

export async function transcodeOggToM4a(oggFile, m4aFile, ffmpegBin = 'ffmpeg') {
  await fsp.mkdir(path.dirname(m4aFile), { recursive: true });
  const tmp = `${m4aFile}.${crypto.randomUUID()}.tmp`;
  try {
    await new Promise((resolve, reject) => {
      const args = M4A_TRANSCODE_ARGS.map(a => a === '%IN%' ? oggFile : a === '%OUT%' ? tmp : a);
      const child = spawn(ffmpegBin, args, { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', d => { stderr += String(d); if (stderr.length > 2048) stderr = stderr.slice(-2048); });
      child.on('error', err => reject(err));
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(-200)}`)));
    });
    await fsp.rename(tmp, m4aFile);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// mist: 内存中的 ogg 明文 → m4a（用于加密音频：先解密到内存，再落盘临时 ogg 转码）。
export async function transcodeOggBufferToM4a(data, m4aFile, ffmpegBin = 'ffmpeg') {
  await fsp.mkdir(path.dirname(m4aFile), { recursive: true });
  const tmpOgg = `${m4aFile}.${crypto.randomUUID()}.src.ogg`;
  await fsp.writeFile(tmpOgg, data);
  try { await transcodeOggToM4a(tmpOgg, m4aFile, ffmpegBin); }
  finally { await fsp.rm(tmpOgg, { force: true }).catch(() => {}); }
}

// 校验 m4a 是否真的是 MP4/AAC 容器（用于测试与缓存校验）。
export async function isM4aFile(file) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size < 16) return false;
  const handle = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(12);
    const { bytesRead } = await handle.read(head, 0, 12, 4); // box type 在 offset 4
    if (bytesRead < 8) return false;
    return head.subarray(0, 4).toString('ascii') === 'ftyp';
  } finally { await handle.close(); }
}
