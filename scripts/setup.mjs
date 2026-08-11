import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url))),root=process.env.RPG_SETUP_ROOT?path.resolve(process.env.RPG_SETUP_ROOT):defaultRoot,configFile=path.join(root,'config.json'),force=process.argv.includes('--force');
const existing=await fsp.readFile(configFile,'utf8').then(JSON.parse).catch(()=>null);
if(existing&&!force){
  console.error('config.json 已存在。若只想轮换管理员和游客凭据，请运行 npm run setup -- --force');
  process.exit(1)
}
const randomPassword=()=>crypto.randomBytes(12).toString('base64url'),hash=password=>{const salt=crypto.randomBytes(16).toString('hex');return{salt,value:crypto.scryptSync(password,salt,64).toString('hex')}};
const adminPassword=process.env.RPG_ADMIN_PASSWORD||randomPassword(),guestPassword=process.env.RPG_GUEST_PASSWORD||randomPassword(),admin=hash(adminPassword),guest=hash(guestPassword);
const config={...existing,host:existing?.host||'0.0.0.0',port:existing?.port||8787,sourceRoot:existing?.sourceRoot||path.join(root,'games'),recollectionRoot:existing?.recollectionRoot||path.join(root,'recollections'),libraryDir:existing?.libraryDir||'./library',dataDir:existing?.dataDir||'./data',siteTitle:existing?.siteTitle||'RPG Maker LAN Library',auth:{adminUsername:process.env.RPG_ADMIN_USERNAME||existing?.auth?.adminUsername||'admin',adminPasswordSalt:admin.salt,adminPasswordHash:admin.value,sessionSecret:crypto.randomBytes(32).toString('hex')}};
const dataDir=path.resolve(root,config.dataDir),existingSettings=await fsp.readFile(path.join(path.resolve(root,config.dataDir),'settings.json'),'utf8').then(JSON.parse).catch(()=>null),writeIfMissing=async(file,content)=>{try{await fsp.writeFile(file,content,{encoding:'utf8',flag:'wx'})}catch(error){if(error.code!=='EEXIST')throw error}};
await Promise.all([fsp.mkdir(config.sourceRoot,{recursive:true}),fsp.mkdir(config.recollectionRoot,{recursive:true}),fsp.mkdir(dataDir,{recursive:true})]);
await fsp.writeFile(configFile,JSON.stringify(config,null,2)+'\n','utf8');
await fsp.writeFile(path.join(dataDir,'settings.json'),JSON.stringify({version:1,guestAccess:{passwordSalt:guest.salt,passwordHash:guest.value,sessionVersion:Number(existingSettings?.guestAccess?.sessionVersion||0)+1,updatedAt:new Date().toISOString()}},null,2)+'\n','utf8');
await Promise.all([
  writeIfMissing(path.join(dataDir,'games.json'),'[]\n'),
  writeIfMissing(path.join(dataDir,'users.json'),JSON.stringify({version:1,accounts:[]},null,2)+'\n'),
  writeIfMissing(path.join(dataDir,'ratings.json'),JSON.stringify({version:1,games:{},legacyRatingsMigrated:true},null,2)+'\n')
]);
console.log(`\n${existing?'凭据轮换':'初始化'}完成。以下密码只显示这一次，请保存到密码管理器：`);
console.log(`管理员账号：${config.auth.adminUsername}`);
console.log(`管理员密码：${adminPassword}`);
console.log(`游客密码：${guestPassword}`);
console.log(`游戏目录：${config.sourceRoot}`);
console.log(`回想网页目录：${config.recollectionRoot}`);
