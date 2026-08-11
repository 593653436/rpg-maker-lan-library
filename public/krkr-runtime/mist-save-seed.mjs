// 内置存档播种（bundled save seed）。
// 存档清单由服务端按 config.krkrBundledSaveFiles 注入到 index.html 的
// window.__mistBundledSaveManifests，经 seedBundledSaves({gameId, manifest: ...}) 传入；
// 本模块不持有任何具体游戏 ID。manifest 缺省时静默跳过播种。

export const BUNDLED_SAVE_MANIFESTS = {};

const canonicalPath=name=>`/savedata/${name}`;
const normalizePath=value=>String(value||'').replaceAll('\\','/').replace(/\/+/g,'/').toLowerCase();

async function sha256Hex(data){
  if(!globalThis.crypto?.subtle)throw new Error('WebCrypto SHA-256 unavailable');
  const digest=await globalThis.crypto.subtle.digest('SHA-256',data);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

async function readBundledFile(vlfs,file,readBundled){
  let data;
  if(readBundled)data=new Uint8Array(await readBundled(file));
  else{
    const requested=`/SaveData/${file.name}`,resolved=vlfs.resolveCase(requested);
    if(!resolved)throw new Error(`bundled save missing: ${requested}`);
    const stat=vlfs.stat(resolved);
    if(!stat||stat.isDir||stat.size!==file.size)throw new Error(`bundled save size mismatch: ${requested}`);
    const fd=vlfs.open(resolved,0);
    if(fd<0)throw new Error(`bundled save open failed: ${requested}`);
    try{data=new Uint8Array(await vlfs.read(fd,file.size))}finally{vlfs.close(fd)}
  }
  if(data.length!==file.size)throw new Error(`bundled save size mismatch: ${file.name}`);
  if(file.sha256&&await sha256Hex(data)!==file.sha256)throw new Error(`bundled save hash mismatch: ${file.name}`);
  return data;
}

export async function seedBundledSaves({
  gameId,
  saveSpaceId,
  manifest,
  vlfs,
  readBundled,
  loadExisting,
  persist,
  writeFs,
  markerStorage=globalThis.localStorage,
}){
  if(!manifest||!saveSpaceId)return{supported:false,seeded:[],preserved:[],version:manifest?.version||null};
  const existing=await loadExisting();
  const existingPaths=new Set(existing.map(item=>normalizePath(item.path)));
  const markerKey=`mist-krkr-save-seed:${saveSpaceId}:${manifest.version}`;
  const migrateExisting=manifest.overwriteExistingOnce===true&&markerStorage?.getItem?.(markerKey)!=='complete';
  const seeded=[],replaced=[],preserved=[];
  for(const file of manifest.files){
    const destination=canonicalPath(file.name),exists=existingPaths.has(normalizePath(destination));
    if(exists&&!migrateExisting){preserved.push(destination);continue}
    const data=await readBundledFile(vlfs,file,readBundled);
    writeFs(destination,data);
    vlfs.registerOverlayFile(destination,data);
    await persist(destination,data);
    (exists?replaced:seeded).push(destination);
  }
  markerStorage?.setItem?.(markerKey,'complete');
  return{supported:true,seeded,replaced,preserved,version:manifest.version};
}
