// mist: RPG Maker MV 加密音频/图片（.rpgmvo/.rpgmvm/.rpgmvp）解密与加密。
//
// 背景：MV 游戏在移动端 audioFileExt() 返回 '.m4a'，再经 Decrypter.extToEncryptExt 变成
//   '.rpgmvm' 请求；而发行包里通常只有 '.rpgmvo'（加密的 ogg），没有 '.rpgmvm' → 手机 404 静音。
//   本模块把 .rpgmvo 还原为明文，供转码为 AAC(m4a)，再按游戏格式重新加密返回 .rpgmvm，
//   客户端解密后即可播放（无需改动游戏逻辑）。
//
// 本作（Painting Thief 等）用的“旧式 MV 标准加密”格式：
//   [0..16)   固定头 = SIGNATURE("RPGMV\0\0\0") + VER("000301") + REMAIN("0000000000")
//   [16..32)  明文前 16 字节 XOR encryptionKey
//   [32..end) 明文（不加密）
//   其中 encryptionKey 取自 data/System.json 的 encryptionKey 字段（32 位十六进制 = 16 字节）。
import fsp from 'node:fs/promises';
import path from 'node:path';

export const MV_SIGNATURE = Buffer.from('5250474d56000000', 'hex'); // "RPGMV\0\0\0"
export const MV_VER = Buffer.from('000301', 'hex');
export const MV_REMAIN = Buffer.from('0000000000', 'hex');
export const MV_HEADER = Buffer.concat([MV_SIGNATURE, MV_VER, MV_REMAIN]); // 16 字节

/** 旧式 MV 加密格式是否匹配（头部等于固定 MV 头）。 */
export function isLegacyMvEncrypted(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 32 && buf.subarray(0, 16).equals(MV_HEADER);
}

/** 旧式解密：校验固定头 → 去 16 字节头 → 前 16 字节 XOR key。失败返回 null。 */
export function decryptLegacyMv(buf, keyHex) {
  if (!isLegacyMvEncrypted(buf)) return null;
  const key = Buffer.from(String(keyHex || ''), 'hex');
  if (key.length !== 16) return null;
  const out = Buffer.from(buf.subarray(16));
  for (let i = 0; i < 16 && i < out.length; i++) out[i] ^= key[i];
  return out;
}

/** 旧式加密：固定头 + (明文前 16 字节 XOR key) + 明文其余。与 decryptLegacyMv 互逆。 */
export function encryptLegacyMv(plain, keyHex) {
  if (!Buffer.isBuffer(plain)) throw new Error('明文必须是 Buffer');
  const key = Buffer.from(String(keyHex || ''), 'hex');
  if (key.length !== 16) throw new Error('encryptionKey 无效');
  const out = Buffer.concat([MV_HEADER, Buffer.from(plain)]);
  for (let i = 0; i < 16 && i < plain.length; i++) out[16 + i] ^= key[i];
  return out;
}

// ---- DataGuard（$RGD$）支持：部分整合包把 System.json 也整体加密 ----
// 文件格式: "$RGD$" + base64( XOR(utf8, 64字节派生密钥) )；
// 密钥派生与 DataGuard_Decrypter.js 的 makeKeyBuffer 字节级一致：
//   out[i] = keyStr.charCodeAt(i % len) ^ (i * 31 + 7)   (i ∈ [0,64), 取低 8 位)
export function dataGuardKeyBuffer(keyStr) {
  const str = String(keyStr && keyStr.length ? keyStr : 'RpgData_Guard_Default_Key_2026');
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) out[i] = (str.charCodeAt(i % str.length) ^ (i * 31 + 7)) & 0xFF;
  return out;
}
/** 解密 "$RGD$..." 文本；非 $RGD$ 或失败返回 null。 */
export function dataGuardDecryptText(text, keyStr) {
  if (typeof text !== 'string' || !text.startsWith('$RGD$')) return null;
  const body = text.slice(5).replace(/\s+/g, '');
  if (!body) return null;
  const bin = Buffer.from(body, 'base64');
  if (!bin.length) return null;
  const kb = dataGuardKeyBuffer(keyStr);
  const out = Buffer.allocUnsafe(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = (bin[i] ^ kb[i % 64]) & 0xFF;
  return out.toString('utf8');
}
// 从 js/plugins.js 提取 DataGuard_Decrypter 的「加密密钥」参数（整合包密钥各不相同）
async function findDataGuardKey(gameRoot) {
  for (const rel of ['js/plugins.js', 'www/js/plugins.js']) {
    const raw = await fsp.readFile(path.join(gameRoot, rel), 'utf8').catch(() => null);
    if (!raw) continue;
    const idx = raw.indexOf('"DataGuard_Decrypter"');
    if (idx < 0) continue;
    const m = /"parameters"\s*:\s*(\{[^}]*\})/.exec(raw.slice(idx, idx + 4000));
    if (!m) continue;
    try {
      const params = JSON.parse(m[1]);
      const k = params['加密密钥'] || params['EncryptionKey'];
      if (k) return String(k);
    } catch { /* 参数块解析失败继续 */ }
  }
  return null;
}
function extractEncryptionKey(text) {
  try {
    const json = JSON.parse(text);
    if (typeof json.encryptionKey === 'string' && /^[0-9a-fA-F]{32}/.test(json.encryptionKey)) {
      return json.encryptionKey.slice(0, 32);
    }
  } catch { /* 解析失败 */ }
  return null;
}
// 从 <gameRoot>/data/System.json 读取 encryptionKey（结果缓存；gameRoot 已含 webRoot）。
// System.json 可能被 DataGuard 加密（$RGD$）——先解密再取 key；DataGuard 密钥来自 plugins.js。
const keyCache = new Map();
export async function loadEncryptionKey(gameRoot) {
  if (keyCache.has(gameRoot)) return keyCache.get(gameRoot);
  let key = null;
  for (const rel of ['data/System.json', 'www/data/System.json']) {
    const raw = await fsp.readFile(path.join(gameRoot, rel), 'utf8').catch(() => null);
    if (raw === null) continue;
    const text = raw.replace(/^\uFEFF/, '');
    if (text.startsWith('$RGD$')) {
      const dgKey = await findDataGuardKey(gameRoot);
      for (const k of [dgKey, 'TestKey9527']) {
        if (!k) continue;
        const plain = dataGuardDecryptText(text, k);
        const found = plain && extractEncryptionKey(plain);
        if (found) { key = found; break; }
      }
      if (key) break;
      continue;
    }
    const found = extractEncryptionKey(text);
    if (found) { key = found; break; }
  }
  keyCache.set(gameRoot, key);
  return key;
}
