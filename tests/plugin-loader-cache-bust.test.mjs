import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const server=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const match=/function pluginLoaderCompat\(\)\{return `([\s\S]*?)`\}/.exec(server);
assert.ok(match,'pluginLoaderCompat source missing');
const compat=match[1].replaceAll('\\n','\n').replaceAll('\\`','`');

const calls=[];
const context={PluginManager:{_path:'js/plugins/',loadScript(name){calls.push(this._path+name)}}};
vm.createContext(context);vm.runInContext(compat,context);
context.PluginManager.loadScript('TS_ReplayMode.js');
context.PluginManager.loadScript('TS_Decode.js');
context.PluginManager.loadScript('CommonSave.js');
context.PluginManager.loadScript('CGMZ_SplashScreen.js');
context.PluginManager.loadScript('TitleExtra.js');
context.PluginManager.loadScript('CGGallery.js');
context.PluginManager.loadScript('EventGallery.js');
context.PluginManager.loadScript('SubFolderPicture.js');
context.PluginManager.loadScript('NekoGakuen_SteamworksAPI.js');
context.PluginManager.loadScript('Ramza_PreTitleSplash_MZ.js');
context.PluginManager.loadScript('Chimaki_Lang.js');
context.PluginManager.loadScript('JsScript64Set.js');
context.PluginManager.loadScript('PicturePointColor.js');
context.PluginManager.loadScript('Unrelated.js');
assert.deepEqual(calls,[
 'js/plugins/.mistv/replay-mode-3/TS_ReplayMode.js',
 'js/plugins/.mistv/scenario-decode-3/TS_Decode.js',
 'js/plugins/.mistv/common-save-1/CommonSave.js',
 'js/plugins/.mistv/cyclone-steam-1/CGMZ_SplashScreen.js',
 'js/plugins/.mistv/title-extra-1/TitleExtra.js',
 'js/plugins/.mistv/cggallery-1/CGGallery.js',
 'js/plugins/.mistv/eventgallery-1/EventGallery.js',
 'js/plugins/.mistv/subfolder-picture-1/SubFolderPicture.js',
 'js/plugins/.mistv/steamworks-3/NekoGakuen_SteamworksAPI.js',
 'js/plugins/.mistv/ramza-splash-1/Ramza_PreTitleSplash_MZ.js',
 'js/plugins/.mistv/chimaki-lang-1/Chimaki_Lang.js',
 'js/plugins/.mistv/jsscript64-1/JsScript64Set.js',
 'js/plugins/.mistv/ppc-1/PicturePointColor.js',
 'js/plugins/Unrelated.js'
]);

const mzCalls=[];
const mz={PluginManager:{makeUrl(name){return 'js/plugins/'+encodeURIComponent(name)+'.js'},loadScript(name){mzCalls.push(this.makeUrl(name))}}};
vm.createContext(mz);vm.runInContext(compat,mz);
mz.PluginManager.loadScript('MoviePicture');
mz.PluginManager.loadScript('CGMZ_SplashScreen');
mz.PluginManager.loadScript('TS_ReplayMode');
mz.PluginManager.loadScript('TitleExtra');
mz.PluginManager.loadScript('Unrelated');
assert.deepEqual(mzCalls,[
 'js/plugins/.mistv/mobile-media-5/MoviePicture.js',
 'js/plugins/.mistv/cyclone-steam-1/CGMZ_SplashScreen.js',
 'js/plugins/.mistv/replay-mode-3/TS_ReplayMode.js',
 'js/plugins/.mistv/title-extra-1/TitleExtra.js',
 'js/plugins/Unrelated.js'
]);
assert.doesNotMatch(mzCalls[0],/%3F|\.js\.js|\?/);
assert.match(mzCalls[0],/^js\/plugins\/\.mistv\/[^/]+\/[^/]+\.js$/);

console.log(JSON.stringify({ok:true,mvLoadScript:true,mzMakeUrl:true,mzQueryNotEncoded:true,pathVersioning:true,replayVersion:'replay-mode-3',decodeVersion:'scenario-decode-3',movieVersion:'mobile-media-5',splashVersion:'cyclone-steam-1',titleExtraVersion:'title-extra-1',cgGalleryVersion:'cggallery-1',eventGalleryVersion:'eventgallery-1',subFolderPictureVersion:'subfolder-picture-1',steamworksVersion:'steamworks-3',ramzaSplashVersion:'ramza-splash-1',chimakiLangVersion:'chimaki-lang-1',jsscript64Version:'jsscript64-1',ppcVersion:'ppc-1',unrelatedPreserved:true},null,2));
