import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hirokaIndexCompat, hirokaMainCompat, hirokaManagerCompat, hirokaPluginCompat,
  drillGfttIndexCompat, drillGfttLoaderCompat, drillGfttBufferCompat,
  HIROKA_PLUGIN_DIR
} from '../rpg-compat.mjs';

test('compat functions are gated by the apply flag',()=>{
  const source=`<script src="js/main.js"></script>`;
  assert.equal(hirokaIndexCompat(false,source),source);
  assert.equal(hirokaIndexCompat(true,'const unrelated=true;'),'const unrelated=true;');
  assert.equal(drillGfttIndexCompat(false,source),source);
  assert.equal(drillGfttBufferCompat(false,'anything'),'anything')
});

test('hiroka index versions main.js only when apply',()=>{
  const source=`<script type="text/javascript" src="js/main.js"></script>`;
  const output=hirokaIndexCompat(true,source);
  assert.match(output,/js\/main\.js\?mistv=hiroka-browser-2/);
  assert.equal(hirokaIndexCompat(false,source),source)
});

test('hiroka main versions rmmz_managers only when apply',()=>{
  const source=`"js/rmmz_core.js","js/rmmz_managers.js","js/plugins.js"`;
  const output=hirokaMainCompat(true,source);
  assert.match(output,/js\/rmmz_managers\.js\?mistv=hiroka-loader-2/);
  assert.equal(hirokaMainCompat(false,source),source)
});

test('hiroka manager wraps makeUrl only on the complete signature',()=>{
  const source=`PluginManager.makeUrl = function(filename) { return "js/plugins/" + filename + ".js"; };`;
  const output=hirokaManagerCompat(true,source);
  assert.match(output,/__mistHirokaVersion/);
  assert.match(output,new RegExp(HIROKA_PLUGIN_DIR));
  assert.equal(hirokaManagerCompat(true,'const unrelated=true;'),'const unrelated=true;')
});

test('hiroka plugin PluginUtils Node APIs are replaced only for the complete signature',()=>{
  const source=`const fs = require('fs');\nconst exec = require('child_process').exec;\nconst buildPath=(a,b)=>a+'/'+b;\nconst fileExists=(basePath,fileName)=>{return fs.existsSync(buildPath(basePath,fileName));};\nwindow.PluginUtils={fileExists};`;
  const output=hirokaPluginCompat(true,'PluginUtils',source,{files:['data/resources/a.json']});
  assert.doesNotMatch(output,/require\s*\(/);
  assert.match(output,/data\/resources\/a\.json/);
  assert.equal(hirokaPluginCompat(true,'PluginUtils','const fs = require("fs");'),'const fs = require("fs");');
  assert.equal(hirokaPluginCompat(false,'PluginUtils',source,{files:[]}),source)
});

test('hiroka plugin FontDictionary injects a file list',()=>{
  const source=`const fs = require('fs');\nconst list=[];\nfs.readdir('fonts',(err,files)=>{});\nwindow.FontDictionary={list};`;
  const output=hirokaPluginCompat(true,'FontDictionary',source,{fonts:['mplus-1p-regular.ttf']});
  assert.match(output,/mplus-1p-regular\.ttf/);
  assert.doesNotMatch(output,/require\s*\(/)
});

test('Drill GFTT loader versions only the known plugin',()=>{
  const source=`PluginManager.loadScript = function(name) {\n  var url = this._path + name;\n  var script = document.createElement('script');\n  script.src = url;\n};`;
  const output=drillGfttLoaderCompat(true,source);
  assert.match(output,/mistv=gftt-buffer-2/);
  assert.match(output,/Drill_GaugeFloatingTemporaryText\.js/);
  assert.equal(drillGfttLoaderCompat(true,'const unrelated=true;'),'const unrelated=true;')
});

test('Drill GFTT initializes the command buffer before setting context',()=>{
  const source=`Game_Temp.prototype.drill_GFTT_setBuffer=function(a,b){};\nGame_Temp.prototype.drill_GFTT_setBufferContext=function(context){this._drill_GFTT_commandBuffer['s_data']['context']=context;};`;
  const output=drillGfttBufferCompat(true,source);
  assert.match(output,/__mistGfttBufferCompat/);
  assert.match(output,/drill_GFTT_setBuffer\(3,1\)/);
  assert.equal(drillGfttBufferCompat(true,'const unrelated=true;'),'const unrelated=true;')
});
