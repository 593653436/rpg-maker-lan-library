const COMMON_SAVE_SIGNATURES = [
  /PluginManager\.parameters\s*\(\s*['"]CommonSave['"]\s*\)/,
  /CommonSave\.prototype\.save\s*=\s*function\s*\(\s*\)/,
  /CommonSave\.prototype\.load\s*=\s*function\s*\(\s*\)/,
  /StorageManager\.localFileDirectoryPath\s*\(\s*\)/,
  /LZString\.compressToBase64\s*\(/,
  /LZString\.decompressFromBase64\s*\(/,
  /require\s*\(\s*['"]fs['"]\s*\)/,
  /\$CommonSave\s*=\s*new\s+CommonSave\s*\(/,
];

const SAVE_METHOD = /CommonSave\.prototype\.save\s*=\s*function\s*\(\s*\)\s*\{[\s\S]*?\n\s*\};(?=\s*\n\s*\/\/[^\n]*\n\s*CommonSave\.prototype\.load\s*=)/;
const LOAD_METHOD = /CommonSave\.prototype\.load\s*=\s*function\s*\(\s*\)\s*\{[\s\S]*?\n\s*\};(?=\s*\n\s*\/\/[^\n]*\n\s*CommonSave\.prototype\.localFilePath\s*=)/;

/**
 * Replace only the known MV CommonSave filesystem implementation. The
 * server-provided MV save bridge remains the sole filesystem boundary.
 */
export function commonSaveBrowserCompat(source) {
  if (typeof source !== 'string' || !COMMON_SAVE_SIGNATURES.every(pattern => pattern.test(source))) return source;
  if (!SAVE_METHOD.test(source) || !LOAD_METHOD.test(source)) return source;

  const save = `CommonSave.prototype.save = function() {
        var json = JSON.stringify(this._mData);
        if (typeof StorageManager.saveCommonSave !== 'function') {
            throw new Error('Mist MV common-save bridge is unavailable');
        }
        StorageManager.saveCommonSave(json);
    };`;
  const load = `CommonSave.prototype.load = function() {
        var json = null;
        try {
            if (typeof StorageManager.loadCommonSave !== 'function') {
                throw new Error('Mist MV common-save bridge is unavailable');
            }
            json = StorageManager.loadCommonSave();
        } catch (e) {
            console.error(e);
        }
        if (json) {
            this._mData = JSON.parse(json);
        } else {
            this._mData = {};
        }
    };`;

  const output = source.replace(SAVE_METHOD, save).replace(LOAD_METHOD, load);
  if (/require\s*\(\s*['"]fs['"]\s*\)/.test(output)) return source;
  return `${output}\n;globalThis.__mistCommonSaveBrowserCompat = true;\n`;
}

// ---------------------------------------------------------------------------
// TS_CommonSave (Tranquil-series variant, e.g. 女騎士レティシア 8ce7809e):
// same fs-based common save, plus an undeclared `json` in load() that throws
// ReferenceError in browsers OUTSIDE its try/catch even when `require` is
// guarded — the load() crash kills DataManager.createGameObjects → boot.
// Replace save/load with bridge-delegating versions (plain JSON in/out; the
// MV save bridge owns LZString compression and HTTP storage).
// ---------------------------------------------------------------------------

const TS_SAVE_METHOD = /CommonSave\.prototype\.save = function\(\) \{[\s\S]*?\n[ \t]*\};/;
const TS_LOAD_METHOD = /CommonSave\.prototype\.load = function\(\) \{[\s\S]*?\n[ \t]*\};/;

const TS_SAVE_REPLACEMENT = `CommonSave.prototype.save = function() {
    var json = JSON.stringify(this._mData);
    if (typeof StorageManager.saveCommonSave !== 'function') {
        throw new Error('Mist MV common-save bridge is unavailable');
    }
    StorageManager.saveCommonSave(json);
};`;

const TS_LOAD_REPLACEMENT = `CommonSave.prototype.load = function() {
    var json = null;
    try {
        if (typeof StorageManager.loadCommonSave === 'function') {
            json = StorageManager.loadCommonSave();
        }
    } catch (e) {
        console.error(e);
    }
    if (json) {
        this._mData = JSON.parse(json);
    } else {
        this._mData = {};
    }
};`;

export function tsCommonSaveBrowserCompat(source) {
  if (typeof source !== 'string') return source;
  if (!/TS_CommonSave/.test(source)) return source;
  if (!/CommonSave\.prototype\.save = function\(\) \{/.test(source) || !/CommonSave\.prototype\.load = function\(\) \{/.test(source)) return source;
  if (!/require\s*\(\s*['"]fs['"]\s*\)/.test(source) || !/LZString\.(?:de)?compress/.test(source) || !/localFilePath/.test(source)) return source;
  if (!TS_SAVE_METHOD.test(source) || !TS_LOAD_METHOD.test(source)) return source;

  const output = source.replace(TS_SAVE_METHOD, TS_SAVE_REPLACEMENT).replace(TS_LOAD_METHOD, TS_LOAD_REPLACEMENT);
  if (output === source) return source;
  if (/require\s*\(\s*['"]fs['"]\s*\)/.test(output)) return source;
  return `${output}\n;globalThis.__mistTSCommonSaveBrowserCompat = true;\n`;
}
