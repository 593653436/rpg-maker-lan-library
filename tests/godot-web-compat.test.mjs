// mist: Godot Web 导出通道（实验性）——内容指纹 / 索引改写 / 存档 sidecar / 防漂移。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { isGodotWeb, serveGodotWeb } from '../godot-web-compat.mjs';

const SRC = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

function mkRes() {
  return {
    status: 0, headers: {}, body: null,
    writeHead(c, h = {}) { this.status = c; this.headers = h; },
    end(b) { this.body = b === undefined ? null : (Buffer.isBuffer(b) ? b.toString() : String(b)); },
  };
}
function deps() {
  return {
    serveFile: async (req, res, root, p) => { res.writeHead(200, { 'Content-Type': 'x' }); res.end('file:' + p); },
    text: (res, c, body) => { res.writeHead(c, { 'Content-Type': 'text/plain' }); res.end(String(body)); },
    json: (res, c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); },
  };
}
async function webFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'godotweb-'));
  await fsp.writeFile(path.join(dir, 'index.html'), '<!DOCTYPE html><html><head><title>t</title></head><body><div id="status"></div><canvas id="canvas"></canvas><script>fetch("/__save/_meta")</script></body></html>');
  await fsp.writeFile(path.join(dir, 'index.wasm'), 'x');
  await fsp.writeFile(path.join(dir, 'index.pck'), 'x');
  return dir;
}

test('isGodotWeb 内容指纹：三件套齐全才识别', async () => {
  const partial = await fsp.mkdtemp(path.join(os.tmpdir(), 'godotweb-p-'));
  await fsp.writeFile(path.join(partial, 'index.html'), '<html></html>');
  await fsp.writeFile(path.join(partial, 'index.wasm'), 'x');
  assert.equal(await isGodotWeb(partial), false, '缺 index.pck 不得识别');
  const full = await webFixture();
  assert.equal(await isGodotWeb(full), true);
});

test('索引页改写：<base> + 相对存档路径 + 就绪信号', async () => {
  const dir = await webFixture();
  const res = mkRes();
  await serveGodotWeb({ method: 'GET' }, res, deps(), { id: 'g1' }, dir, '/', null, 'g1');
  assert.equal(res.status, 200);
  const body = res.body;
  assert.ok(body.includes('<base href="/games/g1/">'), '注入 <base>');
  assert.ok(body.includes('"__save/_meta'), '存档接口应为相对路径');
  assert.ok(!body.includes('"/__save/'), '不得残留绝对存档路径');
  assert.ok(body.includes('mist-game-ready'), '就绪信号缺失');
});

test('静态资源走 serveFile（pck 依赖其 Range 支持）', async () => {
  const dir = await webFixture();
  const res = mkRes();
  await serveGodotWeb({ method: 'GET' }, res, deps(), { id: 'g1' }, dir, '/index.pck', null, 'g1');
  assert.equal(res.status, 200);
  assert.equal(res.body, 'file:/index.pck');
});

test('存档 sidecar：PUT→GET→_meta 往返 + 非法名拒绝 + .bak', async () => {
  const dir = await webFixture();
  const d = deps();
  const payload = Buffer.from('{"locale":"zh_TW"}');
  const putReq = Readable.from([payload]);
  putReq.method = 'PUT';
  const resPut = mkRes();
  await serveGodotWeb(putReq, resPut, d, { id: 'g' }, dir, '/__save/options.json', null, 'g');
  assert.equal(resPut.status, 200);
  assert.equal(await fsp.readFile(path.join(dir, 'saves', 'options.json'), 'utf8'), payload.toString());

  // 二次写入应留下 .bak
  const second = Readable.from([Buffer.from('{"locale":"en"}')]);
  second.method = 'PUT';
  await serveGodotWeb(second, mkRes(), d, { id: 'g' }, dir, '/__save/options.json', null, 'g');
  assert.equal(await fsp.readFile(path.join(dir, 'saves', 'options.json.bak'), 'utf8'), payload.toString());

  const resGet = mkRes();
  await serveGodotWeb({ method: 'GET' }, resGet, d, { id: 'g' }, dir, '/__save/options.json', null, 'g');
  assert.equal(resGet.status, 200);
  assert.equal(resGet.body, '{"locale":"en"}');

  const resMeta = mkRes();
  await serveGodotWeb({ method: 'GET' }, resMeta, d, { id: 'g' }, dir, '/__save/_meta', null, 'g');
  const meta = JSON.parse(resMeta.body);
  assert.equal(meta.mode, 'nas');
  assert.ok(meta.files['options.json']);

  const resBad = mkRes();
  await serveGodotWeb({ method: 'GET' }, resBad, d, { id: 'g' }, dir, '/__save/..evil name', null, 'g');
  assert.equal(resBad.status, 400, '非法存档名必须拒绝');
});

test('server.mjs 接线防漂移', () => {
  assert.ok(SRC.includes("from './godot-web-compat.mjs'"), '模块 import 缺失');
  assert.ok(SRC.includes('serveGodotWeb(req,res,'), '路由分派缺失');
  assert.ok(SRC.includes("kind:'godotweb'"), '导入识别缺失');
  assert.ok(fs.existsSync(new URL('../godot-web-compat.mjs', import.meta.url)), '模块文件缺失');
});
