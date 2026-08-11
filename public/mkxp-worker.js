let gameId=null;
let moduleConfig=null;
let runtimeModule=null;
const pendingKeys=[];
const saveHashes=new Map();
let saveSyncRunning=false;
let saveSyncTimer=null;
let displayMetrics={displayWidth:640,displayHeight:480,devicePixelRatio:1};

const status=message=>postMessage({type:'status',message});
let startupStage='idle',startupMessage='',startupStartedAt=0,startupHeartbeat=null,loadedBytes=0,stableFrameTimer=null;
function progress(stage,message,extra={}){startupStage=stage;startupMessage=message;postMessage({type:'progress',stage,message,loadedBytes,...extra})}
function startHeartbeat(){startupStartedAt=Date.now();clearInterval(startupHeartbeat);startupHeartbeat=setInterval(()=>postMessage({type:'heartbeat',stage:startupStage,message:startupMessage,elapsedMs:Date.now()-startupStartedAt,loadedBytes}),1000)}
function stopHeartbeat(){clearInterval(startupHeartbeat);startupHeartbeat=null}
const fatalPattern=/\[mkxp-z exception\]|Game threw an exception|Failed to initialize the mkxp-z game engine|Aborted\(|RuntimeError:/;
function output(type,text){
 const message=String(text);postMessage({type,message});
 if(message.includes('SET_SYSTEM_AV_INFO: 640x480')){
  progress('frame','RGSS3 已载入游戏分辨率，正在等待首帧稳定',{current:5,total:6});
  clearTimeout(stableFrameTimer);stableFrameTimer=setTimeout(()=>{if(startupStage==='frame'){stopHeartbeat();progress('ready','RGSS3 画面已稳定',{current:6,total:6});postMessage({type:'ready',stage:'ready',current:6,total:6})}},3000)
 }
 if(fatalPattern.test(message)){clearTimeout(stableFrameTimer);stopHeartbeat();postMessage({type:'fatal',message})}
}
const fileUrl=(source,path)=>`/api/rgss/${gameId}/file/${source}/${path.split('/').map(encodeURIComponent).join('/')}`;
const savesUrl=()=>`/api/rgss/${gameId}/saves`;
const virtualGameRoot='/rgss-game';
const retroarchRoot='/home/web_user/retroarch/userdata';
const systemRoot=`${retroarchRoot}/system`;
const saveRoot=`${retroarchRoot}/saves`;
const gameEntry=`${virtualGameRoot}/Game.ini`;

function manifestFiles(manifest){
 const files=Array.isArray(manifest.files)?manifest.files:[
  ...(manifest.game||[]).map(path=>({source:'game',path})),
  ...(manifest.rtp||[]).map(path=>({source:'rtp',path}))
 ];
 const overlay=new Map();
 for(const entry of files){
  const normalized=typeof entry==='string'?{source:'game',path:entry}:entry;
  const key=normalized.path.replaceAll('\\','/').toLowerCase();
  if(!overlay.has(key)||normalized.source==='game')overlay.set(key,normalized);
 }
 return [...overlay.values()];
}

function compatScripts(manifest){return Array.isArray(manifest.compatScripts)?manifest.compatScripts:[]}

function compatCoreOptionKey(entry){const name=entry.path.split('/').pop()||'';return `mkxp-z_preload-${[...new TextEncoder().encode(name)].map(byte=>byte.toString(16).padStart(2,'0')).join('')}`}
function writeCoreOptions(FS,manifest){
 const options=compatScripts(manifest).map(entry=>`${compatCoreOptionKey(entry)} = "enabled"`).join('\n');
 FS.writeFile(`${retroarchRoot}/retroarch-core-options.cfg`,new TextEncoder().encode(`${options}\n`));
}

function ensureDirectory(FS,path){
 if(FS.mkdirTree){FS.mkdirTree(path);return}
 const parts=path.split('/').filter(Boolean);let current='';
 for(const part of parts){current+=`/${part}`;try{FS.mkdir(current)}catch{}}
}

function mountLazyFiles(FS,manifest){
 ensureDirectory(FS,virtualGameRoot);
 ensureDirectory(FS,`${systemRoot}/mkxp-z/RTP/RPGVXAce`);
 for(const entry of manifestFiles(manifest)){
  const relative=typeof entry==='string'?entry:entry.path;
  const source=typeof entry==='string'?'game':entry.source==='rtp'?'rtp':'game';
  const root=source==='rtp'?`${systemRoot}/mkxp-z/RTP/RPGVXAce`:virtualGameRoot;
  const virtualPath=`${root}/${relative}`.replace(/\/+/g,'/');
  const slash=virtualPath.lastIndexOf('/');
  const directory=virtualPath.slice(0,slash)||'/';
  ensureDirectory(FS,directory);
  FS.createLazyFile(directory,virtualPath.slice(slash+1),fileUrl(source,relative),true,false);
 }
 for(const entry of compatScripts(manifest)){
  const virtualPath=`${systemRoot}/mkxp-z/${entry.path}`.replace(/\/+/g,'/'),slash=virtualPath.lastIndexOf('/'),directory=virtualPath.slice(0,slash)||'/';
  ensureDirectory(FS,directory);
  if(entry.bytes)FS.writeFile(virtualPath,entry.bytes);else FS.createLazyFile(directory,virtualPath.slice(slash+1),fileUrl('compat',entry.path),true,false);
 }
}

function writeRetroarchConfig(FS){
 ensureDirectory(FS,retroarchRoot);ensureDirectory(FS,saveRoot);ensureDirectory(FS,systemRoot);
 const config=[
  `savefile_directory = "${saveRoot}"`,
  `savestate_directory = "${retroarchRoot}/states"`,
  `system_directory = "${systemRoot}"`,
  `core_options_path = "${retroarchRoot}/retroarch-core-options.cfg"`,
  'log_verbosity = "true"',
  'input_toggle_fast_forward = "space"',
  'input_hold_fast_forward = "l"',
  'input_player1_a = "c"',
  'input_player1_b = "x"',
  'input_player1_x = "z"',
  'input_player1_l = "q"',
  'input_player1_r = "w"',
  'input_player1_l2 = "ctrl"'
 ].join('\n');
 FS.writeFile(`${retroarchRoot}/retroarch.cfg`,new TextEncoder().encode(`${config}\n`));
 ensureDirectory(FS,`${retroarchRoot}/states`);
}

const saveNamePattern=/^Save\d{2,3}$/;
const serverSaveName=path=>{
 const normalized=path.replaceAll('\\','/');
 const base=normalized.split('/').pop()||'';
 const stem=base.endsWith('.rvdata2')?base.slice(0,-8):base;
 if(saveNamePattern.test(stem)||['QuickSave','PublicData'].includes(stem))return stem;
 if(normalized.endsWith('/System/test')||base==='test')return 'WindowSize';
 return null;
};
const bytesEqual=(a,b)=>a?.length===b?.length&&a.every((value,index)=>value===b[index]);
const copyBytes=value=>Uint8Array.from(value);

function walkFiles(FS,root){
 const result=[];let entries;try{entries=FS.readdir(root)}catch{return result}
 for(const entry of entries){if(entry==='.'||entry==='..')continue;const path=`${root}/${entry}`.replace(/\/+/g,'/');let stat=null;try{stat=FS.stat?.(path)||null}catch{continue}
  if(stat&&FS.isDir?.(stat.mode))result.push(...walkFiles(FS,path));else{try{FS.readFile(path);result.push(path)}catch{result.push(...walkFiles(FS,path))}}
 }
 return result;
}

async function fetchInitialSaves(){
 const response=await fetch(savesUrl(),{cache:'no-store'});
 if(!response.ok)throw new Error(`存档列表读取失败 (${response.status})`);
 const payload=await response.json();
 const names=Array.isArray(payload)?payload:Array.isArray(payload.saves)?payload.saves:[];
 const loaded=[];
 for(const item of names){
  const name=typeof item==='string'?item:item?.name;if(!name)continue;
  const saveResponse=await fetch(`${savesUrl()}/${encodeURIComponent(name)}`,{cache:'no-store'});if(!saveResponse.ok)continue;
  const data=new Uint8Array(await saveResponse.arrayBuffer());loaded.push({name,data});saveHashes.set(name,copyBytes(data));
 }
 return loaded;
}

function installInitialSaves(FS,saves){
 ensureDirectory(FS,saveRoot);
 for(const {name,data} of saves){
  const filename=name==='WindowSize'?'System/test':`${name}.rvdata2`;
  const target=`${saveRoot}/${filename}`;ensureDirectory(FS,target.slice(0,target.lastIndexOf('/')));FS.writeFile(target,data);
 }
}

async function syncSaves(FS){
 if(saveSyncRunning)return;saveSyncRunning=true;
 try{
  for(const path of walkFiles(FS,saveRoot)){
   const name=serverSaveName(path);if(!name)continue;
   let data;try{data=copyBytes(FS.readFile(path))}catch{continue}
   if(!data.length||bytesEqual(data,saveHashes.get(name)))continue;
   const response=await fetch(`${savesUrl()}/${encodeURIComponent(name)}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)});
   if(!response.ok)throw new Error(`存档写入失败 (${response.status})`);saveHashes.set(name,copyBytes(data));
  }
 }finally{saveSyncRunning=false}
}

function setDisplayMetrics(canvas,metrics={}){
 displayMetrics={displayWidth:Math.max(1,Number(metrics.displayWidth)||displayMetrics.displayWidth),displayHeight:Math.max(1,Number(metrics.displayHeight)||displayMetrics.displayHeight),devicePixelRatio:Math.max(1,Number(metrics.devicePixelRatio)||displayMetrics.devicePixelRatio)};
 if(canvas){canvas.style.width=`${displayMetrics.displayWidth}px`;canvas.style.height=`${displayMetrics.displayHeight}px`}
}

function installCanvasCompat(canvas){
 const attributes=new Map(),listeners=new Map();
 const style=canvas.style||{};
 if(!style.setProperty)style.setProperty=(name,value)=>{style[name]=String(value)};
 if(!style.removeProperty)style.removeProperty=name=>{delete style[name]};
 canvas.style=style;
 if(!canvas.getAttribute)canvas.getAttribute=name=>attributes.get(name)??null;
 if(!canvas.setAttribute)canvas.setAttribute=(name,value)=>attributes.set(name,String(value));
 if(!canvas.focus)canvas.focus=()=>{};
 if(!canvas.addEventListener)canvas.addEventListener=(type,listener)=>{const set=listeners.get(type)||new Set();set.add(listener);listeners.set(type,set)};
 if(!canvas.removeEventListener)canvas.removeEventListener=(type,listener)=>listeners.get(type)?.delete(listener);
 if(!canvas.dispatchEvent)canvas.dispatchEvent=event=>{for(const listener of listeners.get(event.type)||[])listener.call(canvas,event);return !event.defaultPrevented};
 for(const name of ['clientWidth','clientHeight'])if(!(name in canvas))Object.defineProperty(canvas,name,{configurable:true,get:()=>name==='clientWidth'?displayMetrics.displayWidth:displayMetrics.displayHeight});
 return canvas;
}

function installWorkerBrowserCompat(canvas){
 const eventTarget=()=>{const listeners=new Map();return{
  addEventListener(type,listener){const set=listeners.get(type)||new Set();set.add(listener);listeners.set(type,set)},
  removeEventListener(type,listener){listeners.get(type)?.delete(listener)},
  dispatchEvent(event){for(const listener of listeners.get(event.type)||[])listener.call(this,event);return !event.defaultPrevented}
 }};
 const windowEvents=eventTarget(),documentEvents=eventTarget();
 const workerWindow=Object.assign(windowEvents,{
  devicePixelRatio:displayMetrics.devicePixelRatio,
  getComputedStyle:target=>({display:target?.style?.display||'inline-block'}),
  resizeTo:()=>{},
  AudioContext:self.AudioContext,
  webkitAudioContext:self.webkitAudioContext
 });
 const workerDocument=Object.assign(documentEvents,{
  visibilityState:'visible',fullscreenElement:null,
  getElementById:id=>id==='canvas'?canvas:null,
  querySelector:selector=>selector==='#canvas'?canvas:null
 });
 if(!self.window)self.window=workerWindow;
 if(!self.document)self.document=workerDocument;
 if(!self.navigator)self.navigator={userAgent:'DedicatedWorker',platform:'Worker'};
 if(!self.ResizeObserver)self.ResizeObserver=class{constructor(callback){this.callback=callback}observe(target){this.callback([{target,contentRect:{width:target.clientWidth,height:target.clientHeight}}])}unobserve(){}disconnect(){}};
}

function createKeyboardLikeEvent(data){const event=new Event(data.eventType,{bubbles:true,cancelable:true});Object.defineProperties(event,{key:{value:data.key},code:{value:data.code},keyCode:{value:data.keyCode},which:{value:data.keyCode}});return event}
function dispatchKey(data){
 const target=moduleConfig?.canvas;
 if(!target?.dispatchEvent){pendingKeys.push(data);return}
 target.dispatchEvent(createKeyboardLikeEvent(data));
}

async function start(data){
 gameId=data.gameId;displayMetrics={...displayMetrics,...data.displayMetrics};startHeartbeat();progress('manifest','正在读取 RGSS3 资源清单');
 const canvas=installCanvasCompat(data.canvas);setDisplayMetrics(canvas,displayMetrics);installWorkerBrowserCompat(canvas);
 const [response,initialSaves]=await Promise.all([
  fetch(`/api/rgss/${gameId}/manifest`,{cache:'no-store'}),
  fetchInitialSaves()
 ]);
 if(!response.ok)throw new Error(`RGSS3 清单读取失败 (${response.status})`);
 const manifest=await response.json();
 const totalBytes=(manifest.files||[]).reduce((sum,item)=>sum+(Number(item.size)||0),0),resources=(manifest.files||[]).length;
 progress('preload',`正在验证 ${compatScripts(manifest).length} 个游戏兼容预加载脚本`,{current:1,total:6,resources,totalBytes});
 for(const entry of compatScripts(manifest)){const compatResponse=await fetch(fileUrl('compat',entry.path),{cache:'no-store'});if(!compatResponse.ok)throw new Error(`兼容预加载脚本读取失败 (${compatResponse.status})`);const bytes=new Uint8Array(await compatResponse.arrayBuffer());loadedBytes+=bytes.length;entry.bytes=bytes}
 progress('mount',`已建立 ${resources} 个按需资源索引`,{current:2,total:6,resources,totalBytes});
 saveSyncTimer=setInterval(()=>{const FS=runtimeModule?.FS||globalThis.FS;if(FS)syncSaves(FS).catch(error=>postMessage({type:'error',message:error.message||String(error)}))},3000);
 moduleConfig={
  canvas,
  noInitialRun:true,
  arguments:['--config',`${retroarchRoot}/retroarch.cfg`,gameEntry],
  locateFile:path=>`/mkxp/${path==='mkxp-z_libretro.wasm'?'mkxp-z.wasm':path}`,
  preRun:[module=>{const FS=module?.FS||globalThis.FS;mountLazyFiles(FS,manifest);writeRetroarchConfig(FS);writeCoreOptions(FS,manifest);installInitialSaves(FS,initialSaves)}],
  print:text=>output('status',text),
  printErr:text=>output('log',text),
  retroArchExit:(error,code)=>{const message=error||`RGSS3 已退出 (${code})`;output(fatalPattern.test(message)?'fatal':'log',message)}
 };
 self.Module=moduleConfig;progress('wasm','正在下载并编译单线程 mkxp-z 核心',{current:3,total:6,resources,totalBytes});
 const {default:createRuntime}=await import('/mkxp/mkxp-z.js');
 runtimeModule=await createRuntime(moduleConfig);
 progress('scripts','正在载入 VX Ace 脚本与游戏数据',{current:4,total:6,resources,totalBytes});
 while(pendingKeys.length)dispatchKey(pendingKeys.shift());
 status('RGSS3 引擎正在启动');
 runtimeModule.callMain(moduleConfig.arguments);
 progress('frontend','RetroArch 前端已启动，正在等待 RGSS3 游戏数据',{current:4,total:6,resources,totalBytes});
 status('正在等待 RGSS3 游戏数据');
}

self.onmessage=event=>{
 const data=event.data;
 if(data?.type==='start')start(data).catch(error=>postMessage({type:'fatal',message:error.stack||error.message||String(error)}));
 if(data?.type==='key')dispatchKey({eventType:data.eventType,code:data.code,key:data.key,keyCode:data.keyCode});
 if(data?.type==='display-metrics'){setDisplayMetrics(moduleConfig?.canvas,data);self.window&&(self.window.devicePixelRatio=displayMetrics.devicePixelRatio);self.window?.dispatchEvent?.({type:'resize',defaultPrevented:false})}
 if(data?.type==='sync-save'&&runtimeModule)syncSaves(runtimeModule.FS).catch(error=>postMessage({type:'error',message:error.message||String(error)}));
};
