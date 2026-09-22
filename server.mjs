import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { drillGfttBufferCompat, drillGfttLoaderCompat, drillGfttIndexCompat, HIROKA_PLUGIN_DIR, hirokaIndexCompat, hirokaMainCompat, hirokaManagerCompat, hirokaPluginCompat } from './rpg-compat.mjs';
import { commonSaveBrowserCompat } from './common-save-compat.mjs';
import { scenarioDecodeBrowserCompat, replayModeBrowserCompat, scenarioTextBridge } from './scenario-compat.mjs';
import { clearKrkrArchive, detectKrkrProject, serveKrkrArchive } from './krkr-adapter.mjs';
import { buildKrkrHttpsRedirect } from './krkr-security.mjs';
import { COMPAT_SIGNATURES } from './compat-signatures.mjs';
import { downscalePng, encryptRpgPng, pngDimensions, atlasScaleFor, scaleAtlasText } from './texture-compat.mjs';
import zlib from 'node:zlib';
import { transcodeOggToM4a, transcodeOggBufferToM4a, oggRelToCacheRel } from './m4a-bridge.mjs';
import { decryptLegacyMv, encryptLegacyMv, loadEncryptionKey } from './mv-audio-crypto.mjs';
import { serializeSaveWrite, atomicWriteSave } from './save-write.mjs';
import { fixJsScript76Set } from './js-script-fix.mjs';
import { stripPirateMarkerCode } from './pirate-marker-strip.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = process.env.RPG_CONFIG ? path.resolve(process.env.RPG_CONFIG) : path.join(ROOT, 'config.json');
const config = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
const DATA_DIR = path.resolve(ROOT, config.dataDir || './data');
const LEGACY_LIBRARY_DIR = path.resolve(ROOT, config.libraryDir || './library');
const PUBLIC_DIR = path.join(ROOT, 'public');
const KRKR_RUNTIME_DIR = path.join(PUBLIC_DIR, 'krkr-runtime');
const RECOLLECTION_ROOT = path.resolve(config.recollectionRoot || config.sourceRoot);
const GAMES_FILE = path.join(DATA_DIR, 'games.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const RATINGS_FILE = path.join(DATA_DIR, 'ratings.json');
const COMMENTS_FILE = path.join(DATA_DIR, 'comments.json');
const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const USER_SAVE_DIR = path.join(DATA_DIR,'user-saves');
const LEGACY_SAVE_DIR = path.join(DATA_DIR,'save-fallback');
const LEGACY_SAVE_MIGRATION_FILE = path.join(DATA_DIR,'save-fallback-migration-v1.json');
const RGSS_SAVE_DIR = path.join(DATA_DIR,'rgss-saves');
const LAUNCHER_OVERLAY_DIR = path.join(DATA_DIR,'launcher-overlays');
const MANAGED_COVER_DIR = path.join(DATA_DIR,'managed-covers');
const KRKR_BUNDLED_SAVE_FILES = new Map(Object.entries(config.krkrBundledSaveFiles||{}).map(([id,files])=>[id,new Map(Object.entries(files||{}))]));
const RTP_ROOT = path.resolve(config.rtpRoot || path.join(ROOT,'RPGRTP'));
const EVBUNPACK_COMMAND = process.env.EVBUNPACK_COMMAND || 'uvx --from evbunpack==0.2.6 evbunpack';
const TRANSLATION_NAMES = ['AI翻译.json','翻译文件.json','翻譯文件.json'];
// 响应层补充翻译：key=gameId，value=本地补充翻译 JSON（不改 SMB 原文件；仅 key 不存在时叠加）
const TRANSLATION_EXTRA_FILES = new Map(Object.entries(config.translationExtraFiles||{}));
// 兼容规则目标：按游戏内容指纹（跨用户可迁移）+ 可选 config.compatGames 显式 ID 兜底。
const COMPAT_GAMES = config.compatGames || {};
const fingerprintCache=new Map();
async function gameFingerprint(game){
  if(!game)return null;
  if(fingerprintCache.has(game.id))return fingerprintCache.get(game.id);
  let fp=null;
  try{
    const root=game.webRoot&&game.webRoot!=='.'?path.join(game.sourcePath,game.webRoot):game.sourcePath;
    const index=await fsp.readFile(path.join(root,'index.html')).catch(()=>null);
    const main=index?await fsp.readFile(path.join(root,'js','main.js')).catch(()=>null):null;
    if(index&&main){
      fp='sha256:'+crypto.createHash('sha256').update(String(index.length)+'|').update(index).update('|').update(String(main.length)).update('|').update(main).digest('hex');
    }else{
      // KRKR（data.xp3）等无 index.html 的游戏：取 data.xp3 头部指纹（大小 + 前 256KB）。
      const handle=await fsp.open(path.join(root,'data.xp3'),'r');
      try{const head=Buffer.alloc(262144),{bytesRead}=await handle.read(head,0,head.length,0),stat=await handle.stat();fp='krkr-sha256:'+crypto.createHash('sha256').update(String(stat.size)+'|').update(head.subarray(0,bytesRead)).digest('hex')}finally{await handle.close()}
    }
  }catch{}
  fingerprintCache.set(game.id,fp);
  return fp;
}
async function compatMatches(game,key){
  if(!game)return false;
  const ids=COMPAT_GAMES[key];
  if(Array.isArray(ids)&&ids.includes(game.id))return true;
  const sigs=COMPAT_SIGNATURES[key];
  if(!sigs||!sigs.length)return false;
  const fp=await gameFingerprint(game);
  return fp!==null&&sigs.includes(fp);
}
const MAX_BODY = 1024 * 1024;
const MAX_SAVE_BODY = 10 * 1024 * 1024;
// mist: knsGlobalInfo = KNS_GlobalInfo 插件（愛と平和の魔法少女ローゼリーフ 等 KNS 系游戏）每局必写的
// 全局旗标档；不在白名单时写档被 400 拒绝 → 游戏侧 onReject 停主循环 → 启动闪屏冻结黑屏（2026-09）。
const SAVE_NAME = /^(global|config|common|shared|uta_common|rngd_recomode_switch|ntretdRecoUnlock|anotherNewGame|achievement[s]?|titleInfo|GlobalData|drill_global|drill_timer|gameEnd|gameRecall|gameCloth|trueEnd|file\d+|autosave|MAkaisouSlumguide|knsGlobalInfo|saveimg\d+)$/;
const RGSS3_SAVE_NAME = /^(?:Save\d{2,3}|QuickSave|PublicData|WindowSize)$/;
const RPG_HEADER = Buffer.from('5250474d560000000003010000000000','hex');
const PNG_HEADER = Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
const COVER_DIRS = ['icon','img/titles1','img/titles2','img/system','img/pictures'];
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|rpgmvp|png_)$/i;
const AUTH_COOKIE='mist_session',AUTH_TTL=7*24*60*60,AUTH_ENABLED=Boolean(config.auth?.sessionSecret&&config.auth?.adminPasswordHash);
const PUBLIC_PATHS=new Set(['/login.html','/login.css','/login.js','/config.js']);
const ADMIN_ROUTES=[['GET',/^\/api\/(browse|jobs|game-launchers|translation-candidates|accounts)$/],['POST',/^\/api\/(?:import(?:-batch)?|accounts\/[^/]+\/(?:approve|reject))$/],['PATCH',/^\/api\/(?:games\/|settings\/guest-access$|auth\/registration$)/],['DELETE',/^\/api\/(?:games|accounts)\/[^/]+$/],['POST',/^\/api\/games\/[^/]+\/sync$/]];
const MIME = {
  '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
  '.gif':'image/gif','.svg':'image/svg+xml','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2',
  '.ttf':'font/ttf','.otf':'font/otf','.ogg':'audio/ogg','.m4a':'audio/mp4','.mp3':'audio/mpeg','.wav':'audio/wav',
  '.webm':'video/webm','.mp4':'video/mp4','.wasm':'application/wasm','.zip':'application/octet-stream','.xp3':'application/octet-stream','.efkefc':'application/octet-stream','.rpgmvp':'application/octet-stream',
  '.rpgmvo':'application/octet-stream','.rpgmvm':'application/octet-stream'
};

await Promise.all([fsp.mkdir(DATA_DIR,{recursive:true}),fsp.mkdir(MANAGED_COVER_DIR,{recursive:true})]);
let games = await loadJson(GAMES_FILE, []);
let users = await loadJson(USERS_FILE, {version:1,accounts:[]});
let ratings = await loadJson(RATINGS_FILE, {version:1,games:{},legacyRatingsMigrated:false});
let comments = await loadJson(COMMENTS_FILE, {version:1,games:{}});
let favorites = await loadJson(FAVORITES_FILE, {version:1,users:{}});
const settingsExists=await fsp.stat(SETTINGS_FILE).then(x=>x.isFile()).catch(()=>false);
let settings = await loadJson(SETTINGS_FILE, null);
if(!settingsExists){const salt=crypto.randomBytes(16).toString('hex');settings={version:1,guestAccess:{passwordSalt:salt,passwordHash:crypto.scryptSync('123',salt,64).toString('hex'),sessionVersion:1,updatedAt:new Date().toISOString()},registration:{mode:'open'}};await atomicJson(SETTINGS_FILE,settings)}
if(!settings||settings.version!==1||!settings.guestAccess?.passwordSalt||!settings.guestAccess?.passwordHash||!Number.isInteger(settings.guestAccess.sessionVersion))throw new Error('settings.json 中的游客访问设置无效');
if(!['open','approval','closed'].includes(settings.registration?.mode)){settings.registration={mode:'open'};await atomicJson(SETTINGS_FILE,settings)}
if(!users||users.version!==1||!Array.isArray(users.accounts))users={version:1,accounts:[]};
if(!ratings||ratings.version!==1||!ratings.games||typeof ratings.games!=='object'||Array.isArray(ratings.games))ratings={version:1,games:{},legacyRatingsMigrated:false};
if(!comments||comments.version!==1||!comments.games||typeof comments.games!=='object'||Array.isArray(comments.games))comments={version:1,games:{}};
if(!favorites||favorites.version!==1||!favorites.users||typeof favorites.users!=='object'||Array.isArray(favorites.users))favorites={version:1,users:{}};
for(const list of Object.values(comments.games))if(Array.isArray(list))for(const comment of list)if(!Array.isArray(comment.likedBy))comment.likedBy=[];
for(const item of games)if(!item.type)item.type='game';
if(!ratings.legacyRatingsMigrated){for(const game of games){const value=Number(game.rating)||0;if(value>0&&!ratings.games[game.id])ratings.games[game.id]={[`legacy:${game.id}`]:value}}ratings.legacyRatingsMigrated=true;await atomicJson(RATINGS_FILE,ratings)}
await migrateLegacySaveFallback();
const jobs = new Map();
const loadSessions = new Map();
let writeQueue = Promise.resolve();
for(const game of games){
  if(game.type!=='game')continue;
  try{await attachTranslation(game)}catch{}
}

