const HIROKA_PLUGIN_VERSION='hiroka-browser-2';
const HIROKA_LOADER_VERSION='hiroka-loader-2';
export const HIROKA_PLUGIN_DIR='_mist_hiroka_browser_2';
const HIROKA_PLUGINS=new Set(['PluginUtils','AsyncLoadImage','AdvExtention','FontDictionary']);
const GFTT_PLUGIN='Drill_GaugeFloatingTemporaryText.js';
const GFTT_VERSION='gftt-buffer-2';
const GFTT_LOADER_VERSION='gftt-loader-2';

// 兼容规则由 server.mjs 按游戏内容指纹（compat-signatures.mjs）或配置 ID 判定后传入 apply 布尔值；
// 模块本身不再持有任何具体游戏 ID，跨用户导入同一游戏时命中同一指纹即可生效。

export function hirokaIndexCompat(apply,source){
  if(!apply||typeof source!=='string')return source;
  return source.replace(/(\bsrc=["'](?:\.\/)?js\/main\.js)(?:\?[^"']*)?(["'])/i,`$1?mistv=${HIROKA_PLUGIN_VERSION}$2`);
}

export function hirokaMainCompat(apply,source){
  if(!apply||typeof source!=='string')return source;
  return source.replace(/(["']js\/rmmz_managers\.js)(?:\?[^"']*)?(["'])/,`$1?mistv=${HIROKA_LOADER_VERSION}$2`);
}

