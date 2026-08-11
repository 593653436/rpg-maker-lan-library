import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),violations=[];
const forbiddenDirs=new Set(['data','games','recollections','library','log','logs','MTool','.cache','node_modules']);
const forbiddenExt=new Set(['.rpgsave','.rmmzsave','.rvdata2','.rpgmvp','.rpgmvo','.rpgmvm','.png_','.exe','.dll','.pak','.nw']);
const textExt=new Set(['.js','.mjs','.cjs','.json','.md','.html','.css','.yml','.yaml','.txt','.bat','.sh','.gitignore']);
const forbiddenText=[
  [/192\.168\.0\.(?:5|54)\b/g,'private IP from the original environment'],
  [/C:\\hermes\\/gi,'original absolute path'],
  [/\\\\192\.168\.0\.5\\/g,'original NAS path'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,'hard-coded UUID'],
  [/(?:sessionSecret|adminPasswordHash|adminPasswordSalt)"?\s*:\s*"(?!generated-by-npm-run-setup)[0-9a-f]{24,}/gi,'embedded authentication secret'],
  [/(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/g,'GitHub token']
];
function trackedFiles(){
  try{return execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean)}catch{return null}
}
async function sourceFiles(dir=root,relative=''){
  const files=[];
  for(const entry of await fsp.readdir(dir,{withFileTypes:true})){
    if(entry.name==='.git'||forbiddenDirs.has(entry.name))continue;
    const rel=relative?`${relative}/${entry.name}`:entry.name,full=path.join(dir,entry.name);
    if(entry.isDirectory())files.push(...await sourceFiles(full,rel));else files.push(rel)
  }
  return files
}
const files=trackedFiles()||await sourceFiles();
for(const rel of files){
  const parts=rel.replaceAll('\\','/').split('/'),ext=path.extname(rel).toLowerCase();
  if(parts.some(part=>forbiddenDirs.has(part)))violations.push(`${rel}: tracked runtime/private directory`);
  if(forbiddenExt.has(ext))violations.push(`${rel}: forbidden game/binary extension`);
  if(!textExt.has(ext)&&path.basename(rel)!=='.gitignore')continue;
  const text=await fsp.readFile(path.join(root,rel),'utf8').catch(()=>null);if(text===null)continue;
  for(const [pattern,label] of forbiddenText){pattern.lastIndex=0;if(pattern.test(text))violations.push(`${rel}: ${label}`)}
}
if(violations.length){console.error('Public audit failed:\n'+[...new Set(violations)].map(x=>' - '+x).join('\n'));process.exit(1)}
console.log(JSON.stringify({ok:true,files:files.length,checks:['tracked-runtime-data','game-assets','private-paths','hard-coded-uuids','embedded-secrets']}));
