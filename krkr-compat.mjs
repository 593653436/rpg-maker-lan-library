import fsp from 'node:fs/promises';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const XP3_HEADER=Buffer.from([0x58,0x50,0x33,0x0d,0x0a,0x20,0x0a,0x1a,0x8b,0x67,0x01]);const OVERRIDE_NAME='system/Override.tjs',CUSTOM_MAIN_NAME='system/CustomMainWindow.tjs',MESSAGE_LAYER_NAME='system/default/MessageLayer.tjs',SYS_TITLE_NAME='SysTitle.ks',FLAGS_INIT_NAME='FlagsInitialize.tjs';
const SUMIRE_SCENE_KEYS=['h01_02','h01_03','h02','h03_02','h03_03','h04','h05','h06','h07','h08','h09','h10','h11','h12','h13'];
const SUMIRE_CG_KEYS=['H010','H020','H030','H040','H050','H0601','H070','H080','H090','H100','H110','H120','H130','H140','H150','H160','H170','H180','H190','H200','H2101','H220','H011','H012','H013','H014','H015','H021','H022','H023','H024','H025','H026','H0261','H027','H028','H0281','H029','H031','H032','H0331','H034','H035','H037','H0371','H038','H039','H0391','H039a','H039b','H039c','H039d','H039e','H041','H042','H043','H044','H045','H046','H047','H048','H049','H051','H052','H053','H054','H055','H061','H062','H063','H0631','H064','H0641','H065','H066','H067','H068','H069','H069a','H069b1','H071','H072','H073','H074','H0741','H075','H076','H0771','H081','H082','H083','H084','H085','H086','H087','H088','H089','H089a1','H089a2','H091','H092','H093','H094','H095','H096','H097','H098','H0991','H0992','H099a','H099a1','H101','H102','H103','H104','H105','H106','H107','H108','H109','H109a','H111','H112','H113','H114','H115','H1151','H116','H117','H118','H119','H119a','H119b','H119c','H119d','H119e','H119e1','H121','H122','H123','H124','H125','H126','H127','H128','H129','H129a','H131','H132','H133','H134','H135','H136','H137','H138','H139','H139a','H139b','H139c','H141','H142','H143','H1431','H144','H1441','H145','H146','H1461','H147','H148','H149','H149a','H149b','H151','H152','H153','H154','H1541','H1551','H156','H1561','H157','H1571','H158','H159','H159a','H159a1','H159b','H159c','H159c1','H161','H162','H163','H164','H1641','H1642','H165','H166','H167','H168','H169','H169a','H171','H172','H173','H174','H175','H176','H177','H178','H179','H179a','H179b','H179c','H181','H182','H183','H184','H185','H186','H187','H188','H189','H189a','H189b','H189c','H189d','H189e','H189f','H189g','H189h','H189i','H189j','H189l','H191','H192','H193','H194','H195','H201','H202','H203','H204','H205','H206','H207','H208','H209','H2091','H211','H212','H213','H214','H215','H216','H217','H218','H221','H222','H223','H224','H225','H226','H227'];

function u16(value){const out=Buffer.alloc(2);out.writeUInt16LE(value);return out}
function u32(value){const out=Buffer.alloc(4);out.writeUInt32LE(value>>>0);return out}
function u64(value){const out=Buffer.alloc(8);out.writeBigUInt64LE(BigInt(value));return out}
function chunk(name,data){return Buffer.concat([Buffer.from(name,'ascii'),u64(data.length),data])}
function adler32(buffer){let a=1,b=0;for(const value of buffer){a=(a+value)%65521;b=(b+a)%65521}return ((b<<16)|a)>>>0}
function utf16Script(text){return Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(text.replaceAll('\n','\r\n'),'utf16le')])}