export function hirokaManagerCompat(apply,source){
  const signature=typeof source==='string'&&/PluginManager\.makeUrl\s*=\s*function\s*\(\s*filename\s*\)/.test(source)&&/["']js\/plugins\//.test(source);
  if(!apply||!signature)return source;
  return source+`\n;(() => {\n  if(PluginManager.makeUrl.__mistHirokaVersion)return;\n  const original=PluginManager.makeUrl;\n  const wrapped=function(filename){const url=original.call(this,filename);return ${JSON.stringify([...HIROKA_PLUGINS])}.includes(filename)?url.replace(/([^/]+\.js)$/,${JSON.stringify(HIROKA_PLUGIN_DIR)}+'/$1'):url};\n  wrapped.__mistHirokaVersion=true;PluginManager.makeUrl=wrapped;\n})();\n`;
}

function replaceNodeImport(source,module,replacement){return source.replace(new RegExp(`const\\s+(\\w+)\\s*=\\s*require\\s*\\(\\s*['"]${module}['"]\\s*\\)\\s*(?:\\.exec)?\\s*;`),replacement)}

export function hirokaPluginCompat(apply,name,source,manifest={}){
  if(!apply||!HIROKA_PLUGINS.has(name)||typeof source!=='string')return source;
  if(name==='PluginUtils'){
    const signature=/const\s+fs\s*=\s*require\s*\(\s*['"]fs['"]\s*\)/.test(source)&&/require\s*\(\s*['"]child_process['"]\s*\)\.exec/.test(source)&&/const\s+fileExists\s*=\s*\(\s*basePath\s*,\s*fileName\s*\)/.test(source)&&/window\.PluginUtils\s*=/.test(source);
    if(!signature)return source;
    const files=[...new Set(manifest.files||[])].map(x=>String(x).replaceAll('\\','/'));
    let output=replaceNodeImport(source,'fs','const fs = null;').replace(/const\s+exec\s*=\s*require\s*\(\s*['"]child_process['"]\s*\)\.exec\s*;/,'const exec = null;');
    const start=/const\s+fileExists\s*=\s*\(\s*basePath\s*,\s*fileName\s*\)\s*=>\s*\{/.exec(output);if(!start)return source;let i=start.index+start[0].length,depth=1;for(;i<output.length&&depth;i++){if(output[i]==='{')depth++;else if(output[i]==='}')depth--}if(depth)return source;const end=/\s*;/.exec(output.slice(i));if(!end)return source;i+=end.index+end[0].length;
    const compat=`const __mistFiles=new Set(${JSON.stringify(files)});\n    const fileExists=(basePath,fileName)=>{const key=buildPath(basePath,fileName).replaceAll(${JSON.stringify('\\')},'/').replace(/^[.][/]/,'');return __mistFiles.has(key)};`;
    return output.slice(0,start.index)+compat+output.slice(i);
  }
  if(name==='AsyncLoadImage'){
    const signature=/const\s+fs\s*=\s*require\s*\(\s*['"]fs['"]\s*\)/.test(source)&&/const\s+fileExists\s*=/.test(source)&&/ImageManager\.loadBitmapFromUrlAsync/.test(source)&&/Bitmap\.load\s*\(\s*url\s*\)/.test(source);
    if(!signature)return source;
    let output=replaceNodeImport(source,'fs','');const start=/const\s+fileExists\s*=\s*\(\s*path\s*\)\s*=>\s*\{/.exec(output);if(!start)return source;let i=start.index+start[0].length,depth=1;for(;i<output.length&&depth;i++){if(output[i]==='{')depth++;else if(output[i]==='}')depth--}if(depth)return source;const end=/\s*;/.exec(output.slice(i));if(!end)return source;i+=end.index+end[0].length;return output.slice(0,start.index)+'const fileExists = (path) => true;'+output.slice(i);
  }
  if(name==='AdvExtention'){
    const signature=/const\s+fs\s*=\s*require\s*\(\s*['"]fs['"]\s*\)/.test(source)&&/PluginUtils\.fileExists\s*\(\s*['"]audio\/me['"]/.test(source);
    return signature?replaceNodeImport(source,'fs',''):source;
  }
  if(name==='FontDictionary'){
    const signature=/const\s+fs\s*=\s*require\s*\(\s*['"]fs['"]\s*\)/.test(source)&&/fs\.readdir\s*\(\s*['"]fonts['"]/.test(source)&&/window\.FontDictionary\s*=/.test(source);
    if(!signature)return source;
    const fonts=[...new Set(manifest.fonts||[])].map(String);let output=replaceNodeImport(source,'fs',`const fs={readdir:(dir,callback)=>queueMicrotask(()=>callback(null,${JSON.stringify(fonts)}))};`);return output;
  }
  return source;
}

export function drillGfttIndexCompat(apply,source){
  if(!apply||typeof source!=='string')return source;
  return source.replace(/(\bsrc=["'](?:\.\/)?js\/rpg_managers\.js)(?:\?[^"']*)?(["'])/i,`$1?mistv=${GFTT_LOADER_VERSION}$2`);
}

export function drillGfttLoaderCompat(apply,source){
  const signature=typeof source==='string'&&
    /PluginManager\.loadScript\s*=\s*function\s*\(\s*name\s*\)/.test(source)&&
    /var\s+url\s*=\s*this\._path\s*\+\s*name/.test(source)&&
    /script\.src\s*=\s*url/.test(source);
  if(!apply||!signature)return source;
  return source.replace(/var\s+url\s*=\s*this\._path\s*\+\s*name\s*;/,match=>`${match}\n    if (name === '${GFTT_PLUGIN}') url += '?mistv=${GFTT_VERSION}';`);
}

export function drillGfttBufferCompat(apply,source){
  const signature=typeof source==='string'&&
    /Game_Temp\.prototype\.drill_GFTT_setBufferContext\s*=\s*function\s*\(\s*context\s*\)/.test(source)&&
    /this\._drill_GFTT_commandBuffer\s*\[\s*['"]s_data['"]\s*\]\s*\[\s*['"]context['"]\s*\]\s*=\s*context/.test(source)&&
    /Game_Temp\.prototype\.drill_GFTT_setBuffer\s*=\s*function\s*\([^)]*\)/.test(source);
  if(!apply||!signature)return source;
  return source+`
;(() => {
  const proto=Game_Temp.prototype;
  if(proto.__mistGfttBufferCompat)return;
  const setContext=proto.drill_GFTT_setBufferContext;
  proto.drill_GFTT_setBufferContext=function(context){
    if(this._drill_GFTT_commandBuffer==null)this.drill_GFTT_setBuffer(3,1);
    return setContext.call(this,context);
  };
  proto.__mistGfttBufferCompat=true;
})();
`;
}
