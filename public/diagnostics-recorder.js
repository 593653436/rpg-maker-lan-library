(() => {
  const root=globalThis;
  const MAX_CONSOLE=300,MAX_ERRORS=100,MAX_RESOURCES=120,MAX_SCRIPTS=120,MAX_TEXT=4000;
  const now=()=>new Date().toISOString();
  const trim=value=>String(value).slice(0,MAX_TEXT);
  function safeValue(value,depth=0,seen=new WeakSet()){
    if(value==null||typeof value==='boolean'||typeof value==='number')return value;
    if(typeof value==='string')return trim(value);
    if(typeof value==='bigint'||typeof value==='symbol'||typeof value==='function')return trim(value);
    if(value instanceof Error)return{name:value.name,message:trim(value.message),stack:trim(value.stack||'')};
    if(depth>=4)return trim(Object.prototype.toString.call(value));
    if(typeof value==='object'){
      if(seen.has(value))return'[Circular]';seen.add(value);
      if(Array.isArray(value))return value.slice(0,40).map(x=>safeValue(x,depth+1,seen));
      const out={};let count=0;
      for(const key of Object.keys(value)){if(count++>=50){out.__truncated=true;break}try{out[key]=safeValue(value[key],depth+1,seen)}catch(error){out[key]=`[读取失败: ${error.message}]`}}
      return out;
    }
    return trim(value);
  }
  const push=(list,value,max)=>{list.push(value);if(list.length>max)list.splice(0,list.length-max)};
  function install(options={}){
    if(root.__mistLogRecorder)return root.__mistLogRecorder;
    const state={schemaVersion:1,scope:options.scope||'unknown',gameId:options.gameId||null,startedAt:now(),consoleLogs:[],errors:[],rejections:[],resourceErrors:[],scripts:[]};
    for(const level of ['log','info','warn','error','debug']){
      const original=typeof console[level]==='function'?console[level].bind(console):()=>{};
      const wrapped=function(...args){push(state.consoleLogs,{time:now(),level,args:args.map(x=>safeValue(x))},MAX_CONSOLE);return original(...args)};
      try{Object.defineProperty(wrapped,'name',{value:`mist_${level}`})}catch{}
      console[level]=wrapped;
    }
    addEventListener('error',event=>{
      const target=event.target;
      if(target&&target!==root&&target.tagName){
        push(state.resourceErrors,{time:now(),tag:String(target.tagName),url:trim(target.currentSrc||target.src||target.href||''),outerHTML:trim(target.outerHTML||'')},MAX_RESOURCES);return;
      }
      push(state.errors,{time:now(),message:trim(event.message||event.error?.message||'Unknown error'),file:trim(event.filename||''),line:event.lineno||null,column:event.colno||null,stack:trim(event.error?.stack||'')},MAX_ERRORS);
    },true);
    addEventListener('unhandledrejection',event=>push(state.rejections,{time:now(),reason:safeValue(event.reason instanceof Error?event.reason:{value:event.reason})},MAX_ERRORS));
    try{new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes||[])if(node?.tagName==='SCRIPT'){const item={time:now(),src:trim(node.src||'[inline]'),state:'added'};push(state.scripts,item,MAX_SCRIPTS);node.addEventListener?.('load',()=>item.state='loaded',{once:true});node.addEventListener?.('error',()=>item.state='error',{once:true})}}).observe(document.documentElement,{childList:true,subtree:true})}catch{}
    function interpreter(value){
      if(!value)return null;
      let current=null;try{current=value.currentCommand?.()||value._list?.[value._index]||null}catch{}
      return{eventId:value._eventId??null,index:value._index??null,waitMode:value._waitMode??null,waitCount:value._waitCount??null,running:typeof value.isRunning==='function'?Boolean(value.isRunning()):Boolean(value._list?.length),currentCommand:safeValue(current),child:value._childInterpreter?interpreter(value._childInterpreter):null};
    }
    function runtime(){
      let databaseLoaded=null;try{databaseLoaded=typeof DataManager!=='undefined'?Boolean(DataManager.isDatabaseLoaded?.()):null}catch(error){databaseLoaded=`error: ${error.message}`}
      let errorPrinter='';try{errorPrinter=trim(document.querySelector('#ErrorPrinter, #errorPrinter')?.innerText||'')}catch{}
      const manager=typeof SceneManager!=='undefined'?SceneManager:null,map=typeof $gameMap!=='undefined'?$gameMap:null,player=typeof $gamePlayer!=='undefined'?$gamePlayer:null;
      return{
        engine:typeof Utils!=='undefined'?{name:Utils.RPGMAKER_NAME||null,version:Utils.RPGMAKER_VERSION||null}:null,
        scene:manager?._scene?.constructor?.name||null,nextScene:manager?._nextScene?.constructor?.name||null,sceneStopped:manager?._stopped??null,sceneStack:(manager?._stack||[]).map(x=>x?.name||x?.constructor?.name||trim(x)),
        dataErrorUrl:typeof DataManager!=='undefined'?DataManager._errorUrl||null:null,databaseLoaded,errorPrinter,
        map:map?{id:map._mapId??null,displayName:typeof $dataMap!=='undefined'?$dataMap?.displayName||null:null}:null,
        player:player?{x:player._x??null,y:player._y??null,direction:player._direction??null}:null,
        interpreter:interpreter(map?._interpreter),messageBusy:typeof $gameMessage!=='undefined'&&typeof $gameMessage?.isBusy==='function'?Boolean($gameMessage.isBusy()):null
      };
    }
    function browser(){return{url:location.href,userAgent:navigator.userAgent,language:navigator.language,platform:navigator.platform,online:navigator.onLine,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},screen:{width:screen?.width||null,height:screen?.height||null},documentReady:document.readyState}}
    function networkResources(){try{return performance.getEntriesByType('resource').slice(-200).map(x=>({name:trim(x.name),initiatorType:x.initiatorType||null,duration:Math.round(x.duration||0),transferSize:x.transferSize||0,encodedBodySize:x.encodedBodySize||0,decodedBodySize:x.decodedBodySize||0}))}catch{return[]}}
    const api={state,snapshot(){return{schemaVersion:1,scope:state.scope,gameId:state.gameId,startedAt:state.startedAt,capturedAt:now(),browser:browser(),runtime:runtime(),consoleLogs:state.consoleLogs.slice(),errors:state.errors.slice(),rejections:state.rejections.slice(),resourceErrors:state.resourceErrors.slice(),scripts:state.scripts.slice(),networkResources:networkResources()}}};
    root.__mistLogRecorder=api;return api;
  }
  root.__mistInstallDiagnostics=install;
  const script=document.currentScript,scope=script?.dataset?.mistScope;
  if(scope)install({scope,gameId:script.dataset.gameId||null});
})();