export function buildXp3(files){
  const header=Buffer.concat([XP3_HEADER,Buffer.alloc(8)]),parts=[header],items=[];let offset=header.length;
  for(const file of [...files].sort((a,b)=>a.name.localeCompare(b.name,'en'))){
    const raw=Buffer.isBuffer(file.data)?file.data:Buffer.from(file.data),packed=deflateSync(raw),compressed=packed.length<raw.length,data=compressed?packed:raw;
    parts.push(data);items.push({name:file.name.replaceAll('/','\\'),offset,rawSize:raw.length,packedSize:data.length,compressed,hash:adler32(raw)});offset+=data.length;
  }
  const rawIndex=Buffer.concat(items.map(buildFileChunk)),packedIndex=deflateSync(rawIndex),indexOffset=offset,indexBlock=Buffer.concat([Buffer.from([1]),u64(packedIndex.length),u64(rawIndex.length),packedIndex]);
  header.writeBigUInt64LE(BigInt(indexOffset),11);return Buffer.concat([...parts,indexBlock]);
}

function buildFileChunk(item){
  const name=Buffer.from(item.name.replaceAll('/','\\'),'utf16le'),info=Buffer.concat([u32(item.flags||0),u64(item.rawSize),u64(item.packedSize),u16(name.length/2),name]);
  const segm=Buffer.concat([u32(item.compressed?1:0),u64(item.offset),u64(item.rawSize),u64(item.packedSize)]);
  return chunk('File',Buffer.concat([chunk('info',info),chunk('segm',segm),chunk('adlr',u32(item.hash))]));
}

const override=`/************************************************
 * Override.tjs
 * 　　Copyright (C) 2016 courreges software, All Rights Reserved.
************************************************/
KAGLoadScriptOnce("CustomHistoryLayer.tjs");
KAGLoadScriptOnce("CustomMainWindow.tjs");
if(System.versionInformation.substr(9,1) == 'Z'){
/**/Scripts.require("KrkrzAddMainWindow.tjs");
}
KAGLoadScriptOnce("AfterFunction.tjs");
/* 雾灯 KRKR Web 兼容：Web 版版本字符串不满足 CustomMainWindow.tjs 的 KR2 判定，按原 KR2 路径创建自定义 KAG 窗口 */
global.kag = new CustomKAGWindow() if typeof global.kag == "undefined";
/*TKHS*/KAGLoadScriptOnce("SaveDataPlugin.tjs");
/*TKHS*/KAGLoadScriptOnce("ConfigPlugin.tjs");
/*TKHS*/KAGLoadScriptOnce("MoviePlayerPlugin.tjs");
/*TKHS*/Scripts.require("ExButtonLayer.tjs");
Scripts.require("Strings.tjs");
`;

export function transformSumireMessageLayer(original){
  const expTarget="Scripts.eval(ln.exp) if ln.exp != '';";
  const keyBlock='/*+*///\t\tif(window.getKeyState(VK_RETURN) || window.getKeyState(VK_SPACE))\r\n/*+*/\t\tif(window.getKeyState(VK_RETURN) || window.getKeyState(VK_CONTROL))\r\n\t\t\t\twindow.hideMouseCursor();\r\n\t\t\t\t\t// キーボードによる操作の場合はマウスカーソルを隠す';
  const conditionTarget="if(ln.storage != '' || ln.target != '')";
  const processTarget='window.process(ln.storage, ln.target, ln.countPage);';
  for(const [label,target] of [['exp',expTarget],['key state',keyBlock],['condition',conditionTarget],['process',processTarget]])if(original.split(target).length!==2)throw new Error(`${MESSAGE_LAYER_NAME} ${label} 兼容签名不匹配`);
  return original
    .replace(expTarget,"Scripts.eval(ln.exp) if ln.exp !== void && ln.exp != '';\r\n\t\tvar storage = ln.storage === void ? '' : ln.storage;\r\n\t\tvar target = ln.target === void ? '' : ln.target;")
    .replace(keyBlock,'// 雾灯 KRKR Web 兼容：跳过不影响跳转语义的键盘状态查询/鼠标光标隐藏')
    .replace(conditionTarget,"if(storage != '' || target != '')")
    .replace(processTarget,'window.process(storage, target, ln.countPage);');
}

