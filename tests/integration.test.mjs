import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

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
    write(path.join(mz,'js','rmmz_managers.js'),`PluginManager.makeUrl=function(filename){return "js/plugins/"+filename+".js"};`),
    write(path.join(mz,'js','plugins','CsvAutoLoader.js'),`const fs=require('fs');const path=require('path');const PLUGIN_NAME='CsvAutoLoader';/* data/csvdata */DataManager.createGameObjects=function(){};PluginManager.registerCommand(PLUGIN_NAME,'ReloadCsv',()=>{});`),
    write(path.join(mz,'data','csvdata','dialog.csv'),'id,text\n1,hello\n'),
    write(path.join(mz,'save','titleInfo.rmmzsave'),'synthetic-title-info'),
    write(path.join(mv,'index.html'),`<title>MV Sample</title><script src="js/main.js"></script>`),
    write(path.join(mv,'js','main.js'),`document.write('mv')`),
    write(path.join(mv,'js','rpg_managers.js'),`PluginManager.makeUrl=function(filename){return "js/plugins/"+filename+".js"};`),
    write(path.join(mv,'js','plugins.js'),`var $plugins=[{"name":"AnimationByPoint","status":true,"description":"synthetic","parameters":{}}];`),
    write(path.join(mv,'js','plugins','PluginCommonBase.js'),'window.PluginManagerEx={};'),
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
    const plugins=await fetch(`${base}/games/${mvGame.id}/js/plugins.js`,{headers}).then(r=>r.text());assert.match(plugins,/PluginCommonBase/);
    // 任意路径浏览：sourceRoot 之外的本地路径（os.tmpdir）应可浏览并提供上级目录
    const outside=os.tmpdir();
    const browseOut=await fetch(base+'/api/browse?type=game&path='+encodeURIComponent(outside),{headers}).then(r=>r.json());
    assert.ok(browseOut.current&&browseOut.current.replaceAll('/','\\').toLowerCase().includes(outside.replaceAll('/','\\').toLowerCase()),'应返回请求的目录');
    assert.ok(browseOut.parent,'root 之外的目录应有上级');
    const browseUp=await fetch(base+'/api/browse?type=game&path='+encodeURIComponent(browseOut.parent),{headers}).then(r=>r.json());
    assert.ok(Array.isArray(browseUp.folders),'上级目录应可继续浏览')
  }finally{child.kill();await fsp.rm(root,{recursive:true,force:true})}
});
