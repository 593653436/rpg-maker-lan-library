import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const project=path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/,m=>m.slice(1))));

test('setup creates secrets and force only rotates credentials',async()=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'rpg-lan-setup-')),env={...process.env,RPG_SETUP_ROOT:root,RPG_ADMIN_PASSWORD:'first-admin',RPG_GUEST_PASSWORD:'first-guest'};
  try{
    let run=spawnSync(process.execPath,[path.join(project,'scripts','setup.mjs')],{cwd:project,env,encoding:'utf8'});assert.equal(run.status,0,run.stderr);
    const configFile=path.join(root,'config.json'),settingsFile=path.join(root,'data','settings.json'),gamesFile=path.join(root,'data','games.json');
    const firstConfig=JSON.parse(await fsp.readFile(configFile,'utf8')),firstSettings=JSON.parse(await fsp.readFile(settingsFile,'utf8'));
    await fsp.writeFile(gamesFile,JSON.stringify([{id:'synthetic-entry'}]));
    run=spawnSync(process.execPath,[path.join(project,'scripts','setup.mjs'),'--force'],{cwd:project,env:{...env,RPG_ADMIN_PASSWORD:'second-admin',RPG_GUEST_PASSWORD:'second-guest'},encoding:'utf8'});assert.equal(run.status,0,run.stderr);
    const secondConfig=JSON.parse(await fsp.readFile(configFile,'utf8')),secondSettings=JSON.parse(await fsp.readFile(settingsFile,'utf8')),games=JSON.parse(await fsp.readFile(gamesFile,'utf8'));
    assert.notEqual(secondConfig.auth.sessionSecret,firstConfig.auth.sessionSecret);
    assert.equal(secondSettings.guestAccess.sessionVersion,firstSettings.guestAccess.sessionVersion+1);
    assert.deepEqual(games,[{id:'synthetic-entry'}])
  }finally{await fsp.rm(root,{recursive:true,force:true})}
});