const dataReplacements=new Map([
  [OVERRIDE_NAME,{raw:utf16Script(override),signature:['KAGLoadScriptOnce("CustomMainWindow.tjs")','KAGLoadScriptOnce("SaveDataPlugin.tjs")','KAGLoadScriptOnce("ConfigPlugin.tjs")','KAGLoadScriptOnce("MoviePlayerPlugin.tjs")']}],
  [CUSTOM_MAIN_NAME,{transform(original){
    const target=/^([ \t]*)snapshotLayer\.copyBlueToAlpha\(tmp\);[ \t]*(?:\r?\n|$)/m;
    if(!target.test(original))throw new Error(`${CUSTOM_MAIN_NAME} 兼容签名不匹配：copyBlueToAlpha`);
    if((original.match(/copyBlueToAlpha/g)||[]).length!==1)throw new Error(`${CUSTOM_MAIN_NAME} copyBlueToAlpha 调用数量异常`);
    for(const sig of ['tmp.fillRect(0, 0, sourceWidth, sourceHeight, 0xffffffff);','.type = ltOpaque;','.face = dfOpaque;'])if(!original.includes(sig))throw new Error(`${CUSTOM_MAIN_NAME} 兼容签名不匹配：${sig}`);
    return Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(original.replace(target,'$1/* 雾灯 KRKR Web 兼容：源层为纯白，目标已为 ltOpaque/dfOpaque；无需 layerExSave.dll 的蓝通道转 Alpha */'),'utf16le')]);
  }}],
  [MESSAGE_LAYER_NAME,{transform(original){return Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(transformSumireMessageLayer(original),'utf16le')])}}],
]);

export function transformSumireCompletionFlags(original,{sceneKeys=SUMIRE_SCENE_KEYS,cgKeys=SUMIRE_CG_KEYS}={}){
  const marker='// 雾灯 KRKR Web：Sumire 全回想与全CG直达解锁';
  if(original.includes(marker))return Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(original,'utf16le')]);
  for(const sig of ['sf.UsedCG = %[] if sf.UsedCG === void;','sf.UsedScene = %[] if sf.UsedScene === void;','sf.flagsinit = true;'])if(!original.includes(sig))throw new Error(`${FLAGS_INIT_NAME} 全解锁签名不匹配：${sig}`);
  const target='// 読み込み完了';
  if(original.split(target).length!==2)throw new Error(`${FLAGS_INIT_NAME} 全解锁插入点数量异常`);
  const lines=[marker,...sceneKeys.map(key=>`sf.UsedScene.${key} = 1;`),...cgKeys.map(key=>`sf.UsedCG.${key} = 1;`),`sf.LookScene = ${sceneKeys.length};`,`sf.LookCG = ${cgKeys.length};`,'sf.CompScene = 100;','sf.CompCG = 100;',''];
  return Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(original.replace(target,lines.join('\r\n')+target),'utf16le')]);
}

const patchReplacements=new Map([
  [FLAGS_INIT_NAME,{transform(original){return transformSumireCompletionFlags(original)}}],
  [SYS_TITLE_NAME,{transform(original){
    const target='[wv canskip=true]';
    for(const sig of ['[サークル動画再生]','[動画再生停止]','[動画解放]','[playse buf=&global.SSE_BUF storage="circlelogo.ogg" loop=false]'])if(!original.includes(sig))throw new Error(`${SYS_TITLE_NAME} 启动影片兼容签名不匹配：${sig}`);
    if((original.match(/\[wv canskip=true\]/g)||[]).length!==1)throw new Error(`${SYS_TITLE_NAME} wv 调用数量异常`);
    const buttonTarget='tag.ボタン(%[x:BT.x, y:BT.y, graphic:BT.images, target:BT.target]);';
    for(const sig of ["target:'*click_start'","target:'*click_animation'","target:'*click_memory'"])if(!original.includes(sig))throw new Error(`${SYS_TITLE_NAME} 标题按钮兼容签名不匹配：${sig}`);
    if(original.split(buttonTarget).length!==2)throw new Error(`${SYS_TITLE_NAME} target 按钮构造数量异常`);
    let output=original.replace(target,'; 雾灯 KRKR Web 兼容：circlelogo.mpg 固定 10.01 秒，EOF 未推进时采用有界等待\r\n[wait time=11000 canskip=true]').replace(buttonTarget,"tag.ボタン(%[x:BT.x, y:BT.y, graphic:BT.images, storage:'', target:BT.target, exp:'']);");
    return Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(output,'utf16le')]);
  }}],
]);

