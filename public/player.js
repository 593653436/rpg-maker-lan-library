import {createGameNoticeController} from './game-notice.js';
const params=new URLSearchParams(location.search),gameId=params.get('game');
if(!gameId||!/^[\w-]+$/.test(gameId))location.replace('/');
const frame=document.querySelector('#game-frame'),canvas=document.querySelector('#mkxp-canvas'),pad=document.querySelector('#virtual-pad'),dialog=document.querySelector('#key-dialog');
const gameRequest=(async()=>{const r=await fetch(`/api/games/${gameId}`,{cache:'no-store'}),data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||'游戏信息读取失败');return data.game})();
const loadingPanel=document.querySelector('#loading-panel'),loadingProgress=document.querySelector('#loading-progress'),loadingPercent=document.querySelector('#loading-percent'),loadingSize=document.querySelector('#loading-size'),loadingSpeed=document.querySelector('#loading-speed'),loadingResources=document.querySelector('#loading-resources'),loadingRemaining=document.querySelector('#loading-remaining'),loadingStatus=document.querySelector('#loading-status'),reloadGame=document.querySelector('#reload-game'),copyDiagnostics=document.querySelector('#copy-diagnostics');
const noticeDialog=document.querySelector('#game-notice-dialog'),noticeController=createGameNoticeController({gameId,dialog:noticeDialog,trigger:document.querySelector('#view-notice'),content:document.querySelector('#game-notice-content'),heading:document.querySelector('#game-notice-title'),fetchGame:async id=>{const r=await fetch(`/api/games/${id}`,{cache:'no-store'}),data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||'公告读取失败');return data.game}});
document.querySelector('#close-game-notice').onclick=document.querySelector('#confirm-game-notice').onclick=()=>noticeDialog.close();noticeController.load().catch(error=>console.warn('[雾灯公告]',error));
let loadToken=null,loadTimer=null,lastSample={time:performance.now(),bytes:0},smoothedSpeed=0,lastAdvance=performance.now(),gameReady=false,localRetryAttempts=0,lastDiagnostic=null,lastLoadView=null,mkxpWorker=null,isRgss3=false,workerMessages=[],rgssProgress=null,rgssStartedAt=0,rgssTimer=null,rgssPhase=0,firstFatal=null,fatalBacktrace=[];
const rgssPhaseOrder={prepare:0,manifest:1,preload:2,mount:3,wasm:4,scripts:5,frontend:6,frame:7,ready:8};
const canvasDisplayMetrics=()=>{const rect=canvas.getBoundingClientRect(),ratio=Math.min(rect.width/4,rect.height/3),displayWidth=Math.max(1,Math.round(ratio*4)),displayHeight=Math.max(1,Math.round(ratio*3));return{displayWidth,displayHeight,devicePixelRatio:Math.max(1,window.devicePixelRatio||1)}};
function syncRgssDisplayMetrics(){if(mkxpWorker)mkxpWorker.postMessage({type:'display-metrics',...canvasDisplayMetrics()})}
function buildLogReport(){
 let gameLog=null,gameCaptureError=null;
 try{const win=frame.contentWindow;gameLog=win?.__mistLogRecorder?.snapshot?.()||null;if(!gameLog&&win)gameCaptureError='游戏日志记录器尚未初始化'}catch(error){gameCaptureError=String(error.stack||error)}
 return{schemaVersion:1,title:'雾灯游戏运行日志',capturedAt:new Date().toISOString(),gameId,player:globalThis.__mistLogRecorder?.snapshot?.()||null,game:gameLog,gameCaptureError,workerMessages,firstFatal,fatalBacktrace,loading:{gameReady,loadToken,localRetryAttempts,status:loadingStatus.textContent,rgssProgress,session:lastLoadView,startupDiagnostic:lastDiagnostic}};
}
function exportLogs(){const report=buildLogReport(),result=globalThis.__mistDownloadJsonLog(report);toast(`日志已导出：${result.filename}`);return report}
const formatBytes=n=>n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:n<1073741824?`${(n/1048576).toFixed(1)} MB`:`${(n/1073741824).toFixed(2)} GB`;
const remainingSeconds=(total,loaded,speed)=>speed>0&&total>loaded?Math.ceil((total-loaded)/speed):null;
const formatRemaining=s=>s===null?'计算中':s<60?`约 ${s} 秒`:s<3600?`约 ${Math.ceil(s/60)} 分钟`:`约 ${(s/3600).toFixed(1)} 小时`;
function showRgssProgress(data={}){
 const nextPhase=rgssPhaseOrder[data.stage]??rgssPhase;if(nextPhase<rgssPhase)return;rgssPhase=nextPhase;
 rgssProgress={...rgssProgress,...data,time:new Date().toISOString()};
 const current=Number(data.current)||0,total=Number(data.total)||0,loaded=Number(data.loadedBytes)||0,totalBytes=Number(data.totalBytes)||0;
 if(total>0){const percent=Math.max(0,Math.min(100,current/total*100));loadingProgress.value=percent;loadingProgress.setAttribute('value',String(percent));loadingPercent.textContent=`${percent.toFixed(0)}%`}else{loadingProgress.removeAttribute('value');loadingPercent.textContent='处理中'}
 loadingSize.textContent=totalBytes?`${formatBytes(loaded)} / ${formatBytes(totalBytes)}`:loaded?`已读取 ${formatBytes(loaded)}`:'正在准备运行环境';
 loadingResources.textContent=data.resources?`按需资源：${data.resources}`:data.stage==='wasm'?'核心运行时':'资源索引准备中';
 loadingSpeed.textContent=data.stage==='wasm'?'正在下载单线程核心':'按文件从 NAS 读取';
 loadingRemaining.textContent=`已等待：${Math.max(0,Math.floor((performance.now()-rgssStartedAt)/1000))} 秒`;
 if(data.message)loadingStatus.textContent=data.message;
}
function errorSummary(){return [firstFatal?.message,...fatalBacktrace.map(x=>x.message)].filter(Boolean).join('\n')}
function showRgssFailure(message){gameReady=false;loadingPanel.classList.remove('is-hidden');loadingPanel.classList.add('is-stalled');loadingProgress.removeAttribute('value');loadingPercent.textContent='启动失败';loadingStatus.textContent=errorSummary()||message;reloadGame.hidden=false;clearInterval(rgssTimer)}
async function beginLoading(){
 const game=await gameRequest;
 if(game.engine==='krkr2'){
  isRgss3=false;gameReady=false;frame.hidden=false;canvas.hidden=true;canvas.style.display='none';loadingPanel.classList.remove('is-hidden','is-stalled');reloadGame.hidden=true;loadingProgress.removeAttribute('value');loadingPercent.textContent='正在启动';loadingStatus.textContent='正在加载 KRKR WebAssembly 运行时';frame.src=`/krkr-runtime/${gameId}/`;return;
 }
 if(game.engine==='rgss3'){
  isRgss3=true;gameReady=false;workerMessages=[];firstFatal=null;fatalBacktrace=[];rgssPhase=0;rgssStartedAt=performance.now();frame.hidden=true;canvas.hidden=false;canvas.style.display='block';loadingPanel.classList.remove('is-hidden','is-stalled');reloadGame.hidden=true;showRgssProgress({stage:'prepare',message:'正在启动 RGSS3 单线程引擎'});clearInterval(rgssTimer);rgssTimer=setInterval(()=>{const p=rgssProgress||{stage:'prepare'};showRgssProgress({...p,elapsedMs:performance.now()-rgssStartedAt})},1000);
  if(!mkxpWorker){const offscreen=canvas.transferControlToOffscreen();mkxpWorker=new Worker('/mkxp-worker.js?mistv=rgss-runtime-6');mkxpWorker.onmessage=e=>{const data=e.data||{};workerMessages.push({...data,time:new Date().toISOString()});if(workerMessages.length>200)workerMessages.shift();if(data.type==='progress'||data.type==='heartbeat')showRgssProgress(data);if(data.type==='status'&&data.message&&!/^\[/.test(data.message))loadingStatus.textContent=data.message;if(data.type==='ready'&&data.stage==='ready'){showRgssProgress(data);gameReady=true;clearInterval(rgssTimer);loadingProgress.value=100;loadingProgress.setAttribute('value','100');loadingPercent.textContent='已启动';loadingStatus.textContent='RGSS3 画面已稳定';loadingPanel.classList.add('is-hidden');noticeController.markGameReady()};if(data.type==='log'&&data.message?.includes('Loading path cache'))showRgssProgress({stage:'scripts',message:'正在扫描游戏与 RTP 文件（此阶段约需 40–60 秒）'});if(data.type==='log'&&data.message?.includes('Path cache completed'))showRgssProgress({stage:'scripts',message:'游戏与 RTP 文件扫描完成，正在启动 Ruby'});if(data.type==='fatal'){if(!firstFatal&&/exception.*(?:NoMethodError|RuntimeError|Error)/i.test(data.message||''))firstFatal={...data,time:new Date().toISOString()};else if(firstFatal&&/\[mkxp-z exception\]/.test(data.message||'')&&fatalBacktrace.length<20)fatalBacktrace.push({...data,time:new Date().toISOString()});showRgssFailure(data.message||'RGSS3 启动失败')}};mkxpWorker.onerror=e=>showRgssFailure(e.message||'RGSS3 Worker 启动失败');mkxpWorker.postMessage({type:'start',gameId,canvas:offscreen,displayMetrics:canvasDisplayMetrics()},[offscreen])}
  return;
 }
 loadingPanel.classList.remove('is-hidden','is-stalled');reloadGame.hidden=true;gameReady=false;localRetryAttempts=0;lastSample={time:performance.now(),bytes:0};smoothedSpeed=0;lastAdvance=performance.now();
 const r=await fetch('/api/load-sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gameId})});if(!r.ok)throw new Error('无法建立加载监控');loadToken=(await r.json()).token;
 frame.src=`/games/${gameId}/?shell=1&load=${loadToken}`;clearInterval(loadTimer);loadTimer=setInterval(updateLoading,1000);await updateLoading();
}
async function updateLoading(){
 if(!loadToken)return;try{const r=await fetch(`/api/load-sessions/${loadToken}`,{cache:'no-store'});if(!r.ok)throw new Error();const d=await r.json(),now=performance.now(),dt=Math.max(.25,(now-lastSample.time)/1000),delta=Math.max(0,d.loadedBytes-lastSample.bytes),instant=delta/dt;lastLoadView=d;smoothedSpeed=smoothedSpeed?smoothedSpeed*.68+instant*.32:instant;if(delta>0)lastAdvance=now;lastSample={time:now,bytes:d.loadedBytes};
 const percent=d.totalBytes?Math.min(100,d.loadedBytes/d.totalBytes*100):0;loadingProgress.value=percent;loadingPercent.textContent=d.requestedResources?`${percent.toFixed(0)}%`:'发现资源中';loadingSize.textContent=`${formatBytes(d.loadedBytes)} / ${formatBytes(d.totalBytes)}`;loadingSpeed.textContent=`速率：${smoothedSpeed>1?formatBytes(smoothedSpeed)+'/s':'等待数据'}`;loadingResources.textContent=`资源：${d.completedResources} / ${d.requestedResources}`;loadingRemaining.textContent=`剩余时间：${formatRemaining(remainingSeconds(d.totalBytes,d.loadedBytes,smoothedSpeed))}`;
 const retries=Math.max(d.retryAttempts,localRetryAttempts),waiting=d.activeResources>0||d.completedResources<d.requestedResources,stalled=!gameReady&&waiting&&now-lastAdvance>8000,initializing=!gameReady&&!waiting&&d.requestedResources>0,phase=lastDiagnostic?.scene||lastDiagnostic?.nextScene||(lastDiagnostic?.plugins?'插件初始化':lastDiagnostic?.documentReady==='complete'?'脚本初始化':'网页加载');loadingPanel.classList.toggle('is-stalled',stalled);loadingStatus.textContent=stalled?`网络暂时没有数据，正在等待恢复${retries?`；已自动重试 ${retries} 次`:''}。请不要关闭页面。`:initializing?`已发现的资源下载完成，游戏仍在${phase}阶段。可导出日志。`:retries?`连接已恢复，继续加载；已自动重试 ${retries} 次。`:'大型游戏在弱 Wi-Fi 下可能需要几分钟，请保持页面打开。';reloadGame.hidden=!(stalled&&now-lastAdvance>30000);
 if(gameReady&&d.activeResources===0){loadingPercent.textContent='已完成';loadingProgress.value=100;loadingStatus.textContent='游戏已经准备好';setTimeout(()=>loadingPanel.classList.add('is-hidden'),350);clearInterval(loadTimer)}}catch{loadingPanel.classList.add('is-stalled');loadingStatus.textContent='与加载监控暂时断开，游戏资源仍会继续重试。';reloadGame.hidden=false}}
window.addEventListener('resize',syncRgssDisplayMetrics);
document.addEventListener('fullscreenchange',syncRgssDisplayMetrics);
window.addEventListener('message',e=>{if(e.source!==frame.contentWindow)return;if(e.data?.type==='mist-krkr-status'){lastDiagnostic=e.data;loadingStatus.textContent=e.data.message||'正在启动 KRKR WebAssembly 运行时';return}if(e.data?.type==='mist-krkr-error'){lastDiagnostic=e.data;gameReady=false;loadingPanel.classList.remove('is-hidden');loadingPanel.classList.add('is-stalled');loadingProgress.removeAttribute('value');loadingPercent.textContent='启动失败';loadingStatus.textContent=e.data.message||'KRKR 运行时启动失败';reloadGame.hidden=false;return}if(e.data?.type==='mist-krkr-ready'){lastDiagnostic=e.data;gameReady=true;loadingPercent.textContent='运行时已启动';loadingProgress.value=100;loadingProgress.setAttribute('value','100');loadingStatus.textContent=e.data.message||'KRKR WebAssembly 运行时已启动';noticeController.markGameReady();setTimeout(()=>loadingPanel.classList.add('is-hidden'),350);return}if(e.data?.type==='mist-diagnostic')lastDiagnostic=e.data;if(e.data?.type==='mist-resource-retry')localRetryAttempts=Math.max(localRetryAttempts,Number(e.data.attempt)||0);if(e.data?.type==='mist-game-ready'){gameReady=true;noticeController.markGameReady();updateLoading()}});
const saveRegistrationDialog=document.querySelector('#save-registration-dialog');let saveRegistrationPromptShown=false;
window.addEventListener('message',e=>{if(e.source!==frame.contentWindow||e.data?.type!=='mist-save-registration-required'||saveRegistrationPromptShown)return;saveRegistrationPromptShown=true;toast('游客只能读取 NAS 存档；注册后才能保存独立进度');saveRegistrationDialog.showModal()});
document.querySelector('#save-register-later').onclick=()=>saveRegistrationDialog.close();
document.querySelector('#save-register-now').onclick=async()=>{await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{});location.href='/login.html?register=1'};
copyDiagnostics.onclick=exportLogs;
document.querySelector('#export-logs').onclick=exportLogs;
reloadGame.onclick=()=>beginLoading().catch(e=>{loadingStatus.textContent=e.message;reloadGame.hidden=false});
beginLoading().catch(e=>{loadingStatus.textContent=e.message;reloadGame.hidden=false});

const defaults={
 left:[
  {id:'l1',label:'Q',code:'KeyQ'},{id:'l2',label:'W',code:'KeyW'},{id:'l3',label:'E',code:'KeyE'},
  {id:'l4',label:'A',code:'KeyA'},{id:'l5',label:'Space',code:'Space'},{id:'l6',label:'D',code:'KeyD'},
  {id:'l7',label:'Ctrl',code:'ControlLeft'},{id:'l8',label:'S',code:'KeyS'},{id:'l9',label:'Shift',code:'ShiftLeft'}],
 right:[
  {id:'r1',label:'C',code:'KeyC'},{id:'r2',label:'↑',code:'ArrowUp'},{id:'r3',label:'V',code:'KeyV'},
  {id:'r4',label:'←',code:'ArrowLeft'},{id:'r5',label:'Enter',code:'Enter'},{id:'r6',label:'→',code:'ArrowRight'},
  {id:'r7',label:'Z',code:'KeyZ'},{id:'r8',label:'↓',code:'ArrowDown'},{id:'r9',label:'X',code:'KeyX'}]
};
const storageKey='mist-virtual-pad-v1';
let layout=load(),active=new Map();
function load(){try{const value=JSON.parse(localStorage.getItem(storageKey));if(value?.left?.length===9&&value?.right?.length===9)return value}catch{}return structuredClone(defaults)}
const choices=[['KeyW','W'],['KeyA','A'],['KeyS','S'],['KeyD','D'],['KeyZ','Z'],['KeyX','X'],['KeyC','C'],['KeyQ','Q'],['KeyE','E'],['KeyV','V'],['ArrowUp','方向上'],['ArrowDown','方向下'],['ArrowLeft','方向左'],['ArrowRight','方向右'],['Enter','Enter'],['Escape','Esc'],['Space','空格'],['ShiftLeft','Shift'],['ControlLeft','Ctrl'],['Tab','Tab'],['PageUp','PageUp'],['PageDown','PageDown'],['Backspace','退格']];
const keyData=code=>({code,key:code.startsWith('Key')?code.slice(3).toLowerCase():({ArrowUp:'ArrowUp',ArrowDown:'ArrowDown',ArrowLeft:'ArrowLeft',ArrowRight:'ArrowRight',Enter:'Enter',Escape:'Escape',Space:' ',ShiftLeft:'Shift',ControlLeft:'Control',Tab:'Tab',PageUp:'PageUp',PageDown:'PageDown',Backspace:'Backspace'}[code]||code),keyCode:({ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,Enter:13,Escape:27,Space:32,ShiftLeft:16,ControlLeft:17,Tab:9,PageUp:33,PageDown:34,Backspace:8}[code]||code.charCodeAt(code.length-1))});
function send(code,type){const d=keyData(code);if(isRgss3){mkxpWorker?.postMessage({type:'key',eventType:type,...d});return}const win=frame.contentWindow;if(!win)return;win.document.dispatchEvent(new KeyboardEvent(type,{key:d.key,code:d.code,keyCode:d.keyCode,which:d.keyCode,bubbles:true,cancelable:true}));win.dispatchEvent(new KeyboardEvent(type,{key:d.key,code:d.code,keyCode:d.keyCode,which:d.keyCode,bubbles:true,cancelable:true}))}
function render(){for(const side of ['left','right']){const root=document.querySelector(`#${side}-pad`);root.innerHTML=layout[side].map(k=>`<button type="button" class="vkey" data-id="${k.id}" data-code="${k.code}" aria-label="虚拟按键 ${k.label}">${k.label}</button>`).join('')}}
function unlockMedia(){const win=frame.contentWindow;if(typeof win?.__mistUnlockMedia==='function')win.__mistUnlockMedia()}
function press(btn,pointerId){if(active.has(pointerId))return;active.set(pointerId,btn);btn.classList.add('is-pressed');unlockMedia();send(btn.dataset.code,'keydown');navigator.vibrate?.(12)}
function release(pointerId){const btn=active.get(pointerId);if(!btn)return;send(btn.dataset.code,'keyup');btn.classList.remove('is-pressed');active.delete(pointerId)}
pad.addEventListener('contextmenu',e=>e.preventDefault());
pad.addEventListener('pointerdown',e=>{const btn=e.target.closest('.vkey');if(btn){e.preventDefault();press(btn,e.pointerId)}});
pad.addEventListener('pointerup',e=>release(e.pointerId));
pad.addEventListener('pointercancel',e=>release(e.pointerId));
pad.addEventListener('lostpointercapture',e=>{if(active.has(e.pointerId))release(e.pointerId)});
window.addEventListener('blur',()=>[...active.keys()].forEach(release));
document.addEventListener('visibilitychange',()=>{if(document.hidden)[...active.keys()].forEach(release)});
function renderEditor(){document.querySelector('#key-list').innerHTML=['left','right'].flatMap(side=>layout[side].map((k,i)=>`<div class="key-row"><label>${side==='left'?'左':'右'} ${i+1} · 当前 ${k.label}</label><select data-side="${side}" data-index="${i}">${choices.map(([code,label])=>`<option value="${code}"${code===k.code?' selected':''}>${label}</option>`).join('')}</select></div>`)).join('')}
document.querySelector('#edit').onclick=()=>{renderEditor();dialog.showModal()};
dialog.addEventListener('close',()=>{if(dialog.returnValue!=='save')return;dialog.querySelectorAll('select').forEach(s=>{const item=layout[s.dataset.side][Number(s.dataset.index)],choice=choices.find(x=>x[0]===s.value);item.code=choice[0];item.label=choice[1].replace('方向','')});localStorage.setItem(storageKey,JSON.stringify(layout));render();toast('按键设置已保存')});
document.querySelector('#reset').onclick=()=>{layout=structuredClone(defaults);renderEditor()};
document.querySelector('#clear-save-cache').onclick=async()=>{
 if(isRgss3){if(!confirm('只重新加载当前网页中的 VX Ace 存档副本。NAS 原存档和服务器存档不会删除。是否继续？'))return;mkxpWorker?.postMessage({type:'sync-save'});toast('正在同步存档并重新加载');setTimeout(()=>location.reload(),700);return}
 if(!confirm('只清除当前浏览器中的 RPG Maker 存档缓存并重新加载游戏。NAS 原存档和你的服务器个人存档都不会删除。是否继续？'))return;
 const win=frame.contentWindow;
 try{
  if(typeof win.__mistClearSaveCache==='function')await win.__mistClearSaveCache();
  else{
   for(const key of Object.keys(win.localStorage)){if(key==='RPG Config'||key==='RPG Global'||/^RPG File\d+(?:bak)?$/.test(key)||/^rmmzsave[.:]/i.test(key))win.localStorage.removeItem(key)}
   await new Promise((resolve,reject)=>{const r=win.indexedDB.deleteDatabase('localforage');r.onsuccess=r.onblocked=()=>resolve();r.onerror=()=>reject(r.error)}).catch(()=>{});
  }
  toast('缓存已清除，正在重新读取原存档');setTimeout(()=>{frame.src=`/games/${gameId}/?shell=1&cache=${Date.now()}`},500);
 }catch(e){toast(`清除失败：${e.message}`)}
};
document.querySelector('#clear-browser-cache').onclick=async()=>{
 if(!confirm('清除雾灯为这个游戏缓存的所有资源（脚本/图片/音频），然后强制重新加载。你的存档不会受影响。\n\n注意：浏览器自身的磁盘缓存无法用网页清除；如果清除后问题仍在，请在浏览器设置中清除本网站的缓存数据后重试。是否继续？'))return;
 try{
  const win=frame.contentWindow;
  if(win?.caches?.keys){const keys=await win.caches.keys();await Promise.all(keys.map(k=>win.caches.delete(k).catch(()=>{})))}
  if(globalThis.caches?.keys){const keys=await caches.keys();await Promise.all(keys.map(k=>caches.delete(k).catch(()=>{})))}
  if(win?.localStorage){for(const key of Object.keys(win.localStorage)){if(key.startsWith('mist-')||key.startsWith('__mist'))win.localStorage.removeItem(key)}}
  toast('资源缓存已清除，正在强制重新加载');setTimeout(()=>{frame.src=`/games/${gameId}/?shell=1&cache=${Date.now()}`},500);
 }catch(e){toast(`清除失败：${e.message}`)}
};
document.querySelector('#hide').onclick=e=>{document.body.classList.toggle('pad-hidden');e.currentTarget.textContent=document.body.classList.contains('pad-hidden')?'显示按键':'隐藏按键'};
document.querySelector('#fullscreen').onclick=async()=>{try{document.fullscreenElement?await document.exitFullscreen():await document.documentElement.requestFullscreen()}catch{toast('浏览器不允许自动全屏')}};
document.querySelector('#back').onclick=()=>location.href='/';
// 工具栏抽屉：默认收起（侧边 ☰ 把手），点击展开/收起；桌面宽屏默认展开，触屏/窄屏默认收起
(()=>{
  const tools=document.querySelector('#top-tools'),toggle=document.querySelector('#tool-drawer-toggle');
  if(!tools||!toggle)return;
  const coarse=matchMedia('(pointer: coarse)').matches,narrow=innerWidth<900;
  const setOpen=open=>{
    tools.classList.toggle('is-open',open);
    toggle.classList.toggle('is-open',open);
    toggle.setAttribute('aria-expanded',open?'true':'false');
    toggle.setAttribute('aria-label',open?'收起工具栏':'展开工具栏');
  };
  toggle.addEventListener('click',e=>{e.stopPropagation();setOpen(!tools.classList.contains('is-open'))});
  // 展开后点击页面其他区域（游戏画面/加载层）自动收起；iframe 内点击不冒泡，另在 iframe 加载后监听其 document
  document.addEventListener('pointerdown',e=>{if(tools.classList.contains('is-open')&&!tools.contains(e.target)&&!toggle.contains(e.target))setOpen(false)});
  const attachFrameDismiss=()=>{try{const doc=frame.contentDocument;if(doc)doc.addEventListener('pointerdown',()=>setOpen(false),{passive:true})}catch{}};
  frame.addEventListener('load',attachFrameDismiss);
  setOpen(!coarse&&!narrow);
})();
function toast(text){const el=document.querySelector('#toast');el.textContent=text;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),1800)}
render();
window.addEventListener('pagehide',()=>{if(isRgss3)mkxpWorker?.postMessage({type:'sync-save'})});
