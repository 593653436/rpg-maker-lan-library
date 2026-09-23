// mtool-translator-fast 测试：覆写块语义等价（对照参考实现）+ 注入函数行为
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mtoolFastOverride, mtoolTranslatorFastCompat } from '../mtool-translator-fast.mjs';

// ---- 参考实现：与插件原版相同的巨型正则方案（合成小词典，仅语义对照） ----
function referenceTranslateFactory(dict) {
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const keys = Object.keys(dict).filter((k) => k && k.length > 0).sort((a, b) => b.length - a.length);
    const escTokSrc = '\\x1b[A-Za-z]+(?:\\[\\d+\\])*|\\\\[A-Za-z]+(?:\\[\\d+\\])*';
    const re = new RegExp('(' + escTokSrc + ')|(' + keys.map(escapeRe).join('|') + ')', 'g');
    let skipAscii = true;
    for (const k of keys) {
        if (/^[\x00-\x7F]*$/.test(k)) { skipAscii = false; break; }
    }
    return (text) => {
        if (!text || typeof text !== 'string') return text;
        if (skipAscii && /^[\x00-\x7F]*$/.test(text)) return text;
        return text.replace(re, (m, esc, key) => (esc ? m : dict[key] || m));
    };
}

// ---- 新实现：在 vm 沙箱里运行覆写块（模拟 window.MToolTranslator 环境） ----
function newImplFactory(dict) {
    const mt = { _dict: dict, _cache: new Map(), _loaded: true, _loading: false };
    const sandbox = { window: { MToolTranslator: mt }, console: { log() {}, warn() {} } };
    vm.createContext(sandbox);
    vm.runInContext(mtoolFastOverride(), sandbox);
    mt._buildRegex(); // 覆写后调用（真机时序：load() 的 XHR 回调会调它）
    return (text) => mt.translate(text);
}

function assertEquivalent(dict, cases) {
    const ref = referenceTranslateFactory(dict);
    const impl = newImplFactory(dict);
    for (const c of cases) {
        assert.equal(impl(c), ref(c), `不一致: ${JSON.stringify(c)}`);
    }
}

const D1 = {
    'すらいむ': '史莱姆',
    'すらいむキング': '史莱姆王',
    'スライム': '史莱姆(片假名)',
    'スライムキング': '史莱姆王(片假名)',
    '史': '尸',
    '史莱姆': '史莱姆(已是中文)',
    'HP': '血量',
    'MP': '魔力',
    '战斗': '战斗!',
    'てすと': '测试',
};

test('基础替换 + 最长优先 + 键互含', () => {
    assertEquivalent(D1, [
        '普通文本',
        'すらいむ',
        'すらいむキング',
        'スライムAとスライムキング',
        '史莱姆', // 键互含：完整键优先于短键
        '史',
        'HP: 100 MP: 50',
        '前缀すらいむ后缀',
        'すらいむキングすらいむ', // 连续替换
        '（すらいむ）と「スライム」',
    ]);
});

test('转义令牌优先保留', () => {
    const dict = { ...D1, 'C': 'コ', 'FS': '字体大小', '\x1bC': '不该出现', '\\FS': '也不该' };
    assertEquivalent(dict, [
        '\x1bC[1]すらいむ\x1bC[0]', // ESC 令牌整体保留，内部键不翻译
        '\\FS[20]すらいむ', // 字面反斜杠令牌保留
        'abc\x1b[?xすらいむ',
        '\\N<すらいむ>', // 令牌内的文字照常翻译
        '\x1bC[1]\x1bC[2]',
        '\x1bNotATokenすらいむ', // ESC+字母仍是令牌 → 保留
    ]);
});

test('纯 ASCII 直通与边界', () => {
    assertEquivalent(D1, ['', 'HP 123 abc', 'C:\\temp\\file', '\\FS[20]', '\x1bC[1]', '12345', '   ']);
});

test('部分匹配/前后缀切割', () => {
    const keys = Object.keys(D1);
    const cases = [];
    for (const k of keys) {
        cases.push(k.slice(0, 1), k.slice(0, -1), k.slice(1), 'x' + k, k + 'y', 'x' + k + 'y');
        for (const k2 of keys) cases.push(k + k2, 'あ' + k + 'い' + k2 + 'う');
    }
    assertEquivalent(D1, cases);
});

test('空值与单字符键', () => {
    const dict = { a: 'X', ab: 'Y', 'あ': 'A', 'あい': 'B', 'いう': 'C' };
    assertEquivalent(dict, ['a', 'ab', 'aba', 'あいうえお', 'aabc', 'ああい', 'xa', 'ax']);
});

test('注入函数：幂等 + 指纹守卫', () => {
    const src = 'MT._buildRegex = function() {}; MT._escapeRegex = function() {};';
    const once = mtoolTranslatorFastCompat(src);
    assert.notEqual(once, src);
    assert.ok(once.includes('__mistMtoolFast'));
    const twice = mtoolTranslatorFastCompat(once);
    assert.equal(twice, once, '二次注入必须幂等');
    const other = 'var x = 1;';
    assert.equal(mtoolTranslatorFastCompat(other), other, '无指纹文件应原样返回');
    assert.equal(mtoolTranslatorFastCompat(undefined), undefined);
});
