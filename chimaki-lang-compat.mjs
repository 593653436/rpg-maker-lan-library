// Chimaki_Lang (MZ 多言語 CSV 插件) 浏览器化 — webpack 内联模块 823 = `require("fs")`。
// 浏览器中 parseLang 调 __webpack_require__(823) 同步抛 ReferenceError → CSV 字典永不载入
// → LangManager.data 为空 → 任何含 \T[KEY] 的文本查表崩（标题命令即触发）：
//   'Cannot read properties of undefined (reading 'SIS1036')'。
// 变换：把 fs 模块替换为 XHR 版 readFile/readFileSync（路径去掉前导 './' 后相对游戏页
// /games/<id>/ 解析 → 读 /games/<id>/csv/*.csv）。插件其余逻辑原样保留。
export function chimakiLangFsCompat(source) {
  if (typeof source !== 'string') return source;
  if (source.includes('__mistChimakiFs')) return source; // 已变换（幂等标记）
  if (!/a\.exports\s*=\s*require\(\s*["']fs["']\s*\)/.test(source)) return source;
  const shim = 'a.exports=(function(){if(globalThis.__mistChimakiFs)return globalThis.__mistChimakiFs;function _req(p){var x=new XMLHttpRequest();x.open("GET",String(p).replace(/^[.][/]/,""),false);x.send();if(x.status!==0&&(x.status<200||x.status>=400))throw new Error("HTTP "+x.status);return x.responseText}var _fs={readFile:function(p,e,cb){try{cb(null,_req(p))}catch(err){cb(err)}},readFileSync:function(p){try{return _req(p)}catch(err){return ""}}};globalThis.__mistChimakiFs=_fs;return _fs})()';
  const output = source.replace(/a\.exports\s*=\s*require\(\s*["']fs["']\s*\)/, shim);
  return output === source ? source : output;
}