function loadJson(file, fallback) {
  return fsp.readFile(file, 'utf8').then(JSON.parse).catch(() => fallback);
}
function saveGames() {
  writeQueue = writeQueue.then(() => atomicJson(GAMES_FILE, games));
  return writeQueue;
}
function saveUsers() {
  writeQueue = writeQueue.then(() => atomicJson(USERS_FILE, users));
  return writeQueue;
}
function saveRatings() {
  writeQueue = writeQueue.then(() => atomicJson(RATINGS_FILE, ratings));
  return writeQueue;
}
function saveComments() {
  writeQueue = writeQueue.then(() => atomicJson(COMMENTS_FILE, comments));
  return writeQueue;
}
function saveFavorites() {
  writeQueue = writeQueue.then(() => atomicJson(FAVORITES_FILE, favorites));
  return writeQueue;
}
function saveSettings() {
  writeQueue = writeQueue.then(() => atomicJson(SETTINGS_FILE, settings));
  return writeQueue;
}
async function atomicJson(file, value) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}
function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Content-Length':body.length, 'Cache-Control':'no-store' });
  res.end(body);
}
function createLoadSession(gameId) {
  const token=crypto.randomBytes(18).toString('hex'),now=Date.now(),session={token,gameId,createdAt:now,lastSeen:now,ready:false,resources:new Map(),interruptions:0};
  loadSessions.set(token,session);return session;
}
function loadSessionView(session) {
  const resources=[...session.resources.entries()].map(([path,x])=>({path,size:x.size,loaded:Math.min(x.loaded,x.size),completed:x.completed,failed:x.failed,attempts:x.attempts,active:x.active})),totalBytes=resources.reduce((n,x)=>n+x.size,0),loadedBytes=resources.reduce((n,x)=>n+x.loaded,0);
  return {token:session.token,gameId:session.gameId,createdAt:session.createdAt,lastSeen:session.lastSeen,ready:session.ready,totalBytes,loadedBytes,requestedResources:resources.length,completedResources:resources.filter(x=>x.completed).length,activeResources:resources.filter(x=>x.active>0).length,failedResources:resources.filter(x=>x.failed).length,retryAttempts:resources.reduce((n,x)=>n+Math.max(0,x.attempts-1),0),interruptions:session.interruptions,resources:resources.slice(-100)};
}
function requestLoadSession(req,gameId) {
  let token;try{token=new URL(req.headers.referer||'http://localhost/','http://localhost').searchParams.get('load')}catch{}
  const session=token&&loadSessions.get(token);if(!session||session.gameId!==gameId)return null;session.lastSeen=Date.now();return session;
}
function trackLoadStream(req,res,session,key,size,start=0) {
  if(!session||req.method==='HEAD')return {chunk(){},fail(){}};
  let resource=session.resources.get(key);if(!resource){resource={size,loaded:0,completed:false,failed:false,attempts:0,active:0};session.resources.set(key,resource)}
  resource.size=Math.max(resource.size,size);resource.attempts++;resource.active++;resource.failed=false;let bytes=0,ended=false;
  const finish=ok=>{if(ended)return;ended=true;resource.active=Math.max(0,resource.active-1);resource.loaded=Math.max(resource.loaded,start+bytes);if(ok&&start+bytes>=resource.size)resource.completed=true;else if(!ok){resource.failed=true;session.interruptions++}session.lastSeen=Date.now()};
  res.once('finish',()=>finish(true));res.once('close',()=>{if(!res.writableFinished)finish(false)});
  return {chunk:n=>{bytes+=n;resource.loaded=Math.max(resource.loaded,start+bytes);session.lastSeen=Date.now()},fail:()=>finish(false)};
}
setInterval(()=>{const cutoff=Date.now()-30*60*1000;for(const [token,s] of loadSessions)if(s.lastSeen<cutoff)loadSessions.delete(token)},5*60*1000).unref();
async function readRawBody(req,limit=MAX_SAVE_BODY) {
  const parts=[]; let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('存档过大'),{status:413});parts.push(chunk)}
  return Buffer.concat(parts);
}
function saveNameFromId(id) {
  const value=Number(id); if(!Number.isInteger(value))return null;
  return value<0?'config':value===0?'global':`file${value}`;
}
async function saveMeta(gameRoot) {
  const mz=await fsp.stat(path.join(gameRoot,'js','rmmz_managers.js')).catch(()=>null);
  const mv=mz?null:await fsp.stat(path.join(gameRoot,'js','rpg_managers.js')).catch(()=>null);
  let dir=path.join(gameRoot,'save');
  // mist: webRoot='www' 的 MV/MZ 游戏存档常在游戏根 save/（www 外），如 魔法少女苍蓝星。
  // gameRoot/save 不存在时回退上级目录 save/，保证 SMB 存档可见/可写；正常布局不受影响。
  if(!((await fsp.stat(dir).catch(()=>null))?.isDirectory())){
    const parentSave=path.join(path.dirname(gameRoot),'save');
    if((await fsp.stat(parentSave).catch(()=>null))?.isDirectory())dir=parentSave;
  }
  return {dir,ext:mv?.isFile()?'.rpgsave':'.rmmzsave',engine:mv?.isFile()?'mv':'mz'};
}
function saveFileFor(saveDir,saveName,ext='.rmmzsave') {
  if(!SAVE_NAME.test(saveName)) throw Object.assign(new Error('存档名称无效'),{status:400});
  return path.join(saveDir,`${saveName}${ext}`);
}
function canWriteGameSaves(user){return user.role==='admin'||user.role==='user'}
function gameSaveUserKey(user){const identity=user.role==='user'?user.id:user.username;return crypto.createHash('sha256').update(`${user.role}:${identity}`).digest('hex').slice(0,24)}
function userSaveFile(user,gameId,saveName,ext){if(!canWriteGameSaves(user))return null;return path.join(USER_SAVE_DIR,gameSaveUserKey(user),gameId,`${saveName}${ext}`)}
async function migrateLegacySaveFallback(){
  if((await fsp.stat(LEGACY_SAVE_MIGRATION_FILE).catch(()=>null))?.isFile())return;
  const admin={role:'admin',username:config.auth?.adminUsername||'test-admin'},adminRoot=path.join(USER_SAVE_DIR,gameSaveUserKey(admin));let sourceFiles=0,copied=0,existing=0;
  for(const gameEntry of await fsp.readdir(LEGACY_SAVE_DIR,{withFileTypes:true}).catch(()=>[])){
    if(!gameEntry.isDirectory())continue;const sourceDir=path.join(LEGACY_SAVE_DIR,gameEntry.name),targetDir=path.join(adminRoot,gameEntry.name);
    for(const entry of await fsp.readdir(sourceDir,{withFileTypes:true}).catch(()=>[])){
      if(!entry.isFile()||!/^.+\.(?:rmmzsave|rpgsave)$/i.test(entry.name))continue;const ext=path.extname(entry.name),name=path.basename(entry.name,ext);if(!SAVE_NAME.test(name))continue;sourceFiles++;await fsp.mkdir(targetDir,{recursive:true});const source=path.join(sourceDir,entry.name),target=path.join(targetDir,entry.name);
      try{await fsp.copyFile(source,target,fs.constants.COPYFILE_EXCL);const [a,b]=await Promise.all([fsp.stat(source),fsp.stat(target)]);if(a.size!==b.size)throw new Error(`旧存档迁移大小校验失败：${entry.name}`);copied++}catch(error){if(error.code==='EEXIST')existing++;else throw error}
    }
  }
  if(sourceFiles)await atomicJson(LEGACY_SAVE_MIGRATION_FILE,{version:1,migratedAt:new Date().toISOString(),sourceFiles,copied,existing,target:'admin-user-saves',legacyPreserved:true});
}
async function removeUserGameSaves(gameId){for(const entry of await fsp.readdir(USER_SAVE_DIR,{withFileTypes:true}).catch(()=>[]))if(entry.isDirectory())await fsp.rm(path.join(USER_SAVE_DIR,entry.name,gameId),{recursive:true,force:true})}
async function listSaves(gameRoot,gameId,user) {
  const meta=await saveMeta(gameRoot),merged=new Map();
  const locations=[[meta.dir,'source-readonly']];if(canWriteGameSaves(user))locations.push([path.join(USER_SAVE_DIR,gameSaveUserKey(user),gameId),'user-local']);
  for(const [dir,location] of locations){
    const entries=await fsp.readdir(dir,{withFileTypes:true}).catch(()=>[]);
    for(const e of entries){const m=/^(global|config|common|shared|uta_common|rngd_recomode_switch|ntretdRecoUnlock|anotherNewGame|achievement[s]?|titleInfo|GlobalData|drill_global|drill_timer|gameEnd|gameRecall|gameCloth|trueEnd|file\d+|autosave|MAkaisouSlumguide|knsGlobalInfo|saveimg\d+)\.(rmmzsave|rpgsave)$/i.exec(e.name);if(!e.isFile()||!m||path.extname(e.name).toLowerCase()!==meta.ext)continue;const stat=await fsp.stat(path.join(dir,e.name)),lower=m[1].toLowerCase(),name=lower==='titleinfo'?'titleInfo':lower==='anothernewgame'?'anotherNewGame':m[1];merged.set(name,{name,bytes:stat.size,updatedAt:stat.mtime.toISOString(),location})}
  }
  return {engine:meta.engine,extension:meta.ext,canSave:canWriteGameSaves(user),saves:[...merged.values()].sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}))};
}
async function serveSave(req,res,user,gameRoot,gameId,saveName) {
  const meta=await saveMeta(gameRoot),local=userSaveFile(user,gameId,saveName,meta.ext),source=saveFileFor(meta.dir,saveName,meta.ext),localStat=local?await fsp.stat(local).catch(()=>null):null,file=localStat?.isFile()?local:source,stat=localStat?.isFile()?localStat:await fsp.stat(source).catch(()=>null);
  if(!stat?.isFile()) return text(res,404,'存档不存在');
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-store'});
  if(req.method==='HEAD')return res.end();
  const stream=fs.createReadStream(file);stream.on('error',error=>{if(!res.destroyed)res.destroy(error)});stream.pipe(res);
}
async function writeSave(req,res,user,gameRoot,gameId,saveName) {
  if(!canWriteGameSaves(user))return json(res,403,{error:'游客只能读取 NAS 存档，请注册并登录后保存独立进度',code:'SAVE_REGISTRATION_REQUIRED'});
  const data=await readRawBody(req); if(!data.length)throw Object.assign(new Error('存档内容为空'),{status:400});
  const meta=await saveMeta(gameRoot),file=userSaveFile(user,gameId,saveName,meta.ext);
  await serializeSaveWrite(path.resolve(file), ()=>atomicWriteSave(file, data));
  return json(res,200,{ok:true,name:saveName,bytes:data.length,location:'user-local'});
}
async function removeSave(res,user,gameRoot,gameId,saveName) {
  if(!canWriteGameSaves(user))return json(res,403,{error:'游客只能读取 NAS 存档，请注册并登录后管理独立进度',code:'SAVE_REGISTRATION_REQUIRED'});const meta=await saveMeta(gameRoot),local=userSaveFile(user,gameId,saveName,meta.ext);await fsp.rm(local,{force:true});return json(res,200,{ok:true,name:saveName});
}
function rgssUserKey(user){return crypto.createHash('sha256').update(`${user.role}:${user.accountId||user.username}`).digest('hex').slice(0,24)}
function rgssSaveFile(user,gameId,saveName){
  if(!RGSS3_SAVE_NAME.test(saveName))throw Object.assign(new Error('VX Ace 存档名称无效'),{status:400});
  return path.join(RGSS_SAVE_DIR,rgssUserKey(user),gameId,`${saveName}.rvdata2`);
}
function rgssSourceSaveFile(gameRoot,saveName){
  if(/^Save\d{2,3}$/.test(saveName))return path.join(gameRoot,'Save',`${saveName}.rvdata2`);
  if(saveName==='QuickSave'||saveName==='PublicData')return path.join(gameRoot,`${saveName}.rvdata2`);
  if(saveName==='WindowSize')return path.join(gameRoot,'System','test');
  throw Object.assign(new Error('VX Ace 存档名称无效'),{status:400});
}
function rgssRtpRoot(game){
  if(game.engine!=='rgss3'||game.rtp!=='RPGVXAce')throw Object.assign(new Error('未配置受支持的 RGSS RTP'),{status:422});
  return path.join(RTP_ROOT,'RGSS3','RPGVXAce');
}
const RGSS_GAME_DIRS=new Set(['Audio','Data','Fonts','Graphics','Movies']);
const RGSS_COMPAT_SCRIPTS=new Map([
  ['himono-vampire-rgss3',[{name:'z-himono-vampire-rgss3-win32-wrap.rb',path:'Scripts/Preload/z-himono-vampire-rgss3-win32-wrap.rb',file:path.join(PUBLIC_DIR,'rgss-compat','z-himono-vampire-rgss3-win32-wrap.rb')}]]
]);
async function rgssFiles(root,source){
  const files=[];
  async function walk(dir,relative=''){
    for(const entry of await fsp.readdir(dir,{withFileTypes:true}).catch(()=>[])){
      if(entry.isSymbolicLink())continue;
      const rel=relative?`${relative}/${entry.name}`:entry.name,full=path.join(dir,entry.name);
      if(entry.isDirectory())await walk(full,rel);
      else if(entry.isFile()){const stat=await fsp.stat(full);files.push({path:rel.replaceAll('\\','/'),source,size:stat.size,updatedAt:stat.mtime.toISOString()})}
    }
  }
  if(source==='game'){
    const ini=path.join(root,'Game.ini'),stat=await fsp.stat(ini).catch(()=>null);if(stat?.isFile())files.push({path:'Game.ini',source,size:stat.size,updatedAt:stat.mtime.toISOString()});
    for(const dir of RGSS_GAME_DIRS){const full=path.join(root,dir);if((await fsp.stat(full).catch(()=>null))?.isDirectory())await walk(full,dir)}
  }else await walk(root);
  return files;
}
const rgssManifestCache=new Map();
async function rgssManifest(game){
  if(game.engine!=='rgss3')throw Object.assign(new Error('游戏不是已配置的 VX Ace 项目'),{status:422});
  const cached=rgssManifestCache.get(game.id);if(cached)return cached;
  const root=await gameRootFor(game),rtpRoot=rgssRtpRoot(game),gameFiles=await rgssFiles(root,'game'),owned=new Set(gameFiles.map(x=>x.path.toLowerCase())),rtpFiles=(await rgssFiles(rtpRoot,'rtp')).filter(x=>!owned.has(x.path.toLowerCase()));
  const compatScripts=[];for(const script of RGSS_COMPAT_SCRIPTS.get(game.id)||[]){const stat=await fsp.stat(script.file).catch(()=>null);if(stat?.isFile())compatScripts.push({path:script.path,source:'compat',size:stat.size,updatedAt:stat.mtime.toISOString()})}
  const manifest={version:2,gameId:game.id,engine:'rgss3',rtp:game.rtp,files:[...gameFiles,...rtpFiles],compatScripts};rgssManifestCache.set(game.id,manifest);return manifest;
}
async function listRgssSaves(user,gameRoot,gameId){
  const merged=new Map(),sourceDir=path.join(gameRoot,'Save'),localDir=path.dirname(rgssSaveFile(user,gameId,'Save01'));
  for(const [dir,location] of [[sourceDir,'source-readonly'],[localDir,'user-local']])for(const entry of await fsp.readdir(dir,{withFileTypes:true}).catch(()=>[])){const match=/^(Save\d{2,3})\.rvdata2$/i.exec(entry.name);if(!entry.isFile()||!match)continue;const name=`Save${match[1].slice(4)}`,stat=await fsp.stat(path.join(dir,entry.name));merged.set(name,{name,bytes:stat.size,updatedAt:stat.mtime.toISOString(),location})}
  for(const name of ['QuickSave','PublicData','WindowSize']){
    const local=rgssSaveFile(user,gameId,name),source=rgssSourceSaveFile(gameRoot,name),localStat=await fsp.stat(local).catch(()=>null),sourceStat=await fsp.stat(source).catch(()=>null),stat=localStat?.isFile()?localStat:sourceStat;
    if(stat?.isFile())merged.set(name,{name,bytes:stat.size,updatedAt:stat.mtime.toISOString(),location:localStat?.isFile()?'user-local':'source-readonly'});
  }
  return {engine:'rgss3',extension:'.rvdata2',saves:[...merged.values()].sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}))};
}
async function serveRgssSave(req,res,user,gameRoot,gameId,saveName){
  const local=rgssSaveFile(user,gameId,saveName),source=rgssSourceSaveFile(gameRoot,saveName),localStat=await fsp.stat(local).catch(()=>null),file=localStat?.isFile()?local:source,stat=localStat?.isFile()?localStat:await fsp.stat(source).catch(()=>null);if(!stat?.isFile())return text(res,404,'存档不存在');
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-store'});if(req.method==='HEAD')return res.end();return fs.createReadStream(file).pipe(res);
}
async function writeRgssSave(req,res,user,gameId,saveName){
  const data=await readRawBody(req);if(!data.length)throw Object.assign(new Error('存档内容为空'),{status:400});const file=rgssSaveFile(user,gameId,saveName);
  await serializeSaveWrite(path.resolve(file), ()=>atomicWriteSave(file, data));
  return json(res,200,{ok:true,name:saveName,bytes:data.length,location:'user-local'});
}
function translationBridge(gameId) {
  return `(() => {\n  const state={map:null};\n  const load=fetch('/api/game-translation/${gameId}',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(d=>{state.map=d?.map||{};state.norm={};try{for(const k in state.map){if(state.map[k]===k)continue;const n=normKey(k);if(n&&!(n in state.norm))state.norm[n]=state.map[k]}}catch{}}).catch(e=>{console.error('[雾灯翻译]',e);state.map={}});\n  const trimBoth=text=>typeof text==='string'?text.replace(/^[\\u3000\\s]+|[\\u3000\\s]+$/g,''):text;const normKey=text=>{if(typeof text!=='string')return text;const s=clean(text).replace(/[.．。…]{2,}/g,'…');return s.replace(/^[　「『"'（(【[]+/,'').replace(/[\\u005d　」』"'.…！？。，、：；,!?）)】♡♥❤]+$/,'').trim()};const clean=text=>trimBoth(String(text).replace(controls,''));const exact=text=>{if(typeof text!=='string'||!state.map)return text;if(Object.prototype.hasOwnProperty.call(state.map,text)&&state.map[text]!==text)return state.map[text];const k1=trimBoth(text),k2=clean(text);if(k1!==text&&Object.prototype.hasOwnProperty.call(state.map,k1)&&state.map[k1]!==k1)return state.map[k1];if(k2!==text&&Object.prototype.hasOwnProperty.call(state.map,k2)&&state.map[k2]!==k2)return state.map[k2];const k3=normKey(text);return state.norm&&state.norm[k3]!==undefined&&state.norm[k3]!==text?state.norm[k3]:text};\n  const controls=/((?:\\\\|\\x1b)(?:[A-Za-z]+(?:\\[[^\\]]*\\]|<[^>]*>)?|[{}.$|!><^#]))/gi;\n  const leadingControls=/^((?:(?:\\\\|\\x1b)(?:[A-Za-z]+(?:\\[[^\\]]*\\]|<[^>]*>)?|[{}.$|!><^]))+)/i;\n  const controlFree=text=>text.replace(controls,'');\n  const translatedValue=key=>{if(Object.prototype.hasOwnProperty.call(state.map,key)&&state.map[key]!==key)return state.map[key];const k1=trimBoth(key),k2=clean(key);if(k1!==key&&Object.prototype.hasOwnProperty.call(state.map,k1)&&state.map[k1]!==k1)return state.map[k1];if(k2!==key&&Object.prototype.hasOwnProperty.call(state.map,k2)&&state.map[k2]!==k2)return state.map[k2];const k3=normKey(key);if(state.norm&&state.norm[k3]!==undefined&&state.norm[k3]!==key)return state.norm[k3];const im=k3.match(/^(?:[ぁ-んァ-ヶー]{1,2}[.．。…]{1,6}|[.．。…]{1,6})/);if(im&&im[0].length<k3.length){const rest=normKey(k3.slice(im[0].length));if(state.norm&&state.norm[rest]!==undefined&&state.norm[rest]!==rest)return state.norm[rest]}for(let cut=k3.length-1;cut>=4;cut--){const pre=k3.slice(0,cut),tail=k3.slice(cut);if(!/^[.．。…！？!?、：；　 \t♡♥❤っ]*$/.test(tail))continue;if(state.norm&&state.norm[pre]!==undefined&&state.norm[pre]!==pre&&tail.length<=16)return state.norm[pre]}return null};\n  const translateSegments=text=>{const parts=text.split(controls),plain=parts.filter((_,index)=>index%2===0).join('').replace(/\\n/g,'');const whole=translatedValue(plain);if(whole!==null){let used=false;return parts.map((part,index)=>{if(index%2)return part;if(!used&&part){used=true;return whole}return ''}).join('')}return parts.map((part,index)=>index%2?part:(translatedValue(part)??part)).join('')};\n  const translateBlock=text=>{const nl=String.fromCharCode(10),lines=text.split(nl),plainLines=lines.map(clean),wholeKeys=[text,lines.join(''),plainLines.join(nl),plainLines.join('')];for(const key of wholeKeys){const value=translatedValue(key);if(value!==null)return value}const out=[];for(let i=0;i<lines.length;){let matched=false;for(let end=lines.length;end>i;end--){const original=lines.slice(i,end),plain=plainLines.slice(i,end),keys=[original.join(nl),original.join(''),plain.join(nl),plain.join('')];let value=null;for(const key of keys){value=translatedValue(key);if(value!==null)break}if(value!==null){out.push(end===i+1&&plain[0]!==original[0]?translateSegments(original[0]):value);i=end;matched=true;break}}if(!matched){out.push(translateSegments(lines[i]));i++}}return out.join(nl)};\n  const looksExecutable=text=>typeof text==='string'&&/^[\\x20-\\x7e]+$/.test(text)&&/[A-Za-z_$]/.test(text)&&/(?:[+*/%<>=!&|?:]|\\s-\\s)/.test(text);\n  const escaped=text=>{if(typeof text!=='string'||!state.map||looksExecutable(text))return text;const rubyPlain=text.replace(/(?:\\\\|\\x1b)RB?\\[([^,\\]]+),[^\\]]*\\]/gi,'$1');if(rubyPlain!==text){const rubyExact=translatedValue(rubyPlain);if(rubyExact!==null)return rubyExact;const rubyTranslated=translateBlock(rubyPlain);if(rubyTranslated!==rubyPlain)return rubyTranslated}const direct=translatedValue(text);if(direct!==null)return direct;const normalized=text.replace(/\\\\n/g,'\\n');const normalizedValue=translatedValue(normalized);if(normalized!==text&&normalizedValue!==null)return normalizedValue.replace(/\\n/g,'\\\\n');const translated=translateBlock(normalized);return normalized!==text?translated.replace(/\\n/g,'\\\\n'):translated};\n  function install(){if(typeof Window_Base==='undefined')return;\n    if(typeof Game_Message!=='undefined'&&Game_Message.prototype.allText&&!Game_Message.prototype.allText.__mist){const original=Game_Message.prototype.allText;const wrapped=function(){return escaped(original.call(this))};wrapped.__mist=true;Game_Message.prototype.allText=wrapped}\n    if(typeof Window_Message!=='undefined'&&Window_Message.prototype.startMessage&&!Window_Message.prototype.startMessage.__mist){const original=Window_Message.prototype.startMessage;const wrapped=function(){const originalLines=globalThis.$gameMessage&&Array.isArray($gameMessage._texts)?$gameMessage._texts.slice():null;if(originalLines){const joined=originalLines.join(String.fromCharCode(10)),translated=translateBlock(joined);if(translated!==joined&&originalLines.some(line=>controlFree(line)!==line)){$gameMessage._texts=[translated]}}return original.apply(this,arguments)};wrapped.__mist=true;Window_Message.prototype.startMessage=wrapped}\n    if(typeof Bitmap!=='undefined'&&Bitmap.prototype.drawText&&!Bitmap.prototype.drawText.__mist){const original=Bitmap.prototype.drawText;const wrapped=function(text,...args){return original.call(this,exact(text),...args)};wrapped.__mist=true;Bitmap.prototype.drawText=wrapped}\n    if(Window_Base.prototype.drawText&&!Window_Base.prototype.drawText.__mist){const original=Window_Base.prototype.drawText;const wrapped=function(text,...args){return original.call(this,exact(text),...args)};wrapped.__mist=true;Window_Base.prototype.drawText=wrapped}\n    if(Window_Base.prototype.drawTextEx&&!Window_Base.prototype.drawTextEx.__mist){const original=Window_Base.prototype.drawTextEx;const wrapped=function(text,...args){return original.call(this,escaped(text),...args)};wrapped.__mist=true;Window_Base.prototype.drawTextEx=wrapped}\n    if(typeof Window_Message!=='undefined'&&Window_Message.prototype.convertEscapeCharacters&&!Window_Message.prototype.convertEscapeCharacters.__mist){const original=Window_Message.prototype.convertEscapeCharacters;const wrapped=function(text){return original.call(this,escaped(text))};wrapped.__mist=true;Window_Message.prototype.convertEscapeCharacters=wrapped}\n    window.translateMessageBlock=translateBlock;console.info('[雾灯翻译] 显示层翻译已挂载');\n  }\n  window.__mistTranslateText=exact;window.__mistTranslateEscaped=escaped;window.__mistTranslationInstall=()=>load.then(install);window.addEventListener('load',()=>load.then(install),{once:true});\n})();`;
}
function mvSaveBridge(gameId) {
  const base=`/api/game-saves/${gameId}`;
  return `(() => {\n  const base=${JSON.stringify(base)};let installed=false,canSave=true,names=new Set(),aliases=new Map();const cache=new Map();\n  const notifyReadonly=()=>{try{window.parent&&window.parent.postMessage({type:'mist-save-registration-required'},'*')}catch{}};\n  const request=(url,options)=>{const x=new XMLHttpRequest();x.open(options?.method||'GET',url,false);if(options?.body!==undefined)x.setRequestHeader('Content-Type','text/plain;charset=UTF-8');x.send(options?.body);if(x.status>=400)throw new Error(x.responseText||('HTTP '+x.status));return x};\n  try{const d=JSON.parse(request(base).responseText),canonical=x=>String(x).toLowerCase()==='anothernewgame'?'anotherNewGame':x;canSave=d.canSave!==false;for(const s of d.saves){const n=canonical(s.name);names.add(n.toLowerCase());aliases.set(n.toLowerCase(),n)}}catch(e){console.error('[雾灯存档 MV]',e)}\n  const resolve=key=>{const k=String(key).toLowerCase();return names.has(k)?(aliases.get(k)||key):null};\n  const name=id=>{if(typeof id==='string'&&!/^-?\d+$/.test(id))return id==='Torigoya Achievement2'?'achievements':id;const n=Number(id);return n===-1001?'anotherNewGame':n<0?'config':n===0?'global':'file'+n};\n  function install(){if(typeof StorageManager==='undefined')return;installed=true;\n    StorageManager.save=function(id,json){if(!canSave){notifyReadonly();throw new Error('游客只能读取 NAS 存档，请注册后保存独立进度')}const key=name(id),alias=resolve(key)||key;request(base+'/'+alias,{method:'PUT',body:LZString.compressToBase64(json)});names.add(key.toLowerCase());aliases.set(key.toLowerCase(),alias);cache.set(key,json)};\n    StorageManager.load=function(id){const key=name(id),alias=resolve(key);if(alias===null)return null;if(cache.has(key))return cache.get(key);const text=request(base+'/'+alias).responseText;let json=null;if(typeof text==='string'&&text.indexOf('@@__FMOO_PROSAVE__@@')===0){try{const x=new XMLHttpRequest();x.open('POST','/api/mv-prosave-unwrap',false);x.setRequestHeader('Content-Type','text/plain;charset=UTF-8');x.send(text);if(x.status>=400)throw new Error(x.responseText||('HTTP '+x.status));json=x.responseText}catch(e){console.error('[雾灯存档] ProSave 解包失败',e);return null}}else{json=LZString.decompressFromBase64(text)}cache.set(key,json);return json};\n    StorageManager.exists=function(id){return resolve(name(id))!==null};\n    StorageManager.remove=function(id){if(!canSave){notifyReadonly();throw new Error('游客不能删除 NAS 存档，请注册后管理独立进度')}const key=name(id),alias=resolve(key);if(alias===null)return;request(base+'/'+alias,{method:'DELETE'});names.delete(key.toLowerCase());aliases.delete(key.toLowerCase());cache.delete(key)};\n    StorageManager.loadCommonSave=function(isBackup){if(isBackup)return null;if(!names.has('common'))return null;if(cache.has('common'))return cache.get('common');const json=LZString.decompressFromBase64(request(base+'/common').responseText);cache.set('common',json);return json};\n    StorageManager.saveCommonSave=function(json){if(!canSave){notifyReadonly();throw new Error('游客只能读取 NAS 回想解锁，请注册后保存独立进度')}request(base+'/common',{method:'PUT',body:LZString.compressToBase64(json)});names.add('common');cache.set('common',json)};\n    StorageManager.existsCommonSave=function(isBackup){if(isBackup)return false;return names.has('common')};\n    StorageManager.removeCommonSave=function(isBackup){if(isBackup)return;if(!canSave){notifyReadonly();throw new Error('游客不能删除 NAS 回想解锁')}request(base+'/common',{method:'DELETE'});names.delete('common');cache.delete('common')};
    // UTA_CommonSave webStorage 底层：浏览器恒走 HTTP 主数据；isBackup=true 恒空（无备份概念），
    // 防止 UTA load() 成功后 existsCommonSave(true)+removeCommonSave(true) 误删主数据。
    StorageManager.loadFromWebStorageCommonSave=function(isBackup){if(isBackup)return null;return StorageManager.loadCommonSave(false)};
    StorageManager.saveToWebStorageCommonSave=function(json){return StorageManager.saveCommonSave(json)};
    StorageManager.webStorageExistsCommonSave=function(isBackup){if(isBackup)return false;return StorageManager.existsCommonSave(false)};
    StorageManager.removeWebStorageCommonSave=function(isBackup){if(isBackup)return;return StorageManager.removeCommonSave(false)};
    StorageManager.webStorageKeyCommonSave=function(isBackup){return isBackup?'RPG Common.bak':'RPG Common'};\n    StorageManager.rngd_reco_patch_load=function(){if(!names.has('rngd_recomode_switch'))return '{}';return LZString.decompressFromBase64(request(base+'/rngd_recomode_switch').responseText)};\n    StorageManager.rngd_reco_patch_save=function(json){if(!canSave){notifyReadonly();throw new Error('游客只能读取 NAS 回想解锁，请注册后保存独立进度')}request(base+'/rngd_recomode_switch',{method:'PUT',body:LZString.compressToBase64(json)});names.add('rngd_recomode_switch')};\n    StorageManager.backup=function(){};StorageManager.backupExists=function(){return false};StorageManager.cleanBackup=function(){};StorageManager.restoreBackup=function(){};\n    if(typeof DataManager!=='undefined')DataManager.isThisGameFile=function(id){if(!(Number(id)>0&&StorageManager.exists(id)))return false;const globalInfo=this.loadGlobalInfo?.(),info=globalInfo?.[Number(id)];if(!info||typeof info!=='object')return false;if(!StorageManager.isLocalMode?.())return !this._globalId||info.globalId===this._globalId;return true};\n    window.__mistClearSaveCache=async function(){for(const key of Object.keys(localStorage)){if(key==='RPG Config'||key==='RPG Global'||key==='RPG Common'||key==='RPG rngd_recomode_switch'||key==='achievement'||/^RPG File\\d+(?:bak)?$/.test(key))localStorage.removeItem(key)}return true};\n    console.info('[雾灯存档 MV] 已连接 '+names.size+' 个存档');\n  }\n  window.__mistMvSaveInstall=install;window.addEventListener('load',install,{once:true});\n})();`;
}
function saveBridge(gameId) {
  const base=`/api/game-saves/${gameId}`;
  return `(() => {\n  const base=${JSON.stringify(base)};\n  let names=new Set(),installed=false,canSave=true;\n  const berr=m=>{const e=new Error(m);e.__mistBridge=true;return e};\n  const notifyReadonly=()=>{try{window.parent&&window.parent.postMessage({type:'mist-save-registration-required'},'*')}catch{}};\n  const ready=fetch(base,{cache:'no-store'}).then(r=>{if(!r.ok)throw berr('存档列表读取失败');return r.json()}).then(d=>{canSave=d.canSave!==false;names=new Set(d.saves.map(x=>x.name))});\n  const decode=buffer=>new TextDecoder().decode(buffer);\n  const encode=text=>new TextEncoder().encode(text);\n  const convert=typeof Fossil!=='undefined'&&typeof Fossil.convertFileIdToFileNameIfItWasNotPassedInRight==='function'?name=>{try{return Fossil.convertFileIdToFileNameIfItWasNotPassedInRight(name)}catch(e){return name}}:name=>name;\n  function install(force){\n    if((installed&&!force)||typeof StorageManager==='undefined')return; installed=true;\n    StorageManager.saveZip=async function(name,zip){name=convert(name);await ready;if(!canSave){notifyReadonly();throw berr('游客只能读取 NAS 存档，请注册后保存独立进度')}const r=await fetch(base+'/'+encodeURIComponent(name),{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:encode(zip)});if(!r.ok)throw berr(await r.text());names.add(name)};StorageManager.saveZip.__mistBridge=true;\n    StorageManager.loadZip=async function(name){name=convert(name);await ready;const r=await fetch(base+'/'+encodeURIComponent(name),{cache:'no-store'});if(r.status===404)return null;if(!r.ok)throw berr(await r.text());return decode(await r.arrayBuffer())};StorageManager.loadZip.__mistBridge=true;\n    StorageManager.exists=function(name){name=convert(name);return names.has(name)};StorageManager.exists.__mistBridge=true;\n    StorageManager.remove=async function(name){name=convert(name);await ready;if(!canSave){notifyReadonly();throw berr('游客不能删除 NAS 存档，请注册后管理独立进度')}const r=await fetch(base+'/'+encodeURIComponent(name),{method:'DELETE'});if(!r.ok)throw berr(await r.text());names.delete(name)};StorageManager.remove.__mistBridge=true;\n    window.__mistClearSaveCache=async function(){try{await localforage.clear()}catch{}for(const key of Object.keys(localStorage)){if(/^rmmzsave[.:]/i.test(key))localStorage.removeItem(key)}return true};\n    ready.then(()=>console.info('[雾灯存档] 已连接 SMB 存档，共 '+names.size+' 个')).catch(e=>console.error('[雾灯存档]',e));\n  }\n  window.__mistSaveInstall=install;\n  window.addEventListener('load',install,{once:true});\n})();`;
}
function protectedMzDatabaseCompat(source,wasm){
  const signature=/DataManager\.onXhrLoad\s*=/.test(source)&&/require\s*\(\s*['"]fs['"]\s*\)/.test(source)&&/require\s*\(\s*['"]path['"]\s*\)/.test(source)&&/rmmz_core\.dat/.test(source)&&/WebAssembly\.Instance/.test(source)&&/Buffer\.from\s*\(\s*c\.data\s*,\s*['"]base64['"]\s*\)/.test(source)&&/137\s*\^\s*\(\s*t\s*&\s*255\s*\)/.test(source)&&/exports\.(?:_?process)/.test(source);
  if(!signature||!Buffer.isBuffer(wasm)||wasm.length<8||wasm.subarray(0,4).toString('hex')!=='0061736d')return '';
  try{const module=new WebAssembly.Module(wasm),imports=WebAssembly.Module.imports(module),exports=WebAssembly.Module.exports(module);if(!imports.some(x=>x.module==='env'&&x.name==='memory'&&x.kind==='memory')||!exports.some(x=>x.name==='process'&&x.kind==='function'))return ''}catch{return ''}
  const encoded=wasm.toString('base64');
  return `\n;(() => {\n  if(window.__mistProtectedMzDatabase)return;\n  try{\n    const wasmBytes=Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0)),memory=new WebAssembly.Memory({initial:256}),instance=new WebAssembly.Instance(new WebAssembly.Module(wasmBytes),{env:{memory}}),transform=instance.exports.process||instance.exports._process;\n    if(typeof transform!=='function')throw new Error('WASM process 导出不存在');\n    DataManager.onXhrLoad=function(xhr,name,src,url){\n      if(xhr.status>=400)return this.onXhrError(name,src,url);\n      try{\n        const wrapped=JSON.parse(xhr.responseText);\n        if(!wrapped||typeof wrapped.data!=='string'){window[name]=wrapped;this.onLoad(window[name]);return}\n        const raw=atob(wrapped.data),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0)),filename=src.split(/[\\\\/]/).pop().replace('.json','').toLowerCase();let hash=0;for(let i=0;i<filename.length;i++)hash=((hash<<5)-hash+filename.charCodeAt(i))|0;const key=(137^(hash&255))&255,ptr=4096,needed=ptr+bytes.length-memory.buffer.byteLength;if(needed>0)memory.grow(Math.ceil(needed/65536));new Uint8Array(memory.buffer).set(bytes,ptr);transform(ptr,bytes.length,key);const plain=new Uint8Array(memory.buffer.slice(ptr,ptr+bytes.length));window[name]=JSON.parse(new TextDecoder().decode(plain).replace(/^\\uFEFF/,''));this.onLoad(window[name]);\n      }catch(error){console.error('[雾灯 MZ 数据库兼容] 解密失败',src,error);this.onXhrError(name,src,url)}\n    };\n    window.__mistProtectedMzDatabase=true;\n  }catch(error){console.error('[雾灯 MZ 数据库兼容] 初始化失败',error)}\n})();\n`;
}
function protectedMvDatabaseCompat(source){
  const signature=/require\s*\(\s*['"]fs['"]\s*\)/.test(source)&&/require\s*\(\s*['"]path['"]\s*\)/.test(source)&&/Buffer\.from\s*\(\s*c\.data\s*,\s*['"]base64['"]\s*\)/.test(source)&&/window\._K/.test(source)&&/src\.replace\s*\(\s*['"]\.json['"]\s*,\s*['"]['"]\s*\)/.test(source);
  if(!signature)return '';
  return `\n;(() => {\n  const decode=(src,payload)=>{const raw=atob(payload),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0)),name=src.replace('.json','');let t=0;for(let i=0;i<name.length;i++)t=((t<<5)-t+name.charCodeAt(i))|0;const fk=(127|(t&255))&~(127&(t&255));let last=fk;for(let i=bytes.length-1;i>=0;i--){const c=(fk|33)&~(fk&33),m=i%128,p=((last<<4)|(last>>>2))&~((last<<4)&(last>>>2)),k=((((c+m+p)|200)&~((c+m+p)&200))+39)&255,v=(bytes[i]|k)&~(bytes[i]&k);bytes[i]=v;last=v}return JSON.parse(new TextDecoder().decode(bytes).replace(/^\\uFEFF/,'').trim())};\n  DataManager.loadDataFile=function(name,src){const xhr=new XMLHttpRequest(),url='data/'+src;xhr.open('GET',url);xhr.overrideMimeType('application/json');xhr.onload=function(){if(xhr.status>=400){DataManager._errorUrl=url;return}try{const wrapped=JSON.parse(xhr.responseText),value=wrapped&&typeof wrapped.data==='string'?decode(src,wrapped.data):wrapped;window[name]=value;DataManager.onLoad(value)}catch(error){DataManager._errorUrl=url;console.error('[雾灯数据库兼容] '+src,error)}};xhr.onerror=function(){DataManager._errorUrl=url};window[name]=null;xhr.send()};\n  window.__mistProtectedMvDatabase=true;\n})();\n`;
}
function startupDiagnostics(gameId) {
  return `(() => {\n  if(window.__mistDiagnostics)return;const state=window.__mistDiagnostics={gameId:${JSON.stringify(gameId)},startedAt:new Date().toISOString(),scripts:[],errors:[],rejections:[],resources:[]};\n  const clean=x=>x==null?null:String(x).slice(0,2000),record=(list,value)=>{list.push(value);if(list.length>30)list.shift()};\n  addEventListener('error',e=>{const item={time:new Date().toISOString(),message:clean(e.message),file:clean(e.filename),line:e.lineno,column:e.colno,stack:clean(e.error?.stack)};record(state.errors,item);console.error('[雾灯启动诊断:error]',JSON.stringify(item))},true);\n  addEventListener('unhandledrejection',e=>{const item={time:new Date().toISOString(),reason:clean(e.reason?.stack||e.reason)};record(state.rejections,item);console.error('[雾灯启动诊断:promise]',JSON.stringify(item))});\n  new MutationObserver(records=>{for(const r of records)for(const node of r.addedNodes)if(node.tagName==='SCRIPT'){const item={src:node.src||'[inline]',state:'added',time:new Date().toISOString()};record(state.scripts,item);node.addEventListener('load',()=>item.state='loaded');node.addEventListener('error',()=>item.state='error')}}).observe(document.documentElement,{childList:true,subtree:true});\n  const snapshot=()=>{let databaseLoaded=null;try{databaseLoaded=typeof DataManager!=='undefined'&&DataManager.isDatabaseLoaded()}catch(error){databaseLoaded='error: '+error.message}const canvas=document.querySelector('canvas'),printer=document.querySelector('#errorPrinter');return {type:'mist-diagnostic',time:new Date().toISOString(),ageSeconds:Math.round((Date.now()-Date.parse(state.startedAt))/1000),documentReady:document.readyState,scene:typeof SceneManager!=='undefined'?SceneManager._scene?.constructor?.name:null,nextScene:typeof SceneManager!=='undefined'?SceneManager._nextScene?.constructor?.name:null,sceneStopped:typeof SceneManager!=='undefined'?!!SceneManager._stopped:null,dataErrorUrl:typeof DataManager!=='undefined'?DataManager._errorUrl:null,databaseLoaded,databases:{system:typeof $dataSystem!=='undefined'&&!!$dataSystem,mapInfos:typeof $dataMapInfos!=='undefined'&&!!$dataMapInfos,commonEvents:typeof $dataCommonEvents!=='undefined'&&!!$dataCommonEvents},canvas:canvas?{width:canvas.width,height:canvas.height,connected:canvas.isConnected}:null,errorPrinter:clean(printer?.textContent),plugins:typeof $plugins!=='undefined'?{total:$plugins.length,enabled:$plugins.filter(x=>x.status).length,extractor:$plugins.find(x=>x.name==='DRS_AllDataExtractor')||null}:null,lastScripts:state.scripts.slice(-15),errors:state.errors,rejections:state.rejections,performance:performance.getEntriesByType('resource').slice(-30).map(x=>({name:x.name.split('/').slice(-3).join('/'),duration:Math.round(x.duration),bytes:x.transferSize||x.encodedBodySize||0}))};};\n  window.__mistDiagnosticSnapshot=snapshot;setInterval(()=>{const data=snapshot();parent?.postMessage(data,'*');if(data.ageSeconds%10<2)console.info('[雾灯启动诊断]',JSON.stringify(data))},2000);\n})();\n`;
}
async function serveGameIndex(res,gameRoot,gameId) {
  // FOSSIL (MV→MZ 互操作层) 游戏：直接使用 SMB 已有的 FOSSILindex.html 作为入口。
  // FOSSIL.js 作为插件被原 index.html/main.js 加载时会执行 writeNewIndexFile()（require('fs') 写盘+跳转），
  // 浏览器无 fs → ReferenceError: require is not defined → 黑屏。
  // FOSSILindex.html 只引用 js/plugins/FOSSIL.js，此时 FOSSIL 走主替代分支（typeof scriptUrls=="undefined"），
  // 自加载核心脚本 + PluginManager.setup($plugins)，完全不触碰 Node API。
  const game=games.find(g=>g.id===gameId);
  const fossilEntry=await compatMatches(game,'fossil')&&await fsp.stat(path.join(gameRoot,'FOSSILindex.html')).then(()=>true).catch(()=>false);
  const file=path.join(gameRoot,fossilEntry?'FOSSILindex.html':'index.html'), html=await fsp.readFile(file,'utf8').catch(()=>null);
  if(html===null)return text(res,404,'文件不存在');
  // 汉化组 HUIZHI 广告横幅（固定定位弹层 + 免费游戏每日更新 + 游戏更新/发布页外链按钮）：
  // 响应层剥除整块（BEGIN..END 注释标记），SMB 源文件零改动；无该标记的游戏输出不变。
  const stripped=html.replace(/<!--\s*HUIZHI\s+BEGIN[\s\S]*?HUIZHI\s+END\s*-->/g,'');
  const meta=await saveMeta(gameRoot),tags=[`<meta name="mist-cache" content="no-store"><script>try{var _c=document.createElement('canvas'),_g=_c.getContext('webgl')||_c.getContext('experimental-webgl');if(_g){var _m=_g.getParameter(_g.MAX_TEXTURE_SIZE);if(_m>0)document.cookie='mistmts='+_m+';path=/;max-age=31536000';var _l=_g.getExtension('WEBGL_lose_context');if(_l)_l.loseContext()}}catch(e){}</script><script src="/diagnostics-recorder.js" data-mist-scope="game" data-game-id="${gameId}"></script><script src="/startup-diagnostics/${gameId}.js"></script><script src="/${meta.engine==='mv'?'mv-save-bridge':'save-bridge'}/${gameId}.js"></script>`,...(meta.engine==='mv'?[`<script src="/scenario-text-bridge/${gameId}.js"></script>`]:[])];
  if(game?.translation?.enabled)tags.push(`<script src="/translation-bridge/${gameId}.js"></script>`);
  // FOSSIL 主替代模式：核心脚本全部加载后 FOSSIL 的 fixes 会把 StorageManager.saveZip/loadZip/exists/remove
  // 覆盖为 localForage 版本（isLocalMode()=false → forage），导致 SMB 存档不可见。轮询守卫检测桥被覆盖
  // （方法上无 __mistBridge 标记）时强制重装 HTTP 桥；插件加载期间多次覆盖也能自愈。
  if(fossilEntry)tags.push(`<script>;(()=>{if(window.__mistFossilSaveGuard)return;window.__mistFossilSaveGuard=true;const timer=setInterval(()=>{try{if(typeof StorageManager!=='undefined'&&StorageManager.loadZip&&StorageManager.loadZip.__mistBridge!==true&&typeof window.__mistSaveInstall==='function'){window.__mistSaveInstall(true);console.info('[雾灯存档] FOSSIL 覆盖检测到，已重装 SMB 桥')}}catch(e){}},400);window.addEventListener('load',()=>setTimeout(()=>{const t=setInterval(()=>{try{if(typeof StorageManager!=='undefined'&&StorageManager.loadZip&&StorageManager.loadZip.__mistBridge===true){clearInterval(timer);clearInterval(t);console.info('[雾灯存档] 桥已稳定')}}catch(e){}},500)},3000)})();</script>`);
  const tag=tags.join(''),version='mistv=4',versioned=stripped.replace(/(\bsrc=["'](?:\.\/)?js\/main\.js)(?:\?[^"']*)?(["'])/i,`$1?${version}$2`).replace(/(\bsrc=["'](?:\.\/)?js\/plugins\/enc_lv2d\.js)(?:\?[^"']*)?(["'])/i,`$1?mistv=enc5$2`);
  const injected=versioned.includes('</head>')?versioned.replace('</head>',`    ${tag}\n    </head>`):tag+versioned;
  const output=hirokaIndexCompat(await compatMatches(game,'hiroka'),drillGfttIndexCompat(await compatMatches(game,'gftt'),injected));
  const body=Buffer.from(output);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store'});res.end(body);
}
function text(res, status, value) {
  const body = Buffer.from(value);
  res.writeHead(status, { 'Content-Type':'text/plain; charset=utf-8', 'Content-Length':body.length });
  res.end(body);
}
function b64url(value){return Buffer.from(value).toString('base64url')}
function authConfig(){return config.auth||{}}
function sign(value){return crypto.createHmac('sha256',authConfig().sessionSecret||'').update(value).digest('base64url')}
function issueSession(user){const payload=b64url(JSON.stringify({role:user.role,username:user.username,accountId:user.id||null,guestVersion:user.role==='guest'?settings.guestAccess.sessionVersion:null,exp:Math.floor(Date.now()/1000)+AUTH_TTL}));return `${payload}.${sign(payload)}`}
function parseCookies(req){return Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)]}))}
function capabilities(user){const admin=user.role==='admin',registered=user.role==='user',member=admin||registered;return{username:user.username,role:user.role,canRate:member,canComment:member,canFavorite:member,canLikeComments:member,canManage:admin,canManageAccounts:admin}}
function currentUser(req){try{const token=parseCookies(req)[AUTH_COOKIE];if(!token)return null;const [payload,signature]=token.split('.'),expected=sign(payload);if(!signature||signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return null;const data=JSON.parse(Buffer.from(payload,'base64url'));if(data.exp<Math.floor(Date.now()/1000)||!['admin','user','guest'].includes(data.role)||data.role==='guest'&&data.guestVersion!==settings.guestAccess.sessionVersion)return null;if(data.role==='user'){const account=users.accounts.find(x=>x.id===data.accountId&&x.status!=='pending');return account?{id:account.id,username:account.username,role:'user'}:null}return{username:data.role==='admin'?authConfig().adminUsername:'guest',role:data.role}}catch{return null}}
function sessionCookie(token,maxAge=AUTH_TTL){return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`}
function sendAuth(res,user,status=200){const body=Buffer.from(JSON.stringify({user:capabilities(user)}));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store','Set-Cookie':sessionCookie(issueSession(user))});res.end(body)}
function passwordValid(password){const auth=authConfig(),actual=crypto.scryptSync(String(password||''),auth.adminPasswordSalt||'',64),expected=Buffer.from(auth.adminPasswordHash||'','hex');return expected.length===actual.length&&crypto.timingSafeEqual(actual,expected)}
function accountPasswordValid(account,password){const actual=crypto.scryptSync(String(password||''),account.passwordSalt,64),expected=Buffer.from(account.passwordHash,'hex');return expected.length===actual.length&&crypto.timingSafeEqual(actual,expected)}
function guestPasswordValid(password){const guest=settings.guestAccess,actual=crypto.scryptSync(String(password||''),guest.passwordSalt,64),expected=Buffer.from(guest.passwordHash,'hex');return expected.length===actual.length&&crypto.timingSafeEqual(actual,expected)}
function usernameKey(value){return String(value||'').trim().toLocaleLowerCase('zh-CN')}
function publicAccount(account){return{id:account.id,username:account.username,createdAt:account.createdAt}}
function publicPendingAccount(account){return{id:account.id,username:account.username,createdAt:account.createdAt}}
function ratingKey(user){return user.role==='admin'?'admin':user.role==='user'?user.id:null}
function ratingSummary(gameId,user){const votes=ratings.games[gameId]&&typeof ratings.games[gameId]==='object'?ratings.games[gameId]:{},values=Object.values(votes).map(Number).filter(x=>Number.isFinite(x)&&x>0&&x<=6);return{rating:values.length?values.reduce((a,b)=>a+b,0)/values.length:0,ratingCount:values.length,myRating:Number(votes[ratingKey(user)])||0}}
function memberKey(user){return user.role==='admin'?'admin':user.role==='user'?user.id:null}
function commentView(comment,user){const key=memberKey(user),likedBy=Array.isArray(comment.likedBy)?comment.likedBy:[];return{id:comment.id,username:comment.username,content:comment.content,createdAt:comment.createdAt,updatedAt:comment.updatedAt,mine:key!==null&&comment.userId===key,likeCount:likedBy.length,liked:key!==null&&likedBy.includes(key)}}
function isFavorite(gameId,user){const key=memberKey(user);return key!==null&&Array.isArray(favorites.users[key])&&favorites.users[key].includes(gameId)}
function gameView(game,user){const commentPreview=(comments.games[game.id]||[]).slice(0,5).map(x=>commentView(x,user));return{...game,notice:typeof game.notice==='string'?game.notice:'',...ratingSummary(game.id,user),favorite:isFavorite(game.id,user),commentPreview}}
function redirectLogin(res){res.writeHead(302,{Location:'/login.html','Cache-Control':'no-store'});res.end()}
function requiresAdmin(method,p){return ADMIN_ROUTES.some(([m,re])=>m===method&&re.test(p))}
async function readBody(req) {
  const parts=[]; let size=0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('请求内容过大'), { status:413 });
    parts.push(chunk);
  }
  if (!parts.length) return {};
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON 格式无效'), { status:400 }); }
}
function cleanName(name) {
  return String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}
function isWithin(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function isWithinWin32(child,parent) {
  const rel=path.win32.relative(path.win32.resolve(parent),path.win32.resolve(child));
  return rel===''||(!rel.startsWith('..')&&!path.win32.isAbsolute(rel));
}
async function resolveLibrarySource(input,type='game') {
  const root=type==='recollection'?RECOLLECTION_ROOT:config.sourceRoot;
  let raw=String(input||'').trim().replace(/^smb:\/\//i,'\\\\\\\\').replace(/\//g,'\\\\');
  if(!raw)throw Object.assign(new Error(type==='recollection'?'请输入回想网页目录':'请输入游戏目录'),{status:400});
  // 任意本地磁盘或 SMB/UNC 绝对地址均可；相对路径按默认根目录解析。
  if(!path.win32.isAbsolute(raw))raw=path.win32.resolve(root,raw);
  const source=path.win32.resolve(raw);
  const stat=await fsp.stat(source).catch(()=>null);if(!stat?.isDirectory())throw Object.assign(new Error('目录不存在或当前不可访问'),{status:404});
  return source;
}
async function resolveSource(input){return resolveLibrarySource(input,'game')}
function sourcePathKey(value){const raw=String(value||'');return path.win32.isAbsolute(raw)?path.win32.normalize(path.win32.resolve(raw)).toLowerCase():path.normalize(path.resolve(raw)).toLowerCase()}
async function detectWebRoot(source,type='game') {
  if(type==='recollection'){
    const dist=path.join(source,'dist','index.html');
    if((await fsp.stat(dist).catch(()=>null))?.isFile())return path.join(source,'dist');
  }
  const direct=path.join(source,'index.html');if((await fsp.stat(direct).catch(()=>null))?.isFile())return source;
  if(type==='game'){const www=path.join(source,'www','index.html');if((await fsp.stat(www).catch(()=>null))?.isFile())return path.join(source,'www')}
  if(type==='recollection'){const web=path.join(source,'web','index.html');if((await fsp.stat(web).catch(()=>null))?.isFile())return path.join(source,'web')}
  throw Object.assign(new Error(type==='recollection'?'该目录不是网页回想室：未找到 index.html 或 web/index.html':'该目录不是可直接网页运行的 RPG Maker 游戏：未找到 index.html 或 www/index.html'),{status:422});
}
async function detectGameRoot(source){return detectWebRoot(source,'game')}
async function detectGameProject(source) {
  try{return {kind:'web',webRoot:await detectGameRoot(source)}}catch(error){
    const krkr=await detectKrkrProject(source);if(krkr)return {kind:'krkr',...krkr,webRoot:source};throw error
  }
}
function launcherLabel(file){const name=path.basename(file,'.exe'),lower=name.toLowerCase();if(/(?:^|[_-])zh(?:-cn)?(?:$|[_-])|chinese|中文/.test(lower))return '中文';if(/(?:^|[_-])en(?:$|[_-])|english/.test(lower))return '英文';if(/(?:^|[_-])ja(?:$|[_-])|japanese|日本/.test(lower))return '日文';return /^(?:game|start|launch|play)$/i.test(name)?'原版 / 默认':name}
async function isEnigmaLauncher(file){const handle=await fsp.open(file,'r');try{const head=Buffer.alloc(4096),{bytesRead}=await handle.read(head,0,head.length,0);if(bytesRead<256||head.toString('ascii',0,2)!=='MZ')return false;const pe=head.readUInt32LE(0x3c);if(pe+24>bytesRead||head.toString('ascii',pe,pe+4)!=='PE\0\0')return false;const sections=head.readUInt16LE(pe+6),optionalSize=head.readUInt16LE(pe+20),table=pe+24+optionalSize;for(let i=0;i<sections&&table+(i+1)*40<=bytesRead;i++)if(head.toString('ascii',table+i*40,table+i*40+8).replace(/\0/g,'').startsWith('.enigma'))return true;return false}finally{await handle.close()}}
async function discoverLaunchers(source){const entries=await fsp.readdir(source,{withFileTypes:true}),launchers=[];for(const entry of entries){if(!entry.isFile()||!entry.name.toLowerCase().endsWith('.exe')||/(?:unins|uninstall|setup|config|crash|report|tool|notification[_-]?helper)/i.test(entry.name))continue;const full=path.join(source,entry.name),stat=await fsp.stat(full);const kind=await isEnigmaLauncher(full)?'enigma':'native',label=launcherLabel(entry.name);launchers.push({file:entry.name,label,kind,browserCompatible:kind==='enigma'||label==='原版 / 默认',size:stat.size,modifiedAt:stat.mtime.toISOString(),fingerprint:`${stat.size}-${Math.trunc(stat.mtimeMs)}`})}return launchers.sort((a,b)=>(a.label==='原版 / 默认'?-1:b.label==='原版 / 默认'?1:a.file.localeCompare(b.file,'en',{numeric:true})))}
async function selectedLauncher(source,file,{required=false}={}){const launchers=await discoverLaunchers(source),compatible=launchers.filter(x=>x.browserCompatible);if(!file){if(required&&compatible.length>1)throw Object.assign(new Error('该目录有多个网页兼容启动器，请先选择要使用的版本'),{status:409,code:'LAUNCHER_REQUIRED',launchers});return compatible.length===1?compatible[0]:null}if(typeof file!=='string'||path.basename(file)!==file||file.includes('..'))throw Object.assign(new Error('启动器路径无效'),{status:400});const launcher=launchers.find(x=>x.file.toLowerCase()===file.toLowerCase());if(!launcher)throw Object.assign(new Error('所选启动器不在游戏目录中'),{status:400});if(!launcher.browserCompatible)throw Object.assign(new Error('该启动器的封装格式暂不支持网页模式'),{status:422});return launcher}
function splitCommand(value){return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(x=>x.replace(/^"|"$/g,''))||[]}
async function runLauncherExtractor(exe,out){const parts=splitCommand(EVBUNPACK_COMMAND),command=parts.shift();if(!command)throw new Error('未配置启动器解包工具');await new Promise((resolve,reject)=>{const child=spawn(command,[...parts,'--ignore-pe',exe,out],{cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe']}),chunks=[];child.stdout.on('data',x=>chunks.push(x));child.stderr.on('data',x=>chunks.push(x));child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(`启动器覆盖层提取失败（${code}）：${Buffer.concat(chunks).toString('utf8').slice(-2000)}`)))})}
async function prepareLauncherOverlay(game,source,launcher){
  const live=path.join(LAUNCHER_OVERLAY_DIR,game.id),token=crypto.randomUUID(),tmp=`${live}.tmp-${token}`,backup=`${live}.old-${token}`;
  await fsp.rm(tmp,{recursive:true,force:true});
  if(launcher?.kind!=='enigma'){await fsp.rm(live,{recursive:true,force:true});delete launcher?.cachedFile;return launcher}
  try{
    const launcherDir=path.join(tmp,'launcher'),extractDir=path.join(tmp,'overlay'),sourceExe=path.join(source,launcher.file),localExe=path.join(launcherDir,launcher.file);
    await Promise.all([fsp.mkdir(launcherDir,{recursive:true}),fsp.mkdir(extractDir,{recursive:true})]);
    await fsp.copyFile(sourceExe,localExe);
    const [sourceStat,localStat]=await Promise.all([fsp.stat(sourceExe),fsp.stat(localExe)]);
    if(sourceStat.size!==localStat.size||localStat.size!==launcher.size)throw new Error('启动器复制到服务器后大小校验失败');
    await runLauncherExtractor(localExe,extractDir);
    const www=path.join(extractDir,game.webRoot||'www'),stat=await fsp.stat(www).catch(()=>null);
    if(!stat?.isDirectory())throw new Error('启动器中没有找到对应的网页覆盖文件');
    for(const entry of await fsp.readdir(tmp,{recursive:true,withFileTypes:true}))if(entry.isSymbolicLink())throw new Error('启动器覆盖层包含不安全的符号链接');
    const old=await fsp.stat(live).catch(()=>null);if(old)await fsp.rename(live,backup);
    try{await fsp.rename(tmp,live)}catch(error){if(old)await fsp.rename(backup,live).catch(()=>{});throw error}
    await fsp.rm(backup,{recursive:true,force:true});
    launcher.cachedFile=`launcher/${launcher.file}`;return launcher;
  }finally{await Promise.all([fsp.rm(tmp,{recursive:true,force:true}),fsp.rm(backup,{recursive:true,force:true})])}
}
async function overlayRootFor(game){if(game.launcher?.kind!=='enigma')return null;const root=path.resolve(LAUNCHER_OVERLAY_DIR,game.id,'overlay',game.webRoot||'.'),stat=await fsp.stat(root).catch(()=>null);return stat?.isDirectory()?root:null}
async function resourceRootFor(game,sub,baseRoot){const overlay=await overlayRootFor(game);if(!overlay)return baseRoot;const target=safeJoin(overlay,sub);return target&&(await fsp.stat(target).catch(()=>null))?.isFile()?overlay:baseRoot}
async function listDirectory(dir,type='game') {
  const root=type==='recollection'?RECOLLECTION_ROOT:config.sourceRoot,resolved=await resolveLibrarySource(dir||root,type);
  const entries = await fsp.readdir(resolved, { withFileTypes:true }),addedPaths=new Set(games.filter(g=>(g.type||'game')===type).map(g=>sourcePathKey(g.sourcePath)));
  const folders=[];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full=path.join(resolved, entry.name),stat=await fsp.stat(full).catch(()=>null);
    const direct=await fsp.stat(path.join(full,'index.html')).catch(()=>null);
    const nested=!direct?await fsp.stat(path.join(full,type==='game'?'www':'web','index.html')).catch(()=>null):null;
    const krkr=type==='game'&&!direct&&!nested?await detectKrkrProject(full):null;
    folders.push({name:entry.name,path:full,playable:Boolean(direct?.isFile()||nested?.isFile()||krkr),engine:krkr?.engine||null,added:addedPaths.has(sourcePathKey(full)),modifiedAt:(stat?.mtime||new Date(0)).toISOString()});
  }
  folders.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
  // 任意地址可浏览：上级目录不再限制在根目录内；到磁盘/共享根即止。
  const parentPath=path.win32.dirname(resolved);
  const parent=parentPath===resolved?null:parentPath;
  return {current:resolved,parent,folders,type};
}
async function readTitle(root) {
  try {
    const html = await fsp.readFile(path.join(root,'index.html'),'utf8');
    return html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || '';
  } catch { return ''; }
}
async function inspectTranslation(file,name) {
  const stat=await fsp.stat(file).catch(()=>null);if(!stat?.isFile()||stat.size>20*1024*1024)return null;
  try{const raw=parseTranslationJson(await fsp.readFile(file,'utf8'));if(!raw||Array.isArray(raw)||typeof raw!=='object')return null;const pairs=Object.entries(raw).filter(([k,v])=>typeof k==='string'&&typeof v==='string'&&k&&v),entries=pairs.filter(([k,v])=>k!==v).length;if(pairs.length<10||entries<1)return null;return {file:name,entries,bytes:stat.size,updatedAt:stat.mtime.toISOString()}}catch{return null}
}
async function translationCandidates(sourceDir) {
  const entries=await fsp.readdir(sourceDir,{withFileTypes:true}).catch(()=>[]),found=[];
  for(const entry of entries)if(entry.isFile()&&/\.jsony?$/i.test(entry.name)){const info=await inspectTranslation(path.join(sourceDir,entry.name),entry.name);if(info)found.push(info)}
  return found.sort((a,b)=>{const ai=TRANSLATION_NAMES.indexOf(a.file),bi=TRANSLATION_NAMES.indexOf(b.file);return (ai<0?999:ai)-(bi<0?999:bi)||b.entries-a.entries||a.file.localeCompare(b.file,'zh-CN',{numeric:true})})
}
async function findTranslation(sourceDir) {
  const candidates=await translationCandidates(sourceDir);return candidates.find(x=>TRANSLATION_NAMES.includes(x.file)||/(翻译|翻譯|translation|translate)/i.test(x.file))||null;
}
async function selectedTranslation(sourceDir,file) {
  if(typeof file!=='string'||path.basename(file)!==file||file.includes('..')||!/\.jsony?$/i.test(file))throw Object.assign(new Error('翻译文件路径无效'),{status:400});
  const found=(await translationCandidates(sourceDir)).find(x=>x.file===file);if(!found)throw Object.assign(new Error('所选文件不是有效翻译 JSON'),{status:400});return found;
}
async function translationMap(game) {
  const source=await resolveSource(game.sourcePath),info=game.translation?.file?await selectedTranslation(source,game.translation.file).catch(()=>null):null;if(!info)return null;
  const raw=parseTranslationJson(await fsp.readFile(path.join(source,info.file),'utf8')),map={};
  for(const [key,value] of Object.entries(raw))if(typeof key==='string'&&typeof value==='string'&&key&&value&&key!==value)map[key]=value;
  const extraPath=TRANSLATION_EXTRA_FILES.get(game.id);
  if(extraPath){
    try{
      const extra=JSON.parse((await fsp.readFile(extraPath,'utf8')).replace(/^\uFEFF/,''));
      for(const [key,value] of Object.entries(extra))if(typeof key==='string'&&typeof value==='string'&&key&&value&&key!==value&&!Object.prototype.hasOwnProperty.call(map,key))map[key]=value;
    }catch(e){console.error('[雾灯翻译] 补充翻译加载失败',extraPath,e.message)}
  }
  return {info:{...info,entries:Object.keys(map).length},map};
}
async function attachTranslation(game) {
  const source=await resolveSource(game.sourcePath);if(Object.hasOwn(game,'translationSelection')){if(game.translationSelection===null){game.translation=null;return}const chosen=await selectedTranslation(source,game.translationSelection).catch(()=>null);game.translation=chosen?{...chosen,enabled:true}:null;return}
  const found=await findTranslation(source);game.translation=found?{...found,enabled:true}:null;
}
async function findCover(root) {
  const candidates=await findCoverCandidates(root,1);
  return candidates[0]?.path || null;
}
function managedCoverFile(rel) {
  if(!rel.startsWith('@managed/'))return null;
  const name=rel.slice('@managed/'.length);
  if(!name||path.basename(name)!==name||!/\.(?:png|jpe?g|webp|gif)$/i.test(name))return null;
  return {name,file:path.join(MANAGED_COVER_DIR,name)};
}
function coverPriority(rel) {
  const name=rel.toLowerCase();
  if(name.includes('titles1')) return 0;
  if(name.includes('title') || name.includes('cover') || name.includes('封面')) return 1;
  if(name.startsWith('icon/')) return 2;
  if(name.includes('system')) return 3;
  return 4;
}
async function findCoverCandidates(root,limit=80) {
  const found=[];
  for(const dirRel of COVER_DIRS){
    const dir=path.join(root,...dirRel.split('/'));
    const entries=await fsp.readdir(dir,{withFileTypes:true}).catch(()=>[]);
    for(const entry of entries){
      if(!entry.isFile() || !IMAGE_EXT.test(entry.name)) continue;
      const rel=`${dirRel}/${entry.name}`;
      const stat=await fsp.stat(path.join(dir,entry.name)).catch(()=>null);
      if(stat) found.push({path:rel,size:stat.size,encrypted:/\.(rpgmvp|png_)$/i.test(entry.name),priority:coverPriority(rel)});
      if(found.length>=250) break;
    }
  }
  return found.sort((a,b)=>a.priority-b.priority || b.size-a.size || a.path.localeCompare(b.path)).slice(0,limit).map(({priority,...x})=>x);
}
const _encryptionKeysCache=new Map();
async function encryptionKeys(root) {
  const cached=_encryptionKeysCache.get(root);
  if(cached)return cached;
  const keys=[];
  try {const system=JSON.parse((await fsp.readFile(path.join(root,'data','System.json'),'utf8')).replace(/^\uFEFF/,'')),key=String(system.encryptionKey||'');if(/^[0-9a-f]{32}$/i.test(key))keys.push(Buffer.from(key,'hex'))}catch{}
  // mist: System.json 自带合法 key 时直接使用，跳过目录扫描——扫描要读 img/system+titles1+titles2
  // 各前 80 个加密文件（可超 100MB SMB 读取），每次未命中缓存都会触发，造成图片加载线性变慢。
  if(keys.length===0){
    for(const dirRel of ['img/system','img/titles1','img/titles2']){const dir=path.join(root,...dirRel.split('/')),entries=await fsp.readdir(dir,{withFileTypes:true}).catch(()=>[]);for(const entry of entries.slice(0,80)){if(!entry.isFile()||!/\.(?:rpgmvp|png_)$/i.test(entry.name))continue;const encrypted=await fsp.readFile(path.join(dir,entry.name)).catch(()=>null);if(!encrypted||encrypted.length<49||!encrypted.subarray(0,16).equals(RPG_HEADER))continue;const body=encrypted.subarray(16),key=Buffer.from(body.subarray(0,16).map((byte,index)=>byte^PNG_HEADER[index])),output=Buffer.from(body);for(let i=0;i<16;i++)output[i]^=key[i];if(validPngHeader(output))keys.push(key)}}
  }
  const seen=new Set();const result=keys.filter(key=>{const id=key.toString('hex');if(seen.has(id))return false;seen.add(id);return true});
  _encryptionKeysCache.set(root,result);
  return result;
}
function crc32(buffer){let crc=0xffffffff;for(const byte of buffer){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}return(crc^0xffffffff)>>>0}
function validPngHeader(buffer){return buffer.length>=33&&buffer.subarray(0,16).equals(PNG_HEADER)&&buffer.readUInt32BE(16)>0&&buffer.readUInt32BE(16)<=32768&&buffer.readUInt32BE(20)>0&&buffer.readUInt32BE(20)<=32768&&crc32(buffer.subarray(12,29))===buffer.readUInt32BE(29)}
function validJpeg(buffer){
  if(buffer.length<32||!buffer.subarray(0,11).equals(Buffer.from('ffd8ffe000104a46494600','hex'))||buffer[11]!==1||buffer[12]>2||buffer[13]>2||buffer.readUInt16BE(14)===0||buffer.readUInt16BE(14)!==buffer.readUInt16BE(16)||!buffer.subarray(-2).equals(Buffer.from('ffd9','hex')))return false;
  let offset=2,sawFrame=false,sawScan=false;
  while(offset<buffer.length-1){if(buffer[offset++]!==0xff)return false;while(buffer[offset]===0xff)offset++;const marker=buffer[offset++];if(marker===0xd9)return sawFrame&&sawScan&&offset===buffer.length;if(marker===0xda){if(offset+2>buffer.length)return false;const size=buffer.readUInt16BE(offset);if(size<2||offset+size>buffer.length)return false;offset+=size;sawScan=true;while(offset<buffer.length-1){if(buffer[offset]!==0xff){offset++;continue}let next=offset+1;while(buffer[next]===0xff)next++;const code=buffer[next];if(code===0x00||code>=0xd0&&code<=0xd7){offset=next+1;continue}if(code===0xd9)return sawFrame&&next===buffer.length-1;return false}return false}if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;if(offset+2>buffer.length)return false;const size=buffer.readUInt16BE(offset);if(size<2||offset+size>buffer.length)return false;if((marker>=0xc0&&marker<=0xc3||marker>=0xc5&&marker<=0xc7||marker>=0xc9&&marker<=0xcb||marker>=0xcd&&marker<=0xcf)&&size>=7){const height=buffer.readUInt16BE(offset+3),width=buffer.readUInt16BE(offset+5);if(!width||!height||width>32768||height>32768)return false;sawFrame=true}offset+=size}
  return false
}
function decryptedImage(output){if(validPngHeader(output))return{output,type:'image/png'};if(validJpeg(output))return{output,type:'image/jpeg'};return null}
function decryptRpgImage(encrypted,keys=[]){
  if(encrypted.length<49||!encrypted.subarray(0,16).equals(RPG_HEADER))return null;const body=encrypted.subarray(16),candidates=[...keys,Buffer.from(body.subarray(0,16).map((byte,index)=>byte^PNG_HEADER[index]))],seen=new Set();for(const actualKey of candidates){const id=actualKey.toString('hex');if(seen.has(id))continue;seen.add(id);const output=Buffer.from(body);for(let i=0;i<16;i++)output[i]^=actualKey[i];const image=decryptedImage(output);if(image)return image}return null
}
async function serveCover(req,res,root,rel) {
  const managed=managedCoverFile(rel);
  if(managed)return serveFile(req,res,MANAGED_COVER_DIR,`/${managed.name}`,'public, max-age=3600');
  const file=safeJoin(root,`/${rel}`);
  if(!file) return text(res,403,'禁止访问');
  const stat=await fsp.stat(file).catch(()=>null);
  if(!stat?.isFile()) return text(res,404,'封面不存在');
  if(!/\.(rpgmvp|png_)$/i.test(file)) return serveFile(req,res,root,`/${rel}`,'public, max-age=3600');
  const encrypted=await fsp.readFile(file),image=decryptRpgImage(encrypted,await encryptionKeys(root));
  if(!image) return text(res,422,'无法解密图片或图片格式无效');
  res.writeHead(200,{'Content-Type':image.type,'Content-Length':image.output.length,'Cache-Control':'no-store'});
  if(req.method==='HEAD') return res.end();
  res.end(image.output);
}
async function startImport(body) {
  const type=body.type==='recollection'?'recollection':'game';
  const sourceDir=await resolveLibrarySource(body.sourcePath,type),project=type==='game'?await detectGameProject(sourceDir):{kind:'web',webRoot:await detectWebRoot(sourceDir,type)},webRoot=project.webRoot;
  if(games.some(g=>path.resolve(g.sourcePath)===path.resolve(sourceDir)&&g.type===type))throw Object.assign(new Error(type==='recollection'?'这个回想网页已经添加过':'这个源目录已经添加过'),{status:409});
  const id=crypto.randomUUID(),title=cleanName(body.title)||cleanName(await readTitle(webRoot))||cleanName(path.basename(sourceDir));
  const cover=type==='game'&&project.kind==='web'?await findCover(webRoot):null,now=new Date().toISOString();
  const game={id,type,title,sourcePath:sourceDir,webRoot:path.relative(sourceDir,webRoot)||'.',cover,notice:'',storageMode:'direct',rating:0,createdAt:now,updatedAt:now};
  if(type==='game'&&project.kind==='krkr'){game.engine=project.engine;game.runtime=project.runtime;game.xp3Files=project.xp3Files;game.launcher=null;game.translation=null}
  else if(type==='game'){game.launcher=await selectedLauncher(sourceDir,body.launcher,{required:true});await prepareLauncherOverlay(game,sourceDir,game.launcher);await attachTranslation(game)};
  games.unshift(game);await saveGames();
  const job={id,type:'register',entryType:type,gameId:id,title,state:'done',sourcePath:sourceDir,createdAt:now,finishedAt:now};
  jobs.set(id,job);
  return job;
}
async function startBatchImport(body) {
  const parent=await resolveSource(body.sourcePath),entries=await fsp.readdir(parent,{withFileTypes:true}),replaceGameIds=new Set(Array.isArray(body.replaceGameIds)?body.replaceGameIds:[]),imported=[],replaced=[],duplicates=[],skipped=[];
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true}))){
    if(!entry.isDirectory())continue;
    const sourcePath=path.join(parent,entry.name);
    if(games.some(game=>(game.type||'game')==='game'&&sourcePathKey(game.sourcePath)===sourcePathKey(sourcePath))){skipped.push({name:entry.name,sourcePath,reason:'已经添加'});continue}
    try{
      const project=await detectGameProject(sourcePath),webRoot=project.webRoot,title=cleanName(await readTitle(webRoot))||cleanName(entry.name),existing=games.find(game=>(game.type||'game')==='game'&&game.title.toLocaleLowerCase('zh-CN')===title.toLocaleLowerCase('zh-CN'));
      if(existing&&!replaceGameIds.has(existing.id)){duplicates.push({existingGameId:existing.id,title,existingSourcePath:existing.sourcePath,sourcePath});continue}
      if(existing){const now=new Date().toISOString(),replacement={...existing,title,sourcePath,webRoot:path.relative(sourcePath,webRoot)||'.',cover:project.kind==='web'?await findCover(webRoot):null,storageMode:'direct',updatedAt:now};if(project.kind==='krkr'){replacement.engine=project.engine;replacement.runtime=project.runtime;replacement.xp3Files=project.xp3Files;replacement.launcher=null;replacement.translation=null;delete replacement.translationSelection}else{delete replacement.runtime;delete replacement.xp3Files;replacement.launcher=await selectedLauncher(sourcePath,existing.launcher?.file,{required:true});await prepareLauncherOverlay(replacement,sourcePath,replacement.launcher);delete replacement.translationSelection;await attachTranslation(replacement)}Object.assign(existing,replacement);clearKrkrArchive(existing.id);await saveGames();replaced.push({id:existing.id,title,sourcePath});continue}
      const job=await startImport({sourcePath});imported.push({id:job.gameId,title:job.title,sourcePath});
    }
    catch(error){skipped.push({name:entry.name,sourcePath,reason:error.status===422&&/未找到 index\.html/.test(error.message)?'不是可导入的 RPG Maker 网页游戏':error.message||'导入失败'})}
  }
  return {sourcePath:parent,imported,replaced,duplicates,skipped};
}
async function startSync(id) {
  const game=games.find(g=>g.id===id);
  if(!game)throw Object.assign(new Error('项目不存在'),{status:404});
  const type=game.type||'game',sourceDir=await resolveLibrarySource(game.sourcePath,type),project=type==='game'?await detectGameProject(sourceDir):{kind:'web',webRoot:await detectWebRoot(sourceDir,type)},gameRoot=project.webRoot;
  game.title=cleanName(await readTitle(gameRoot))||game.title;
  game.webRoot=path.relative(sourceDir,gameRoot)||'.';
  if(type==='game'&&project.kind==='krkr'){game.engine=project.engine;game.runtime=project.runtime;game.xp3Files=project.xp3Files;game.launcher=null;game.translation=null;clearKrkrArchive(game.id)}
  else if(type==='game'){delete game.runtime;delete game.xp3Files;if(game.launcher){const launcher=await selectedLauncher(sourceDir,game.launcher.file);if(launcher.fingerprint!==game.launcher.fingerprint||!await overlayRootFor(game))await prepareLauncherOverlay(game,sourceDir,launcher);game.launcher=launcher}game.cover=await findCover(gameRoot);await attachTranslation(game)}
  game.storageMode='direct';
  game.updatedAt=new Date().toISOString();
  await saveGames();
  const jobId=crypto.randomUUID(), now=new Date().toISOString();
  const job={id:jobId,type:'refresh',gameId:id,title:game.title,state:'done',sourcePath:game.sourcePath,createdAt:now,finishedAt:now};
  jobs.set(jobId,job);
  return job;
}
async function updateGame(id,body,user) {
  const game=games.find(g=>g.id===id);
  if(!game) throw Object.assign(new Error('游戏不存在'),{status:404});
  let gameChanged=false;
  if(Object.hasOwn(body,'rating')){
    const rating=Number(body.rating),key=ratingKey(user);
    if(!key)throw Object.assign(new Error('请注册并登录后评分'),{status:403});
    if(!Number.isFinite(rating)||rating<0||rating>6||!Number.isInteger(rating*2)) throw Object.assign(new Error('评分必须是 0 到 6，步进为 0.5'),{status:400});
    const votes=ratings.games[id]??={};if(rating===0)delete votes[key];else votes[key]=rating;if(!Object.keys(votes).length)delete ratings.games[id];await saveRatings();
  }
  if(Object.hasOwn(body,'notice')){
    if(typeof body.notice!=='string')throw Object.assign(new Error('管理员留言必须是文本'),{status:400});
    const notice=body.notice.replace(/\r\n?/g,'\n').trim();if(notice.length>2000)throw Object.assign(new Error('管理员留言最多 2000 字'),{status:400});
    game.notice=notice;if(notice)game.noticeUpdatedAt=new Date().toISOString();else delete game.noticeUpdatedAt;gameChanged=true;
  }
  if(Object.hasOwn(body,'cover')){
    const sourceDir=await resolveSource(game.sourcePath), gameRoot=path.resolve(sourceDir,game.webRoot||'.');
    const cover=String(body.cover||'').replaceAll('\\','/');
    const managed=managedCoverFile(cover),managedStat=managed?await fsp.stat(managed.file).catch(()=>null):null;
    if(managed&&!managedStat?.isFile())throw Object.assign(new Error('本地托管封面不存在'),{status:400});
    if(!managed){const candidates=await findCoverCandidates(gameRoot,250);if(!candidates.some(x=>x.path===cover))throw Object.assign(new Error('封面不在候选图片中'),{status:400})}
    game.cover=cover;gameChanged=true;
  }
  if(Object.hasOwn(body,'translation')){
    if((game.type||'game')!=='game')throw Object.assign(new Error('回想网页不使用游戏翻译'),{status:400});
    if(body.translation===null||body.translation===''){game.translationSelection=null;game.translation=null}else{const source=await resolveSource(game.sourcePath),chosen=await selectedTranslation(source,body.translation);game.translationSelection=chosen.file;game.translation={...chosen,enabled:true}}gameChanged=true;
  }
  if(Object.hasOwn(body,'launcher')){
    if((game.type||'game')!=='game')throw Object.assign(new Error('回想网页没有启动器'),{status:400});
    const source=await resolveSource(game.sourcePath),launcher=await selectedLauncher(source,body.launcher);
    await prepareLauncherOverlay(game,source,launcher);game.launcher=launcher;gameChanged=true;
  }
  if(gameChanged){game.updatedAt=new Date().toISOString();await saveGames()}return gameView(game,user);
}
async function gameRootFor(game) {
  const type=game.type||'game',sourceDir=await resolveLibrarySource(game.sourcePath,type);
  let gameRoot=path.resolve(sourceDir,game.webRoot||'.');
  if(type==='recollection'&&(game.webRoot||'.')==='.'){
    const dist=path.join(sourceDir,'dist'),index=path.join(dist,'index.html');
    if((await fsp.stat(index).catch(()=>null))?.isFile())gameRoot=dist;
  }
  if(!isWithin(gameRoot,sourceDir))throw Object.assign(new Error('项目路径无效'),{status:403});
  return gameRoot;
}
async function removeGame(id) {
  const index=games.findIndex(g=>g.id===id);
  if(index<0) throw Object.assign(new Error('游戏不存在'),{status:404});
  const [game]=games.splice(index,1);clearKrkrArchive(id);delete ratings.games[id];delete comments.games[id];for(const [key,list] of Object.entries(favorites.users)){favorites.users[key]=list.filter(x=>x!==id);if(!favorites.users[key].length)delete favorites.users[key]}await saveGames();await saveRatings();await saveComments();await saveFavorites();
  await Promise.all([fsp.rm(path.join(LEGACY_LIBRARY_DIR,id),{recursive:true,force:true}),fsp.rm(path.join(LAUNCHER_OVERLAY_DIR,id),{recursive:true,force:true}),removeUserGameSaves(id)]);
  return game;
}
function safeJoin(root, decodedPath) {
  const target=path.resolve(root,'.'+decodedPath);
  return isWithin(target,root)?target:null;
}
function serveCompatBuffer(req,res,output,contentType,cacheKey,loadSession) {
  const headers={'Content-Type':contentType,'Cache-Control':'no-store','Accept-Ranges':'bytes'},range=req.headers.range;let start=0,end=output.length-1,status=200;
  if(range){const match=/bytes=(\d*)-(\d*)/.exec(range);if(!match)return res.writeHead(416,{'Content-Range':`bytes */${output.length}`}).end();start=match[1]?Number(match[1]):0;end=match[2]?Math.min(Number(match[2]),end):end;if(start>end||start>=output.length)return res.writeHead(416,{'Content-Range':`bytes */${output.length}`}).end();status=206;headers['Content-Range']=`bytes ${start}-${end}/${output.length}`}
  const body=output.subarray(start,end+1),tracker=trackLoadStream(req,res,loadSession,cacheKey,output.length,start);headers['Content-Length']=body.length;res.writeHead(status,headers);tracker.chunk(body.length);res.end(body);
}
async function serveMainCompat(req,res,gameRoot,gameId,loadSession) {
  const file=path.join(gameRoot,'js','main.js'),source=await fsp.readFile(file,'utf8').catch(()=>null);if(source===null)return text(res,404,'文件不存在');const versioned=source.replace(/(["']js\/(?:r(?:pg|mmz)_core|plugins)\.js)(?:\?[^"']*)?(["'])/g,'$1?mistv=4$2');
  const game=games.find(g=>g.id===gameId),itanki=await compatMatches(game,'itanki');
  let output=hirokaMainCompat(await compatMatches(game,'hiroka'),versioned);
  // mist: {異端秘律} cubism4ForMZ.js 旧 URL 已被浏览器 max-age=86400 缓存（修复前原文件），
  // 改 no-store 拦不住已缓存资源 → 用户仍执行 require 崩溃旧版。轮询 patch PluginManager.makeUrl，
  // 让该插件加载 URL 带 ?mistv=itanki2（新 URL 强制重新请求 → serveItankiCubismCompat 注入版）。
  if(itanki){
    output+=`\n;(() => {
  if(window.__mistItankiMain)return;window.__mistItankiMain=true;
  const apply=()=>{
    if(typeof PluginManager==='undefined'||!PluginManager.makeUrl||PluginManager.makeUrl.__mistItanki)return false;
    const origM=PluginManager.makeUrl;
    PluginManager.makeUrl=function(filename){
      if(filename==='live2d/cubism4ForMZ')return "js/plugins/live2d/cubism4ForMZ.js?mistv=itanki2";
      return origM.apply(this,arguments);
    };
    PluginManager.makeUrl.__mistItanki=true;
    return true;
  };
  if(apply())return;
  const timer=setInterval(()=>{if(apply())clearInterval(timer)},50);
  setTimeout(()=>clearInterval(timer),10000);
})();\n`;
  }
  return serveCompatBuffer(req,res,Buffer.from(output),'text/javascript; charset=utf-8','/js/main.js',loadSession);
}
function pluginCommonBaseOrderCompat(source,available){
  if(!available)return source;
  const dependencies=['MAT_BattlestartendFade','AnimationByPoint','ImageSmoothSetting','MenuSubCommand','RX_T_SelfSw_BatCtrl'];
  return source+`\n;(() => {\n  if(typeof $plugins==='undefined'||!Array.isArray($plugins)||$plugins.some(plugin=>plugin?.name==='PluginCommonBase'))return;\n  const dependencies=${JSON.stringify(dependencies)},index=$plugins.findIndex(plugin=>plugin?.status&&dependencies.includes(plugin.name));\n  if(index<0)return;\n  $plugins.splice(index,0,{name:'PluginCommonBase',status:true,description:'PluginManagerEx base (restored by Mist)',parameters:{}});\n})();\n`;
}
function disableDesktopDevPlugins(source){
  const start=source.indexOf('['),end=source.lastIndexOf(']');if(start<0||end<=start)return source.replace(/("name"\s*:\s*"DRS_AllDataExtractor"\s*,\s*"status"\s*:\s*)true/g,'$1false');
  let plugins;try{plugins=JSON.parse(source.slice(start,end+1))}catch{return source.replace(/("name"\s*:\s*"DRS_AllDataExtractor"\s*,\s*"status"\s*:\s*)true/g,'$1false')}
  for(const plugin of plugins){const description=String(plugin?.description||'');if(plugin?.name==='DRS_AllDataExtractor'||plugin?.name==='Text2Frame'&&/(?:テキストファイル|text file)/i.test(description)&&/(?:イベントコマンド|event command)/i.test(description)&&/(?:開発支援|development)/i.test(description)||plugin?.name==='del_Text2Frame'&&/開発支援プラグイン/.test(description)||plugin?.name==='del_CBR_LoadAllMapFile'&&/Text2Frame/.test(description)&&/サポート用プラグイン/.test(description))plugin.status=false}
  return source.slice(0,start)+JSON.stringify(plugins)+source.slice(end+1)
}
function reportedPluginListCompat(source,flags){  if(flags.itanki){return source.replace(/("name"\s*:\s*")(DKTools)(")/g,'$1DKTools.v5$3')}
  if(!flags.standingPicture)return source;
  const start=source.indexOf('[');if(start<0)return source;
  let plugins,length;try{const tail=source.slice(start),decoderEnd=(()=>{let depth=0,string=false,escape=false;for(let i=0;i<tail.length;i++){const ch=tail[i];if(string){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch==='"')string=false}else if(ch==='"')string=true;else if(ch==='[')depth++;else if(ch===']'&&--depth===0)return i+1}return -1})();if(decoderEnd<0)return source;length=decoderEnd;plugins=JSON.parse(tail.slice(0,length))}catch{return source}
  const plugin=plugins.find(item=>item?.name==='LL_StandingPicture');if(plugin?.parameters)plugin.parameters.catheBootPicture='false';
  return source.slice(0,start)+JSON.stringify(plugins)+source.slice(start+length)
}
async function servePluginListCompat(req,res,gameRoot,loadSession,gameId) {
  const file=path.join(gameRoot,'js','plugins.js'),source=await fsp.readFile(file,'utf8').catch(()=>null);if(source===null)return text(res,404,'文件不存在');const base=await fsp.stat(path.join(gameRoot,'js','plugins','PluginCommonBase.js')).catch(()=>null);
  const game=games.find(g=>g.id===gameId);const flags={itanki:await compatMatches(game,'itanki'),standingPicture:await compatMatches(game,'standingPicture')};
  let output=reportedPluginListCompat(pluginCommonBaseOrderCompat(disableDesktopDevPlugins(source),base?.isFile()),flags);
  // mist: {異端秘律} (0094b0e0) cubism4ForMZ.js 加版本 query 破坏浏览器旧缓存：
  // 修复前该文件以 max-age=86400 被缓存（无 query 的旧 URL），服务端改 no-store 拦不住已缓存未过期的
  // 资源 → 用户手机仍执行 require 崩溃的旧版。改 URL 后强制重新请求，命中 serveItankiCubismCompat。
  if(flags.itanki)output=output.replaceAll('"js/plugins/live2d/cubism4ForMZ.js"','"js/plugins/live2d/cubism4ForMZ.js?mistv=itanki2"');
  return serveCompatBuffer(req,res,Buffer.from(output),'text/javascript; charset=utf-8','/js/plugins.js',loadSession);
}

async function serveExternMessageCsvCompat(req,res,gameRoot,loadSession) {
  // mist: STRAY DOG FIANCE 的 ExternMessage 插件参数 Csv File Path=ExternMessage_en.csv（默认英文），
  // 但游戏自带 ExternMessage_cn.csv（中文，键与 jp 同构，4570/4759 覆盖）。对话文本全部走 CSV 注入，
  // 不经 Window_Message 翻译桥 → 英文直显。响应层把 en 请求改写为 cn 文件（SMB 零改动）。
  const relative='/data/ExternMessage_en.csv',cnRelative='/data/ExternMessage_cn.csv';
  const cnFile=path.join(gameRoot,...cnRelative.slice(1).split('/')),cnStat=await fsp.stat(cnFile).catch(()=>null);
  if(!cnStat?.isFile())return serveCompatBuffer(req,res,Buffer.from(''),'text/plain; charset=utf-8',relative,loadSession);
  const data=await fsp.readFile(cnFile);
  res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Length':data.length,'Cache-Control':'no-store'});
  return res.end(data);
}
async function serveCsvAutoLoaderCompat(req,res,gameRoot,loadSession) {
  const relative='/js/plugins/CsvAutoLoader.js',file=path.join(gameRoot,...relative.slice(1).split('/')),source=await fsp.readFile(file,'utf8').catch(()=>null);if(source===null)return text(res,404,'文件不存在');
  const signature=/require\s*\(\s*["']fs["']\s*\)/.test(source)&&/require\s*\(\s*["']path["']\s*\)/.test(source)&&/data[\\/]csvdata/.test(source)&&/DataManager\.createGameObjects/.test(source)&&/PluginManager\.registerCommand\s*\(\s*PLUGIN_NAME\s*,\s*["']ReloadCsv["']/.test(source);
  if(!signature)return serveCompatBuffer(req,res,Buffer.from(source),'text/javascript; charset=utf-8',relative,loadSession);
  const entries=await fsp.readdir(path.join(gameRoot,'data','csvdata'),{withFileTypes:true}).catch(()=>[]),files=entries.filter(entry=>entry.isFile()&&entry.name.toLowerCase().endsWith('.csv')).map(entry=>entry.name).sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));
  const output=`(() => {\n  const PLUGIN_NAME='CsvAutoLoader',files=${JSON.stringify(files)};\n  const loadAllCsvFiles=()=>{for(const fileName of files){try{const xhr=new XMLHttpRequest();xhr.open('GET','data/csvdata/'+encodeURIComponent(fileName),false);xhr.overrideMimeType('text/csv; charset=UTF-8');xhr.send();if(xhr.status>=400)throw new Error('HTTP '+xhr.status);const arrayName=fileName.replace(/\\.csv$/i,''),text=xhr.responseText.replace(/^\\uFEFF/,'').trim();window[arrayName]=text?text.split(/\\r?\\n/).map(line=>line.split(',')):[];}catch(error){console.error('CSV文件读取失败: '+fileName,error);window[fileName.replace(/\\.csv$/i,'')]=[];}}};\n  const original=DataManager.createGameObjects;DataManager.createGameObjects=function(){original.apply(this,arguments);loadAllCsvFiles()};\n  PluginManager.registerCommand(PLUGIN_NAME,'ReloadCsv',loadAllCsvFiles);window.__mistCsvAutoLoader={files,loadAllCsvFiles};\n})();\n`;
  return serveCompatBuffer(req,res,Buffer.from(output),'text/javascript; charset=utf-8',relative,loadSession);
}
async function serveCommonSaveCompat(req,res,gameRoot,loadSession) {
  const relative='/js/plugins/CommonSave.js',file=path.join(gameRoot,...relative.slice(1).split('/')),source=await fsp.readFile(file,'utf8').catch(()=>null);if(source===null)return text(res,404,'文件不存在');
  const output=commonSaveBrowserCompat(source);
  return serveCompatBuffer(req,res,Buffer.from(output),'text/javascript; charset=utf-8',relative,loadSession);
}
async function serveScenarioPluginCompat(req,res,gameRoot,name,loadSession) {
  const relative=`/js/plugins/${name}.js`,file=path.join(gameRoot,...relative.slice(1).split('/')),source=await fsp.readFile(file,'utf8').catch(()=>null);if(source===null)return text(res,404,'文件不存在');
  const output=name==='TS_ReplayMode'?replayModeBrowserCompat(source):scenarioDecodeBrowserCompat(source);
  return serveCompatBuffer(req,res,Buffer.from(output),'text/javascript; charset=utf-8',relative,loadSession);
}
async function hirokaBrowserManifest(gameRoot){
  const files=new Set(),walk=async(relative,depth=0)=>{if(depth>4||files.size>=5000)return;const dir=path.join(gameRoot,...relative.split('/')),entries=await fsp.readdir(dir,{withFileTypes:true}).catch(()=>[]);for(const entry of entries){if(entry.isSymbolicLink())continue;const item=`${relative}/${entry.name}`.replaceAll('\\','/');if(entry.isDirectory()){files.add(item);await walk(item,depth+1)}else if(entry.isFile())files.add(item)}};
  await walk('data/resources');await walk('audio/me');const fontEntries=await fsp.readdir(path.join(gameRoot,'fonts'),{withFileTypes:true}).catch(()=>[]),fonts=fontEntries.filter(x=>x.isFile()&&/\.(?:woff2?|ttf|otf)$/i.test(x.name)).map(x=>x.name).sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));return{files:[...files],fonts}
}
async function serveHirokaPluginCompat(req,res,gameRoot,gameId,name,loadSession){
  const relative=`/js/plugins/${name}.js`,file=path.join(gameRoot,...relative.slice(1).split('/')),source=await fsp.readFile(file,'utf8').catch(()=>null);if(source===null)return text(res,404,'文件不存在');const manifest=name==='PluginUtils'||name==='FontDictionary'?await hirokaBrowserManifest(gameRoot):{},output=Buffer.from(hirokaPluginCompat(await compatMatches(games.find(g=>g.id===gameId),'hiroka'),name,source,manifest));return serveCompatBuffer(req,res,output,'text/javascript; charset=utf-8',relative,loadSession)
}
async function serveText2FrameCompat(req,res,gameRoot,name,loadSession) {
  const relative=`/js/plugins/${name}.js`,file=path.join(gameRoot,...relative.slice(1).split('/')),source=await fsp.readFile(file,'utf8').catch(()=>null);if(source===null)return text(res,404,'文件不存在');
  const standard=name==='Text2Frame'&&/require\s*\(\s*["']fs["']\s*\)/.test(source)&&/require\s*\(\s*["']path["']\s*\)/.test(source)&&/process\.mainModule\.filename/.test(source)&&/PluginManager\.registerCommand\s*\(\s*["']Text2Frame["']/.test(source)&&/(?:Map(?:\$\{|0*\d+\.json)|CommonEvents\.json)/.test(source)&&/(?:writeFileSync|writeData)/.test(source),text2Frame=name==='del_Text2Frame'&&/require\s*\(\s*["']fs["']\s*\)/.test(source)&&/require\s*\(\s*["']path["']\s*\)/.test(source)&&/process\.mainModule\.filename/.test(source)&&/CommonEvents\.json/.test(source)&&/writeData/.test(source),helper=name==='del_CBR_LoadAllMapFile'&&/Text2Frame/.test(source)&&/CBR_making\.map/.test(source)&&/loadAllMapFile/.test(source);
  const output=Buffer.from(standard||text2Frame||helper?'/* disabled: RPG Maker editor Text2Frame development utility */\n':source);return serveCompatBuffer(req,res,output,'text/javascript; charset=utf-8',relative,loadSession)
}
// mist: F_ 系 Movie 插件的浏览器化（そのゆう 4a5d88ea 等）。插件本体全部是 DOM <video> +
// PIXI 纹理写法，浏览器完全可用；唯一障碍是开头的 NW.js 门卫（不初始化 → SceneManager.playMovie
// 未定义 → GalleryScene 回想入口校验 "unable to play movies" 拒绝进入）。
// 处理：门卫中和 + 自动播放被拒时静音重试（首次用户输入恢复音量）；其余逻辑零改动。
async function serveMovieFPluginCompat(req,res,gameRoot,loadSession) {
  const relative='/js/plugins/Movie.js',file=path.join(gameRoot,'js','plugins','Movie.js');
  const source=await fsp.readFile(file,'utf8').catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  const signature=source.includes('Movie does not supports platforms other than NW.js')&&source.includes('SceneManager.playMovie')&&source.includes('SimpleVideoBaseTexture');
  const gate='if (!Utils.isNwjs()) {';
  if(!signature||source.split(gate).length-1!==1||source.split('this._element.play();').length-1!==1)
    return serveCompatBuffer(req,res,Buffer.from(source),'text/javascript; charset=utf-8',relative,loadSession);
  let patched=source.split(gate).join('if (false) { /* mist: browser-enabled */');
  const play='this._element.play();';
  const retry=("const _mistEl=this._element;const _mistP=_mistEl.play();"
    +"if(_mistP&&_mistP.catch)_mistP.catch(_mistErr=>{"
    +"if(_mistErr&&_mistErr.name==='NotAllowedError'){"
    +"_mistEl.muted=true;const _r=_mistEl.play();if(_r&&_r.catch)_r.catch(()=>{});"
    +"const _un=()=>{_mistEl.muted=false;document.removeEventListener('keydown',_un);document.removeEventListener('pointerdown',_un);};"
    +"document.addEventListener('keydown',_un);document.addEventListener('pointerdown',_un);"
    +"}else{console.error('[\u96fe\u706f Movie]',_mistErr);}});");
  patched=patched.split(play).join(retry);
  return serveCompatBuffer(req,res,Buffer.from(patched),'text/javascript; charset=utf-8',relative,loadSession);
}
async function serveMoviePictureCompat(req,res,gameRoot,loadSession) {
  const relative='/js/plugins/MoviePicture.js',file=path.join(gameRoot,...relative.slice(1).split('/')),source=await fsp.readFile(file,'utf8').catch(()=>null);if(source===null)return text(res,404,'文件不存在');
  const signature=/Bitmap_Video\.prototype\.play\s*=\s*function/.test(source)&&/this\._video\.play\s*\(\s*\)/.test(source)&&/Bitmap_Video\.prototype\._createVideo\s*=\s*function/.test(source)&&/document\.createElement\s*\(\s*['"]video['"]\s*\)/.test(source)&&/this\._video\.autoplay\s*=\s*true/.test(source);
  const outerPath=/Game_Screen\.prototype\.setVideoPictureName\s*=\s*function\s*\(\s*movieName\s*,\s*useAlpha\s*,\s*useOuter\s*\)\s*\{\s*this\._videoUseAlpha\s*=\s*useAlpha\s*;\s*if\s*\(\s*useOuter\s*&&\s*!movieName\.match\s*\(\s*\/\^\[A-Z\]:\/\s*\)\s*\)\s*\{\s*const\s+path\s*=\s*require\s*\(\s*['"]path['"]\s*\)\s*;\s*this\._videoPictureName\s*=\s*path\.join\s*\(\s*path\.dirname\s*\(\s*StorageManager\.localFileDirectoryPath\s*\(\s*\)\s*\)\s*,\s*movieName\s*\)\s*;\s*\}\s*else\s*\{\s*this\._videoPictureName\s*=\s*movieName\s*;\s*\}\s*\}/;
  if(!signature)return serveCompatBuffer(req,res,Buffer.from(source),'text/javascript; charset=utf-8',relative,loadSession);
  const browserOuter=`Game_Screen.prototype.setVideoPictureName = function(movieName, useAlpha, useOuter) {\n        this._videoUseAlpha = useAlpha;\n        // mist: browser URLs are already rooted at the served game, so do not resolve a NW.js save-directory path.\n        this._videoPictureName = movieName;\n    }`;
  const browserVideoPath=`ImageManager.getVideoFilePath = function(filename) {\n        // mist: MP_SET_OUTER_MOVIE passes a complete game-relative media URL, unlike ordinary MoviePicture names.\n        if (/^(?:[A-Z]:|https?:\\/\\/|\\/)/i.test(filename)) return filename;\n        if (/\\.(?:webm|mp4)(?:[?#].*)?$/i.test(filename) && /[\\/]/.test(filename)) return filename.split('/').map(encodeURIComponent).join('/');\n        return this.getVideoFileFolder() + encodeURIComponent(filename) + this.getVideoFileExt();\n    };`;
  let patched=outerPath.test(source)?source.replace(outerPath,browserOuter):source;
  const videoPath=/ImageManager\.getVideoFilePath\s*=\s*function\s*\(\s*filename\s*\)\s*\{\s*if\s*\(\s*!filename\.match\s*\(\s*\/\^\[A-Z\]:\/\s*\)\s*\)\s*\{\s*return\s*this\.getVideoFileFolder\s*\(\s*\)\s*\+\s*encodeURIComponent\s*\(\s*filename\s*\)\s*\+\s*this\.getVideoFileExt\s*\(\s*\)\s*;\s*\}\s*else\s*\{\s*return\s+filename\s*;\s*\}\s*\}/;
  patched=videoPath.test(patched)?patched.replace(videoPath,browserVideoPath):patched;
  const compat=`\n;(() => {\n  if(globalThis.__mistMoviePictureMobileCompat)return;globalThis.__mistMoviePictureMobileCompat=true;\n  const pending=globalThis.__mistPendingMedia=new Set(),previousMuted=new WeakMap();\n  const surface=error=>{console.error('[雾灯 MoviePicture]',error);setTimeout(()=>{throw error},0)};\n  const remember=video=>{if(!pending.has(video))previousMuted.set(video,!!video.muted);pending.add(video);video.muted=true;video.defaultMuted=true};\n  const retryMuted=(video,error)=>{if(error?.name!=='NotAllowedError')return surface(error);remember(video);let retry;try{retry=video.play()}catch(next){if(next?.name!=='NotAllowedError')surface(next);return}retry?.catch?.(next=>{if(next?.name!=='NotAllowedError')surface(next)})};\n  const originalPlay=Bitmap_Video.prototype.play;Bitmap_Video.prototype.play=function(){const video=this._video;if(!video)return;let result;try{result=video.play()}catch(error){retryMuted(video,error);return}result?.catch?.(error=>retryMuted(video,error));return result};\n  const originalCreate=Bitmap_Video.prototype._createVideo;Bitmap_Video.prototype._createVideo=function(){const result=originalCreate.apply(this,arguments),video=this._video;if(video){video.playsInline=true;video.setAttribute?.('playsinline','');video.setAttribute?.('webkit-playsinline','');if(globalThis.matchMedia?.('(pointer: coarse)')?.matches)remember(video)}return result};\n  if(Bitmap_Video.prototype.destroy){const originalDestroy=Bitmap_Video.prototype.destroy;Bitmap_Video.prototype.destroy=function(){const video=this._video;if(video){pending.delete(video);previousMuted.delete(video)}return originalDestroy.apply(this,arguments)}}\n  globalThis.__mistUnlockMedia=()=>{for(const video of [...pending]){const restore=previousMuted.get(video)??false;video.muted=restore;video.defaultMuted=restore;let result;try{result=video.play()}catch(error){if(error?.name==='NotAllowedError'){video.muted=true;video.defaultMuted=true}else{pending.delete(video);previousMuted.delete(video);surface(error);continue}}result?.catch?.(error=>{if(error?.name==='NotAllowedError'){video.muted=true;video.defaultMuted=true}else{pending.delete(video);previousMuted.delete(video);surface(error)}});pending.delete(video);previousMuted.delete(video)}};\n  globalThis.addEventListener?.('pointerdown',globalThis.__mistUnlockMedia,{passive:true});globalThis.addEventListener?.('touchend',globalThis.__mistUnlockMedia,{passive:true});\n})();\n`;
  const close=/\}\)\(\);\s*$/.exec(patched);if(!close)return serveCompatBuffer(req,res,Buffer.from(patched),'text/javascript; charset=utf-8',relative,loadSession);const output=patched.slice(0,close.index)+compat+patched.slice(close.index);
  return serveCompatBuffer(req,res,Buffer.from(output),'text/javascript; charset=utf-8',relative,loadSession)
}
function pluginLoaderCompat(){return `\n;(() => {if(typeof PluginManager==='undefined'||PluginManager.__mistPluginVersions)return;const versions={Movie:'movie-browser-1',MoviePicture:'mobile-media-5',Sakura_MapNameExtend:'mapname-1',SoR_DataNoteExtension_MZ:'sornote-1',CsvAutoLoader:'csv-loader-1',CommonSave:'common-save-1',TS_ReplayMode:'replay-mode-2',TS_Decode:'scenario-decode-2',DRS_BoostEngine:'drs-boost-2',enc_lv2d:'enc-lv2d-2',villaA_AnimationTitleButtonFilter1:'villa-a-1',stwv_allDataFlag:'stwv-flag-1',FlowerCore:'flower-core-1',Wataridori_AddFileSystem:'wataridori-1',Torigoya_Achievement2:'torigoya-1',NekoGakuen_SteamworksAPI:'steamworks-2',JsScript76Set:'jsscript76-1',SRD_UltraBase:'pirate-strip-1',SaveSlotCustom:'saveslot-1',CGMZ_SplashScreen:'cyclone-steam-1'};if(typeof PluginManager.makeUrl==='function'){const originalMake=PluginManager.makeUrl;PluginManager.makeUrl=function(filename){const plain=String(filename),base=plain.endsWith('.js')?plain.slice(0,-3):plain,url=originalMake.call(this,filename),version=versions[base];return version?url.replace(/(js[/]plugins[/])([^?]*[.]js)/,'$1.mistv/'+version+'/$2'):url}}else if(typeof PluginManager.loadScript==='function'){const originalLoad=PluginManager.loadScript;PluginManager.loadScript=function(name){const plain=String(name),base=plain.endsWith('.js')?plain.slice(0,-3):plain,version=versions[base];return originalLoad.call(this,version?'.mistv/'+version+'/'+base+'.js':plain)}}PluginManager.__mistPluginVersions=true})();\n`}
async function serveDrsBoostEngineCompat(req,res,gameRoot,gameId,loadSession,fileName='DRS_BoostEngine.js') {
  const relative='/js/plugins/'+fileName,file=path.join(gameRoot,...relative.slice(1).split('/')),source=await fsp.readFile(file,'utf8').catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  const signature=/require\s*\(\s*["']fs["']\s*\)/.test(source)&&/require\s*\(\s*["']path["']\s*\)/.test(source)&&/[A-Za-z0-9]+_MainWindow.html/.test(source)&&/nw\.Window\.open/.test(source)&&/SceneManager\.update/.test(source);
  const imports=/const\s+e=require\s*\(\s*["']fs["']\s*\)\s*,\s*n=require\s*\(\s*["']path["']\s*\)\s*;/;
  const replacement='const e={writeFileSync(){},unlinkSync(){}},n={join:(...parts)=>parts.join("/")},process={cwd:()=>""},nw={Window:{open(){},get(){return {window:globalThis}}}};\n/* mist: browser-safe DRS_BoostEngine; keeps Alt+number speed controls and disables only the NW.js settings window */';
  const output=signature&&imports.test(source)?source.replace(imports,replacement):source;
  return serveCompatBuffer(req,res,Buffer.from(output),'text/javascript; charset=utf-8',relative,loadSession);
}
async function serveDevExtractorCompat(req,res,gameRoot,loadSession) {
  const file=path.join(gameRoot,'js','plugins','DRS_AllDataExtractor.js'),source=await fsp.readFile(file,'utf8').catch(()=>null);if(source===null)return text(res,404,'文件不存在');
  const isExtractor=/require\s*\(\s*["']fs["']\s*\)/.test(source)&&/require\s*\(\s*["']path["']\s*\)/.test(source)&&/data_output/.test(source)&&/writeFileSync/.test(source),output=Buffer.from(isExtractor?'/* disabled: test-play data extractor */\n':source),tracker=trackLoadStream(req,res,loadSession,'/js/plugins/DRS_AllDataExtractor.js',output.length);res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':output.length,'Cache-Control':'no-store'});tracker.chunk(output.length);res.end(output);
}
function legacyStringPolyfillCompat() {
  // mist: 终末的死斗场 (cdd9510d) JsScript75Set(粒子) hook 了 DataManager.loadDataFile：
  // `if(src.contains('Test_TrpParticles'))` —— String.prototype.contains 是 Firefox 旧别名，
  // Chromium 从未支持 → 首个 loadDataFile 调用即 TypeError → loadDatabase 中断 → 数据库全空、
  // 卡 Scene_Boot。补上别名（= includes），对其它游戏无副作用。
  return `\n;(() => {\n  if(typeof String!=='undefined'&&!String.prototype.contains){String.prototype.contains=String.prototype.includes}\n})();\n`;
}

function cgRoomSwitchFix(){return `\n;(() => {\n  if(globalThis.__mistCgRoomFix)return;globalThis.__mistCgRoomFix=true;globalThis.__mistCgRoomFixCount=0;\n  const apply=()=>{try{if(typeof $gameMap==='undefined'||typeof $gameSwitches==='undefined'||!$gameMap||!$gameSwitches)return;if($gameMap.mapId()===3&&$gameSwitches.value(318)&&!$gameSwitches.value(316)){$gameSwitches.setValue(316,true);globalThis.__mistCgRoomFixCount++;console.info('[雾灯] CG屋修复：已补齐开关316')}}catch(e){}};\n  setInterval(apply,600);setTimeout(apply,50);\n})();\n`}

const pirateStripCache=new Map();

async function servePluginMarkerStripCompat(req,res,gameRoot,sub,loadSession){
  const file=safeJoin(gameRoot,sub);if(!file)return null;
  const stat=await fsp.stat(file).catch(()=>null);if(!stat?.isFile()||stat.size>4*1024*1024)return null;
  const key=file+'|'+stat.mtimeMs+'|'+stat.size;let entry=pirateStripCache.get(key);
  if(entry===undefined){
    const source=await fsp.readFile(file,'utf8').catch(()=>null),stripped=source===null?null:stripPirateMarkerCode(source);
    entry=stripped===null?null:Buffer.from(stripped,'utf8');
    if(entry!==null)console.log('[雾灯插件净化] 已剥离盗版注入标记:',sub);
    if(pirateStripCache.size>800)pirateStripCache.clear();
    pirateStripCache.set(key,entry);
  }
  if(entry===null)return null;
  return serveCompatBuffer(req,res,entry,'text/javascript; charset=utf-8',sub,loadSession);
}

function parseTranslationJson(text) {
  const kept=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(line=>{const t=line.trimStart();return !t.startsWith('//')&&!/^\/\*.*\*\/\s*$/.test(t)});
  return JSON.parse(kept.join('\n'));
}

function knsRejectStopGuard(source) {
  // mist: MZ 1.5+ 核心把「未处理的 Promise 拒绝」当致命错误：onReject → onError → stop() 停主循环 + 全屏报错。
  // 浏览器平台上，平台型异步失败（存档桥 4xx、弱网、游客只读）会被升级成“启动闪屏冻结黑屏”
  // （愛と平和の魔法少女ローゼリーフ 案例：knsGlobalInfo 写档被 400 拒 → 游戏停在启动闪屏）。
  // 仅拦截存档桥标记（.__mistBridge）的拒绝：console.warn、不中止游戏；游戏自身未处理拒绝维持原行为。
  // 桌面 NW.js 不受影响（加载 NAS 原文，不经此路由注入）。
  if (!/SceneManager\.onReject\s*=\s*function/.test(source)) return '';
  if (!source.includes('event.message = event.reason')) return '';
  if (!/SceneManager\.onError\s*=\s*function[\s\S]{0,600}?this\.stop\(\)/.test(source)) return '';
  return `\n;(() => { if(!globalThis.SceneManager || SceneManager.__mistRejectGuard) return; SceneManager.__mistRejectGuard = true;\n  const origReject = SceneManager.onReject;\n  SceneManager.onReject = function(event) { try { const r = event && event.reason; if (r && r.__mistBridge) { console.warn('[雾灯兼容] 已拦截存档桥 Promise 拒绝（浏览器平台不中止游戏）:', r && r.message); return; } } catch (e) {} try { origReject.call(this, event); } catch (e) {} };\n})();\n`;
}

function mzLocalFileWebNoopCompat(source) {
  const re=/(StorageManager\.saveToLocalFile = function\(saveName, zip\) \{)(\r?\n)(    const dirPath = this\.fileDirectoryPath\(\);)/;
  if(!re.test(source))return source;
  return source.replace(re,(m,a,nl,b)=>a+nl+'    if (typeof require !== \"function\") { return Promise.resolve(); } // mist: 浏览器无本地文件系统，静默成功'+nl+b);
}

function audioNullSaveCompat(source) {
  const playBgm=/(AudioManager\.playBgm = function\(bgm, pos\) \{)(\r?\n)(    if \(this\.isCurrentBgm\(bgm\)\) \{)/;
  const playBgs=/(AudioManager\.playBgs = function\(bgs, pos\) \{)(\r?\n)(    if \(this\.isCurrentBgs\(bgs\)\) \{)/;
  let output=source;
  if(playBgm.test(output))output=output.replace(playBgm,(m,a,nl,b)=>a+nl+'    if (!bgm) { this.stopBgm(); this._currentBgm = null; return; } /* mist: null 存档安全 */'+nl+b);
  if(playBgs.test(output))output=output.replace(playBgs,(m,a,nl,b)=>a+nl+'    if (!bgs) { this.stopBgs(); this._currentBgs = null; return; } /* mist: null 存档安全 */'+nl+b);
  if(output!==source)console.log('[雾灯兼容] rpg_managers.js 音频 null 存档安全守卫已注入');
  return output;
}

async function serveCycloneSplashCompat(req,res,gameRoot,loadSession) {
  const relative='/js/plugins/CGMZ_SplashScreen.js',file=path.join(gameRoot,'js','plugins','CGMZ_SplashScreen.js'),source=await fsp.readFile(file,'utf8').catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  const hasGate=/!CycloneSteam\.isSubscribedApp\(\s*\d+\s*\)/.test(source);
  const output=hasGate?source.replace(/!CycloneSteam\.isSubscribedApp\(\s*\d+\s*\)/g,'false'):source;
  if(hasGate)console.log('[雾灯插件净化] CGMZ_SplashScreen Steam 订阅门卫已中和');
  return serveCompatBuffer(req,res,Buffer.from(output),'text/javascript; charset=utf-8',relative,loadSession)
}

async function serveSakuraMapNameCompat(req,res,gameRoot,loadSession) {
  const relative='/js/plugins/Sakura_MapNameExtend.js',file=path.join(gameRoot,'js','plugins','Sakura_MapNameExtend.js');
  const source=await fsp.readFile(file,'utf8').catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  const fsDecl="  const fs = require('fs');",pathDecl="  const path = require('path');";
  const baseFn="  const getBasePath = () => path.dirname(process.mainModule.filename);";
  if(!source.includes(fsDecl)||!source.includes(pathDecl)||!source.includes(baseFn))
    return serveCompatBuffer(req,res,Buffer.from(source),'text/javascript; charset=utf-8',relative,loadSession);
  const fsStub="  const fs = (typeof require === 'function') ? require('fs') : { readdirSync: () => [], readFileSync: () => 'null', writeFileSync: () => {}, existsSync: () => false }; /* mist: nwjs fs stub */";
  const pathStub="  const path = (typeof require === 'function') ? require('path') : { dirname: (p) => { const a = String(p || '').split('/'); a.pop(); return a.join('/') || '.'; }, join: function () { return Array.prototype.filter.call(arguments, Boolean).join('/'); } }; /* mist: nwjs path stub */";
  const baseGuard="  const getBasePath = () => (typeof process !== 'undefined' && process.mainModule) ? path.dirname(process.mainModule.filename) : '.'; /* mist: process guard */";
  let patched=source.replace(fsDecl,fsStub).replace(pathDecl,pathStub).replace(baseFn,baseGuard);
  return serveCompatBuffer(req,res,Buffer.from(patched),'text/javascript; charset=utf-8',relative,loadSession);
}

async function serveSoRDataNoteCompat(req,res,gameRoot,loadSession) {
  const relative='/js/plugins/SoR_DataNoteExtension_MZ.js',file=path.join(gameRoot,'js','plugins','SoR_DataNoteExtension_MZ.js');
  const source=await fsp.readFile(file,'utf8').catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  if(!source.includes("const fs = require('fs');")||!source.includes('Extended_NotePath'))
    return serveCompatBuffer(req,res,Buffer.from(source),'text/javascript; charset=utf-8',relative,loadSession);
  let payload=soRNoteCache.get(gameRoot);
  if(!payload){
    const noteDir=path.join(gameRoot,'data','SoRNote');
    const entries=await fsp.readdir(noteDir,{withFileTypes:true}).catch(()=>[]);
    const names=entries.map(e=>e.name);
    const files={};
    const targets=entries.filter(e=>e.isFile()&&e.name.endsWith('_note'));
    for(let i=0;i<targets.length;i+=32){
      const batch=targets.slice(i,i+32);
      const got=await Promise.all(batch.map(e=>fsp.readFile(path.join(noteDir,e.name),'utf8').catch(()=>null)));
      got.forEach((c,j)=>{if(c!==null)files[batch[j].name]=c});
    }
    payload='const __mistSoRFS = (function () {\n'
      +'  var names = '+JSON.stringify(names)+';\n'
      +'  var files = '+JSON.stringify(files)+';\n'
      +'  function base(f){ var s=String(f||""); return s.split("/").pop(); }\n'
      +'  return { names: names, readdirSync: function () { return names.slice(); },'
      +' readFileSync: function (f) { var k=base(f); return Object.prototype.hasOwnProperty.call(files,k) ? files[k] : ""; },'
      +' existsSync: function (f) { return Object.prototype.hasOwnProperty.call(files, base(f)); },'
      +' writeFileSync: function () {}, unlinkSync: function () {}, mkdirSync: function () {} };\n'
      +'})();\n';
    payload=payload.replace(/[\u0080-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
    soRNoteCache.set(gameRoot,payload);
    console.log('[mist SoRNote] 扩展备注内嵌：'+targets.length+' 个 _note，'+payload.length+' 字节（'+gameRoot+'）');
  }
  const open="(function() {";
  const idx=source.indexOf(open);
  let patched=idx<0?source:(source.slice(0,idx+open.length)+'\n'+payload+source.slice(idx+open.length));
  patched=patched.split("const fs = require('fs');").join('const fs = __mistSoRFS;');
  return serveCompatBuffer(req,res,Buffer.from(patched),'text/javascript; charset=utf-8',relative,loadSession);
}

const soRNoteCache=new Map();

function fileExistsGuardFix(gameId){return `\n;(() => {\n  if(globalThis.__mistFileExistsGuard)return;globalThis.__mistFileExistsGuard=true;\n  const base=${JSON.stringify(path.posix.join('/games',gameId||''))};\n  globalThis.__mistExists=(p)=>{try{let s=String(p).replaceAll(String.fromCharCode(92),'/');while(s.startsWith('./'))s=s.slice(2);if(s.startsWith('www/'))s=s.slice(4);while(s.startsWith('/'))s=s.slice(1);if(!s)return false;const xhr=new XMLHttpRequest();xhr.open('HEAD',base+'/'+s.split('/').map(encodeURIComponent).join('/')+'?mistprobe=1',false);xhr.send(null);return xhr.status>=200&&xhr.status<400}catch(e){return false}};\n  const patch=()=>{try{if(typeof Game_Interpreter==='undefined')return;const proto=Game_Interpreter.prototype;if(!proto.command111||proto.command111.__mistExistsGuard)return;const orig=proto.command111;const wrapped=function(){const p=this._params;if(p&&String(p[0])==='12'&&typeof p[1]==='string'&&p[1].indexOf('existsSync(')>=0&&p[1].indexOf('require(')>=0){let code=p[1];code=code.split("require('fs').existsSync(").join('__mistExists(');code=code.split('require("fs").existsSync(').join('__mistExists(');let result=false;try{result=!!eval(code)}catch(e){console.warn('[雾灯] 存在性校验求值失败',e)}this._branch[this._indent]=result;if(result===false)this.skipBranch();return true}return orig.apply(this,arguments)};wrapped.__mistExistsGuard=true;proto.command111=wrapped}catch(e){}};\n  patch();setInterval(patch,1500);\n})();\n`}
async function serveSaveSlotCustomCompat(req,res,gameRoot,loadSession) {
  const relative='/js/plugins/SaveSlotCustom.js',file=path.join(gameRoot,'js','plugins','SaveSlotCustom.js'),source=await fsp.readFile(file,'utf8').catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  // mist: 本拷贝插件参数 slotSettings 为空串（打包时丢了配置）→ 顶层 JSON.parse("") 抛
  // SyntaxError → main.js onWindowError 记录错误 → window load 时跳过 SceneManager.run →
  // 整个游戏卡启动。空/空白回退 "[]"（插件退化为无自定义槽位，等同未配置）。
  const patched=source.split('JSON.parse(pluginParams.slotSettings)').join('JSON.parse(String(pluginParams.slotSettings||"").trim()||"[]")');
  return serveCompatBuffer(req,res,Buffer.from(patched),'text/javascript; charset=utf-8',relative,loadSession);
}

const _downscaleCache=new Map();const _downscaleCacheMax=24;
function downscaleCacheGet(key){const v=_downscaleCache.get(key);if(v!==undefined){_downscaleCache.delete(key);_downscaleCache.set(key,v);return v}return undefined}
function downscaleCacheSet(key,value){if(_downscaleCache.size>=_downscaleCacheMax){const oldest=_downscaleCache.keys().next().value;if(oldest!==undefined)_downscaleCache.delete(oldest)}_downscaleCache.set(key,value)}

async function serveMissingImageFallback(req,res,gameRoot,sub){
  if(!/^\/img\/.+\.(?:rpgmvp|png_|png)$/i.test(sub))return null;
  const file=path.join(gameRoot,...sub.slice(1).split('/'));
  const stat=await fsp.stat(file).catch(()=>null);
  if(stat&&stat.isFile())return null;
  const encrypted=/\.(?:rpgmvp|png_)$/i.test(sub);
  let payload=_transparentPng,mime='image/png';
  if(encrypted){
    const keys=await encryptionKeys(gameRoot),key=keys&&keys[0]&&keys[0].length===16?keys[0]:null;
    if(key){
      const body=Buffer.from(_transparentPng);
      for(let i=0;i<16&&i<body.length;i++)body[i]^=key[i];
      payload=Buffer.concat([RPG_HEADER,body]);
      mime='application/octet-stream';
    }
  }
  console.log('[雾灯缺图兜底]',sub);
  res.writeHead(200,{'Content-Type':mime,'Content-Length':payload.length,'Cache-Control':'public, max-age=300'});
  return res.end(payload);
}
// ── 移动端 WebGL 纹理上限兼容（mist）─────────────────────────────────────────
// Android Chrome/WebView 的 MAX_TEXTURE_SIZE 常见 4096（Adreno 732 等）。RPG Maker MV
// 视差图/大图一旦超限，WebGL texImage2D 静默失败（不抛错、资源加载全 200）→ 整图黑屏。
// 对 /img/ 下的超限图片：解密 → 等比降采样至 ≤MAX_TEXTURE_SIZE → 原格式重封装（RMMV 加密
// 或明文 PNG）返回。引擎 Decrypter.decryptArrayBuffer 解密环节完全不变，拿到的是限内尺寸。
// 不适用/未超限 → 返回 null，走原 serveFile 原样流出（不影响其它游戏与路径）。

// 读取图片尺寸（前 48 字节；支持明文 PNG、RMMV/MZ 加密 .rpgmvp/.png_ 的 16 字节签名偏移）
async function readImageDims(file){
  const fh=await fsp.open(file,'r').catch(()=>null);if(!fh)return null;
  try{const b=Buffer.alloc(48);const {bytesRead}=await fh.read(b,0,48,0);if(bytesRead<24)return null;
    if(b[0]===0x89)return {width:b.readUInt32BE(16),height:b.readUInt32BE(20)};
    // mist: RPGMV/MZ 加密图（xxx.png_/.rpgmvp）= [16B RPGMV 签名][明文，仅前 16 字节 XOR key]
    // → 明文 IHDR 宽高在文件偏移 32/36。用 IHDR 深度/类型/压缩/过滤字节（40-43）做形状校验，
    // 防止把加密 JPEG 等非 PNG 载荷的随机字节误读为尺寸。
    if(bytesRead>=48&&b[0]===0x52&&b[1]===0x50&&b[2]===0x47&&b[3]===0x4d&&b[4]===0x56&&b[42]===0&&b[43]===0&&[1,2,4,8,16].includes(b[40])&&[0,2,3,4,6].includes(b[41]))return {width:b.readUInt32BE(32),height:b.readUInt32BE(36)};
    if(bytesRead>=48&&b[16]===0x89)return {width:b.readUInt32BE(32),height:b.readUInt32BE(36)};
    return null;
  }finally{await fh.close()}
}
// ── spine .atlas 配套缩放（mist）────────────────────────────────────────────
// 客户端纹理上限不足时，serveImageTextureCompat 会把图集中的大 PNG 降采样；本函数对
// 同一 .atlas 的 xy/size/orig/offset 做同比例缩放 → pixi-spine 帧不再越界，布局不变。
// 页图片未超限（或读不到尺寸）→ 整文件原样返回 null 走静态路径，零影响。
async function serveAtlasCompat(req,res,gameRoot,sub){
  if(!/\.atlas$/i.test(sub))return null;
  if(req.method!=='GET'&&req.method!=='HEAD')return null;
  const file=path.join(gameRoot,...sub.slice(1).split('/'));
  const stat=await fsp.stat(file).catch(()=>null);
  if(!stat?.isFile())return null;
  const maxSize=textureMaxForRequest(req);
  const raw=await fsp.readFile(file).catch(()=>null);
  if(raw===null)return null;
  const text=raw.toString('utf8');
  const dir=path.dirname(file),pageScales={};let any=false;
  for(const line of text.split(/\r?\n/)){
    const t=line.trim();
    if(!t||/^\s/.test(line)||!/\.(png|jpe?g|webp)$/i.test(t))continue;
    const imgPath=path.join(dir,t);
    const dim=await readImageDims(imgPath)||await readImageDims(imgPath.replace(/\.(png|jpe?g|webp)$/i,'.rpgmvp'))||await readImageDims(imgPath+'_'); // mist: MZ 加密图名是 xxx.png_（EMERALD TREASURE 等），漏找会导致 atlas 未缩放而贴图已降采样 → pixi 帧越界崩溃
    if(!dim)continue;
    const sc=atlasScaleFor(dim.width,dim.height,maxSize);
    if(!sc)continue;
    pageScales[t]={scale:sc.scale,width:sc.width,height:sc.height};any=true;
  }
  if(!any){
    // mist: 无缩放需求也走本路径并统一 max-age=300：游戏端图集 URL 无法加版本号，
    // 缩短缓存保证未来的图集级兼容修复 ≤5 分钟送达所有客户端（原 serveFile 是 86400）。
    res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Length':raw.length,'Cache-Control':'public, max-age=300'});
    if(req.method==='HEAD')return res.end();
    return res.end(raw);
  }
  const body=Buffer.from(scaleAtlasText(text,pageScales),'utf8');
  res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Length':body.length,'Cache-Control':'public, max-age=300'});
  if(req.method==='HEAD')return res.end();
  return res.end(body);
}
async function serveImageTextureCompat(req,res,gameRoot,sub){
  if(!/^\/img\/.+\.(?:rpgmvp|png_|png)$/i.test(sub))return null;
  const file=path.join(gameRoot,...sub.slice(1).split('/'));
  const stat=await fsp.stat(file).catch(()=>null);
  if(!stat?.isFile())return null;
  const encrypted=/\.(?:rpgmvp|png_)$/i.test(sub);
  const raw=await fsp.readFile(file);
  let png;
  if(encrypted){
    const image=decryptRpgImage(raw,await encryptionKeys(gameRoot));
    if(!image)return null; // 非 RMMV 加密（明文/其它格式）→ 交给原路径
    png=image.output;
  }else{
    png=raw; // 明文 PNG（非加密游戏的大图同样可能超限）
  }
  const dim=pngDimensions(png);
  const maxSize=textureMaxForRequest(req);
  if(!dim||(dim.width<=maxSize&&dim.height<=maxSize))return null;
  if(req.method!=='GET'&&req.method!=='HEAD')return null;
  const cacheKey=gameRoot+'|'+sub+'|'+maxSize;
  let payload=downscaleCacheGet(cacheKey);
  if(!payload){
    const resized=downscalePng(png,maxSize);
    if(!resized)return null;
    if(encrypted){
      const keys=await encryptionKeys(gameRoot),key=keys&&keys[0];
      if(!key||key.length!==16)return null; // 无密钥无法重加密 → 原样流出（保持现状）
      payload={mime:'application/octet-stream',data:encryptRpgPng(resized,key)};
    }else{
      payload={mime:'image/png',data:resized};
    }
    downscaleCacheSet(cacheKey,payload);
  }
  res.writeHead(200,{'Content-Type':payload.mime,'Content-Length':payload.data.length,'Cache-Control':'public, max-age=300'});
  if(req.method==='HEAD')return res.end();
  return res.end(payload.data);
}

let m4aTranscodeQueue = Promise.resolve();
async function serveM4aFallback(req,res,root,sub,gameId,loadSession) {
  if(!/\.m4a$/i.test(sub)) return false;
  let decoded;
  try{ decoded=decodeURIComponent(sub.replace(/%(?![\\da-f]{2})/gi,'%25')); }catch{ return false; }
  const rel = decoded.replace(/^\/+/,'');
  if(!rel || rel.includes('..')) return false;
  const oggRel = '/' + rel.replace(/\.m4a$/i,'.ogg');
  const oggFile = safeJoin(root, oggRel);
  if(!oggFile) return false;
  const oggStat = await fsp.stat(oggFile).catch(()=>null);
  if(!oggStat?.isFile()) return false;
  const cacheFile = path.join(M4A_CACHE_DIR, gameId, oggRelToCacheRel(rel));
  let stat = await fsp.stat(cacheFile).catch(()=>null);
  if(!stat?.isFile()){
    const task = m4aTranscodeQueue.then(async()=>{
      const again = await fsp.stat(cacheFile).catch(()=>null);
      if(again?.isFile()) return;
      console.log(`[m4a] 转码 ${oggRel} → ${cacheFile}`);
      await transcodeOggToM4a(oggFile, cacheFile, FFMPEG_BIN);
    });
    m4aTranscodeQueue = task.catch(err=>{ console.error('[m4a] 转码失败', err.message); });
    try{ await task; }catch(err){ console.error('[m4a] 转码失败', err.message); return false; }
    stat = await fsp.stat(cacheFile).catch(()=>null);
    if(!stat?.isFile()) return false;
  }
  const headers={'Content-Type':'audio/mp4','Cache-Control':'public, max-age=86400','Accept-Ranges':'bytes'};
  const range=req.headers.range;
  if(range){
    const match=/bytes=(\d*)-(\d*)/.exec(range);
    if(match){ const start=match[1]?Number(match[1]):0,end=match[2]?Math.min(Number(match[2]),stat.size-1):stat.size-1;
      if(start<=end && start<stat.size){res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${stat.size}`,'Content-Length':end-start+1});const stream=fs.createReadStream(cacheFile,{start,end}),tracker=trackLoadStream(req,res,loadSession,decoded,stat.size,start);stream.on('data',chunk=>tracker.chunk(chunk.length));stream.on('error',error=>{tracker.fail();if(!res.destroyed)res.destroy(error)});stream.pipe(res);return true;}
    }
    res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}); return res.end(),true;
  }
  res.writeHead(200,{...headers,'Content-Length':stat.size});
  if(req.method==='HEAD') return true;
  const stream=fs.createReadStream(cacheFile),tracker=trackLoadStream(req,res,loadSession,decoded,stat.size);stream.on('data',chunk=>tracker.chunk(chunk.length));stream.on('error',error=>{tracker.fail();if(!res.destroyed)res.destroy(error)});stream.pipe(res);
  return true;
}

// mist: 加密音频（.rpgmvo）在移动端的 m4a 兜底。
// 手机 MV 的 audioFileExt() 返回 '.m4a'，经 Decrypter.extToEncryptExt 变成 '.rpgmvm' 请求；
// 发行包通常只有 '.rpgmvo'（加密 ogg），没有 '.rpgmvm' → 404 静音。
// 这里把 .rpgmvo 解密 → 转码为 AAC(m4a) → 按同款旧式格式重新加密返回，客户端解密后即可播放。

async function serveEncryptedAudioM4a(req,res,root,sub,game,loadSession){
  if(!/\.rpgmvm$/i.test(sub)) return false;
  let decoded;
  try{ decoded=decodeURIComponent(sub.replace(/%(?![\da-f]{2})/gi,'%25')); }catch{ return false; }
  const rel=decoded.replace(/^\/+/,'');
  if(!rel||rel.includes('..')) return false;
  const srcFile=safeJoin(root,'/'+rel.replace(/\.rpgmvm$/i,'.rpgmvo'));
  if(!srcFile) return false;
  const srcStat=await fsp.stat(srcFile).catch(()=>null);
  if(!srcStat?.isFile()) return false;
  const key=await loadEncryptionKey(root);
  if(!key){ console.error('[m4a] 加密音频缺少 encryptionKey，无法转码:',rel); return false; }
  const cacheFile=path.join(M4A_CACHE_DIR,game.id,rel.replace(/\.rpgmvm$/i,'.m4a'));
  let stat=await fsp.stat(cacheFile).catch(()=>null);
  if(!stat?.isFile()){
    const task=m4aTranscodeQueue.then(async()=>{
      const again=await fsp.stat(cacheFile).catch(()=>null);
      if(again?.isFile()) return;
      const encrypted=await fsp.readFile(srcFile);
      const plain=decryptLegacyMv(encrypted,key);
      if(!plain) throw new Error('MV 加密格式不匹配（仅支持旧式固定头格式）');
      console.log(`[m4a] 解密并转码加密音频 ${rel}`);
      await transcodeOggBufferToM4a(plain,cacheFile,FFMPEG_BIN);
    });
    m4aTranscodeQueue=task.catch(err=>{ console.error('[m4a] 加密音频转码失败',err.message); });
    try{ await task; }catch(err){ console.error('[m4a] 加密音频转码失败',err.message); return false; }
    stat=await fsp.stat(cacheFile).catch(()=>null);
    if(!stat?.isFile()) return false;
  }
  const plainM4a=await fsp.readFile(cacheFile);
  const body=encryptLegacyMv(plainM4a,key);
  res.writeHead(200,{'Content-Type':'audio/mp4','Content-Length':body.length,'Cache-Control':'public, max-age=86400'});
  if(req.method==='HEAD') return true;
  res.end(body);
  return true;
}

async function serveJsScript76SetCompat(req,res,gameRoot,loadSession){
  const file=path.join(gameRoot,'js','plugins','JsScript76Set.js');
  const source=await fsp.readFile(file,'utf8').catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  const output=Buffer.from(fixJsScript76Set(source.replace(/^\uFEFF/,'')),'utf8');
  res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':output.length,'Cache-Control':'no-store'});
  return res.end(output);
}

// mist: 移动端 WebGL MAX_TEXTURE_SIZE 上限（Adreno/Mali 常见 4096），超出即静默黑屏；
// 服务端对超限图片解密→降采样→重加密返回。可用 config.maxTextureSize 覆盖（测试用小值验证管线）。
const MAX_TEXTURE_SIZE_CONFIG = Number(config.maxTextureSize || 0) || 0;
function textureMaxForRequest(req){
  if(MAX_TEXTURE_SIZE_CONFIG>0)return MAX_TEXTURE_SIZE_CONFIG;
  const m=/mistmts=(\d+)/.exec(req.headers.cookie||'');const client=m?Number(m[1]):0;
  if(client>0)return client;
  const ua=req.headers['user-agent']||'';
  if(/Android|iPhone|iPad|iPod|Mobile/i.test(ua))return 4096;
  return 16384;
}
const M4A_CACHE_DIR = path.join(DATA_DIR, 'audio-m4a');
const FFMPEG_BIN = process.env.FFMPEG_PATH || config.ffmpegPath || 'ffmpeg';

async function characterImageNames(...roots) {
  const names=new Set();
  for(const root of roots){
    if(!root)continue;const base=path.join(root,'img','characters'),walk=async(dir,prefix='')=>{
      const entries=await fsp.readdir(dir,{withFileTypes:true}).catch(()=>[]);
      for(const entry of entries){if(names.size>=10000)break;if(entry.isSymbolicLink())continue;const relative=prefix?`${prefix}/${entry.name}`:entry.name,full=path.join(dir,entry.name);if(entry.isDirectory())await walk(full,relative);else if(entry.isFile()&&/\.(?:png|png_|rpgmvp)$/i.test(entry.name))names.add(relative.replace(/\.(?:png|png_|rpgmvp)$/i,''))}
    };await walk(base)
  }
  return [...names].sort((a,b)=>a.localeCompare(b,'en',{numeric:true}))
}
function encLv2dBrowserShim(scriptUrl) {
  const gameBase=scriptUrl.replace(/\/js\/plugins\/[^/]*$/,'');
  const shim=`;(() => {
  if(globalThis.__mistEncLv2dShim)return;globalThis.__mistEncLv2dShim=true;
  const gameBase=${JSON.stringify(gameBase)},toUrl=p=>String(p).replace(/\\\\/g,'/');
  const syncStatus=url=>{try{const xhr=new XMLHttpRequest();xhr.open('GET',url,false);xhr.send(null);return xhr.status}catch{return 0}};
  const fsShim={
    existsSync:p=>{const s=syncStatus(toUrl(p));if(s>=200&&s<400)return true;if(/game_end_icon3|voice\.csv/i.test(String(p)))return true;return false},
    readFileSync:(p,opt)=>{try{const xhr=new XMLHttpRequest();xhr.open('GET',toUrl(p),false);xhr.send(null);if(xhr.status>=400)throw new Error('ENOENT: '+p);return opt&&opt.encoding?xhr.responseText:xhr.response}catch{return opt&&opt.encoding?'':new Uint8Array(0)}},
    writeFileSync:()=>{},readdirSync:()=>[],mkdirSync:()=>{},unlinkSync:()=>{},
    statSync:p=>({isFile:()=>true,isDirectory:()=>false}),
    readFile:(p,cb)=>{try{cb(null,fsShim.readFileSync(p))}catch(e){cb(e)}},
    writeFile:(p,d,cb)=>{cb&&cb(null)}
  };
  const pathShim={
    dirname:p=>{const s=String(p).replace(/\\\\/g,'/'),i=s.lastIndexOf('/');return i<=0?'/':s.slice(0,i)},
    normalize:p=>String(p).replace(/\\\\/g,'/').replace(/\\/+\\//g,'/'),
    join:(...a)=>a.join('/').replace(/\\\\/g,'/').replace(/\\/+\\//g,'/'),
    basename:p=>{const s=String(p).replace(/\\\\/g,'/');return s.slice(s.lastIndexOf('/')+1)},
    extname:p=>{const b=pathShim.basename(p),i=b.lastIndexOf('.');return i>=0?b.slice(i):''},
    resolve:(...a)=>a.join('/').replace(/\\\\/g,'/')
  };
  globalThis.require=globalThis.require||function(id){
    if(id==='fs')return fsShim;
    if(id==='path')return pathShim;
    if(id==='nw.gui')return {};
    throw new Error('require('+id+') is not available in the browser');
  };
  // mist: 注入的 require/process 会让 Utils.isNwjs() 误判为 NW.js，导致
  // initNwjs/StorageManager.isLocalMode/Input._wrapNwjsAlert 走桌面包代码而崩溃。
  // 浏览器环境必须明确判定为非 NW.js。
  if(typeof Utils!=='undefined'&&!Utils.__mistIsNwjsPatched){try{Utils.isNwjs=function(){return false};Utils.__mistIsNwjsPatched=true}catch{}}
  if(!globalThis.process)globalThis.process={
    mainModule:{filename:gameBase+'/Game.exe'},
    argv:[gameBase+'/Game.exe'],
    versions:{},
    platform:'win32',
    env:{},
    cwd:()=>gameBase,
    on:()=>{},
    once:()=>{},
    exit:()=>{}
  };
})();
`;
  return shim;
}
async function serveEncLv2dCompat(req,res,gameRoot,loadSession) {
  const relative='/js/plugins/enc_lv2d.js',file=path.join(gameRoot,...relative.slice(1).split('/')),source=await fsp.readFile(file,'utf8').catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  const signature=/require\s*\(\s*['"]fs['"]\s*\)/.test(source)&&/setMotionSeData/.test(source)&&/SceneManager/.test(source)&&/live2dModel/.test(source)&&/process\s*\[?['"]?mainModule/.test(source)||/require\s*\(\s*['"]fs['"]\s*\)/.test(source)&&/setMotionSeData/.test(source)&&/game_end_icon3/.test(source);
  if(!signature)return serveCompatBuffer(req,res,Buffer.from(source),'text/javascript; charset=utf-8',relative,loadSession);
  const scriptUrl=(req.headers.host?`http://${req.headers.host}`:'')+req.url.replace(/\?.*$/,''),output=Buffer.from(encLv2dBrowserShim(scriptUrl)+source);
  return serveCompatBuffer(req,res,output,'text/javascript; charset=utf-8',relative,loadSession)
}
async function serveVillaAAnimationTitleCompat(req,res,gameRoot,loadSession) {
  const relative='/js/plugins/villaA_AnimationTitleButtonFilter1.js',file=path.join(gameRoot,...relative.slice(1).split('/')),source=await fsp.readFile(file,'utf8').catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  const signature=/pluginName\s*=\s*'AnimationTitleButtonFilter1'/.test(source)&&/PluginManager\s*\[\s*['"]parameters['"]\s*\]\s*\(\s*pluginName\s*\)/.test(source)&&/AnimationTitleButtonFilter1/.test(source);
  if(!signature)return serveCompatBuffer(req,res,Buffer.from(source),'text/javascript; charset=utf-8',relative,loadSession);
  // mist: 插件源码硬编码 pluginName='AnimationTitleButtonFilter1'（无 villaA_ 前缀），
  // 而 $plugins 注册名为 villaA_AnimationTitleButtonFilter1，导致 PluginManager.parameters()
  // 查不到参数返回 {} → JSON.parse(undefined) 崩溃。将查询名改为注册名。
  const output=source.replace(/pluginName\s*=\s*'AnimationTitleButtonFilter1'/,"pluginName='villaA_AnimationTitleButtonFilter1'");
  return serveCompatBuffer(req,res,Buffer.from(output),'text/javascript; charset=utf-8',relative,loadSession)
}
const _decryptedCache=new Map();const _decryptedCacheMax=512;
function decryptedCacheGet(key){const v=_decryptedCache.get(key);if(v!==undefined){_decryptedCache.delete(key);_decryptedCache.set(key,v);return v}return undefined}
function decryptedCacheSet(key,value){if(_decryptedCache.size>=_decryptedCacheMax){const oldest=_decryptedCache.keys().next().value;if(oldest!==undefined)_decryptedCache.delete(oldest)}_decryptedCache.set(key,value)}
const _transparentPng=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63606060f80f0001040100f5b6e5f70000000049454e44ae426082','hex');
async function serveEliPictureCompat(req,res,gameRoot,sub,loadSession) {
  // mist: エリィは村の共有妻 (11a147e1) 存档界面插件 NUUN_SaveScreen_3 配置 BackGroundImg="pictures"，
  // NUUN_Base 的 ImageManager.nuun_LoadPictures 用 loadBitmap("img/", filename) 拼出 img/pictures.png，
  // 而磁盘上 pictures 是目录 → 404 → weakNetworkRetry 无限重试 → Scene_Load 永不就绪卡死转圈。
  // 该背景图是装饰性占位（存档列表背景）。注意：此游戏是自定义加密引擎（_startDecrypting 请求 url+"_"，
  // Utils.decryptArrayBuffer 校验 RPGMV 头后 XOR 解密），所以占位图必须以 RPGMV 加密格式返回——
  // 引擎解密后才能得到可显示的透明 PNG，否则明文会被 decryptArrayBuffer 抛 Decryption error。
  if(sub!=='/img/pictures.png'&&sub!=='/img/pictures.png_')return null;
  const keys=await encryptionKeys(gameRoot),key=keys&&keys[0]&&keys[0].length===16?keys[0]:null;
  let payload=_transparentPng;
  if(key){
    const body=Buffer.from(_transparentPng);
    for(let i=0;i<16&&i<body.length;i++)body[i]^=key[i];
    payload=Buffer.concat([RPG_HEADER,body]);
  }
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':payload.length,'Cache-Control':'public, max-age=86400'});
  return res.end(payload);
}
async function serveItankiDKToolsCompat(req,res,gameRoot,relative,loadSession) {
  // mist: {異端秘律} (0094b0e0)：DKTools 在 SceneManager.initialize（main.js load 回调）立即执行
  // Localization._loadData，rmmz_core 注入的 load 事件监听器晚于 main.js 注册 → 覆写来不及。
  // 改为直接在 DKTools.js 文件末尾追加覆写（插件脚本解析即生效）：absolutePathExists 对
  // locales 索引文件（zhjson/zh.json）返回 true，其余保持原逻辑。
  const actualRelative=relative.replace(/DKTools\.v5\.js$/,'DKTools.js');
  const file=path.join(gameRoot,...actualRelative.slice(1).split('/')),source=await fsp.readFile(file).catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  const patch=`\n;(()=>{\n  if(globalThis.__mistItankiDk)return;globalThis.__mistItankiDk=true;\n  if(typeof DKTools!=='undefined'&&DKTools.IO&&DKTools.IO.absolutePathExists&&!DKTools.IO.absolutePathExists.__mistItankiDk){\n    const origA=DKTools.IO.absolutePathExists;\n    DKTools.IO.absolutePathExists=function(path){\n      const p=String(path||'');\n      if(p.endsWith('zhjson')||p.endsWith('zh.json'))return true;\n      return origA.apply(this,arguments);\n    };\n    DKTools.IO.absolutePathExists.__mistItankiDk=true;\n  }\n})();\n`;
  const output=Buffer.concat([source,Buffer.from(patch)]);
  return serveCompatBuffer(req,res,output,'text/javascript; charset=utf-8',relative,loadSession);
}
async function serveItankiStampCompat(req,res,sub,loadSession) {
  // mist: {異端秘律} (0094b0e0) DKTools.IO._loadStamp 同步加载 data/Stamp.json（磁盘不存在 → 404），
  // 且 loadJson 未传 onError → __processError(xhr, undefined) → throwError(xhr) → 启动崩溃。
  // 返回 {}（空 stamp）：decompress:true 让 pako.inflate 抛错 → status ERROR_DECOMPRESSING →
  // onSuccess 收到后 stamp 保持空对象，不崩。
  if(sub!=='/data/Stamp.json')return null;
  res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Length':2,'Cache-Control':'no-store'});
  return res.end('{}');
}
async function serveItankiLocaleCompat(req,res,gameRoot,sub,loadSession) {
  // mist: {異端秘律} (0094b0e0) DKTools 单文件分支请求的 locales/zhjson（directoryPath+'json'）。
  // 磁盘无此文件；返回 locales/zh/*.json 的合并翻译（首 key 优先，与 DKTools processJsonFile 一致），
  // 让 DKTools 本地化数据正常填充。合并结果缓存（目录固定）。
  if(!/^\/locales\/(?:zhjson|zh\.json)$/.test(sub))return null;
  const cacheKey='itanki-zh-merge';
  let merged=_itankiLocaleCache.get(cacheKey);
  if(!merged){
    const dir=path.join(gameRoot,'locales','zh'),data={};
    const files=await fsp.readdir(dir).catch(()=>[]);
    for(const f of files.sort()){
      if(!f.endsWith('.json'))continue;
      try{
        const obj=JSON.parse((await fsp.readFile(path.join(dir,f),'utf8')).replace(/^\uFEFF/,''));
        for(const [k,v] of Object.entries(obj)){if(data[k]===undefined)data[k]=v}
      }catch{}
    }
    merged=Buffer.from(JSON.stringify(data),'utf8');
    _itankiLocaleCache.set(cacheKey,merged);
  }
  res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Length':merged.length,'Cache-Control':'no-store'});
  return res.end(merged);
}
const _itankiLocaleCache=new Map();
async function serveItankiCubismCompat(req,res,gameRoot,loadSession) {
  // mist: {異端秘律} (0094b0e0) Live2D 表情命令（cubism4ForMZ.js）在浏览器崩溃：
  // ①loadExpressionNow 用 NW.js 专属代码 require("path")/process.mainModule/StorageManager.fsReadFile
  //   → ReferenceError: require is not defined → catch 返回 Promise.resolve(undefined)（truthy!）
  // ②setExpressionNow 拿到 Promise → _setExpressionNow(Promise) → startMotion 遍历旧 entry 时
  //   motionQueueEntry._motion.getFadeOutTime() 崩（_motion 是上次失败的 Promise）→ TypeError
  //   抛在解释器 → NPC 对话事件卡死。
  // 修复：①改同步 XHR 加载 expression JSON（models/<name>/Expression/*.exp3.json 相对路径即可）
  // ②失败路径返回 undefined（setExpressionNow 的 !expression 拦截，不再进 _setExpressionNow）
  // ③startMotion 遍历容错（_motion 无效跳过）作第二道防线。
  const file=path.join(gameRoot,'js','plugins','live2d','cubism4ForMZ.js');
  const source=await fsp.readFile(file).catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  let out=source.toString('utf8').replace(/\r\n/g,'\n');
  const nwBlock=`const basePath = require("path").dirname(process.mainModule.filename);
            const path = basePath + "/models/" + expressionManager.settings.name + "/" + expressionManager.getExpressionFile(definition);
            var exp = {};
            var data = StorageManager.fsReadFile(path);`;
  const browserBlock=`var path = "models/" + expressionManager.settings.name + "/" + expressionManager.getExpressionFile(definition);
            var exp = {};
            var __req = new XMLHttpRequest();
            __req.open("GET", path, false);
            __req.send(null);
            if (__req.status !== 200 && __req.status !== 0) { throw new Error("HTTP " + __req.status); }
            var data = __req.responseText;`;
  if(out.includes(nwBlock))out=out.replace(nwBlock,browserBlock);
  const retBlock=`        }
        return Promise.resolve(undefined);
    }
    static releaseTasks() {`;
  const retFix=`        }
        return undefined;
    }
    static releaseTasks() {`;
  if(out.includes(retBlock))out=out.replace(retBlock,retFix);
  const fadeLine='motionQueueEntry.setFadeOut(motionQueueEntry._motion.getFadeOutTime()); // フェードアウト設定';
  const fadeFix='if (motionQueueEntry._motion && typeof motionQueueEntry._motion.getFadeOutTime === "function") { motionQueueEntry.setFadeOut(motionQueueEntry._motion.getFadeOutTime()); } // フェードアウト設定';
  if(out.includes(fadeLine))out=out.replace(fadeLine,fadeFix);
  const output=Buffer.from(out,'utf8');
  res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':output.length,'Cache-Control':'no-store'});
  return res.end(output);
}
async function serveHirokaEncryptedCompat(req,res,gameRoot,sub,loadSession) {
  // mist: 凍堂ヒロカの隷雄譚 (a449fc1a) 自定义加密引擎——服务端解密 + 引擎明文路径双保险。
  // 背景：引擎 rmmz_scenes.js 调 setEncryptionInfo(true,true,key)，Bitmap._startDecrypting 请求 url+'_'
  // 由 Utils.decryptArrayBuffer 解密。但调用链 url 形态混乱：有的带 '_'（menu_window.png_ → 原逻辑拼出
  // menu_window.png__ 双下划线 404），有的不带（AsyncLoadImage 直接请求 menu_window.png → 磁盘只有 .png_ → 404）。
  // 且历史明文缓存（旧版服务端解密 max-age=86400）会让引擎二次解密报 Decryption error。
  // 本函数：对 .png/.png_/.ogg/.ogg_ 多候选——找到磁盘加密文件即解密返回明文（max-age 可缓存）；
  // 配合注入的 hasEncryptedImages=false，引擎完全不解密，任何缓存状态都能直接显示。
  // 性能：解密结果 LRU 缓存（512 张），冷启动后标题动画 219 张只需首次读 SMB+解密，之后纯内存。
  const cacheKey=gameRoot+'|'+sub;
  const hit=decryptedCacheGet(cacheKey);
  if(hit){res.writeHead(200,{'Content-Type':hit.type,'Content-Length':hit.data.length,'Cache-Control':'public, max-age=86400'});return res.end(hit.data)}
  const candidates=[sub];
  if(/\.png$/i.test(sub))candidates.push(sub+'_');
  if(/\.ogg$/i.test(sub))candidates.push(sub+'_');
  if(/\.png_$/i.test(sub))candidates.push(sub.slice(0,-1));
  if(/\.ogg_$/i.test(sub))candidates.push(sub.slice(0,-1));
  for(const cand of candidates){
    const file=path.join(gameRoot,...cand.slice(1).split('/'));
    const stat=await fsp.stat(file).catch(()=>null);
    if(!stat?.isFile())continue;
    const data=await fsp.readFile(file),keys=await encryptionKeys(gameRoot);
    if(/\.(?:png_|png)$/i.test(cand)){
      if(data.subarray(0,16).equals(RPG_HEADER)){
        const image=decryptRpgImage(data,keys);
        if(image){const payload={type:image.type,data:image.output};decryptedCacheSet(cacheKey,payload);res.writeHead(200,{'Content-Type':payload.type,'Content-Length':payload.data.length,'Cache-Control':'public, max-age=86400'});return res.end(payload.data)}
      }else{
        // 已是明文图片
        const payload={type:'image/png',data};decryptedCacheSet(cacheKey,payload);res.writeHead(200,{'Content-Type':payload.type,'Content-Length':payload.data.length,'Cache-Control':'public, max-age=86400'});return res.end(payload.data)
      }
    }
    if(/\.(?:ogg_|ogg)$/i.test(cand)){
      if(data.subarray(0,16).equals(RPG_HEADER)){
        const body=data.subarray(16);
        for(const actualKey of keys){
          const output=Buffer.from(body);
          for(let i=0;i<16;i++)output[i]^=actualKey[i];
          if(output.subarray(0,4).equals(Buffer.from('OggS','ascii'))){const payload={type:'audio/ogg',data:output};decryptedCacheSet(cacheKey,payload);res.writeHead(200,{'Content-Type':payload.type,'Content-Length':payload.data.length,'Cache-Control':'public, max-age=86400'});return res.end(payload.data)}
        }
      }else if(data.subarray(0,4).equals(Buffer.from('OggS','ascii'))){
        const payload={type:'audio/ogg',data};decryptedCacheSet(cacheKey,payload);res.writeHead(200,{'Content-Type':payload.type,'Content-Length':payload.data.length,'Cache-Control':'public, max-age=86400'});return res.end(payload.data)
      }
    }
  }
  return null;
}
async function serveSteamworksCompat(req,res,gameRoot,loadSession) {
  const relative='/js/plugins/NekoGakuen_SteamworksAPI.js',file=path.join(gameRoot,...relative.slice(1).split('/')),source=await fsp.readFile(file,'utf8').catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  const signature=/process\.env\.USERNAME/.test(source)&&/SceneManager\.initialize\s*=\s*function/.test(source);
  if(!signature)return serveCompatBuffer(req,res,Buffer.from(source),'text/javascript; charset=utf-8',relative,loadSession);
  // mist: Steam API 插件在 SceneManager.initialize 里裸读 process.env.USERNAME（nw.js 专属，8 处）。
  // 浏览器无 process → ReferenceError 卡死启动（SimpleVoice 二次异常只是表象）。
  // 注入 process 兜底（env 空 → 所有 steamuser 判断 false，Steam 全屏/暂停逻辑跳过）；
  // SteamworksAPIManager.initialize 有 typeof require 保护（浏览器安全跳过），其余 Steam 函数
  // 都有 isSteamClientRun() 前置（greenworksCore 未定义 → false），无需其他改动。
  // 同时强制 Utils.isNwjs()=false，避免注入的 process 让引擎误判为 NW.js 走桌面包代码崩溃。
  let output=source;
  // 第二坑：SceneManager.checkSteamRunning 每帧被 updateMain 调用，isSteamClientRun()=false 时
  // 进入裸 require('electron'/'nw.gui') 分支 → ReferenceError；且会 SceneManager.exit() 退出游戏。
  // 浏览器环境无 Steam 检测意义 → 函数体替换为 no-op（保留声明，避免插件后续引用缺失）。
  const checkRe=/SceneManager\.checkSteamRunning = function \(\) \{[\s\S]*?\n        \};/g;
  if(checkRe.test(output)){
    // 插件内 checkSteamRunning 可能定义 2 次（作者复制），必须全部替换，否则第二个仍裸 require
    output=output.replace(checkRe,`SceneManager.checkSteamRunning = function () {\n            // mist: 浏览器环境跳过 Steam 运行检测（桌面端会 require electron/nw.gui 并退出游戏）\n        };`);
  }
  const shim=`\n;(() => {\n  if(globalThis.__mistSteamworksShim)return;globalThis.__mistSteamworksShim=true;\n  if(!globalThis.process)globalThis.process={\n    mainModule:{filename:'Game.exe'},argv:['Game.exe'],versions:{},platform:'win32',\n    env:{},cwd:()=>'',on:()=>{},once:()=>{},exit:()=>{}\n  };\n  if(typeof Utils!=='undefined'&&!Utils.__mistIsNwjsPatched){try{Utils.isNwjs=function(){return false};Utils.__mistIsNwjsPatched=true}catch{}}\n})();\n`;
  return serveCompatBuffer(req,res,Buffer.from(shim+output),'text/javascript; charset=utf-8',relative,loadSession);
}
async function serveTorigoyaAchievementCompat(req,res,gameRoot,loadSession) {
  const relative='/js/plugins/Torigoya_Achievement2.js',file=path.join(gameRoot,...relative.slice(1).split('/')),source=await fsp.readFile(file,'utf8').catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  const signature=/pickJsonValueFromParameter\s*=\s*function/.test(source)&&/JsonEx\.parse/.test(source)&&/pickStructAchievement/.test(source);
  if(!signature)return serveCompatBuffer(req,res,Buffer.from(source),'text/javascript; charset=utf-8',relative,loadSession);
  // mist: 游戏作者在 baseAchievementData 参数的 description 字段里写了真实换行（未转义），
  // JSON.parse/JsonEx.parse 直接崩 "Bad control character in string literal" → 成就系统加载失败。
  // 响应层把 pickJsonValueFromParameter 的 JsonEx.parse 前置换行转义（\n → \\n、\r 移除）。
  const patched=source
    .replace(/return JsonEx\.parse\(parameter\[key\]\);/, `return JsonEx.parse(String(parameter[key]).replace(/\\r/g, '').replace(/\\n/g, '\\\\n'));`)
    .replace(/if \(typeof parameter === 'string'\) parameter = JSON\.parse\(parameter\);/, `if (typeof parameter === 'string') parameter = JSON.parse(parameter.replace(/\\r/g, '').replace(/\\n/g, '\\\\n'));`)
    .replace(/if \(typeof parameters === 'string'\) parameters = JSON\.parse\(parameters\);/, `if (typeof parameters === 'string') parameters = JSON.parse(parameters.replace(/\\r/g, '').replace(/\\n/g, '\\\\n'));`);
  return serveCompatBuffer(req,res,Buffer.from(patched),'text/javascript; charset=utf-8',relative,loadSession);
}
async function serveNupuManagersCompat(req,res,gameRoot,gameId) {
  const relative='/js/rpg_managers.js',file=path.join(gameRoot,...relative.slice(1).split('/')),source=await fsp.readFile(file,'utf8').catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  const signature=/LngMode\s*=\s*["']jp["']/.test(source)&&/var fs = require\(['"]fs['"]\)/.test(source)&&/readFileSync\(["']lng\.txt["']/.test(source);
  if(!signature)return serveCompatBuffer(req,res,Buffer.from(source),'text/javascript; charset=utf-8',relative,null);
  // mist: nupu 汉化组修改版 rpg_managers.js 在文件顶层（DataManager 定义前）裸 require('fs') 读 lng.txt
  // （语言文件，根目录），浏览器无 Node → ReferenceError 黑屏。后续 StorageManager 本地存档方法
  // （642-794 行）也在 isLocalMode() 分支内 require('fs')——shim 强制 Utils.isNwjs=false 后不执行。
  // 注入 fs/path/process shim：readFileSync('lng.txt') 走 HTTP 拉真实文件（失败回退 'cn'），其余空实现。
  const gameBase=path.posix.join('/games',gameId||'', '').replace(/\/$/,'');
  const shim=`\n;(() => {\n  if(globalThis.__mistNupuLngShim)return;globalThis.__mistNupuLngShim=true;\n  const base=${JSON.stringify(gameBase)};\n  const syncFetch=url=>{try{const xhr=new XMLHttpRequest();xhr.open('GET',url,false);xhr.send(null);if(xhr.status>=400)throw new Error('HTTP '+xhr.status);return xhr.responseText}catch(e){throw e}};\n  const baseRequire=globalThis.require;\n  const baseFs=(()=>{try{return baseRequire?baseRequire('fs'):null}catch(e){return null}})();\n  const fsShim=Object.assign({},baseFs||{},{    readFileSync:(p,opt)=>{const s=String(p);if(/lng\\.txt/i.test(s)){try{return syncFetch(base+'/lng.txt').trim()}catch{return 'cn'}}return (baseFs&&typeof baseFs.readFileSync==='function')?baseFs.readFileSync(p,opt)||'':''},\n    existsSync:()=>false,readdirSync:()=>[],mkdirSync:()=>{},writeFileSync:()=>{},unlinkSync:()=>{},statSync:()=>({isFile:()=>true,isDirectory:()=>false})\n  });\n  const pathShim={\n    dirname:p=>{const s=String(p).replace(/\\\\\\\\/g,'/'),i=s.lastIndexOf('/');return i<=0?'/':s.slice(0,i)},\n    join:(...a)=>a.join('/').replace(/\\\\\\\\/g,'/').replace(/\\/+\\//g,'/'),\n    basename:p=>{const s=String(p).replace(/\\\\\\\\/g,'/');return s.slice(s.lastIndexOf('/')+1)},\n    extname:p=>{const b=pathShim.basename(p),i=b.lastIndexOf('.');return i>=0?b.slice(i):''},\n    resolve:(...a)=>a.join('/').replace(/\\\\\\\\/g,'/')\n  };\n  globalThis.require=function(id){if(id==='fs')return fsShim;if(id==='path')return pathShim;if(/greenworks/i.test(id))return{initAPI:()=>false,isSteamRunning:()=>false};if(id==='nw.gui')return {};if(baseRequire)return baseRequire(id);throw new Error('require('+id+') is not available in the browser')};\n  if(!globalThis.process)globalThis.process={mainModule:{filename:${JSON.stringify(gameBase)}+'/Game.exe'},argv:[],versions:{},platform:'win32',env:{},cwd:()=>'',on:()=>{},once:()=>{},exit:()=>{}};\n  if(typeof Utils!=='undefined'&&!Utils.__mistIsNwjsPatched){try{Utils.isNwjs=function(){return false};Utils.__mistIsNwjsPatched=true}catch{}}\n})();\n`;
  return serveCompatBuffer(req,res,Buffer.from(shim+source+pluginLoaderCompat()),'text/javascript; charset=utf-8',relative,null);
}
async function serveWataridoriCompat(req,res,gameRoot,loadSession) {
  const relative='/js/plugins/Wataridori_AddFileSystem.js',file=path.join(gameRoot,...relative.slice(1).split('/')),source=await fsp.readFile(file,'utf8').catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  const signature=/checkAddCommandEnable\s*=\s*function/.test(source)&&/require\s*\(\s*["']path["']\s*\)/.test(source)&&/process\.mainModule\.filename/.test(source)&&/p_name_folder/.test(source);
  if(!signature)return serveCompatBuffer(req,res,Buffer.from(source),'text/javascript; charset=utf-8',relative,loadSession);
  // mist: 渡鸟追加文件系统插件（patch 补丁按钮）在 Scene_Title.createCommandWindow → checkAddCommandEnable
  // 里裸 require('path')/require('fs')/process.mainModule.filename 检查游戏根 patch/ 文件夹。
  // 浏览器无 Node → ReferenceError → 标题命令窗口创建失败 → sceneStopped=true 卡死。
  // 注入 fs/path/process shim：existsSync 恒 false（本游戏无 patch 文件夹 → "APPLY PATCH" 按钮隐藏），
  // readdirSync 返回 []，getTextPath 等路径逻辑安全短路；同时 Utils.isNwjs=()=>false 防误判。
  const gameBase=path.posix.join('/games',loadSession?.gameId||'', '').replace(/\/$/,'');
  const shim=`\n;(() => {\n  if(globalThis.__mistWataridoriShim)return;globalThis.__mistWataridoriShim=true;\n  const fsShim={existsSync:()=>false,readdirSync:()=>[],readFileSync:()=>'',writeFileSync:()=>{},mkdirSync:()=>{},statSync:()=>({isFile:()=>true,isDirectory:()=>false})};\n  const pathShim={\n    dirname:p=>{const s=String(p).replace(/\\\\\\\\/g,'/'),i=s.lastIndexOf('/');return i<=0?'/':s.slice(0,i)},\n    join:(...a)=>a.join('/').replace(/\\\\\\\\/g,'/').replace(/\\/+\\//g,'/'),\n    basename:p=>{const s=String(p).replace(/\\\\\\\\/g,'/');return s.slice(s.lastIndexOf('/')+1)},\n    extname:p=>{const b=pathShim.basename(p),i=b.lastIndexOf('.');return i>=0?b.slice(i):''},\n    resolve:(...a)=>a.join('/').replace(/\\\\\\\\/g,'/')\n  };\n  if(!globalThis.require)globalThis.require=function(id){if(id==='fs')return fsShim;if(id==='path')return pathShim;if(id==='nw.gui')return {};throw new Error('require('+id+') is not available in the browser')};\n  if(!globalThis.process)globalThis.process={mainModule:{filename:${JSON.stringify(gameBase)}+'/Game.exe'},argv:[],versions:{},platform:'win32',env:{},cwd:()=>'',on:()=>{},once:()=>{},exit:()=>{}};\n  if(typeof Utils!=='undefined'&&!Utils.__mistIsNwjsPatched){try{Utils.isNwjs=function(){return false};Utils.__mistIsNwjsPatched=true}catch{}}\n})();\n`;
  return serveCompatBuffer(req,res,Buffer.from(shim+source),'text/javascript; charset=utf-8',relative,loadSession);
}
async function serveFlowerCoreCompat(req,res,gameRoot,loadSession) {
  const relative='/js/plugins/FlowerCore.js',file=path.join(gameRoot,...relative.slice(1).split('/')),source=await fsp.readFile(file,'utf8').catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  const signature=/FlowerCore\.loadAllCsv\s*=\s*function/.test(source)&&/require\s*\(\s*["']fs["']\s*\)/.test(source)&&/getTextPath/.test(source)&&/process\.mainModule\.filename/.test(source);
  if(!signature)return serveCompatBuffer(req,res,Buffer.from(source),'text/javascript; charset=utf-8',relative,loadSession);
  // mist: FlowerCore 在插件加载阶段（IIFE 末尾 loadAllCsv()）裸 require('fs')+require('path')+process.mainModule
  // 读游戏根 text/*.csv（nw.js 专属）→ 浏览器 ReferenceError 黑屏（数据库都未加载）。
  // 注入 fs/path shim：readdir 返回 text/ 下已知 CSV 列表（HTTP 探测），readFile 用同步 XHR 拉真实文件；
  // process.mainModule.filename 指向游戏根，getTextPath → 根/text。SMB 零改动。
  const gameBase=path.posix.join('/games',loadSession?.gameId||'', '').replace(/\/$/,'');
  const shim=`\n;(() => {\n  if(globalThis.__mistFlowerCoreShim)return;globalThis.__mistFlowerCoreShim=true;\n  const base=${JSON.stringify(gameBase)};\n  const syncFetch=url=>{try{const xhr=new XMLHttpRequest();xhr.open('GET',url,false);xhr.send(null);if(xhr.status>=400)throw new Error('HTTP '+xhr.status);return xhr.responseText}catch(e){throw e}};\n  const fsShim={\n    readdir:(dir,cb)=>{try{const list=JSON.parse(syncFetch('/api/flower-text-list/'+base.split('/games/')[1])).filter(n=>n.endsWith('.csv'));cb(null,list)}catch(e){cb(e)}},\n    readFile:(p,enc,cb)=>{if(typeof enc==='function'){cb=enc;enc='utf8'}try{const url=String(p).replace(/\\\\\\\\/g,'/').replace(/^.*?\\/text\\//,base+'/text/');cb(null,syncFetch(url))}catch(e){cb(e)}},\n    readFileSync:(p,enc)=>{const url=String(p).replace(/\\\\\\\\/g,'/').replace(/^.*?\\/text\\//,base+'/text/');return syncFetch(url)},\n    existsSync:()=>true,statSync:()=>({isFile:()=>true,isDirectory:()=>false}),writeFileSync:()=>{},mkdirSync:()=>{}\n  };\n  const pathShim={\n    dirname:p=>{const s=String(p).replace(/\\\\\\\\/g,'/'),i=s.lastIndexOf('/');return i<=0?'/':s.slice(0,i)},\n    join:(...a)=>a.join('/').replace(/\\\\\\\\/g,'/').replace(/\\/+\\//g,'/'),\n    basename:p=>{const s=String(p).replace(/\\\\\\\\/g,'/');return s.slice(s.lastIndexOf('/')+1)},\n    extname:p=>{const b=pathShim.basename(p),i=b.lastIndexOf('.');return i>=0?b.slice(i):''},\n    resolve:(...a)=>a.join('/').replace(/\\\\\\\\/g,'/')\n  };\n  if(!globalThis.require)globalThis.require=function(id){if(id==='fs')return fsShim;if(id==='path')return pathShim;if(id==='nw.gui')return {};throw new Error('require('+id+') is not available in the browser')};\n  if(!globalThis.process)globalThis.process={mainModule:{filename:${JSON.stringify(gameBase)}+'/Game.exe'},argv:[],versions:{},platform:'win32',env:{},cwd:()=>'',on:()=>{},once:()=>{},exit:()=>{}};\n  if(typeof Utils!=='undefined'&&!Utils.__mistIsNwjsPatched){try{Utils.isNwjs=function(){return false};Utils.__mistIsNwjsPatched=true}catch{}}\n})();\n`;
  return serveCompatBuffer(req,res,Buffer.from(shim+source),'text/javascript; charset=utf-8',relative,loadSession);
}
async function serveStwvAllDataFlagCompat(req,res,gameRoot,loadSession) {
  const relative='/js/plugins/stwv_allDataFlag.js',file=path.join(gameRoot,...relative.slice(1).split('/')),source=await fsp.readFile(file,'utf8').catch(()=>null);
  if(source===null)return text(res,404,'文件不存在');
  const signature=/checkAllDataFlag/.test(source)&&/require\s*\(\s*["']fs["']\s*\)/.test(source)&&/emeraldallopen\.flag/.test(source)&&/Scene_Boot\.prototype\.start/.test(source);
  if(!signature)return serveCompatBuffer(req,res,Buffer.from(source),'text/javascript; charset=utf-8',relative,loadSession);
  // mist: 插件在 Scene_Boot.start 时 require('fs') 检查本地 emeraldallopen.flag（全开放作弊开关）。
  // 该游戏 rmmz_managers.js 被作者改为无条件 require('path')+process.mainModule（原版 MZ 有 isNwjs 分支），
  // 浏览器无 Node → 注入 require shim（existsSync 恒 false = 正常游戏行为），
  // 并把 fileDirectoryPath 还原为原版浏览器行为（"save/"），保证存档系统与全开放检查都不崩溃。
  const shim=`\n;(() => {if(globalThis.__mistStwvFlagShim)return;globalThis.__mistStwvFlagShim=true;if(!globalThis.require){globalThis.require=function(id){if(id==='fs')return{existsSync:()=>false,readFileSync:()=>''};return{}};}if(typeof StorageManager!=='undefined'&&!StorageManager.__mistFileDirPatched){StorageManager.__mistFileDirPatched=true;try{StorageManager.fileDirectoryPath=function(){return 'save/';}}catch{}}})();\n`;
  return serveCompatBuffer(req,res,Buffer.from(shim+source),'text/javascript; charset=utf-8',relative,loadSession)
}
async function serveAyatamCompat(req,res,gameRoot,baseRoot,loadSession) {
  const relative='/js/plugins/Ayatam_AdvancedCharacterGraphics.js',file=path.join(gameRoot,...relative.slice(1).split('/')),source=await fsp.readFile(file,'utf8').catch(()=>null);if(source===null)return text(res,404,'文件不存在');
  const signature=/Ayatam\.ACG\.getImgPath/.test(source)&&/Ayatam\.ACG\.makeFileLists/.test(source)&&/Ayatam\.ACG\.loadImgFile/.test(source)&&/require\s*\(\s*['"]path['"]\s*\)/.test(source)&&/require\s*\(\s*['"]fs['"]\s*\)/.test(source);
  if(!signature)return serveCompatBuffer(req,res,Buffer.from(source),'text/javascript; charset=utf-8',relative,loadSession);
  const files=await characterImageNames(baseRoot,gameRoot===baseRoot?null:gameRoot),safe=source.replace(/require\s*\(\s*['"](?:path|fs)['"]\s*\)/g,'null/* mist browser compatibility */').replace(/require\s*\(\s*['"]nw\.gui['"]\s*\)\.Window\.get\(\)\.showDevTools\(\)/g,"globalThis.nw?.Window?.get?.()?.showDevTools?.()");
  const bridge=`\n;(() => {const files=${JSON.stringify(files)};globalThis.__mistAyatamCharacterFiles=files;if(!globalThis.Ayatam?.ACG)return;Ayatam.ACG.getImgPath=()=>'';Ayatam.ACG.makeFileLists=function(){this._loadedCharacters??=[];for(const name of files){ImageManager.loadCharacter(name);if(!this._loadedCharacters.includes(name))this._loadedCharacters.push(name)}};Ayatam.ACG.loadImgFile=function(){this._loadedCharacters=[];this.makeFileLists()};})();\n`;
  return serveCompatBuffer(req,res,Buffer.from(safe+bridge),'text/javascript; charset=utf-8',relative,loadSession)
}
function serveCommonEventsBuffer(req,res,source,loadSession) {
  const output=Buffer.isBuffer(source)?source:Buffer.from(source),tracker=trackLoadStream(req,res,loadSession,'/data/CommonEvents.json',output.length);res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Length':output.length,'Cache-Control':'no-store'});tracker.chunk(output.length);res.end(output)
}
async function serveCommonEventsCompat(req,res,gameRoot,loadSession) {
  const file=path.join(gameRoot,'data','CommonEvents.json'),source=await fsp.readFile(file).catch(()=>null);if(source===null)return text(res,404,'文件不存在');
  let data;try{data=JSON.parse(source.toString('utf8').replace(/^\uFEFF/,''))}catch{return serveCommonEventsBuffer(req,res,source,loadSession)}
  if(!Array.isArray(data))return serveCommonEventsBuffer(req,res,source,loadSession);
  for(const event of data){if(!event?.list?.length)continue;const commands=event.list.filter(x=>x.code!==0),onlyScript=commands.every(x=>x.code===355||x.code===655),script=commands.map(x=>x.parameters?.[0]||'').join('\n');if(onlyScript&&/require\s*\(\s*["']fs["']\s*\)/.test(script)&&/(?:Telegram@hyckzz|VGVsZWdyYW1AaHlja3p6)/.test(script)&&/existsSync/.test(script)&&/openSync/.test(script))event.list=[{code:0,indent:0,parameters:[]}]}
  return serveCommonEventsBuffer(req,res,Buffer.from(JSON.stringify(data)),loadSession)
}
function reportedGameCompat(gameId,flags) {
  const {preloadHeavy,menuReadyBypass,mobileEncryptedAudio,splashFallback,chineseWrap}=flags;
  if(!preloadHeavy&&!menuReadyBypass&&!mobileEncryptedAudio&&!splashFallback&&!chineseWrap)return '';
  return `\n;(() => {\n  const id=${JSON.stringify(gameId)},isCoarse=()=>!!globalThis.matchMedia?.('(pointer: coarse)')?.matches;\n  const install=()=>{\n    if(${menuReadyBypass}&&typeof Scene_Menu!=='undefined'){Scene_Menu.prototype.isReady=function(){const ready=EffectManager.isReady()&&FontManager.isReady();if(ready&&!this.__mistReadyLogged){this.__mistReadyLogged=true;console.info('[雾灯兼容] 菜单不等待全局图片缓存')}return ready}}\n    if(${mobileEncryptedAudio}&&typeof AudioManager!=='undefined'){const originalExt=AudioManager.audioFileExt;AudioManager.audioFileExt=function(){if(isCoarse()&&globalThis.WebAudio?.canPlayOgg?.())return '.ogg';return originalExt.apply(this,arguments)};const resume=()=>{try{const context=globalThis.WebAudio?._context;if(context?.state==='suspended')context.resume()}catch{}};const previous=globalThis.__mistUnlockMedia;globalThis.__mistUnlockMedia=()=>{resume();return previous?.()};addEventListener('pointerdown',resume,{passive:true});addEventListener('touchend',resume,{passive:true})}\n    if(${splashFallback}&&typeof Scene_Splash!=='undefined'){const originalUpdate=Scene_Splash.prototype.update;Scene_Splash.prototype.update=function(){originalUpdate.apply(this,arguments);if(!this._started)return;this.__mistFrames=(this.__mistFrames||0)+1;if(this.__mistFrames>300&&globalThis.SceneManager?._scene===this&&!SceneManager._nextScene){console.warn('[雾灯兼容] 启动画面超时，继续进入标题');this.gotoTitle()}}}\n    if(${chineseWrap}&&typeof Window_Base!=='undefined'){Window_Base.prototype.checkWordWrap=function(textState){if(!textState||!this._wordWrap)return false;const ch=textState.text[textState.index];if(!ch||ch==='\\n')return false;return this.textWidth(ch)+textState.x>this.contents.width}}\n  };\n  if(document.readyState==='loading')addEventListener('load',install,{once:true});else install();\n})();\n`;
}
function weakNetworkCompat(gameId,flags) {
  return `\n;(() => {\n  if(window.__mistWeakNetworkRetry)return;window.__mistWeakNetworkRetry=true;${reportedGameCompat(gameId,flags)}\n  const encodeBarePercent=url=>typeof url==='string'?url.replace(/%(?![0-9a-f]{2})/gi,'%25'):url;\n  if(typeof Bitmap!=='undefined'&&Bitmap.prototype._requestImage&&!Bitmap.prototype._requestImage.__mistPercent){const original=Bitmap.prototype._requestImage;const wrapped=function(url){return original.call(this,encodeBarePercent(url))};wrapped.__mistPercent=true;Bitmap.prototype._requestImage=wrapped}\n  if(typeof Decrypter!=='undefined'&&Decrypter.decryptImg&&!Decrypter.decryptImg.__mistPercent){const original=Decrypter.decryptImg;const wrapped=function(url,...args){return original.call(this,encodeBarePercent(url),...args)};wrapped.__mistPercent=true;Decrypter.decryptImg=wrapped}\n  const delays=[1000,2000,3000,5000,8000,12000,15000,20000,30000,45000,60000,60000];\n  if(typeof ResourceHandler!=='undefined')ResourceHandler._defaultRetryInterval=delays;\n  if(typeof Bitmap!=='undefined'&&!Bitmap.prototype.__mistWeakNetworkRetry&&Bitmap.prototype._onError&&Bitmap.prototype.retry){const failed=Bitmap.prototype._onError;Bitmap.prototype._onError=function(){if(this.__mistPermanentFailure)return failed.apply(this,arguments);this.__mistRetryCount=(this.__mistRetryCount||0)+1;if(this.__mistRetryCount<=delays.length){this._loadingState='retrying';setTimeout(()=>this.retry(),delays[this.__mistRetryCount-1]);window.parent?.postMessage({type:'mist-resource-retry',kind:'image',attempt:this.__mistRetryCount},'*')}else failed.apply(this,arguments)};const loaded=Bitmap.prototype._onLoad;if(loaded)Bitmap.prototype._onLoad=function(){this.__mistRetryCount=0;return loaded.apply(this,arguments)};Bitmap.prototype.__mistWeakNetworkRetry=true}\n  if(typeof WebAudio!=='undefined'&&!WebAudio.prototype.__mistWeakNetworkRetry&&WebAudio.prototype._onError&&WebAudio.prototype.retry){const failed=WebAudio.prototype._onError;WebAudio.prototype._onError=function(){this.__mistRetryCount=(this.__mistRetryCount||0)+1;if(this.__mistRetryCount<=delays.length){setTimeout(()=>this.retry(),delays[this.__mistRetryCount-1]);window.parent?.postMessage({type:'mist-resource-retry',kind:'audio',attempt:this.__mistRetryCount},'*')}else failed.apply(this,arguments)};WebAudio.prototype.__mistWeakNetworkRetry=true}\n  let sent=false;const ready=()=>{if(sent||typeof SceneManager==='undefined')return;const scene=SceneManager._scene,name=scene?.constructor?.name,isStandard=(typeof Scene_Title!=='undefined'&&scene instanceof Scene_Title)||(typeof Scene_Map!=='undefined'&&scene instanceof Scene_Map)||(typeof Scene_Battle!=='undefined'&&scene instanceof Scene_Battle);const transitional=/^(Scene_Boot|Scene_Loading|Scene_Splash|Scene_SplashScreen|Scene_Error|Scene_Gameover|Scene_Test)$/;if(scene&&typeof scene.isReady==='function'&&scene.isReady()&&(isStandard||(!transitional.test(name)&&name!=='undefined'&&name!=='null'&&!name.includes('Splash')&&!name.includes('Loading')))){sent=true;window.parent?.postMessage({type:'mist-game-ready',scene:name},'*');const token=new URLSearchParams(location.search).get('load');if(token)fetch('/api/load-sessions/'+token,{method:'POST'}).catch(()=>{})}};setInterval(ready,500);\n})();\n`;
}
function nwjsGlobalShimCompat(apply) {
  // mist: マグノリアの鎧姫 (d503ac6f) 等 NW.js 打包 MV 游戏：多个插件顶层裸用 Node API →
  // DRS_BoostEngineMV.js: const e=require("fs"),n=require("path")（writeFileSync/unlinkSync/join/cwd/nw.Window）
  // SRD_SuperToolsEngine.js: process.versions['node-webkit']（顶层执行）→ ReferenceError →
  // SRD_HUDMaker.js 连锁崩（依赖 SuperToolsEngine 初始化对象 push undefined）。
  // 终末的死斗场 (cdd9510d)：JsScript22Set 等插件 require('fs') 且事件脚本（new Function）调用
  // fs.openSync → 浏览器无 → 左上角报错；fsShim 补 openSync/closeSync/appendFileSync 等。
  // 注入全局 require/process/nw shim（rpg_core.js 最先加载，全局生效）；Utils.isNwjs 强制 false
  // （否则 process shim 会让 isNwjs 误判 true 走 NW.js 分支）。
  if(!apply)return '';
  return `\n;(() => {
  if(globalThis.__mistNwjsGlobalShim)return;globalThis.__mistNwjsGlobalShim=true;
  const fsShim={readFileSync:()=>'',writeFileSync:()=>{},unlinkSync:()=>{},existsSync:()=>false,readdirSync:()=>[],mkdirSync:()=>{},statSync:()=>({isFile:()=>true,isDirectory:()=>false}),readFile:(p,cb)=>cb&&cb(null,''),writeFile:(p,d,cb)=>cb&&cb(null),openSync:()=>1,closeSync:()=>{},appendFileSync:()=>{},open:(p,f,cb)=>cb&&cb(null,1),close:(fd,cb)=>cb&&cb(null),appendFile:(p,d,cb)=>cb&&cb(null),readSync:()=>0,writeSync:()=>0,read:(fd,b,o,l,p,cb)=>cb&&cb(null,0),write:(fd,b,o,l,p,cb)=>cb&&cb(null,0)};
  const pathShim={join:(...a)=>a.join('/').replace(/\\\\/g,'/'),dirname:p=>{const s=String(p).replace(/\\\\/g,'/'),i=s.lastIndexOf('/');return i<=0?'/':s.slice(0,i)},basename:p=>{const s=String(p).replace(/\\\\/g,'/');return s.slice(s.lastIndexOf('/')+1)},resolve:(...a)=>a.join('/'),extname:p=>{const s=String(p),i=s.lastIndexOf('.');return i>=0?s.slice(i):''}};
  if(!globalThis.require)globalThis.require=function(id){if(id==='fs')return fsShim;if(id==='path')return pathShim;if(/greenworks/i.test(id))return{initAPI:()=>false,isSteamRunning:()=>false};if(id==='nw.gui')return{};throw new Error('require('+id+') is not available in the browser')};
  if(!globalThis.process)globalThis.process={versions:{},mainModule:{filename:'Game.exe'},argv:[],env:{},platform:'win32',cwd:()=>'',on:()=>{},once:()=>{},exit:()=>{}};
  if(!globalThis.nw)globalThis.nw={App:{argv:[],quit:()=>{},on:()=>{}},Window:{open:()=>({width:0,height:0,on:()=>{},close:()=>{},window:{addEventListener:()=>{},removeEventListener:()=>{}}}),get:()=>({window:{addEventListener:()=>{},removeEventListener:()=>{}}})}};
  if(typeof Utils!=='undefined'&&!Utils.__mistIsNwjsPatched){try{Utils.isNwjs=function(){return false};Utils.__mistIsNwjsPatched=true}catch{}}
})();
`;
}
function encryptedImageHttpCompat(source) {
  // mist: pattern 匹配原版 MV 结构（requestFile.onload → if(status<xhrOk) → error listener → `}` 直接 `};`）。
  // 修改版游戏（如 ヤリステメスブター）在 if 块后自带 else Fallback（`} else { ... }`），非贪婪 [\s\S]*? 会
  // 跨过 else 块匹配到函数尾 `};`，$1 已含 `} else {` 再插入一个 → 双 else 语法错误黑屏。
  // 修复：$1 内含 `} else` 视为修改版（自带回退逻辑，无需注入），直接返回原文件。
  const pattern=/(requestFile\.onload\s*=\s*function\s*\(\s*\)\s*\{\s*if\s*\(\s*this\.status\s*<\s*Decrypter\._xhrOk\s*\)\s*\{[\s\S]*?bitmap\._image\.addEventListener\s*\(\s*['"]error['"][\s\S]*?Bitmap\.prototype\._onError\.bind\s*\(\s*bitmap\s*\)\s*\)\s*;?\s*)(\}\s*\};)/;
  if(!pattern.test(source))return source;
  const match=source.match(pattern);
  if(match[1].includes('} else'))return source;
  return source.replace(pattern,"$1} else {\n            bitmap.__mistPermanentFailure = true;\n            bitmap._onError();\n        $2")
}
function fossilStretchCompat(apply) {
  // FOSSIL (MV→MZ) 游戏：游戏目录无 rmmz_parameters.js，MZ 的 screenAutoScale 参数不存在，
  // FOSSIL 改版 rmmz_core.js 的 Graphics._defaultStretchMode() 固定返回 Utils.isNwjs()||Utils.isMobileDevice()，
  // 桌面浏览器 → false → _stretchEnabled=false → _realScale=1 → 大分辨率画布按原始尺寸铺开，超出视口产生滚动条/裁剪。
  // 覆盖为始终 true：_updateRealScale 用 min(窗口/画布) 保持纵横比缩放，_centerElement 居中——符合"原比例清晰缩放"。
  if(!apply)return '';
  return `\n;(() => { if(window.__mistFossilStretch)return; window.__mistFossilStretch=true;\n  if(typeof Graphics!=='undefined'){ Graphics._defaultStretchMode=function(){return true}; const apply=()=>{ try{ if(Graphics._stretchEnabled!==true)Graphics._stretchEnabled=true; Graphics._updateAllElements(); }catch(e){} }; if(Graphics._canvas){ apply() } else { const mo=new MutationObserver(()=>{ if(Graphics._canvas){ apply(); mo.disconnect() } }); mo.observe(document.body||document.documentElement,{childList:true,subtree:true}); } } })();\n`;
}
async function serveCoreWithCompat(req,res,gameRoot,fileName,loadSession,gameId) {
  const file=path.join(gameRoot,'js',fileName),source=await fsp.readFile(file).catch(()=>null);if(source===null)return text(res,404,'文件不存在');
  const game=games.find(g=>g.id===gameId);
  const [reportedFlags,fossil,hiroka,eli,itanki,nwjs]=await Promise.all([
    (async()=>{const [preloadHeavy,menuReadyBypass,mobileEncryptedAudio,splashFallback,chineseWrap]=await Promise.all([compatMatches(game,'standingPicture'),compatMatches(game,'standingPicture'),compatMatches(game,'mobileAudio'),compatMatches(game,'splashFallback'),compatMatches(game,'chineseWrap')]);return{preloadHeavy,menuReadyBypass,mobileEncryptedAudio,splashFallback,chineseWrap}})(),
    compatMatches(game,'fossil'),compatMatches(game,'hiroka'),compatMatches(game,'eli'),compatMatches(game,'itanki'),compatMatches(game,'nwjsShim')]);
  const output=Buffer.concat([Buffer.from(encryptedImageHttpCompat(source.toString('utf8'))),Buffer.from(weakNetworkCompat(gameId,reportedFlags)),Buffer.from(fossilStretchCompat(fossil)),Buffer.from(hirokaEncryptedUrlCompat(hiroka)),Buffer.from(eliDecryptCompat(eli)),Buffer.from(itankiLocaleCompat(itanki)),Buffer.from(nwjsGlobalShimCompat(nwjs)),Buffer.from(legacyStringPolyfillCompat())]),headers={'Content-Type':'text/javascript; charset=utf-8','Content-Length':output.length,'Cache-Control':'no-store'},tracker=trackLoadStream(req,res,loadSession,'/js/'+fileName,output.length);res.writeHead(200,headers);tracker.chunk(output.length);res.end(output);
}
function eliDecryptCompat(apply) {
  // mist: エリィは村の共有妻 (11a147e1) 存档界面背景图 img/pictures.png_ 的兼容：
  // 服务器对不存在图片返回 RPGMV 加密格式的透明 PNG（serveEliPictureCompat），引擎正常解密显示。
  // 但早期版本曾返回明文透明 PNG（max-age=86400），浏览器磁盘缓存了明文 → decryptArrayBuffer
  // 抛 Decryption error。注入 _onXhrLoad 容错：解密失败（响应实为明文/缓存明文）时直接 Blob 显示，
  // 对任何缓存状态免疫。
  if(!apply)return '';
  return `\n;(() => {
  if(globalThis.__mistEliDecrypt)return;globalThis.__mistEliDecrypt=true;
  if(typeof Bitmap!=='undefined'&&Bitmap.prototype._onXhrLoad&&!Bitmap.prototype._onXhrLoad.__mistEliPlain){
    const origX=Bitmap.prototype._onXhrLoad;
    Bitmap.prototype._onXhrLoad=function(xhr){
      try{return origX.apply(this,arguments)}catch(e){
        if(xhr&&xhr.status>=0&&xhr.status<400&&xhr.response){
          try{const blob=new Blob([xhr.response]);this._image.src=URL.createObjectURL(blob);return}catch(e2){}
        }
        this._onError();
      }
    };
    Bitmap.prototype._onXhrLoad.__mistEliPlain=true;
  }
})();
`;
}
function itankiLocaleCompat(apply) {
  // mist: {異端秘律} (0094b0e0) DKTools 本地化：浏览器（非 nwjs）模式下 DKTools.IO.absolutePathExists
  // 恒 false → locales/zh 目录 exists()=false → 走单文件分支尝试加载 locales/zhjson（directoryPath+'json'）
  // → 文件 exists()=false → throwError 崩溃（不发 HTTP 请求，纯响应层无法救）。
  // 注入：只对 locales 索引文件路径（zhjson/zh.json）返回 true，其余保持原逻辑（避免目录分支的
  // stamp 空列表二次崩溃）；服务器对 /locales/zhjson 返回 locales/zh/*.json 合并翻译（serveItankiLocaleCompat）。
  if(!apply)return '';
  return `\n;(() => {
  if(globalThis.__mistItankiLocale)return;globalThis.__mistItankiLocale=true;
  if(typeof DKTools!=='undefined'&&DKTools.IO&&DKTools.IO.absolutePathExists&&!DKTools.IO.absolutePathExists.__mistItanki){
    const origA=DKTools.IO.absolutePathExists;
    DKTools.IO.absolutePathExists=function(path){
      const p=String(path||'');
      if(p.endsWith('zhjson')||p.endsWith('zh.json'))return true;
      return origA.apply(this,arguments);
    };
    DKTools.IO.absolutePathExists.__mistItanki=true;
  }
  if(typeof Utils!=='undefined'&&!Utils.isNwjs.__mistItanki){const origN=Utils.isNwjs;Utils.isNwjs=function(){return false};Utils.isNwjs.__mistItanki=true;void origN}
})();
`;
}
function hirokaEncryptedUrlCompat(apply) {
  // mist: 凍堂ヒロカの隷雄譚 (a449fc1a) 自定义加密引擎：rmmz_scenes.js 在 onDatabaseLoaded 调用
  // Utils.setEncryptionInfo(true,true,key)，Bitmap._startDecrypting 请求 this._url+'_' 后由
  // Utils.decryptArrayBuffer 解密（服务端必须透传加密字节，不能服务端解密——否则二次解密报 Decryption error）。
  // 部分调用链（如标题菜单窗口）传入的 url 已带 '_' 后缀（日志 Bitmap._url=menu_window.png_），
  // _startDecrypting 再拼 '_' → menu_window.png__ → 404 → weakNetworkRetry 无限重试卡标题。
  // 注入①：url 已以 '_' 结尾时不再重复追加（图片 _startDecrypting 与音频 _realUrl 同修）。
  // 注入②：_onXhrLoad 容错——若响应已是明文（历史缓存/服务端解密残留），Utils.decryptArrayBuffer
  // 抛 Decryption error，此时直接 Blob 显示明文，避免无谓崩溃（对 24h 内被旧版缓存污染的客户端友好）。
  // 注入③：强制 hasEncryptedImages/hasEncryptedAudio=false——服务端已解密返回明文（serveHirokaEncryptedCompat
  // 对 .png/.png_/.ogg/.ogg_ 多候选解密），引擎直接走明文加载路径（Bitmap._startLoading 的 else 分支
  // image.src=url、WebAudio 直接 fetch），彻底绕开 url+'_' 拼缀与二次解密，任何缓存状态都能显示。
  if(!apply)return '';
  return `\n;(() => {
  if(globalThis.__mistHirokaEncUrl)return;globalThis.__mistHirokaEncUrl=true;
  if(typeof Utils!=='undefined'){
    const mark=()=>{try{Utils.hasEncryptedImages=function(){return false};Utils.hasEncryptedAudio=function(){return false};Utils._hasEncryptedImages=false;Utils._hasEncryptedAudio=false}catch{}};
    mark();
    if(Utils.setEncryptionInfo&&!Utils.setEncryptionInfo.__mistEncForce){const origS=Utils.setEncryptionInfo;Utils.setEncryptionInfo.__mistEncForce=true;Utils.setEncryptionInfo=function(){origS.apply(this,arguments);mark()}}
  }
  if(typeof Bitmap!=='undefined'&&Bitmap.prototype._startDecrypting&&!Bitmap.prototype._startDecrypting.__mistEncUrl){
    const orig=Bitmap.prototype._startDecrypting;
    Bitmap.prototype._startDecrypting=function(){
      if(String(this._url||'').endsWith('_')){
        const xhr=new XMLHttpRequest();
        xhr.open('GET',this._url);
        xhr.responseType='arraybuffer';
        xhr.onload=()=>this._onXhrLoad(xhr);
        xhr.onerror=this._onError.bind(this);
        xhr.send();
        return;
      }
      return orig.apply(this,arguments);
    };
    Bitmap.prototype._startDecrypting.__mistEncUrl=true;
  }
  if(typeof Bitmap!=='undefined'&&Bitmap.prototype._onXhrLoad&&!Bitmap.prototype._onXhrLoad.__mistEncPlain){
    const origX=Bitmap.prototype._onXhrLoad;
    Bitmap.prototype._onXhrLoad=function(xhr){
      try{return origX.apply(this,arguments)}catch(e){
        if(xhr&&xhr.status>=0&&xhr.status<400&&xhr.response){
          try{const blob=new Blob([xhr.response]);this._image.src=URL.createObjectURL(blob);return}catch(e2){}
        }
        this._onError();
      }
    };
    Bitmap.prototype._onXhrLoad.__mistEncPlain=true;
  }
  if(typeof WebAudio!=='undefined'&&WebAudio.prototype._realUrl&&!WebAudio.prototype._realUrl.__mistEncUrl){
    const orig=WebAudio.prototype._realUrl;
    WebAudio.prototype._realUrl=function(){
      const url=orig.apply(this,arguments);
      return String(url).endsWith('__')?url.slice(0,-1):url;
    };
    WebAudio.prototype._realUrl.__mistEncUrl=true;
  }
})();
`;
}
async function serveFile(req,res,root,pathname,cache='public, max-age=3600',loadSession=null,extraHeaders={},omitAcceptRanges=false) {
  let decoded;
  try { decoded=decodeURIComponent(pathname.replace(/%(?![\da-f]{2})/gi,'%25')); } catch { return text(res,400,'无效路径'); }
  let file=safeJoin(root,decoded); if(!file) return text(res,403,'禁止访问');
  let stat=await fsp.stat(file).catch(()=>null);
  if(stat?.isDirectory()){ file=path.join(file,'index.html'); stat=await fsp.stat(file).catch(()=>null); }
  if(!stat?.isFile()) return text(res,404,'文件不存在');
  const ext=path.extname(file).toLowerCase();
  const headers={'Content-Type':MIME[ext]||'application/octet-stream','Cache-Control':cache,...(omitAcceptRanges?{}:{'Accept-Ranges':'bytes'}),...extraHeaders};
  const range=req.headers.range;
  if(range){
    const match=/bytes=(\d*)-(\d*)/.exec(range);
    if(match){ const start=match[1]?Number(match[1]):0,end=match[2]?Math.min(Number(match[2]),stat.size-1):stat.size-1;
      if(start<=end && start<stat.size){res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${stat.size}`,'Content-Length':end-start+1});const stream=fs.createReadStream(file,{start,end}),tracker=trackLoadStream(req,res,loadSession,decoded,stat.size,start);stream.on('data',chunk=>tracker.chunk(chunk.length));stream.on('error',error=>{tracker.fail();if(!res.destroyed)res.destroy(error)});stream.pipe(res);return;}
    }
    res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}); return res.end();
  }
  res.writeHead(200,{...headers,'Content-Length':stat.size});
  if(req.method==='HEAD') return res.end();
  const stream=fs.createReadStream(file),tracker=trackLoadStream(req,res,loadSession,decoded,stat.size);stream.on('data',chunk=>tracker.chunk(chunk.length));stream.on('error',error=>{tracker.fail();if(!res.destroyed)res.destroy(error)});stream.pipe(res);
}

const requestHandler=async(req,res)=>{
  try{
    const rawPath=String(req.url||'').split('?')[0];if(rawPath.startsWith('/api/rgss/')&&/(?:^|\/)(?:\.\.|%2e%2e)(?:\/|%2f|$)/i.test(rawPath))return text(res,400,'路径无效');
    const url=new URL(req.url,'http://localhost'),p=url.pathname;
    const secureRedirect=buildKrkrHttpsRedirect({encrypted:Boolean(req.socket.encrypted),forwardedProto:req.headers['x-forwarded-proto'],forwardedHost:req.headers['x-forwarded-host']||req.headers.host,trustForwardedHeaders:Boolean(config.proxy?.trustForwardedHeaders),url,httpsConfig:config.https,isKrkrGame:id=>games.some(game=>game.id===id&&game.type==='game'&&game.engine==='krkr2')});
    if(secureRedirect){res.writeHead(307,{Location:secureRedirect,'Cache-Control':'no-store'});return res.end()}
    if(p==='/api/auth/registration'&&req.method==='GET')return json(res,200,{mode:settings.registration.mode});
    if(p==='/api/auth/login'&&req.method==='POST'){const body=await readBody(req),username=String(body.username||'').trim();if(username===authConfig().adminUsername&&passwordValid(body.password))return sendAuth(res,{username,role:'admin'});const account=users.accounts.find(x=>x.usernameKey===usernameKey(username)&&x.status!=='pending');if(!account||!accountPasswordValid(account,body.password))return json(res,401,{error:'账号或密码错误'});return sendAuth(res,{id:account.id,username:account.username,role:'user'})}
    if(p==='/api/auth/register'&&req.method==='POST'){const body=await readBody(req),username=String(body.username||'').trim(),password=String(body.password||'');if(settings.registration.mode==='closed')return json(res,403,{error:'注册已关闭'});if(!/^[\p{L}\p{N}_-]{2,32}$/u.test(username))return json(res,400,{error:'用户名需为 2 到 32 个中文、字母、数字、下划线或短横线'});if(password.length<4||password.length>128)return json(res,400,{error:'密码长度需为 4 到 128 个字符'});const key=usernameKey(username);if(key===usernameKey(authConfig().adminUsername)||users.accounts.some(x=>x.usernameKey===key))return json(res,409,{error:'用户名已存在'});const salt=crypto.randomBytes(16).toString('hex'),account={id:crypto.randomUUID(),username,usernameKey:key,passwordSalt:salt,passwordHash:crypto.scryptSync(password,salt,64).toString('hex'),createdAt:new Date().toISOString()};if(settings.registration.mode==='approval'){account.status='pending';users.accounts.push(account);await saveUsers();return json(res,202,{pending:true,message:'注册申请已提交，请等待管理员审核'})}users.accounts.push(account);await saveUsers();return sendAuth(res,{id:account.id,username,role:'user'},201)}
    if(p==='/api/auth/guest'&&req.method==='POST'){const body=await readBody(req);if(!guestPasswordValid(body.password))return json(res,401,{error:'游客访问密码错误'});return sendAuth(res,{username:'guest',role:'guest'})}
    if(p==='/api/auth/logout'&&req.method==='POST'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Set-Cookie':sessionCookie('',0)});return res.end('{"ok":true}')}
    const user=AUTH_ENABLED?currentUser(req):{username:'test-admin',role:'admin'};
    if(p==='/api/auth/me'){if(!user)return json(res,401,{error:'未登录'});return json(res,200,{user:capabilities(user)})}
    if(!user&&!PUBLIC_PATHS.has(p)){if(p.startsWith('/api/'))return json(res,401,{error:'请先登录'});return redirectLogin(res)}
    if(user&&p==='/login.html')return res.writeHead(302,{Location:'/'}).end();
    let ratingBody=null;
    if(user?.role!=='admin'&&requiresAdmin(req.method,p)){
      const ratingPatch=user?.role==='user'&&req.method==='PATCH'&&/^\/api\/games\/[^/]+$/.test(p);
      if(!ratingPatch)return json(res,403,{error:user?.role==='guest'?'游客只能浏览和游玩，请注册后评分':'普通账号只能浏览、游玩和评分'});
      const body=await readBody(req),keys=body&&typeof body==='object'&&!Array.isArray(body)?Object.keys(body):[];
      if(keys.length!==1||keys[0]!=='rating')return json(res,403,{error:'普通账号只能修改评分'});
      ratingBody=body;
    }
    if(p==='/api/status' && req.method==='GET')return json(res,200,{ok:true,title:config.siteTitle,sourceRoot:config.sourceRoot,recollectionRoot:RECOLLECTION_ROOT,gameCount:games.filter(x=>x.type==='game').length,recollectionCount:games.filter(x=>x.type==='recollection').length,itemCount:games.length,host:config.host,port:config.port,storageMode:'direct'});
    if(p==='/api/load-sessions'&&req.method==='POST'){const body=await readBody(req),game=games.find(g=>g.id===body.gameId&&g.type==='game');if(!game)return json(res,404,{error:'游戏不存在'});return json(res,201,loadSessionView(createLoadSession(game.id)))}
    const loadMatch=p.match(/^\/api\/load-sessions\/([a-f0-9]{36})$/);if(loadMatch){const session=loadSessions.get(loadMatch[1]);if(!session)return json(res,404,{error:'加载会话不存在或已过期'});session.lastSeen=Date.now();if(req.method==='POST')session.ready=true;return json(res,200,loadSessionView(session))}
    if(p==='/api/games' && req.method==='GET')return json(res,200,{games:games.map(game=>gameView(game,user))});
    if(p==='/api/accounts'&&req.method==='GET')return json(res,200,{accounts:users.accounts.filter(x=>x.status!=='pending').map(publicAccount),pendingAccounts:users.accounts.filter(x=>x.status==='pending').map(publicPendingAccount)});
    if(p==='/api/auth/registration'&&req.method==='PATCH'){const body=await readBody(req),mode=String(body.mode||'');if(!['open','approval','closed'].includes(mode))return json(res,400,{error:'注册模式无效'});settings.registration={mode,updatedAt:new Date().toISOString()};await saveSettings();return json(res,200,{mode,updatedAt:settings.registration.updatedAt})}
    if(p==='/api/settings/guest-access'&&req.method==='PATCH'){const body=await readBody(req),password=String(body.password||'');if(password.length<1||password.length>128)return json(res,400,{error:'游客访问密码长度需为 1 到 128 个字符'});const salt=crypto.randomBytes(16).toString('hex');settings.guestAccess={passwordSalt:salt,passwordHash:crypto.scryptSync(password,salt,64).toString('hex'),sessionVersion:settings.guestAccess.sessionVersion+1,updatedAt:new Date().toISOString()};await saveSettings();return json(res,200,{ok:true,updatedAt:settings.guestAccess.updatedAt})}
    let pendingMatch=p.match(/^\/api\/accounts\/([^/]+)\/(approve|reject)$/);if(pendingMatch&&req.method==='POST'){const index=users.accounts.findIndex(x=>x.id===pendingMatch[1]&&x.status==='pending');if(index<0)return json(res,404,{error:'待审核账号不存在'});const account=users.accounts[index];if(pendingMatch[2]==='approve'){delete account.status;account.approvedAt=new Date().toISOString();await saveUsers();return json(res,200,{account:publicAccount(account)})}users.accounts.splice(index,1);await saveUsers();return json(res,200,{rejected:publicPendingAccount(account)})}
    let accountMatch=p.match(/^\/api\/accounts\/([^/]+)$/);if(accountMatch&&req.method==='DELETE'){const index=users.accounts.findIndex(x=>x.id===accountMatch[1]);if(index<0)return json(res,404,{error:'账号不存在'});const [account]=users.accounts.splice(index,1);for(const votes of Object.values(ratings.games))if(votes&&typeof votes==='object')delete votes[account.id];for(const [gameId,list] of Object.entries(comments.games)){comments.games[gameId]=list.filter(x=>x.userId!==account.id).map(x=>({...x,likedBy:(x.likedBy||[]).filter(id=>id!==account.id)}));if(!comments.games[gameId].length)delete comments.games[gameId]}delete favorites.users[account.id];await fsp.rm(path.join(USER_SAVE_DIR,gameSaveUserKey({role:'user',id:account.id})),{recursive:true,force:true});await saveUsers();await saveRatings();await saveComments();await saveFavorites();return json(res,200,{removed:publicAccount(account)})}
    if(p==='/api/browse' && req.method==='GET'){const type=url.searchParams.get('type')==='recollection'?'recollection':'game';return json(res,200,await listDirectory(url.searchParams.get('path')||'',type))}
    if(p==='/api/game-launchers'&&req.method==='GET'){const source=await resolveSource(url.searchParams.get('path')||''),krkr=await detectKrkrProject(source);if(krkr)return json(res,200,{sourcePath:source,engine:krkr.engine,launchers:[],requiresSelection:false});const launchers=await discoverLaunchers(source);return json(res,200,{sourcePath:source,launchers,requiresSelection:launchers.filter(x=>x.browserCompatible).length>1})}
    if(p==='/api/translation-candidates'&&req.method==='GET'){const source=await resolveSource(url.searchParams.get('path')||'');return json(res,200,{sourcePath:source,candidates:await translationCandidates(source)})}
    if(p==='/api/import' && req.method==='POST') return json(res,202,await startImport(await readBody(req)));
    if(p==='/api/import-batch' && req.method==='POST') return json(res,202,await startBatchImport(await readBody(req)));
    if(p==='/api/jobs' && req.method==='GET') return json(res,200,{jobs:[...jobs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,30)});
    let m=p.match(/^\/api\/games\/([^/]+)\/sync$/); if(m && req.method==='POST') return json(res,202,await startSync(m[1]));
    m=p.match(/^\/api\/games\/([^/]+)\/favorite$/);if(m&&(req.method==='PUT'||req.method==='DELETE')){
      const game=games.find(g=>g.id===m[1]);if(!game)return json(res,404,{error:'项目不存在'});const key=memberKey(user);if(key===null)return json(res,403,{error:'请注册并登录后收藏'});
      const list=favorites.users[key]??=[];if(req.method==='PUT'){if(!list.includes(game.id))list.push(game.id);favorites.users[key]=list}else{favorites.users[key]=list.filter(id=>id!==game.id);if(!favorites.users[key].length)delete favorites.users[key]}await saveFavorites();return json(res,200,{favorite:req.method==='PUT'});
    }
    m=p.match(/^\/api\/games\/([^/]+)\/covers$/); if(m && req.method==='GET'){
      const game=games.find(g=>g.id===m[1]); if(!game) return json(res,404,{error:'游戏不存在'});
      return json(res,200,{cover:game.cover,candidates:await findCoverCandidates(await gameRootFor(game))});
    }
    m=p.match(/^\/api\/games\/([^/]+)\/comments$/);if(m){
      const game=games.find(g=>g.id===m[1]);if(!game)return json(res,404,{error:'游戏不存在'});
      if(req.method==='GET')return json(res,200,{comments:(comments.games[m[1]]||[]).map(x=>commentView(x,user))});
      if(req.method==='DELETE'){
        if(user.role==='guest')return json(res,403,{error:'请注册并登录后管理评论'});
        const list=comments.games[m[1]]||[],userId=user.role==='admin'?'admin':user.id,index=list.findIndex(x=>x.userId===userId);if(index<0)return json(res,404,{error:'还没有发表过评论'});list.splice(index,1);if(!list.length)delete comments.games[m[1]];await saveComments();return json(res,200,{ok:true});
      }
      if(req.method==='POST'){
        if(user.role==='guest')return json(res,403,{error:'请注册并登录后评论'});
        const body=await readBody(req),content=String(body.content||'').replace(/\r\n?/g,'\n').trim();if(!content)return json(res,400,{error:'评论内容不能为空'});if(content.length>1000)return json(res,400,{error:'评论最多 1000 字'});
        const list=comments.games[m[1]]??=[],userId=user.role==='admin'?'admin':user.id,existing=list.find(x=>x.userId===userId),now=new Date().toISOString();
        if(existing){existing.content=content;existing.updatedAt=now;await saveComments();return json(res,200,{comment:commentView(existing,user)})}
        const comment={id:crypto.randomUUID(),userId,username:user.username,content,createdAt:now,updatedAt:now,likedBy:[]};list.push(comment);comments.games[m[1]]=list;await saveComments();return json(res,201,{comment:commentView(comment,user)});
      }
    }
    m=p.match(/^\/api\/games\/([^/]+)\/comments\/([^/]+)\/like$/);if(m&&(req.method==='PUT'||req.method==='DELETE')){
      const game=games.find(g=>g.id===m[1]);if(!game)return json(res,404,{error:'游戏不存在'});const key=memberKey(user);if(key===null)return json(res,403,{error:'请注册并登录后点赞'});const comment=(comments.games[m[1]]||[]).find(x=>x.id===m[2]);if(!comment)return json(res,404,{error:'评论不存在'});const likedBy=Array.isArray(comment.likedBy)?comment.likedBy:[];if(req.method==='PUT'){if(!likedBy.includes(key))likedBy.push(key)}else{const index=likedBy.indexOf(key);if(index>=0)likedBy.splice(index,1)}comment.likedBy=likedBy;await saveComments();return json(res,200,{comment:commentView(comment,user)});
    }
    m=p.match(/^\/api\/games\/([^/]+)$/);
    if(m && req.method==='GET'){const game=games.find(g=>g.id===m[1]);return game?json(res,200,{game:gameView(game,user)}):json(res,404,{error:'游戏不存在'})}
    if(m && req.method==='PATCH') return json(res,200,{game:await updateGame(m[1],ratingBody??await readBody(req),user)});
    if(m && req.method==='DELETE') return json(res,200,{removed:await removeGame(m[1])});
    m=p.match(/^\/covers\/([^/]+)$/); if(m){
      const game=games.find(g=>g.id===m[1]); if(!game) return text(res,404,'游戏不存在');
      return await serveCover(req,res,await gameRootFor(game),game.cover||'');
    }
    m=p.match(/^\/cover-preview\/([^/]+)$/); if(m){
      const game=games.find(g=>g.id===m[1]); if(!game) return text(res,404,'游戏不存在');
      return await serveCover(req,res,await gameRootFor(game),url.searchParams.get('path')||'');
    }
    m=p.match(/^\/startup-diagnostics\/([^/]+)\.js$/);if(m){const game=games.find(g=>g.id===m[1]);if(!game)return text(res,404,'游戏不存在');const body=Buffer.from(startupDiagnostics(m[1]));res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store'});return res.end(body)}
    m=p.match(/^\/save-bridge\/([^/]+)\.js$/); if(m){
      const game=games.find(g=>g.id===m[1]); if(!game)return text(res,404,'游戏不存在');
      const body=Buffer.from(saveBridge(m[1]));res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store'});return res.end(body);
    }
    m=p.match(/^\/mv-save-bridge\/([^/]+)\.js$/); if(m){
      const game=games.find(g=>g.id===m[1]);if(!game)return text(res,404,'游戏不存在');
      const body=Buffer.from(mvSaveBridge(m[1]));res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store'});return res.end(body);
    }
    m=p.match(/^\/scenario-text-bridge\/([^/]+)\.js$/); if(m){
      const game=games.find(g=>g.id===m[1]&&g.type==='game');if(!game)return text(res,404,'游戏不存在');
      const body=Buffer.from(scenarioTextBridge(m[1]));res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store'});return res.end(body);
    }
    m=p.match(/^\/scenario-text\/([^/]+)\/(.+)$/); if(m&&req.method==='GET'){
      const game=games.find(g=>g.id===m[1]&&g.type==='game');if(!game)return text(res,404,'游戏不存在');
      let relative;try{relative=decodeURIComponent(m[2])}catch{return text(res,400,'路径无效')}
      const parts=relative.replaceAll('\\','/').split('/'),fileName=parts.pop(),lang=parts.join('/');
      if(parts.length>1||lang&&!/^(?:Ja|En|Ch)$/i.test(lang)||!fileName||fileName==='.'||fileName==='..'||/[\\/:*?"<>|]/.test(fileName)||!/^.+\.(?:txt|sl)$/i.test(fileName))return text(res,400,'场景文件名无效');
      const sourceDir=await resolveSource(game.sourcePath),scenarioRoot=path.join(sourceDir,'scenario'),file=safeJoin(scenarioRoot,'/'+(lang?lang+'/':'')+fileName);if(!file)return text(res,403,'禁止访问');
      const stat=await fsp.stat(file).catch(()=>null);if(!stat?.isFile())return text(res,404,'场景文件不存在');
      res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Length':stat.size,'Cache-Control':'no-store'});return fs.createReadStream(file).pipe(res);
    }
    m=p.match(/^\/translation-bridge\/([^/]+)\.js$/); if(m){
      const game=games.find(g=>g.id===m[1]);if(!game||!game.translation?.enabled)return text(res,404,'翻译不存在');
      const body=Buffer.from(translationBridge(m[1]));res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store'});return res.end(body);
    }
    m=p.match(/^\/api\/game-translation\/([^/]+)$/); if(m&&req.method==='GET'){
      const game=games.find(g=>g.id===m[1]);if(!game)return json(res,404,{error:'游戏不存在'});const data=await translationMap(game);if(!data)return json(res,404,{error:'没有找到有效翻译文件'});return json(res,200,data);
    }
    m=p.match(/^\/api\/flower-text-list\/([^/]+)$/);if(m&&req.method==='GET'){
      const game=games.find(g=>g.id===m[1]);if(!game)return json(res,404,{error:'游戏不存在'});const root=await gameRootFor(game),textDir=path.join(root,'text');const entries=await fsp.readdir(textDir).catch(()=>[]);return json(res,200,entries.filter(n=>n.endsWith('.csv')));
    }
if(p==='/api/mv-prosave-unwrap'&&req.method==='POST'){const raw=await readRawBody(req);const prefix='@@__FMOO_PROSAVE__@@',bodyText=raw.toString('utf8');if(!bodyText.startsWith(prefix))return text(res,400,'不是 ProSave 格式');try{const json=zlib.inflateRawSync(Buffer.from(bodyText.slice(prefix.length),'base64'));res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Length':json.length,'Cache-Control':'no-store'});return res.end(json)}catch(e){return text(res,400,'ProSave 解压失败')}}
    m=p.match(/^\/api\/game-saves\/([^/]+)(?:\/([^/]+))?$/); if(m){
      const game=games.find(g=>g.id===m[1]);if(!game)return json(res,404,{error:'游戏不存在'});const root=await gameRootFor(game),name=m[2]?decodeURIComponent(m[2]):null;
      if(name&&!SAVE_NAME.test(name))return json(res,400,{error:'存档名称无效'});
      if(!name&&req.method==='GET')return json(res,200,await listSaves(root,game.id,user));
      if(name&&req.method==='GET')return await serveSave(req,res,user,root,game.id,name);
      if(name&&req.method==='PUT')return await writeSave(req,res,user,root,game.id,name);
      if(name&&req.method==='DELETE')return await removeSave(res,user,root,game.id,name);
    }
    m=p.match(/^\/api\/rgss\/([^/]+)\/manifest$/);if(m&&req.method==='GET'){
      const game=games.find(g=>g.id===m[1]&&g.type==='game');if(!game)return json(res,404,{error:'游戏不存在'});return json(res,200,await rgssManifest(game));
    }
    m=p.match(/^\/api\/rgss\/([^/]+)\/file\/(game|rtp)\/(.+)$/);if(m&&(req.method==='GET'||req.method==='HEAD')){
      const game=games.find(g=>g.id===m[1]&&g.type==='game');if(!game)return text(res,404,'游戏不存在');let relative;try{relative=decodeURIComponent(m[3])}catch{return text(res,400,'路径无效')}if(relative.includes('\\')||relative.split('/').some(x=>!x||x==='.'||x==='..'))return text(res,400,'路径无效');
      const root=m[2]==='game'?await gameRootFor(game):rgssRtpRoot(game);if(m[2]==='game'&&relative!=='Game.ini'&&!RGSS_GAME_DIRS.has(relative.split('/')[0]))return text(res,403,'禁止访问');return await serveFile(req,res,root,`/${relative}`,'private, max-age=86400');
    }
    m=p.match(/^\/api\/rgss\/([^/]+)\/file\/compat\/(.+)$/);if(m&&(req.method==='GET'||req.method==='HEAD')){
      const game=games.find(g=>g.id===m[1]&&g.type==='game'&&g.engine==='rgss3');if(!game)return text(res,404,'游戏不存在');let relative;try{relative=decodeURIComponent(m[2])}catch{return text(res,400,'路径无效')}if(relative.includes('\\')||relative.split('/').some(x=>!x||x==='.'||x==='..'))return text(res,400,'路径无效');const script=(RGSS_COMPAT_SCRIPTS.get(game.id)||[]).find(x=>x.path===relative);if(!script)return text(res,404,'兼容脚本不存在');const stat=await fsp.stat(script.file).catch(()=>null);if(!stat?.isFile())return text(res,404,'兼容脚本不存在');res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Length':stat.size,'Cache-Control':'no-store','Accept-Ranges':'bytes'});if(req.method==='HEAD')return res.end();return fs.createReadStream(script.file).pipe(res);
    }
    m=p.match(/^\/api\/rgss\/([^/]+)\/saves(?:\/([^/]+))?$/);if(m){
      const game=games.find(g=>g.id===m[1]&&g.type==='game'&&g.engine==='rgss3');if(!game)return json(res,404,{error:'游戏不存在'});const root=await gameRootFor(game),name=m[2]?decodeURIComponent(m[2]):null;if(name&&!RGSS3_SAVE_NAME.test(name))return json(res,400,{error:'VX Ace 存档名称无效'});
      if(!name&&req.method==='GET')return json(res,200,await listRgssSaves(user,root,game.id));if(name&&(req.method==='GET'||req.method==='HEAD'))return await serveRgssSave(req,res,user,root,game.id,name);if(name&&req.method==='PUT')return await writeRgssSave(req,res,user,game.id,name);if(name&&req.method==='DELETE'){await fsp.rm(rgssSaveFile(user,game.id,name),{force:true});return json(res,200,{ok:true,name})}
    }
    m=p.match(/^\/games\/([^/]+)\/js\/plugins\/Drill_GaugeFloatingTemporaryText\.js$/);if(m){
      const game=games.find(g=>g.id===m[1]);if(!game)return text(res,404,'游戏不存在');
      const file=path.join(await gameRootFor(game),'js','plugins','Drill_GaugeFloatingTemporaryText.js'),source=await fsp.readFile(file,'utf8').catch(()=>null);if(source===null)return text(res,404,'文件不存在');
      const output=Buffer.from(drillGfttBufferCompat(await compatMatches(game,'gftt'),source));res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':output.length,'Cache-Control':'no-store'});return res.end(output);
    }
    m=p.match(/^\/games\/([^/]+)\/js\/plugins\/MPP_MessageEX\.js$/);if(m){
      const game=games.find(g=>g.id===m[1]);if(!game)return text(res,404,'游戏不存在');
      const file=path.join(await gameRootFor(game),'js','plugins','MPP_MessageEX.js'),source=await fsp.readFile(file,'utf8').catch(()=>null);if(source===null)return text(res,404,'文件不存在');
      const compat=`\n;(() => {\n  const WindowClass=window.Window_MessageName||(window.MPP&&MPP.Window_MessageName);\n  if(!WindowClass||WindowClass.prototype.__mistColorIndexCompat)return;\n  const initialize=WindowClass.prototype.initialize;\n  WindowClass.prototype.initialize=function(){this._colorIndex=0;return initialize.apply(this,arguments)};\n  WindowClass.prototype.__mistColorIndexCompat=true;\n})();\n`,output=Buffer.from(source+compat);res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':output.length,'Cache-Control':'no-store'});return res.end(output);
    }
    m=p.match(/^\/games\/([^/]+)\/js\/plugins\/RecollectionMode_save_switch_independent_patch\.js$/);if(m){
      const game=games.find(g=>g.id===m[1]);if(!game)return text(res,404,'游戏不存在');
      const file=path.join(await gameRootFor(game),'js','plugins','RecollectionMode_save_switch_independent_patch.js'),source=await fsp.readFile(file,'utf8').catch(()=>null);if(source===null)return text(res,404,'文件不存在');
      const output=Buffer.from(source+'\n;window.__mistMvSaveInstall && window.__mistMvSaveInstall();\n');res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':output.length,'Cache-Control':'no-store'});return res.end(output);
    }
    m=p.match(/^\/games\/([^/]+)\/js\/rmmz_managers\.js$/); if(m){
      const game=games.find(g=>g.id===m[1]);if(!game)return text(res,404,'游戏不存在');
      const file=path.join(await gameRootFor(game),'js','rmmz_managers.js'),source=await fsp.readFile(file,'utf8').catch(()=>null);if(source===null)return text(res,404,'文件不存在');
      const wasm=await fsp.readFile(path.join(await gameRootFor(game),'js','rmmz_core.dat')).catch(()=>null),guarded=mzLocalFileWebNoopCompat(source),compat=protectedMzDatabaseCompat(guarded,wasm),manager=hirokaManagerCompat(await compatMatches(game,'hiroka'),guarded),output=Buffer.from(manager+compat+pluginLoaderCompat()+knsRejectStopGuard(source)+((await compatMatches(game,'xyouRoom'))?cgRoomSwitchFix():'')+'\n;window.__mistSaveInstall && window.__mistSaveInstall();window.__mistTranslationInstall && window.__mistTranslationInstall();\n');res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':output.length,'Cache-Control':'no-store'});return res.end(output);
    }
    m=p.match(/^\/games\/([^/]+)\/js\/rpg_managers\.js$/); if(m){
      const game=games.find(g=>g.id===m[1]);if(!game)return text(res,404,'游戏不存在');
      const file=path.join(await gameRootFor(game),'js','rpg_managers.js'),source=await fsp.readFile(file,'utf8').catch(()=>null);if(source===null)return text(res,404,'文件不存在');
      if(await compatMatches(game,'nupu'))return await serveNupuManagersCompat(req,res,await gameRootFor(game),game.id);
      const guarded=audioNullSaveCompat(source),compat=protectedMvDatabaseCompat(guarded),manager=drillGfttLoaderCompat(await compatMatches(game,'gftt'),guarded),output=Buffer.from(manager+compat+pluginLoaderCompat()+((await compatMatches(game,'fileExistsGuard'))?fileExistsGuardFix(game.id):'')+'\n;window.__mistMvSaveInstall && window.__mistMvSaveInstall();window.__mistTranslationInstall && window.__mistTranslationInstall();\n');res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':output.length,'Cache-Control':'no-store'});return res.end(output);
    }
    m=p.match(/^\/recollections\/([^/]+)(\/.*)?$/);if(m){
      const item=games.find(g=>g.id===m[1]&&g.type==='recollection');if(!item)return text(res,404,'回想网页不存在');
      const sub=m[2]||'/',cache=sub==='/'||sub==='/index.html'||sub==='/manifest.json'?'no-store':'public, max-age=3600';
      return await serveFile(req,res,await gameRootFor(item),sub,cache);
    }
    const krkrIsolation={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin'};
    m=p.match(/^\/api\/krkr\/([^/]+)\/bundled-save\/([^/]+)$/);if(m&&(req.method==='GET'||req.method==='HEAD')){
      const game=games.find(g=>g.id===m[1]&&g.type==='game'&&g.engine==='krkr2'),allowed=KRKR_BUNDLED_SAVE_FILES.get(m[1]),fileName=m[2];
      if(!game||!allowed)return text(res,404,'KRKR 全 CG 存档不存在');
      if(!allowed.has(fileName))return text(res,404,'KRKR 全 CG 存档文件不存在');
      const root=await resolveSource(game.sourcePath),file=path.join(root,'SaveData',fileName),stat=await fsp.stat(file).catch(()=>null);
      if(!stat?.isFile()||stat.size!==allowed.get(fileName))return text(res,409,'KRKR 全 CG 存档校验失败');
      res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-store',...krkrIsolation});
      if(req.method==='HEAD')return res.end();return fs.createReadStream(file).pipe(res);
    }
    m=p.match(/^\/api\/krkr\/([^/]+)\/game\.zip$/);if(m&&(req.method==='GET'||req.method==='HEAD')){
      const game=games.find(g=>g.id===m[1]&&g.type==='game'&&g.engine==='krkr2');if(!game)return text(res,404,'KRKR 游戏不存在');
      Object.entries(krkrIsolation).forEach(([name,value])=>res.setHeader(name,value));
      return await serveKrkrArchive(req,res,await resolveSource(game.sourcePath),game.id,await compatMatches(game,'sumire'));
    }
    m=p.match(/^\/krkr-runtime\/([^/]+)(\/.*)?$/);if(m){
      const game=games.find(g=>g.id===m[1]&&g.type==='game'&&g.engine==='krkr2');if(!game)return text(res,404,'KRKR 游戏不存在');
      const sub=m[2]||'/';
      if(sub==='/' ){res.writeHead(302,{Location:`/krkr-runtime/${game.id}/index.html?game=${encodeURIComponent(`/api/krkr/${game.id}/game.zip`)}&entry=data.xp3&space=${encodeURIComponent(game.id)}`,'Cache-Control':'no-store',...krkrIsolation});return res.end()}
      return await serveFile(req,res,KRKR_RUNTIME_DIR,sub,'no-store',null,krkrIsolation,true);
    }
    m=p.match(/^\/games\/([^/]+)(\/.*)?$/); if(m){
      const game=games.find(g=>g.id===m[1]&&g.type==='game'); if(!game) return text(res,404,'游戏不存在');
      const [drsBoost,nwjs,hiroka,itanki,flowerCore,wataridori,steamworks,externMessage,eli]=await Promise.all([compatMatches(game,'drsBoost'),compatMatches(game,'nwjsShim'),compatMatches(game,'hiroka'),compatMatches(game,'itanki'),compatMatches(game,'flowerCore'),compatMatches(game,'wataridori'),compatMatches(game,'steamworks'),compatMatches(game,'externMessage'),compatMatches(game,'eli')]);
      if(game.engine==='krkr2'){const sub=m[2]||'/';if(sub==='/' ){res.writeHead(302,{Location:`/krkr-runtime/${game.id}/`,'Cache-Control':'no-store'});return res.end()}return text(res,404,'KRKR 资源由浏览器运行时提供')}
      const baseRoot=await gameRootFor(game);let sub=m[2]||'/';try{const dec=decodeURIComponent(sub);if(dec!==sub&&!/[\\]|(^|\/)\.\.(\/|$)/.test(dec))sub=dec}catch{}sub=sub.replace(/^\/js\/plugins\/\.mistv\/[^/]+\//,'/js/plugins/');const root=await resourceRootFor(game,sub,baseRoot),loadSession=requestLoadSession(req,m[1]);
      if(url.searchParams.get('mistprobe')==='1'){const probeFile=safeJoin(root,sub),probeStat=probeFile?await fsp.stat(probeFile).catch(()=>null):null;res.writeHead(probeStat?.isFile()?200:404,{'Content-Type':'text/plain; charset=utf-8','Content-Length':0,'Cache-Control':'no-store'});return res.end()}if(sub==='/'||sub==='/index.html')return await serveGameIndex(res,baseRoot,m[1]);
      if(sub==='/js/main.js')return await serveMainCompat(req,res,root,game.id,loadSession);if(sub==='/js/plugins.js')return await servePluginListCompat(req,res,root,loadSession,game.id);if(drsBoost&&sub==='/js/plugins/DRS_BoostEngine.js')return await serveDrsBoostEngineCompat(req,res,root,game.id,loadSession);if(nwjs&&sub==='/js/plugins/DRS_BoostEngineMV.js')return await serveDrsBoostEngineCompat(req,res,root,game.id,loadSession,'DRS_BoostEngineMV.js');if(hiroka&&new RegExp(`^/js/plugins/(?:${HIROKA_PLUGIN_DIR}/)?(?:PluginUtils|AsyncLoadImage|AdvExtention|FontDictionary)\\.js$`).test(sub))return await serveHirokaPluginCompat(req,res,root,game.id,path.basename(sub,'.js'),loadSession);if(/^\/js\/plugins\/(?:Text2Frame|del_Text2Frame|del_CBR_LoadAllMapFile)\.js$/.test(sub))return await serveText2FrameCompat(req,res,root,path.basename(sub,'.js'),loadSession);if(sub==='/js/plugins/CommonSave.js')return await serveCommonSaveCompat(req,res,root,loadSession);if(/^\/js\/plugins\/(?:TS_ReplayMode|TS_Decode)\.js$/.test(sub))return await serveScenarioPluginCompat(req,res,root,path.basename(sub,'.js'),loadSession);if(sub==='/js/plugins/CsvAutoLoader.js')return await serveCsvAutoLoaderCompat(req,res,root,loadSession);if(sub==='/js/plugins/DRS_AllDataExtractor.js')return await serveDevExtractorCompat(req,res,root,loadSession);if(sub==='/js/plugins/Movie.js')return await serveMovieFPluginCompat(req,res,root,loadSession);if(sub==='/js/plugins/Sakura_MapNameExtend.js')return await serveSakuraMapNameCompat(req,res,root,loadSession);if(sub==='/js/plugins/SoR_DataNoteExtension_MZ.js')return await serveSoRDataNoteCompat(req,res,root,loadSession);if(sub==='/js/plugins/MoviePicture.js')return await serveMoviePictureCompat(req,res,root,loadSession);if(sub==='/js/plugins/JsScript76Set.js')return await serveJsScript76SetCompat(req,res,root,loadSession);if(sub==='/js/plugins/SaveSlotCustom.js')return await serveSaveSlotCustomCompat(req,res,root,loadSession);if(sub==='/js/plugins/Ayatam_AdvancedCharacterGraphics.js')return await serveAyatamCompat(req,res,root,baseRoot,loadSession);if(sub==='/js/plugins/enc_lv2d.js')return await serveEncLv2dCompat(req,res,root,loadSession);if(itanki&&(sub==='/js/plugins/DKTools.js'||sub==='/js/plugins/DKTools.v5.js'))return await serveItankiDKToolsCompat(req,res,root,sub,loadSession);if(itanki&&sub==='/js/plugins/live2d/cubism4ForMZ.js')return await serveItankiCubismCompat(req,res,root,loadSession);if(sub==='/js/plugins/FlowerCore.js'&&flowerCore)return await serveFlowerCoreCompat(req,res,root,loadSession);if(sub==='/js/plugins/Wataridori_AddFileSystem.js'&&wataridori)return await serveWataridoriCompat(req,res,root,loadSession);if(sub==='/js/plugins/Torigoya_Achievement2.js'&&wataridori)return await serveTorigoyaAchievementCompat(req,res,root,loadSession);if(sub==='/js/plugins/NekoGakuen_SteamworksAPI.js'&&steamworks)return await serveSteamworksCompat(req,res,root,loadSession);if(sub==='/js/plugins/villaA_AnimationTitleButtonFilter1.js')return await serveVillaAAnimationTitleCompat(req,res,root,loadSession);if(sub==='/js/plugins/CGMZ_SplashScreen.js')return await serveCycloneSplashCompat(req,res,root,loadSession);if(sub==='/js/plugins/stwv_allDataFlag.js')return await serveStwvAllDataFlagCompat(req,res,root,loadSession);if(sub==='/data/ExternMessage_en.csv'&&externMessage)return await serveExternMessageCsvCompat(req,res,root,loadSession);if(sub==='/data/CommonEvents.json')return await serveCommonEventsCompat(req,res,root,loadSession);if(sub==='/lng.txt'){const lngSrc=await fsp.readFile(path.join(root,'..','lng.txt')).catch(()=>null)||await fsp.readFile(path.join(root,'lng.txt')).catch(()=>null);if(!lngSrc)return text(res,404,'文件不存在');res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Length':lngSrc.length,'Cache-Control':'no-store'});return res.end(lngSrc)}if(sub==='/js/rpg_core.js'||sub==='/js/rmmz_core.js')return await serveCoreWithCompat(req,res,root,path.basename(sub),loadSession,game.id);if(hiroka&&/\.(?:png_?|ogg_?)$/i.test(sub)){const r=await serveHirokaEncryptedCompat(req,res,root,sub,loadSession);if(r!==null)return r}if(eli){const r=await serveEliPictureCompat(req,res,root,sub,loadSession);if(r!==null)return r}if(itanki){const r=await serveItankiStampCompat(req,res,sub,loadSession);if(r!==null)return r;const r2=await serveItankiLocaleCompat(req,res,root,sub,loadSession);if(r2!==null)return r2}if(sub.startsWith('/img/')){const at=await serveAtlasCompat(req,res,root,sub);if(at!==null)return at;const r=await serveImageTextureCompat(req,res,root,sub);if(r!==null)return r;const r2=await serveMissingImageFallback(req,res,root,sub);if(r2!==null)return r2}if(/\.m4a$/i.test(sub)&&await serveM4aFallback(req,res,root,sub,game.id,loadSession))return;if(/\.rpgmvm$/i.test(sub)&&await serveEncryptedAudioM4a(req,res,root,sub,game,loadSession))return;if(/^\/js\/plugins\/.+\.js$/i.test(sub)){const r=await servePluginMarkerStripCompat(req,res,root,sub,loadSession);if(r!==null)return r}return await serveFile(req,res,root,sub,'public, max-age=86400',loadSession);
    }
    if(p==='/player.html'&&url.searchParams.get('game')){const game=games.find(g=>g.id===url.searchParams.get('game'));if(game?.engine==='krkr2')return await serveFile(req,res,PUBLIC_DIR,p,'no-cache',null,krkrIsolation)}
    if(p==='/config.js') return text(res,200,`window.SITE_CONFIG=${JSON.stringify({title:config.siteTitle})};`);
    if(p==='/krkr-runtime/index.html'||p.endsWith('/krkr-runtime/index.html')){
      const file=path.join(KRKR_RUNTIME_DIR,'index.html'),source=await fsp.readFile(file,'utf8').catch(()=>null);
      if(source!==null){
        const manifests=Object.fromEntries(Object.entries(config.krkrBundledSaveFiles||{}).map(([id,files])=>[id,{version:'config-v1',files:Object.entries(files||{}).map(([name,size])=>({name,size:Number(size)}))}]));
        const script=`<script>window.__mistBundledSaveManifests=${JSON.stringify(manifests)};</script>`;
        const injected=source.includes('</head>')?source.replace('</head>',script+'</head>'):script+source;
        const body=Buffer.from(injected);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store',...krkrIsolation});return res.end(body);
      }
    }
    if(p.startsWith('/krkr-runtime/'))return await serveFile(req,res,KRKR_RUNTIME_DIR,p.slice('/krkr-runtime'.length)||'/','no-store',null,{...krkrIsolation,...(p.endsWith('/sw.js')?{'Service-Worker-Allowed':'/'}:{})},true);
    return await serveFile(req,res,PUBLIC_DIR,p==='/'?'/index.html':p,'no-cache');
  }catch(error){ console.error(error); json(res,error.status||500,{error:error.message||'服务器错误',...(error.code?{code:error.code}:{}),...(error.launchers?{launchers:error.launchers}:{})}); }
};

const server=http.createServer(requestHandler);
server.requestTimeout=0;
server.timeout=0;
server.keepAliveTimeout=65000;
server.headersTimeout=120000;
function lanAddresses(){const out=[];for(const ifaces of Object.values(os.networkInterfaces()))for(const i of ifaces||[])if(i.family==='IPv4'&&!i.internal)out.push(i.address);return out}
server.listen(config.port,config.host,()=>console.log(`\n${config.siteTitle} HTTP 已启动：\n  本机：http://localhost:${config.port}\n  局域网：${lanAddresses().map(ip=>`http://${ip}:${config.port}`).join('\n          ')||'<未检测到局域网地址>'}\n  SMB：${config.sourceRoot}\n`));

if(config.https?.enabled){
  const keyFile=path.resolve(ROOT,config.https.keyFile),certFile=path.resolve(ROOT,config.https.certFile);
  const tls={key:await fsp.readFile(keyFile),cert:await fsp.readFile(certFile)};
  const httpsServer=https.createServer(tls,requestHandler);
  httpsServer.requestTimeout=0;
  httpsServer.timeout=0;
  httpsServer.keepAliveTimeout=65000;
  httpsServer.headersTimeout=120000;
  httpsServer.listen(config.https.port,config.host,()=>console.log(`${config.siteTitle} HTTPS 已启动：\n  本机：https://localhost:${config.https.port}\n  局域网：https://${config.https.publicHost}:${config.https.port}\n  KRKR 游戏会从 HTTP 自动转入可信安全上下文。\n`));
}
