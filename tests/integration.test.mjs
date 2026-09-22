import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const project=path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/,m=>m.slice(1))));
const write=async(file,content)=>{await fsp.mkdir(path.dirname(file),{recursive:true});await fsp.writeFile(file,content)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function waitFor(url){for(let i=0;i<60;i++){try{const r=await fetch(url);if(r.status<500)return}catch{}await sleep(100)}throw new Error('server did not start')}
function cookieFrom(response){return response.headers.get('set-cookie')?.split(';')[0]||''}

test('synthetic MV/MZ library works without real games',{skip:process.platform!=='win32',timeout:30000},async()=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'rpg-lan-public-')),port=18878,games=path.join(root,'games'),mz=path.join(games,'MZ Sample'),mv=path.join(games,'MV Sample','www');
  await Promise.all([
    write(path.join(mz,'index.html'),`<title>MZ Sample</title><script src="js/main.js"></script>`),
    write(path.join(mz,'js','main.js'),`document.write('mz')`),
    write(path.join(mz,'js','rmmz_managers.js'),`PluginManager.makeUrl=function(filename){return "js/plugins/"+filename+".js"};\nSceneManager.onReject = function(event) { event.message = event.reason; };\nSceneManager.onError = function(event) { this.stop(); };\nStorageManager.saveToLocalFile = function(saveName, zip) {\n    const dirPath = this.fileDirectoryPath();\n    return dirPath;\n};`),
    write(path.join(mz,'js','plugins','CsvAutoLoader.js'),`const fs=require('fs');const path=require('path');const PLUGIN_NAME='CsvAutoLoader';/* data/csvdata */DataManager.createGameObjects=function(){};PluginManager.registerCommand(PLUGIN_NAME,'ReloadCsv',()=>{});`),
    write(path.join(mz,'data','csvdata','dialog.csv'),'id,text\n1,hello\n'),
    write(path.join(mz,'js','plugins','CGMZ_SplashScreen.js'),`if (!CycloneSteam.isSubscribedApp(1234)) { console.log("gated"); }`),
    write(path.join(mz,'js','plugins','Sakura_MapNameExtend.js'),`  const fs = require('fs');\n  const path = require('path');\n  const getBasePath = () => path.dirname(process.mainModule.filename);`),
    write(path.join(mz,'js','plugins','SoR_DataNoteExtension_MZ.js'),`const fs = require('fs');\nconst Extended_NotePath = 'data/SoRNote/';\n(function() {\n  boot();\n})();`),
    write(path.join(mz,'data','SoRNote','boss_note'),'SYNTHNOTE'),
    write(path.join(mz,'save','titleInfo.rmmzsave'),'synthetic-title-info'),
    write(path.join(mv,'index.html'),`<title>MV Sample</title><script src="js/main.js"></script>`),
    write(path.join(mv,'js','main.js'),`document.write('mv')`),
    write(path.join(mv,'js','rpg_managers.js'),`PluginManager.makeUrl=function(filename){return "js/plugins/"+filename+".js"};\nAudioManager.playBgm = function(bgm, pos) {\n    if (this.isCurrentBgm(bgm)) {\n        this.updateBgmParameters(bgm);\n    }\n};\nAudioManager.playBgs = function(bgs, pos) {\n    if (this.isCurrentBgs(bgs)) {\n        this.updateBgsParameters(bgs);\n    }\n};`),
    write(path.join(mv,'js','plugins.js'),`var $plugins=[{"name":"AnimationByPoint","status":true,"description":"synthetic","parameters":{}}];`),
    write(path.join(mv,'js','plugins','PluginCommonBase.js'),'window.PluginManagerEx={};'),
    write(path.join(mv,'js','plugins','Movie.js'),`if (!Utils.isNwjs()) {\n\tconsole.error(\"Movie does not supports platforms other than NW.js\");\n} else if (typeof AssetDatabaseMovie === 'undefined') {\n\tconsole.error(\"AssetDatabaseMovie not found\");\n} else {\n\tconst MovieManager = { _element: null, play() { this._element.play(); } };\n\tclass SimpleVideoBaseTexture extends PIXI.BaseTexture {}\n\tSceneManager.playMovie = function (movieId, context) { MovieManager.play(); };\n}\n`),
    write(path.join(mv,'save','AnotherNewGame.rpgsave'),'synthetic-another-new-game'),
    write(path.join(mv,'save','global.rpgsave'),'synthetic-global')
  ]);
  const password='public-test-password',salt=crypto.randomBytes(16).toString('hex'),config={host:'127.0.0.1',port,sourceRoot:games,recollectionRoot:path.join(root,'recollections'),libraryDir:path.join(root,'library'),dataDir:path.join(root,'data'),siteTitle:'Synthetic Library',auth:{adminUsername:'admin',adminPasswordSalt:salt,adminPasswordHash:crypto.scryptSync(password,salt,64).toString('hex'),sessionSecret:crypto.randomBytes(32).toString('hex')}};
  await write(path.join(root,'config.json'),JSON.stringify(config));
  const guestSalt=crypto.randomBytes(16).toString('hex');await write(path.join(root,'data','settings.json'),JSON.stringify({version:1,guestAccess:{passwordSalt:guestSalt,passwordHash:crypto.scryptSync('guest',guestSalt,64).toString('hex'),sessionVersion:1}}));
  const child=spawn(process.execPath,[path.join(project,'server.mjs')],{cwd:project,env:{...process.env,RPG_CONFIG:path.join(root,'config.json')},stdio:'ignore'});
  try{
    const base=`http://127.0.0.1:${port}`;await waitFor(base+'/login.html');
    const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password})});assert.equal(login.status,200);const cookie=cookieFrom(login),headers={cookie,'content-type':'application/json'};
    for(const [sourcePath,title] of [[mz,'MZ Sample'],[path.dirname(mv),'MV Sample']]){const r=await fetch(base+'/api/import',{method:'POST',headers,body:JSON.stringify({sourcePath,title})});assert.equal(r.status,202)}
    const listed=await fetch(base+'/api/games',{headers}).then(r=>r.json());assert.equal(listed.games.length,2);const mzGame=listed.games.find(x=>x.title==='MZ Sample'),mvGame=listed.games.find(x=>x.title==='MV Sample');
    const titleInfo=await fetch(`${base}/api/game-saves/${mzGame.id}/titleInfo`,{headers}).then(r=>r.text());assert.equal(titleInfo,'synthetic-title-info');
    const csv=await fetch(`${base}/games/${mzGame.id}/js/plugins/CsvAutoLoader.js`,{headers}).then(r=>r.text());assert.doesNotMatch(csv,/require\s*\(/);assert.match(csv,/dialog\.csv/);
    const mvSaves=await fetch(`${base}/api/game-saves/${mvGame.id}`,{headers}).then(r=>r.json());assert.ok(mvSaves.saves.some(x=>x.name==='anotherNewGame'));
    const mvBridge=await fetch(`${base}/mv-save-bridge/${mvGame.id}.js`,{headers}).then(r=>r.text());assert.match(mvBridge,/n===-1001\?'anotherNewGame'/);
    const rejected=await fetch(`${base}/api/game-saves/${mvGame.id}/arbitrary`,{headers});assert.equal(rejected.status,400);
    const knsOk=await fetch(`${base}/api/game-saves/${mzGame.id}/knsGlobalInfo`,{method:'PUT',headers,body:'{"x":1}'});assert.ok(knsOk.ok,'knsGlobalInfo 应在白名单');
    for(const nm of ['gameEnd','gameRecall','gameCloth','trueEnd']){const r2=await fetch(`${base}/api/game-saves/${mvGame.id}/${nm}`,{method:'PUT',headers,body:'{}'});assert.ok(r2.ok,nm+' 应在白名单')}
    const plugins=await fetch(`${base}/games/${mvGame.id}/js/plugins.js`,{headers}).then(r=>r.text());assert.match(plugins,/PluginCommonBase/);
    // FMOO 存档：服务端解包端点（合成 ProSave 格式）
    const proSave = '@@__FMOO_PROSAVE__@@' + zlib.deflateRawSync(Buffer.from('{"system":{"x":1}}')).toString('base64');
    const unwrapped = await fetch(base+'/api/mv-prosave-unwrap',{method:'POST',headers:{...headers,'content-type':'text/plain;charset=UTF-8'},body:proSave});
    assert.equal(unwrapped.status,200);assert.equal(await unwrapped.text(),'{"system":{"x":1}}');
    const notProSave = await fetch(base+'/api/mv-prosave-unwrap',{method:'POST',headers,body:'hello'});
    assert.equal(notProSave.status,400);
    const mvSaveBridge2=await fetch(`${base}/mv-save-bridge/${mvGame.id}.js`,{headers}).then(r=>r.text());assert.match(mvSaveBridge2,/mv-prosave-unwrap/);
    // Movie.js（F_ 系）：NW 门卫中和 + 自动播放重试；版本段路径同源同内容
    const moviePatched=await fetch(`${base}/games/${mvGame.id}/js/plugins/Movie.js`,{headers}).then(r=>r.text());
    assert.match(moviePatched,/mist: browser-enabled/);assert.match(moviePatched,/NotAllowedError/);assert.match(moviePatched,/SceneManager\.playMovie/);
    const movieVersioned=await fetch(`${base}/games/${mvGame.id}/js/plugins/.mistv/movie-browser-1/Movie.js`,{headers}).then(r=>r.text());
    assert.equal(movieVersioned,moviePatched);
    const mvManagers=await fetch(`${base}/games/${mvGame.id}/js/rpg_managers.js`,{headers}).then(r=>r.text());
    assert.match(mvManagers,/Movie:'movie-browser-1'/);assert.match(mvManagers,/\.mistv\/'\+version/);
    const mzManagers=await fetch(`${base}/games/${mzGame.id}/js/rmmz_managers.js`,{headers}).then(r=>r.text());
    assert.match(mzManagers,/__mistRejectGuard/);
    const cgmz=await fetch(`${base}/games/${mzGame.id}/js/plugins/CGMZ_SplashScreen.js`,{headers}).then(r=>r.text());
    assert.match(cgmz,/if \(false\)/);assert.doesNotMatch(cgmz,/!CycloneSteam\.isSubscribedApp/);
    const sakura=await fetch(`${base}/games/${mzGame.id}/js/plugins/Sakura_MapNameExtend.js`,{headers}).then(r=>r.text());
    assert.match(sakura,/mist: nwjs fs stub/);
    const sor=await fetch(`${base}/games/${mzGame.id}/js/plugins/SoR_DataNoteExtension_MZ.js`,{headers}).then(r=>r.text());
    assert.match(sor,/__mistSoRFS/);assert.match(sor,/SYNTHNOTE/);
    // MZ 游戏首页注入纹理上限探针；mistprobe 路由返回真实存在性
    const mzIndex2=await fetch(`${base}/games/${mzGame.id}/`,{headers}).then(r=>r.text());assert.match(mzIndex2,/mistmts/);
    const probeHit=await fetch(`${base}/games/${mvGame.id}/js/plugins.js?mistprobe=1`,{headers});assert.equal(probeHit.status,200);
    const probeMiss=await fetch(`${base}/games/${mvGame.id}/js/nope.js?mistprobe=1`,{headers});assert.equal(probeMiss.status,404);
    // 任意路径浏览：sourceRoot 之外的本地路径（os.tmpdir）应可浏览并提供上级目录
    const outside=os.tmpdir();
    const browseOut=await fetch(base+'/api/browse?type=game&path='+encodeURIComponent(outside),{headers}).then(r=>r.json());
    assert.ok(browseOut.current&&browseOut.current.replaceAll('/','\\').toLowerCase().includes(outside.replaceAll('/','\\').toLowerCase()),'应返回请求的目录');
    assert.ok(browseOut.parent,'root 之外的目录应有上级');
    const browseUp=await fetch(base+'/api/browse?type=game&path='+encodeURIComponent(browseOut.parent),{headers}).then(r=>r.json());
    assert.ok(Array.isArray(browseUp.folders),'上级目录应可继续浏览')
  }finally{child.kill();await fsp.rm(root,{recursive:true,force:true})}
});
