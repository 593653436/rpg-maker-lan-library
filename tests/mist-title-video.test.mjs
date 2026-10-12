// mist: 重标题帧序列 → 服务端烘焙视频替换（@mist 路由 + 索引注入 + 12fps 量化帧重绘）。
// 与 server.mjs 的 mistTitleVideoTag / serveGameIndex 注入 / 路由 保持一致（源码级断言防漂移）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

function extractTag() {
  const start = src.indexOf('function mistTitleVideoTag(');
  assert.ok(start >= 0, 'mistTitleVideoTag 缺失');
  const mark = src.indexOf("lines.push('})();</script>');", start);
  assert.ok(mark > start, 'tag 收尾标记缺失');
  const end = src.indexOf('\n}', mark);
  assert.ok(end > mark, 'tag 函数结束缺失');
  return src.slice(start, end + 2);
}

test('mistTitleVideoTag renders a guarded video-swap client script', () => {
  const fn = extractTag();
  const ctx = vm.createContext({ Buffer });
  vm.runInContext(fn + '\n;globalThis.__tag = mistTitleVideoTag;', ctx);
  const out = vm.runInContext('__tag("demo-game")', ctx);
  assert.equal(typeof out, 'string');
  // URL 指向 @mist 路由下的 mp4
  assert.ok(out.includes('/games/') && out.includes('/@mist/title_fire.mp4'), '视频 URL 缺失');
  // 拦截 ImageManager.loadTitle2（阻断 215 帧预载）
  assert.ok(out.includes('ImageManager.loadTitle2 = function()'), 'loadTitle2 拦截缺失');
  assert.ok(out.includes('new Bitmap(1, 1)'), '占位位图缺失');
  // Scene_Title 就绪后把动画精灵换成视频精灵
  assert.ok(out.includes('scene._backSprite2'), '精灵替换目标缺失');
  assert.ok(out.includes('__mistVideoInstance'), '视频精灵标记缺失');
  assert.ok(out.includes('getChildIndex(old)'), '原位替换缺失');
  // 帧率量化：按 12fps 帧号变化才重绘（防 60fps 全屏合成/上传）
  assert.ok(out.includes('Math.floor(v.currentTime * 12)'), '12fps 量化缺失');
  assert.ok(out.includes('v.currentTime !== this._t') === false, '旧的恒真守卫不应存在');
  // 版本标记（线上确认用）
  assert.ok(out.includes('v4-mp4-opaque'), '版本标记缺失');
  // 只在 MZ 且场景存在时生效（防御性）
  assert.ok(out.includes("window.Scene_Title"), 'Scene_Title 守卫缺失');
});

test('server.mjs wires the @mist route and the index injection (drift guard)', () => {
  assert.ok(src.includes("if(sub.startsWith('/@mist/')){"), '@mist 路由缺失');
  assert.ok(src.includes("path.join(DATA_DIR,'mist-media',m[1])"), '@mist 路由目录缺失');
  assert.ok(src.includes('nm.includes(String.fromCharCode(92))'), '@mist 路径穿越防护缺失');
  assert.ok(src.includes("[mistTitleVideoTag(gameId)]:[]),"), '索引注入缺失');
  assert.ok(src.includes("fsp.stat(path.join(DATA_DIR,'mist-media',gameId,'title_fire.mp4'))"), '视频存在性探测缺失');
  assert.ok(src.includes("'.mp4':'video/mp4'"), 'mp4 MIME 缺失');
});