async function readExact(handle,offset,length){const out=Buffer.alloc(length);const {bytesRead}=await handle.read(out,0,length,offset);if(bytesRead!==length)throw new Error(`XP3 读取不足：${offset}+${length}`);return out}
function parseChunks(buffer){const out=[];let pos=0;while(pos<buffer.length){if(pos+12>buffer.length)throw new Error('XP3 chunk 头损坏');const name=buffer.toString('ascii',pos,pos+4),size=Number(buffer.readBigUInt64LE(pos+4)),end=pos+12+size;if(end>buffer.length)throw new Error(`XP3 ${name} chunk 越界`);out.push({name,data:buffer.subarray(pos+12,end)});pos=end}return out}

async function readIndex(handle){
  const header=await readExact(handle,0,19);if(!header.subarray(0,11).equals(XP3_HEADER))throw new Error('不是标准 XP3 档案');let next=Number(header.readBigUInt64LE(11)),rawParts=[];
  while(true){const flag=(await readExact(handle,next,1))[0];let pos=next+1,raw;
    if((flag&7)===1){const sizes=await readExact(handle,pos,16),packed=Number(sizes.readBigUInt64LE(0)),rawSize=Number(sizes.readBigUInt64LE(8));pos+=16;raw=inflateSync(await readExact(handle,pos,packed));if(raw.length!==rawSize)throw new Error('XP3 索引解压长度不符');pos+=packed}
    else if((flag&7)===0){const size=Number((await readExact(handle,pos,8)).readBigUInt64LE());pos+=8;raw=await readExact(handle,pos,size);pos+=size}
    else throw new Error(`XP3 索引编码不支持：${flag&7}`);
    rawParts.push(raw);if(!(flag&0x80))break;next=Number((await readExact(handle,pos,8)).readBigUInt64LE());
  }
  return Buffer.concat(rawParts);
}

function parseFileChunk(fileChunk){
  const parts=parseChunks(fileChunk),info=parts.find(x=>x.name==='info'),segm=parts.find(x=>x.name==='segm'),adlr=parts.find(x=>x.name==='adlr');if(!info||!segm||!adlr)throw new Error('XP3 File chunk 缺少必要字段');
  const length=info.data.readUInt16LE(20),name=info.data.subarray(22,22+length*2).toString('utf16le').replaceAll('\\','/'),segments=[];
  for(let pos=0;pos<segm.data.length;pos+=28)segments.push({compressed:(segm.data.readUInt32LE(pos)&7)===1,offset:Number(segm.data.readBigUInt64LE(pos+4)),rawSize:Number(segm.data.readBigUInt64LE(pos+12)),packedSize:Number(segm.data.readBigUInt64LE(pos+20))});
  return {parts,info,segm,adlr,name,segments};
}

async function readEntry(handle,item){const out=[];for(const seg of item.segments){const packed=await readExact(handle,seg.offset,seg.packedSize),raw=seg.compressed?inflateSync(packed):packed;if(raw.length!==seg.rawSize)throw new Error(`${item.name} 解压长度不符`);out.push(raw)}return Buffer.concat(out)}

export async function extractXp3Entry(source,name){
  const handle=await fsp.open(source,'r');
  try{
    const rawIndex=await readIndex(handle),fileChunks=parseChunks(rawIndex),wanted=String(name).replaceAll('\\','/').toLowerCase();
    for(const fileChunk of fileChunks){if(fileChunk.name!=='File')continue;const item=parseFileChunk(fileChunk.data);if(item.name.toLowerCase()===wanted)return await readEntry(handle,item)}
    throw new Error(`XP3 条目不存在：${name}`);
  }finally{await handle.close()}
}

