// MV 加密音频与 DataGuard($RGD$) 合成回归（不依赖 NAS 与真实游戏）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { decryptLegacyMv, encryptLegacyMv, isLegacyMvEncrypted, loadEncryptionKey, MV_HEADER, dataGuardDecryptText } from '../mv-audio-crypto.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra ? ' :: ' + extra : ''}`); }
};

check('MV_HEADER 为 16 字节', MV_HEADER.length === 16);

// ---- 合成 rpgmvo：加密 → 识别 → 解密往返（对应"服务端加密返回、客户端解密播放"） ----
const key = '00112233445566778899aabbccddeeff';
const plain = Buffer.concat([Buffer.from('OggS'), Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 7) % 256))]);
const enc = encryptLegacyMv(plain, key);
check('加密后头部为 MV 固定头', enc.subarray(0, 16).equals(MV_HEADER));
check('识别为旧式 MV 加密', isLegacyMvEncrypted(enc));
const dec = decryptLegacyMv(enc, key);
check('解密往返一致', !!dec && dec.equals(plain));
check('解密后以 OggS 开头', dec.subarray(0, 4).toString('latin1') === 'OggS');
const wrong = decryptLegacyMv(enc, 'ffffffffffffffffffffffffffffffff');
check('错误 key 不会还原 OggS', !wrong || wrong.subarray(0, 4).toString('latin1') !== 'OggS');
check('非加密数据返回 null', decryptLegacyMv(Buffer.from('not an encrypted MV file at all'), key) === null);
check('空 key 返回 null', decryptLegacyMv(enc, '') === null);

// ---- 合成 $RGD$ 加解往返（自包含夹具） ----
const secret = JSON.stringify({ encryptionKey: '00112233445566778899aabbccddeeff', hasEncryptedAudio: true });
const keyStr = 'cccbro18';
const K = new Uint8Array(64);
for (let i = 0; i < 64; i++) K[i] = (keyStr.charCodeAt(i % keyStr.length) ^ (i * 31 + 7)) & 0xFF;
const pb = Buffer.from(secret, 'utf8');
const xored = Buffer.alloc(pb.length);
for (let i = 0; i < pb.length; i++) xored[i] = (pb[i] ^ K[i % 64]) & 0xFF;
const rgd = '$RGD$' + xored.toString('base64');
check('合成 $RGD$ 解密还原', dataGuardDecryptText(rgd, keyStr) === secret);
check('错误密钥不还原', dataGuardDecryptText(rgd, 'wrong-key') !== secret);
check('非 $RGD$ 返回 null', dataGuardDecryptText('{"a":1}', keyStr) === null);

// ---- 合成 gameRoot：plugins.js 密钥 + $RGD$ System.json → loadEncryptionKey 全链 ----
const dgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mist-dg-'));
fs.mkdirSync(path.join(dgRoot, 'data'), { recursive: true });
fs.mkdirSync(path.join(dgRoot, 'js'), { recursive: true });
fs.writeFileSync(path.join(dgRoot, 'js', 'plugins.js'),
  'var $plugins = [\n{"name":"DataGuard_Decrypter","status":true,"description":"x","parameters":{"加密密钥":"cccbro18","日志级别":"详细调试"}}\n];');
fs.writeFileSync(path.join(dgRoot, 'data', 'System.json'), rgd);
const synthKey = await loadEncryptionKey(dgRoot);
check('合成 root 全链（plugins.js→$RGD$解密→key）', synthKey === '00112233445566778899aabbccddeeff', String(synthKey));

// ---- 明文 System.json 读取（对照路径） ----
const plainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mist-plain-'));
fs.mkdirSync(path.join(plainRoot, 'data'), { recursive: true });
fs.writeFileSync(path.join(plainRoot, 'data', 'System.json'), JSON.stringify({ encryptionKey: 'abcdefabcdefabcdefabcdefabcdefab' }));
const plainKey = await loadEncryptionKey(plainRoot);
check('明文 System.json 读取', plainKey === 'abcdefabcdefabcdefabcdefabcdefab', String(plainKey));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
