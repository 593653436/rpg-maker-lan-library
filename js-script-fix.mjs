// mist: runtime patch for the corrupted JsScript76Set.js (dead-arena cdd9510d).
// The source has 2 identical corrupted 3-line blocks (writeHelpFile's dev-only body),
// making the whole plugin fail to parse -> Scene_Boot hangs. Replace globally, no NAS change.
const BAD = "var file = '/*'+':\\n * @help \r\n        file += '\\n * @requiredAssets img/particles/'+images[i];\r\n    }";
const GOOD = "var file = '/*'+':\\n * @help \\n';";
export function fixJsScript76Set(source) {
  if (typeof source !== 'string' || !source.includes(BAD)) return source;
  return source.split(BAD).join(GOOD);
}