export async function buildPatchedXp3(source,replacements=dataReplacements,compatVersion='sumire-kag-order-v4'){
  const stat=await fsp.stat(source);if(!stat.isFile())throw new Error('data.xp3 不存在');const handle=await fsp.open(source,'r');
  try{
    const rawIndex=await readIndex(handle),fileChunks=parseChunks(rawIndex);if(fileChunks.some(x=>x.name!=='File'))throw new Error('XP3 索引包含未知顶层 chunk');
    const parsed=fileChunks.map(x=>({wrapper:x,item:parseFileChunk(x.data)})),found=new Map();
    for(const entry of parsed)if(replacements.has(entry.item.name))found.set(entry.item.name,entry.item);
    const prepared=new Map();
    for(const [name,replacement] of replacements){
      const item=found.get(name);if(!item)throw new Error(`XP3 兼容签名缺少 ${name}`);
      const original=(await readEntry(handle,item)).toString('utf16le').replace(/^\ufeff/,'');
      for(const sig of replacement.signature||[])if(!original.includes(sig))throw new Error(`${name} 兼容签名不匹配：${sig}`);
      const raw=replacement.transform?replacement.transform(original):replacement.raw;
      prepared.set(name,{...replacement,raw});
    }
    let appendOffset=stat.size;const appended=[];const replacementMeta=new Map();
    for(const [name,replacement] of prepared){const packed=deflateSync(replacement.raw);replacementMeta.set(name,{name,offset:appendOffset,rawSize:replacement.raw.length,packedSize:packed.length,compressed:true,hash:adler32(replacement.raw)});appended.push(packed);appendOffset+=packed.length}
    const rebuilt=[];
    for(const entry of parsed){const replacement=replacementMeta.get(entry.item.name);rebuilt.push(replacement?buildFileChunk({...replacement,flags:entry.item.info.data.readUInt32LE(0)}):entry.wrapper.data.length?chunk('File',entry.wrapper.data):entry.wrapper)}
    const newRawIndex=Buffer.concat(rebuilt),packedIndex=deflateSync(newRawIndex),indexOffset=appendOffset,indexBlock=Buffer.concat([Buffer.from([1]),u64(packedIndex.length),u64(newRawIndex.length),packedIndex]),tail=Buffer.concat([...appended,indexBlock]),pointer=u64(indexOffset);
    return {name:path.basename(source),source,originalSize:stat.size,size:stat.size+tail.length,virtualParts:[{start:0,end:10,sourceStart:0},{start:11,end:18,buffer:pointer},{start:19,end:stat.size-1,sourceStart:19},{start:stat.size,end:stat.size+tail.length-1,buffer:tail}],compatVersion};
  }finally{await handle.close()}
}

export const buildPatchedDataXp3=(source)=>buildPatchedXp3(source,dataReplacements,'sumire-skip-key-state-v13');
export const buildPatchedPatchXp3=(source)=>buildPatchedXp3(source,patchReplacements,'sumire-gallery-unlock-v5');

export async function applyKrkrCompat(files,apply){
  if(!apply)return files;
  for(const [fileName,builder] of [['data.xp3',buildPatchedDataXp3],['patch.xp3',buildPatchedPatchXp3]]){
    const index=files.findIndex(x=>x.name.toLowerCase()===fileName);if(index<0){if(fileName==='data.xp3')throw new Error('KRKR 游戏缺少 data.xp3');continue}
    files[index]={...files[index],...await builder(files[index].source)};
  }
  return files;
}

export function getKrkrScriptOrderCompat(apply){
  if(!apply)return null;return {files:[...dataReplacements].map(([name,x])=>({name,buffer:x.raw})),version:'sumire-skip-key-state-v13'};
}
