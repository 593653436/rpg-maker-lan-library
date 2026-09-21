// mist: 翻译匹配增强链测试（合成词典，不依赖任何真实游戏文件）。
// 链：trimBoth → clean(去控制码) → norm(省略号折叠 + 首尾剥壳) → 语气前缀剥离 → 最长前缀回退，
// 与 server.mjs translationBridge 注入浏览器的实现保持一致（源码级断言防漂移）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// ── 与注入链一致的实现（镜像） ──
const controls = /((?:\\|\x1b)(?:[A-Za-z]+(?:\[[^\]]*\]|<[^>]*>)?|[{}.$|!><^#]))/gi;
const trimBoth = t => typeof t === 'string' ? t.replace(/^[\u3000\s]+|[\u3000\s]+$/g, '') : t;
const clean = t => trimBoth(String(t).replace(controls, ''));
const norm = t => {
  const s = clean(t).replace(/[.．。…]{2,}/g, '…');
  return s.replace(/^[　「『"'（(【[]+/, '').replace(/[\u005d　」』"'.…！？。，、：；,!?）)】♡♥❤]+$/, '').trim();
};
const dict = {
  'お前もイってたくせによく言うよ': '你明明也高潮过了还这么说',
  'ん♡ すごい力': '嗯♡ 好厉害的力量',
  '行けると思います': '我想能行',
  '無理矢理...イかされちゃった...♡': '强行...被弄高潮了...♡',
  'ふざけるな': '别开玩笑了'
};
const normIndex = {};
for (const k in dict) { const n = norm(k); if (n && !(n in normIndex)) normIndex[n] = dict[k]; }
const lookup = key => {
  const k3 = norm(key);
  if (normIndex[k3] !== undefined && normIndex[k3] !== key) return normIndex[k3];
  const im = k3.match(/^(?:[ぁ-んァ-ヶー]{1,2}[.．。…]{1,6}|[.．。…]{1,6})/);
  if (im && im[0].length < k3.length) {
    const rest = norm(k3.slice(im[0].length));
    if (normIndex[rest] !== undefined && normIndex[rest] !== rest) return normIndex[rest];
  }
  for (let cut = k3.length - 1; cut >= 4; cut--) {
    const pre = k3.slice(0, cut), tail = k3.slice(cut);
    if (!/^[.．。…！？!?、：；　 \t♡♥❤っ]*$/.test(tail)) continue;
    if (normIndex[pre] !== undefined && normIndex[pre] !== pre && tail.length <= 16) return normIndex[pre];
  }
  return null;
};

test('runtime messages with decoration hit the dictionary through the chain', () => {
  // 1) 「前缀 + … 后缀
  assert.equal(lookup('「お前もイってたくせによく言うよ…'), dict['お前もイってたくせによく言うよ']);
  assert.equal(lookup('お前もイってたくせによく言うよ'), dict['お前もイってたくせによく言うよ']);
  // 2) 控制码 + 全角括号 + ♡/省略号尾
  assert.equal(lookup('\\c[14]（\\c[0]ん♡ すごい力...♡'), dict['ん♡ すごい力']);
  // 3) 语气前缀剥离（ええ...）
  assert.equal(lookup('ええ...行けると思います'), dict['行けると思います']);
  // 4) 省略号形态漂移（... vs …）
  assert.equal(lookup('無理矢理…イかされちゃった…♡'), dict['無理矢理...イかされちゃった...♡']);
  // 5) 最长前缀回退（尾巴仅语气字符）
  assert.equal(lookup('ふざけるな…っ！'), dict['ふざけるな']);
  // 6) 不匹配时返回 null（原样保留）
  assert.equal(lookup('関係のない台詞です'), null);
});

test('server.mjs keeps the chain markers (drift guard)', () => {
  const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("replace(/[.．。…]{2,}/g,'…')"), '省略号折叠缺失');
  assert.ok(src.includes('♡♥❤'), '首尾剥壳字符类缺失');
  assert.ok(src.includes('im[0].length<k3.length'), '语气前缀剥离缺失');
  assert.ok(src.includes('tail.length<=16'), '最长前缀回退缺失');
});
