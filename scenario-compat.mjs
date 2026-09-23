const REPLAY_SIGNATURES = [
  /PluginManager\.parameters\s*\(\s*['"](?:TS_)?ReplayMode['"]\s*\)/,
  /Window_RP\.prototype\.fileLoad\s*=\s*function/,
  /Window_CG\.prototype\.fileLoad\s*=\s*function/,
  /ReplayAllOpen\s*=\s*function/,
  /CGAllOpen\s*=\s*function/,
  /\$advSystem\.localFileDirectoryPath\(\)\s*\+\s*arg(?:RP|CG)text\s*\+\s*TS_Function\.getScenarioExtension\(\)/,
  /require\s*\(\s*['"]fs['"]\s*\)/,
];

const DECODE_SIGNATURES = [
  /var\s+argTsDecodeDebug\s*=\s*false/,
  /var\s+argTsDecodeKey\s*=\s*255/,
  /var\s+argLanguagePath\s*=\s*\[/,
  /ADV_System\.prototype\.fileLoad\s*=\s*function\s*\(\s*filename\s*\)/,
  /TS_Function\.getScenarioExtension\s*\(\s*\)/,
  /require\s*\(\s*['"]fs['"]\s*\)/,
];

const DECODE_VARIANT_SIGNATURES = [
  /ADV_System\.prototype\.fileLoad\s*=\s*function\s*\(\s*filename\s*\)/,
  /eval\s*\(\s*parameters\s*\[\s*['"]Decode['"]\s*\]/,
  /parseInt\s*\(\s*parameters\s*\[\s*['"]Key['"]\s*\]/,
  /TS_Function\.getScenarioExtension\s*\(\s*\)/,
  /require\s*\(\s*['"]fs['"]\s*\)/,
];

function replaceRequireReads(source) {
  return source.replace(
    /var\s+fs\s*=\s*require\s*\(\s*['"]fs['"]\s*\)\s*;\s*\n\s*var\s+filepath\s*=\s*([^;\n]+)\s*;\s*\n\s*var\s+file_data\s*=\s*fs\.readFileSync\s*\(\s*filepath\s*,\s*['"]utf-8['"]\s*\)\s*;/g,
    "var filepath = $1;\n        var file_data = globalThis.__mistReadScenarioText(filepath);"
  );
}

export function replayModeBrowserCompat(source) {
  if (typeof source !== 'string' || !REPLAY_SIGNATURES.every(pattern => pattern.test(source))) return source;
  const output = replaceRequireReads(source);
  if (output === source || /require\s*\(\s*['"]fs['"]\s*\)/.test(output)) return source;
  return `${output}\n;globalThis.__mistReplayModeBrowserCompat = true;\n`;
}

export function scenarioDecodeBrowserCompat(source) {
  if (typeof source !== 'string') return source;
  if (!DECODE_SIGNATURES.every(pattern => pattern.test(source))) return scenarioDecodeVariantCompat(source);
  const method = /ADV_System\.prototype\.fileLoad\s*=\s*function\s*\(\s*filename\s*\)\s*\{\s*var\s+lang_val\s*=\s*\$gameVariables\.value\s*\(\s*TS_GameConfig\.LanguageVal\s*\)\s*;[\s\S]*?return\s+file_data\s*;\s*\n\s*\}/;
  if (!method.test(source)) return source;
  const replacement = `ADV_System.prototype.fileLoad = function(filename) {
        var lang_val = $gameVariables.value(TS_GameConfig.LanguageVal);
        var filepath = this.localFileDirectoryPath() + argLanguagePath[lang_val] + filename + TS_Function.getScenarioExtension();
        var file_data = globalThis.__mistReadScenarioText(filepath);
        if (!$gameTemp.isPlaytest() || argTsDecodeDebug) {
            var text_ary = file_data.split('');
            for (var i = 0; i < text_ary.length; i++) {
                text_ary[i] = String.fromCharCode(text_ary[i].charCodeAt(0) ^ argTsDecodeKey);
            }
            file_data = text_ary.join('');
        }
        return file_data;
    }`;
  const output = source.replace(method, replacement).replace(/\/\*[\s\S]*?\*\//g,block=>block.replace(/require\s*\(/g,'require_disabled('));
  if (output === source || /require\s*\(\s*['"]fs['"]\s*\)/.test(output)) return source;
  return `${output}\n;globalThis.__mistScenarioDecodeBrowserCompat = true;\n`;
}

// 简化版 TS_Decode（如 女騎士レティシア 巴比伦汉化）：无 argLanguagePath/lang_val 多语言结构，
// 仅 eval(parameters['Decode']) + parseInt(parameters['Key']) + 单一 fs 读取。
// 只替换 fs 读取三元组为场景文本桥，XOR 解码循环保持原样。
function scenarioDecodeVariantCompat(source) {
  if (!DECODE_VARIANT_SIGNATURES.every(pattern => pattern.test(source))) return source;
  const output = replaceRequireReads(source);
  if (output === source || /require\s*\(\s*['"]fs['"]\s*\)/.test(output)) return source;
  return `${output}\n;globalThis.__mistScenarioDecodeBrowserCompat = true;\n`;
}

export function scenarioTextBridge(gameId) {
  const base = `/scenario-text/${encodeURIComponent(gameId)}/`;
  return `(() => {\n  const base=${JSON.stringify(base)};\n  const nameFromPath=value=>{const normalized=String(value||'').replaceAll('\\\\','/'),marker='/scenario/',index=normalized.toLowerCase().lastIndexOf(marker),relative=index>=0?normalized.slice(index+marker.length):normalized.split('/').pop(),parts=relative.split('/'),file=parts.pop(),lang=parts.join('/');if(parts.length>1||lang&&!/^(?:Ja|En|Ch)$/i.test(lang)||!file||file==='.'||file==='..'||/[\\\\/:*?\"<>|]/.test(file)||!/^.+\\.(?:txt|sl)$/i.test(file))throw new Error('Scenario path rejected: '+relative);return lang?lang+'/'+file:file};\n  globalThis.__mistReadScenarioText=function(filepath){const name=nameFromPath(filepath),xhr=new XMLHttpRequest();xhr.open('GET',base+name.split('/').map(encodeURIComponent).join('/'),false);xhr.overrideMimeType('text/plain; charset=UTF-8');xhr.send();if(xhr.status>=400)throw new Error(xhr.responseText||('HTTP '+xhr.status));return xhr.responseText};\n  globalThis.__mistScenarioTextBridge=true;\n})();`;
}
