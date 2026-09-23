// PicturePointColor.js（ピクチャ取色プラグイン）ブラウザ互換。
// 原実装は画像読み込み中の Bitmap（width/height=0）や scale=0 のとき
// x = sx*(w/(w*scaleX)) が NaN/Infinity になり、現代の Chromium では
// getImageData(NaN,…) が TypeError "Value is not of type 'long'." を投げる。
// プラグインコマンドはイベント解釈器の中で走るため例外が伝播し
// SceneManager.catchException → シーン停止（例: 回想「思い出す」で固まる）。
// NW.js の旧 Chromium は NaN→0 に暗黙変換していたため発覚しなかった。
// 修復: ジオメトリ不正・bitmap 未生成のときは「ピクチャ外」と同じ -1 を返す
// （読み込み完了後のフレームからは従来どおり正常に取色される）。
// 行尾适配: 原文件是 CRLF（NW.js 游戏常见），锚点按源文件行尾构造。
export function fixPicturePointColor(source) {
    if (typeof source !== 'string') return { source, changed: false };
    const nl = source.includes('\r\n') ? '\r\n' : '\n';
    const i12 = '            ';
    const GEOM_ANCHOR = i12 + 'let x = sx * (w / (w * scaleX));' + nl + i12 + 'let y = sy * (h / (h * scaleY));' + nl + nl + i12 + 'let color = sprite.bitmap.getPixel(x, y);';
    const GEOM_FIXED = i12 + 'let x = sx * (w / (w * scaleX));' + nl + i12 + 'let y = sy * (h / (h * scaleY));' + nl + nl + i12 + 'if (!(w > 0) || !(h > 0) || !(scaleX > 0) || !(scaleY > 0) || !isFinite(x) || !isFinite(y)) {' + nl + i12 + '    return -1; // mist: 画像未読込/スケール0 等 → ピクチャ外扱い' + nl + i12 + '}' + nl + nl + i12 + 'let color = sprite.bitmap.getPixel(x, y);';
    const NULL_ANCHOR = i12 + 'let sprite = new Sprite_Picture(pictureId);' + nl + nl + i12 + 'let w = sprite.bitmap.width;';
    const NULL_FIXED = i12 + 'let sprite = new Sprite_Picture(pictureId);' + nl + i12 + 'if (!sprite.bitmap) {' + nl + i12 + '    return -1; // mist: ピクチャ未表示（空名）→ ピクチャ外扱い' + nl + i12 + '}' + nl + nl + i12 + 'let w = sprite.bitmap.width;';
    let out = source;
    let changed = false;
    if (out.includes(GEOM_ANCHOR)) { out = out.replace(GEOM_ANCHOR, GEOM_FIXED); changed = true; }
    if (out.includes(NULL_ANCHOR)) { out = out.replace(NULL_ANCHOR, NULL_FIXED); changed = true; }
    return { source: out, changed };
}
