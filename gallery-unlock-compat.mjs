// 震える女教師系自研图鉴插件（TitleExtra / CGGallery / EventGallery）浏览器化。
// 三个插件共用同一模式：require('fs') 读写 save/<Name>_unlocks.json（解锁状态）。
// 浏览器中 require 抛错被各自 catch → 解锁数据为空 → 标题按钮不显示 / 图鉴全锁。
// 变换：fs 读写替换为服务端 HTTP 桥（GET/PUT /api/game-unlocks/<gid>/<file>）；
// CGGallery 的 readdirSync(img/pictures/<folder>) 替换为 /api/picture-dir 列表接口。

export const UNLOCK_FILES = {
  TitleExtra: 'TitleExtra_unlocks.json',
  CGGallery: 'CGGallery_unlocks.json',
  EventGallery: 'EventGallery_unlocks.json',
};

export const UNLOCK_FILE_NAMES = new Set(Object.values(UNLOCK_FILES));

function unlockBridgePrelude(gameId) {
  return `;(function(){
  if(globalThis.__mistUnlockBridge)return;globalThis.__mistUnlockBridge=true;
  var gid=${JSON.stringify(gameId)};
  globalThis.__mistUnlockGet=function(name){
    try{var x=new XMLHttpRequest();x.open('GET','/api/game-unlocks/'+gid+'/'+encodeURIComponent(name),false);x.send();
      if(x.status>=400)return {};return JSON.parse(x.responseText||'{}')||{};}catch(e){return {}};
  };
  globalThis.__mistUnlockPut=function(name,data){
    try{var x=new XMLHttpRequest();x.open('PUT','/api/game-unlocks/'+gid+'/'+encodeURIComponent(name),false);
      x.setRequestHeader('Content-Type','application/json');x.send(JSON.stringify(data||{}));}catch(e){console.error('雾灯: 解锁数据保存失败',e);}
  };
  globalThis.__mistListPictureDir=function(folder){
    try{var x=new XMLHttpRequest();x.open('GET','/api/picture-dir/'+gid+'/'+encodeURIComponent(folder),false);x.send();
      if(x.status>=400)return [];return JSON.parse(x.responseText||'[]')||[];}catch(e){return []}
  };
})();
`;
}

const REQUIRE_BLOCK_RE = /_fs\s*=\s*require\s*\(\s*['"]fs['"]\s*\)\s*;\s*\n\s*_path\s*=\s*require\s*\(\s*['"]path['"]\s*\)\s*;\s*\n\s*(?:var\s+_base\s*=\s*_path\.dirname\s*\(\s*process\.mainModule\.filename\s*\)\s*;\s*\n\s*)?UNLOCK_FILE\s*=\s*_path\.join\s*\(\s*[^,;]+,\s*['"]save['"]\s*,\s*['"]([A-Za-z0-9_.]+)['"]\s*\)\s*;/;

const LOAD_RE = /function\s+_loadUnlocks\s*\(\s*\)\s*\{[\s\S]*?\n    \}/;
const SAVE_RE = /function\s+_saveUnlocks\s*\(\s*data\s*\)\s*\{[\s\S]*?\n    \}/;
const READDIR_RE = /if\s*\(\s*_fs\s*&&\s*_path\s*\)\s*\{[\s\S]*?catch\s*\(e\)\s*\{\}\s*\n\s*\}/;

/**
 * 将解锁文件读写换成 HTTP 桥；CGGallery 额外替换图片目录列举。
 * 任一签名/校验不满足则原样返回（宁可不变换也不改坏）。
 */
export function galleryUnlockBrowserCompat(source, gameId, name) {
  const unlockFile = UNLOCK_FILES[name];
  if (!unlockFile || typeof source !== 'string' || typeof gameId !== 'string' || !gameId) return source;
  if (!/require\s*\(\s*['"]fs['"]\s*\)/.test(source)) return source;
  const requireMatch = REQUIRE_BLOCK_RE.exec(source);
  if (!requireMatch || requireMatch[1] !== unlockFile) return source;
  if (!LOAD_RE.test(source) || !SAVE_RE.test(source)) return source;
  if (name === 'CGGallery' && !READDIR_RE.test(source)) return source;

  let output = source
    .replace(REQUIRE_BLOCK_RE, `UNLOCK_FILE = ${JSON.stringify(unlockFile)};`)
    .replace(LOAD_RE, `function _loadUnlocks() {\n        return globalThis.__mistUnlockGet(UNLOCK_FILE);\n    }`)
    .replace(SAVE_RE, `function _saveUnlocks(data) {\n        globalThis.__mistUnlockPut(UNLOCK_FILE, data);\n    }`);
  if (name === 'CGGallery') {
    output = output.replace(READDIR_RE, [
      'try {',
      '                var _all = globalThis.__mistListPictureDir(entry.fileName);',
      '                _unlockedFiles = _all.filter(function (fp) { return !!this._unlocks[fp]; }, this);',
      '            } catch (e) {}',
    ].join('\n'));
  }
  if (output === source || /require\s*\(/.test(output) || /process\.mainModule/.test(output)) return source;
  output = unlockBridgePrelude(gameId) + output;
  output += `\n;globalThis.__mistUnlockCompatFiles=globalThis.__mistUnlockCompatFiles||{};globalThis.__mistUnlockCompatFiles[${JSON.stringify(name)}]=true;\n`;
  return output;
}

// SubFolderPicture.js（震える女教師系，HD CG 文件夹幻灯片插件）：listFolderImages 用
// fs.readdirSync 枚举 img/pictures/<folder>，浏览器中 require 失败 → 空列表 → showPicture
// 得到 'folder/undefined' → CG 不显示。替换为 /api/picture-dir 列表桥（服务端已做
// png/jpg/jpeg/rpgmvp 过滤 + 排序 + 剥扩展名 + 去重，与该插件原语义一致）。
const SFP_LIST_RE = /function\s+listFolderImages\s*\(\s*folder\s*\)\s*\{[\s\S]*?\n    \}/;

export function subFolderPictureBrowserCompat(source, gameId) {
  if (typeof source !== 'string' || typeof gameId !== 'string' || !gameId) return source;
  if (!/require\s*\(\s*['"]fs['"]\s*\)/.test(source)) return source;
  if (!SFP_LIST_RE.test(source)) return source;
  const replacement = [
    '    function listFolderImages(folder) {',
    '        try {',
    "            var entries = globalThis.__mistListPictureDir(folder);",
    "            return entries.map(function (f) { return f.split('/').pop(); });",
    '        } catch (e) {',
    "            console.error('[SubFolderPicture] フォルダ読み込み失敗: ' + folder, e);",
    '            return [];',
    '        }',
    '    }',
  ].join('\n');
  let output = source.replace(SFP_LIST_RE, replacement);
  if (output === source || /require\s*\(/.test(output) || /process\.mainModule/.test(output)) return source;
  output = unlockBridgePrelude(gameId) + output;
  output += `\n;globalThis.__mistUnlockCompatFiles=globalThis.__mistUnlockCompatFiles||{};globalThis.__mistUnlockCompatFiles["SubFolderPicture"]=true;\n`;
  return output;
}
