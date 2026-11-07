// 实验性（Experimental）：Godot Web 导出通道，接口与行为可能在后续版本调整。
// mist: Godot Web 导出游戏通道（内容指纹：index.wasm + index.pck 同时存在即识别）。
// 职责：
//   1) 静态分发 index.html/js/wasm/pck/audio worklets —— serveFile 自带 Range(206，大 pck 必需) 与下载跟踪；
//   2) index.html 响应层改写："/__save/" → 相对 " __save/" + 注入 <base> + 注入 mist-game-ready 信号（解除柜子遮罩）；
//   3) 存档 sidecar：GET/PUT /games/<id>/__save/<name> → 游戏目录 saves/<name>（NAS 上，随目录走；写前 .bak）。
// 依赖（serveFile/text/json）由 server.mjs 在调用点注入，避免模块加载顺序问题。
import fsp from 'node:fs/promises';
import path from 'node:path';

const cache = new Map(); // root -> bool
export async function isGodotWeb(root) {
  if (cache.has(root)) return cache.get(root);
  let ok = false;
  try {
    const [a, b, c] = await Promise.all([
      fsp.stat(path.join(root, 'index.wasm')).catch(() => null),
      fsp.stat(path.join(root, 'index.pck')).catch(() => null),
      fsp.stat(path.join(root, 'index.html')).catch(() => null),
    ]);
    ok = !!(a?.isFile() && b?.isFile() && c?.isFile());
  } catch { ok = false; }
  cache.set(root, ok);
  return ok;
}

const RUNTIME_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function rewriteIndex(gameId, html) {
  let out = html;
  // 存档接口从绝对路径改为相对路径（配合注入的 <base> 指向 /games/<id>/）
  if (out.includes('"/__save/')) out = out.split('"/__save/').join('"__save/');
  if (out.includes("'/__save/")) out = out.split("'/__save/").join("'__save/");
  const base = `<base href="/games/${gameId}/">`;
  out = out.includes('<head>') ? out.replace('<head>', '<head>' + base) : base + out;
  // 引擎就绪后向父页发 mist-game-ready（柜子据此隐藏加载遮罩）
  const ready = `<script>(function(){var n=0,t=setInterval(function(){try{var st=document.getElementById('status'),c=document.getElementById('canvas');var stGone=st&&(st.style.display==='none'||st.hidden||!st.offsetParent);if(stGone||(c&&c.width>0)){clearInterval(t);try{parent.postMessage({type:'mist-game-ready'},'*')}catch(e){}}}catch(e){if(++n>240)clearInterval(t)}},500)})();</script>`;
  out = out.includes('</head>') ? out.replace('</head>', ready + '</head>') : ready + out;
  return out;
}

function readBodyCapped(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > cap) { done = true; reject(Object.assign(new Error('存档过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

async function handleSave(req, res, deps, root, name) {
  const { text, json } = deps;
  if (!NAME_RE.test(name)) return text(res, 400, '非法存档名');
  const dir = path.join(root, 'saves');
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (name === '_meta') {
      const files = {};
      const list = await fsp.readdir(dir).catch(() => []);
      for (const f of list) {
        if (!f.endsWith('.json')) continue;
        const st = await fsp.stat(path.join(dir, f)).catch(() => null);
        if (st?.isFile()) files[f] = { size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
      }
      return json(res, 200, { mode: 'nas', dir: 'saves/', files });
    }
    const file = path.join(dir, name);
    const data = await fsp.readFile(file).catch(() => null);
    if (!data) return text(res, 404, '存档不存在');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    return res.end(data);
  }
  if (req.method === 'PUT') {
    const data = await readBodyCapped(req, 8 * 1024 * 1024).catch((e) => e);
    if (data instanceof Error) return text(res, data.status || 400, data.message || '存档写入失败');
    if (!data || !data.length) return text(res, 400, '存档内容为空');
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    const file = path.join(dir, name), tmp = file + '.tmp';
    await fsp.writeFile(tmp, data);
    const prev = await fsp.readFile(file).catch(() => null);
    if (prev) await fsp.writeFile(file + '.bak', prev).catch(() => {});
    await fsp.rename(tmp, file);
    return json(res, 200, { ok: true, name, bytes: data.length });
  }
  return text(res, 405, '方法不允许');
}

export async function serveGodotWeb(req, res, deps, game, root, sub, loadSession, gameId) {
  const { serveFile, text } = deps;
  if (sub.startsWith('/__save/')) return handleSave(req, res, deps, root, sub.slice(8));
  if (sub === '/' || sub === '/index.html') {
    const html = await fsp.readFile(path.join(root, 'index.html'), 'utf8').catch(() => null);
    if (html === null) return text(res, 404, 'index.html 不存在');
    const body = Buffer.from(rewriteIndex(gameId, html));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...RUNTIME_HEADERS });
    return res.end(body);
  }
  return serveFile(req, res, root, sub, 'public, max-age=3600', loadSession, RUNTIME_HEADERS);
}
// Godot 4.4 的引擎强制要求 Secure Context（getMissingFeatures 含 'Secure Context' 检查）：
// 局域网明文 HTTP 下引擎会直接拒绝启动（错误框 "missing"）。非本机 HTTP 请求一律 302 到 HTTPS。
export function godotWebHttpsRedirect({ req, url, httpsConfig }) {
  if (!httpsConfig?.enabled) return null;
  if (req.socket?.encrypted) return null;
  const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  if (proto === 'https') return null;
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return null;
  const targetHost = String(host || httpsConfig.publicHost || '').replace(/:\d+$/, '');
  const port = Number(httpsConfig.port) || 8788;
  const origin = 'https://' + targetHost + (port === 443 ? '' : ':' + port);
  return origin + url.pathname + url.search;
}

