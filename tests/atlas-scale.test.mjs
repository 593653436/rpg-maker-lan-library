// spine .atlas 坐标缩放单测（纯合成夹具，node --test）
import test from 'node:test';
import assert from 'node:assert/strict';
import { atlasScaleFor, scaleAtlasText } from '../texture-compat.mjs';

test('atlasScaleFor：超限才缩，比例取 min', () => {
  assert.equal(atlasScaleFor(100, 100, 4096), null);
  const sc = atlasScaleFor(6286, 4655, 4096);
  assert.equal(sc.width, 4096);
  assert.equal(sc.height, 3033);
  assert.ok(Math.abs(sc.scale - 4096 / 6286) < 1e-12);
});

test('scaleAtlasText：坐标等比缩放 + 帧不越界 + 旋转交换写回', () => {
  const atlas = [
    '', 'T.png', 'size: 1000, 500', 'format: RGBA8888', 'filter: Linear, Linear', 'repeat: none',
    'plain', '  rotate: false', '  xy: 10, 20', '  size: 200, 100', '  orig: 200, 100', '  offset: 0, 0', '  index: -1',
    'rot', '  rotate: true', '  xy: 800, 300', '  size: 50, 200', '  orig: 52, 202', '  offset: 1, 1', '  index: -1',
    'edge', '  rotate: false', '  xy: 900, 400', '  size: 100, 100', '  orig: 100, 100', '  offset: 0, 0', '  index: -1',
    ''
  ].join('\n');
  const out = scaleAtlasText(atlas, { 'T.png': atlasScaleFor(1000, 500, 300) });
  assert.ok(out.includes('size: 300, 150'), '页 size 行改写');
  assert.ok(out.includes('  xy: 3, 6'), '普通帧 xy');
  assert.ok(out.includes('  size: 60, 30'), '普通帧 size');
  assert.ok(out.includes('  xy: 240, 90'), '旋转帧 xy');
  assert.ok(out.includes('  size: 15, 60'), '旋转帧 size 交换写回');
  assert.ok(out.includes('  orig: 16, 61'), '旋转帧 orig');
  assert.ok(out.includes('  xy: 270, 120'), '贴边帧 xy');
  assert.ok(out.includes('  size: 30, 30'), '贴边帧 size');
  // 不变量：重演解析器的帧检查逻辑
  const lines = out.split('\n'); let cur = null, page = null; let regions = 0;
  for (const raw of lines) {
    const t = raw.trim(); if (!t) continue;
    if (!/^\s/.test(raw)) {
      if (/^size\s*:/i.test(t)) { const m = t.match(/size:\s*(\d+),\s*(\d+)/); page = { w: +m[1], h: +m[2] }; continue; }
      if (/^(format|filter|repeat|pma)\s*:/i.test(t)) continue;
      if (/\.png$/i.test(t)) { page = null; continue; }
      cur = { name: t }; continue;
    }
    if (!cur) continue;
    let m;
    if ((m = raw.match(/rotate\s*:\s*(\S+)/i))) cur.rot = m[1].toLowerCase() === 'true';
    if ((m = raw.match(/xy\s*:\s*(\d+)\s*,\s*(\d+)/i))) { cur.x = +m[1]; cur.y = +m[2]; }
    if ((m = raw.match(/size\s*:\s*(\d+)\s*,\s*(\d+)/i))) {
      cur.s0 = +m[1]; cur.s1 = +m[2]; regions++;
      const extW = cur.rot ? cur.s1 : cur.s0, extH = cur.rot ? cur.s0 : cur.s1;
      assert.ok(page && cur.x + extW <= page.w && cur.y + extH <= page.h, `帧越界: ${cur.name}`);
    }
  }
  assert.equal(regions, 3);
});

test('scaleAtlasText：未列入或未命中的页原样输出', () => {
  const atlas = 'P.png\nsize: 100, 50\na\n  rotate: false\n  xy: 1, 2\n  size: 3, 4\n  orig: 3, 4\n  offset: 0, 0\n  index: -1';
  assert.equal(scaleAtlasText(atlas, {}), atlas);
  assert.equal(scaleAtlasText(atlas, { 'Other.png': atlasScaleFor(100, 50, 10) }), atlas);
});
