// mist-mtool-fast: 手机端 mtool_translator 快速匹配器
// 背景：mtool_translator.js 的 _buildRegex 会把翻译词典(数万键)拼成一个巨型正则
// (单个文本替换在手机 WebView 上可达数百秒——V8 解释器首次全量扫描)，开场即假死。
// 方案：响应层(仅手机 UA)在文件尾追加覆写块，把 _buildRegex/translate 换成
// "按首字符分桶 + 最长优先"的扫描实现：零巨型正则、语义与原实现完全一致
// (转义令牌优先保留、最大匹配、非重叠、缓存、纯 ASCII 直通)。
// 桌面 UA 原样直出，零改动。
import { isMobileUserAgent } from './mv-window-layer-compat.mjs';

const MARKER = '__mistMtoolFast';

// 覆写块：追加在插件 IIFE 之后。MT.load() 的 XHR 是异步的，
// 本块同步执行完时 _buildRegex 尚未被调用，因此能可靠接管 build 时机。
export function mtoolFastOverride() {
    return (
        '\n/* mist-mtool-fast: 手机端快速匹配器(无巨型正则)。语义等价: 转义令牌优先/最大匹配/缓存/纯ASCII直通 */\n' +
        ';(function () {\n' +
        '    var MT = (typeof window !== "undefined") ? window.MToolTranslator : null;\n' +
        '    if (!MT || MT.' + MARKER + ') return;\n' +
        '    MT.' + MARKER + ' = true;\n' +
        '    MT._buildRegex = function () {\n' +
        '        var dict = MT._dict || {};\n' +
        '        var keys = Object.keys(dict);\n' +
        '        var bucket = new Map();\n' +
        '        for (var i = 0; i < keys.length; i++) {\n' +
        '            var k = keys[i];\n' +
        '            if (!k) continue;\n' +
        '            var c = k.charAt(0);\n' +
        '            var arr = bucket.get(c);\n' +
        '            if (!arr) { arr = []; bucket.set(c, arr); }\n' +
        '            arr.push(k);\n' +
        '        }\n' +
        '        bucket.forEach(function (arr) { arr.sort(function (a, b) { return b.length - a.length; }); });\n' +
        '        MT._bucket = bucket;\n' +
        '        MT._skipAscii = true;\n' +
        '        var asciiRe = /^[\\x00-\\x7F]*$/;\n' +
        '        for (var j = 0; j < keys.length; j++) {\n' +
        '            if (keys[j] && asciiRe.test(keys[j])) { MT._skipAscii = false; break; }\n' +
        '        }\n' +
        '        MT._escRe1 = /\\x1b[A-Za-z]+(?:\\[\\d+\\])*/y;\n' +
        '        MT._escRe2 = /\\\\[A-Za-z]+(?:\\[\\d+\\])*/y;\n' +
        '        MT._ready = true;\n' +
        '        console.log("[mtool-fast] 分桶匹配器就绪: " + keys.length + " 键");\n' +
        '    };\n' +
        '    MT.translate = function (text) {\n' +
        '        if (!MT._ready || !MT._bucket || !text || typeof text !== "string") return text;\n' +
        '        if (MT._skipAscii && /^[\\x00-\\x7F]*$/.test(text)) return text;\n' +
        '        if (MT._cache.has(text)) return MT._cache.get(text);\n' +
        '        var out = "";\n' +
        '        var n = text.length;\n' +
        '        var i = 0;\n' +
        '        while (i < n) {\n' +
        '            var c = text.charAt(i);\n' +
        '            if (c === "\\x1b" || c === "\\\\") {\n' +
        '                var re = c === "\\x1b" ? MT._escRe1 : MT._escRe2;\n' +
        '                re.lastIndex = i;\n' +
        '                var m = re.exec(text);\n' +
        '                if (m && m.index === i) { out += m[0]; i += m[0].length; continue; }\n' +
        '            }\n' +
        '            var arr = MT._bucket.get(c);\n' +
        '            var key = null;\n' +
        '            if (arr) {\n' +
        '                for (var j = 0; j < arr.length; j++) {\n' +
        '                    if (text.startsWith(arr[j], i)) { key = arr[j]; break; }\n' +
        '                }\n' +
        '            }\n' +
        '            if (key !== null) { out += (MT._dict[key] || key); i += key.length; }\n' +
        '            else { out += c; i += 1; }\n' +
        '        }\n' +
        '        if (MT._cache.size > 5000) MT._cache.clear();\n' +
        '        MT._cache.set(text, out);\n' +
        '        return out;\n' +
        '    };\n' +
        '})();\n'
    );
}

// 判定：仅当源含目标插件特征且尚未注入时追加
export function mtoolTranslatorFastCompat(source) {
    if (typeof source !== 'string') return source;
    if (!/MT\s*\._buildRegex\s*=\s*function/.test(source)) return source;
    if (!/_escapeRegex/.test(source)) return source;
    if (source.includes(MARKER)) return source;
    return source + mtoolFastOverride();
}

export { isMobileUserAgent };
