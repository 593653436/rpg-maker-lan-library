// PicturePointColor.js（ピクチャ取色）浏览器兼容回归（合成夹具，CRLF）。
// 图片未读完(bitmap 0×0)或空名(bitmap null)时坐标 NaN/Infinity → 现代 Chromium
// getImageData(NaN) 抛 "Value is not of type 'long'." → 事件解译器异常 → 场景停止
// （例：菜单「思い出す」并行事件 PPC_GET_RGB）。修复 = 几何/bitmap 守卫统一返回 -1
//（与插件「ピクチャ外」语义一致）。夹具用 CRLF 覆盖源文件行尾适配路径。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fixPicturePointColor } from '../picture-point-color-compat.mjs';

const FIXTURE_LF = `Game_Screen.prototype._getPicturePointColor = function(pictureId) {
    var picture = this.picture(pictureId);
    if (picture) {
            let sprite = new Sprite_Picture(pictureId);

            let w = sprite.bitmap.width;
        var h = sprite.bitmap.height;
        var scaleX = picture.scaleX() / 100;
        var scaleY = picture.scaleY() / 100;
        var sx = TouchInput.x;
        var sy = TouchInput.y;

            let x = sx * (w / (w * scaleX));
            let y = sy * (h / (h * scaleY));

            let color = sprite.bitmap.getPixel(x, y);
            return color;
    }
    return -1;
};
`;
const src = FIXTURE_LF.split('\n').join('\r\n');
assert.ok(src.includes('\r\n'), 'fixture must be CRLF');

// 0) 夹具锚点
assert.ok(src.includes('let color = sprite.bitmap.getPixel(x, y);'), '原始调用锚点缺失');
assert.ok(!src.includes('isFinite(x)'), '夹具不应已含守卫（防呆）');

// 1) 变换
const { source: out, changed } = fixPicturePointColor(src);
assert.equal(changed, true, '修复必须生效');
assert.ok(out.includes('!(w > 0)') && out.includes('!isFinite(x)'), '几何守卫缺失');
assert.ok(out.includes('if (!sprite.bitmap)'), '空 bitmap 守卫缺失');
assert.ok(out.includes('\r\n'), 'CRLF 行尾应保持');
new vm.Script(out); // 语法校验

// 2) 幂等 / 非命中不动
const again = fixPicturePointColor(out);
assert.equal(again.changed, false, '幂等：不应二次注入');
assert.equal(again.source, out, '幂等：内容不变');
assert.deepEqual(fixPicturePointColor('var x=1;').changed, false, '非命中不动');

// 3) 修复产物在 vm 中实际执行：退化场景 -1，正常场景原样取色
const stubs = { console };
const sandbox = new Proxy(stubs, {
    has: () => true,
    get: (t, k) => {
        if (k === Symbol.unscopables) return undefined;
        if (k in t) return t[k];
        if (k in globalThis) return globalThis[k]; // 真内建（isFinite/Infinity 等）不许被桩掉
        if (k === 'Game_Screen') return (t[k] = { prototype: {} });
        if (k === 'Sprite_Picture') return (t[k] = function () { this.bitmap = null; });
        if (k === 'TouchInput') return (t[k] = { x: 0, y: 0 });
        return (t[k] = function () {});
    },
});
vm.createContext(sandbox);
vm.runInContext(out, sandbox, { filename: 'PicturePointColor.fixed.js' });
const gs = sandbox.Game_Screen.prototype;
assert.equal(typeof gs._getPicturePointColor, 'function', '修复产物未定义方法');

const mkPic = () => ({ scaleX: () => 100, scaleY: () => 100, x: () => 0, y: () => 0, origin: () => 0 });
let r;
r = gs._getPicturePointColor.call({ picture: () => undefined }, 9);
assert.equal(r, -1, '未定义图片 → -1');
r = gs._getPicturePointColor.call({ picture: mkPic }, 9); // Sprite_Picture.bitmap = null
assert.equal(r, -1, '空 bitmap（图片未显示）→ -1');
sandbox.Sprite_Picture = function () { this.bitmap = { width: 0, height: 0, getPixel() { throw new Error('getPixel 不应被调用'); } }; };
r = gs._getPicturePointColor.call({ picture: mkPic }, 9);
assert.equal(r, -1, '加载中 bitmap（0×0）→ -1，不得触碰 getPixel');
sandbox.Sprite_Picture = function () { this.bitmap = { width: 100, height: 100, getPixel(x, y) { assert.equal(x, 10); assert.equal(y, 20); return '#ff0000'; } }; };
sandbox.TouchInput.x = 10; sandbox.TouchInput.y = 20;
r = gs._getPicturePointColor.call({ picture: mkPic }, 9);
assert.equal(r, '#ff0000', '正常路径原样返回颜色');

// 4) server 接线
const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
assert.match(server, /async function servePicturePointColorCompat\(req,res,gameRoot,loadSession\)/, 'serve 函数缺失');
assert.match(server, /PicturePointColor\.js'\)return await servePicturePointColorCompat/, 'dispatch 缺失');
assert.match(server, /PicturePointColor:'ppc-1'/, '版本项缺失');

console.log(JSON.stringify({ ok: true, fixtureFixed: true, parseOk: true, idempotent: true, crlfPreserved: true, vmDegenerateGuarded: true, vmNormalPathOk: true, routesWired: true, versionBumped: true }));
