// mist: serveEncryptedAudioM4a 加密音频转码的叠加层密钥回退（Enigma 打包游戏）合成单测。
// 从 server.mjs 提取真实函数在 vm 中执行，依赖全部以桩替代（纯合成，无真实游戏/无 ffmpeg）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const src = /async function serveEncryptedAudioM4a\([\s\S]*?\n\}/.exec(server);

function makeCtx({ rootKey = null, overlayKey = null, overlaySameRoot = false } = {}) {
  let cacheExists = false, status = null, headers = null, body = null;
  const res = { writeHead: (s, h) => { status = s; headers = h; }, end: b => { body = b; } };
  const ctx = {
    path: { join: (...a) => a.join('/') },
    fsp: {
      stat: async p => {
        if (p === '/nas/bgm/theme.rpgmvo') return { isFile: () => true };
        if (p === '/cache/g1/bgm/theme.m4a') return cacheExists ? { isFile: () => true } : null;
        return null;
      },
      readFile: async () => Buffer.from('m4a-bytes')
    },
    safeJoin: (root, rel) => root + rel,
    loadEncryptionKey: async r => (r === '/nas' ? rootKey : r === '/ovl' ? overlayKey : null),
    resourceRootFor: async () => (overlaySameRoot ? '/nas' : '/ovl'),
    M4A_CACHE_DIR: '/cache',
    FFMPEG_BIN: 'ffmpeg',
    decryptLegacyMv: buf => (buf ? Buffer.from('plain') : null),
    transcodeOggBufferToM4a: async () => { cacheExists = true; },
    encryptLegacyMv: (buf, key) => Buffer.from('enc:' + key),
    m4aTranscodeQueue: Promise.resolve(),
    console: { error() {}, log() {}, info() {} },
    Buffer
  };
  vm.createContext(ctx);
  vm.runInContext(src[0], ctx);
  return { ctx, res, get: () => ({ status, headers, body }) };
}

test('serveEncryptedAudioM4a: overlay-aware encryption key fallback', async () => {
  assert.ok(src, 'serveEncryptedAudioM4a source missing');
  // 1) 常规 webRoot 读不到密钥 → 经叠加层感知路径取到 → 转码并 200
  {
    const { ctx, res, get } = makeCtx({ rootKey: null, overlayKey: 'KEY' });
    const ok = await ctx.serveEncryptedAudioM4a({ method: 'GET' }, res, '/nas', '/bgm/theme.rpgmvm', { id: 'g1' }, null);
    assert.equal(ok, true, '叠加层回退后应成功');
    const { status, headers, body } = get();
    assert.equal(status, 200);
    assert.equal(headers['Content-Type'], 'audio/mp4');
    assert.equal(String(body), 'enc:KEY', '密钥应取自叠加层根');
  }
  // 2) 叠加层根与常规根相同（无叠加层）→ 仍取不到密钥 → 失败返回 false，不写响应
  {
    const { ctx, res, get } = makeCtx({ rootKey: null, overlayKey: 'KEY', overlaySameRoot: true });
    const ok = await ctx.serveEncryptedAudioM4a({ method: 'GET' }, res, '/nas', '/bgm/theme.rpgmvm', { id: 'g1' }, null);
    assert.equal(ok, false);
    assert.equal(get().status, null);
  }
});
