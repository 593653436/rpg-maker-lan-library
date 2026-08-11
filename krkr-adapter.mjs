import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { applyKrkrCompat } from './krkr-compat.mjs';

// Kirikiri/KRKR games are served as a virtual ZIP.  The ZIP contains stored
// entries whose payloads remain in the original SMB directory; Range requests
// are translated to the corresponding source-file ranges.  No game archive is
// copied or rewritten on the server.
export const KRKR_ENGINE = 'krkr2';
export const KRKR_RUNTIME = 'kirikiroid2-web';
const archiveCache = new Map();

function isRegularFile(entry) {
  return entry.isFile() && !entry.isSymbolicLink();
}

async function walkFiles(root) {
  const files = [];
  async function walk(dir, relative = '') {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (isRegularFile(entry)) {
        const stat = await fsp.stat(full);
        files.push({
          name: rel.replaceAll('\\', '/'),
          source: full,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  }
  await walk(root);
  return files.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

export async function detectKrkrProject(source) {
  const entries = await fsp.readdir(source, { withFileTypes: true }).catch(() => []);
  const files = new Set(entries.filter(isRegularFile).map(entry => entry.name.toLowerCase()));
  const xp3Files = entries
    .filter(isRegularFile)
    .map(entry => entry.name)
    .filter(name => /\.xp3$/i.test(name));
  const pluginDir = entries.some(entry => entry.isDirectory() && entry.name.toLowerCase() === 'plugin');
  const looksLikeKrkr = files.has('data.xp3') || files.has('patch.xp3') ||
    (xp3Files.length > 0 && (files.has('startup.tjs') || pluginDir));
  if (!looksLikeKrkr) return null;
  return {
    engine: KRKR_ENGINE,
    runtime: KRKR_RUNTIME,
    webRoot: '.',
    xp3Files: xp3Files.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    hasPluginDirectory: pluginDir,
  };
}

function u16(buffer, offset, value) { buffer.writeUInt16LE(value, offset); }
function u32(buffer, offset, value) { buffer.writeUInt32LE(value >>> 0, offset); }
function u64(buffer, offset, value) { buffer.writeBigUInt64LE(BigInt(value), offset); }

async function fileCrc32(file) {
  const handle = await fsp.open(file, 'r');
  let crc = 0xffffffff;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead;
    do {
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, null));
      for (let i = 0; i < bytesRead; i++) {
        crc ^= buffer[i];
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
    } while (bytesRead > 0);
  } finally {
    await handle.close();
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function crc32Update(crc,buffer) {
  for(const value of buffer){
    crc^=value;
    for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(0xedb88320&-(crc&1));
  }
  return crc;
}

function crc32Buffer(buffer) {
  return (crc32Update(0xffffffff,buffer)^0xffffffff)>>>0;
}

async function virtualFileCrc32(file){
  let crc=0xffffffff;
  for(const part of file.virtualParts){
    if(part.buffer){crc=crc32Update(crc,part.buffer);continue}
    const stream=fs.createReadStream(file.source,{start:part.sourceStart,end:part.sourceStart+(part.end-part.start)});
    for await(const chunk of stream)crc=crc32Update(crc,chunk);
  }
  return (crc^0xffffffff)>>>0;
}

function localHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const out = Buffer.alloc(30 + name.length);
  u32(out, 0, 0x04034b50);
  u16(out, 4, 20);             // version needed
  u16(out, 6, 0x0800);         // UTF-8 filename flag
  u16(out, 8, 0);              // stored, not deflated
  u16(out, 10, 0);             // DOS time
  u16(out, 12, 0);             // DOS date
  u32(out, 14, entry.crc32);
  u32(out, 18, entry.size);
  u32(out, 22, entry.size);
  u16(out, 26, name.length);
  u16(out, 28, 0);
  name.copy(out, 30);
  return out;
}

function centralHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const out = Buffer.alloc(46 + name.length);
  u32(out, 0, 0x02014b50);
  u16(out, 4, 20);              // made by: compatible with version 2.0
  u16(out, 6, 20);              // version needed
  u16(out, 8, 0x0800);          // UTF-8 filename flag
  u16(out, 10, 0);              // stored
  u16(out, 12, 0);
  u16(out, 14, 0);
  u32(out, 16, entry.crc32);
  u32(out, 20, entry.size);
  u32(out, 24, entry.size);
  u16(out, 28, name.length);
  u16(out, 30, 0);              // extra length
  u16(out, 32, 0);              // comment length
  u16(out, 34, 0);              // disk number
  u16(out, 36, 0);              // internal attributes
  u32(out, 38, 0);              // external attributes
  u32(out, 42, entry.localOffset);
  name.copy(out, 46);
  return out;
}

async function buildArchive(source, apply) {
  const files = await applyKrkrCompat(await walkFiles(source),apply);
  if (!files.some(file => file.name.toLowerCase() === 'data.xp3')) {
    throw Object.assign(new Error('KRKR 游戏缺少 data.xp3'), { status: 422 });
  }
  let cursor = 0;
  for (const file of files) {
    file.crc32 = file.virtualParts ? await virtualFileCrc32(file) : file.buffer ? crc32Buffer(file.buffer) : await fileCrc32(file.source);
    file.localOffset = cursor;
    file.local = localHeader(file);
    file.dataOffset = cursor + file.local.length;
    cursor += file.local.length + file.size;
  }
  const centralOffset = cursor;
  const central = Buffer.concat(files.map(centralHeader));
  const eocd = Buffer.alloc(22);
  u32(eocd, 0, 0x06054b50);
  u16(eocd, 4, 0);
  u16(eocd, 6, 0);
  u16(eocd, 8, files.length);
  u16(eocd, 10, files.length);
  u32(eocd, 12, central.length);
  u32(eocd, 16, centralOffset);
  u16(eocd, 20, 0);
  return {
    id,
    source,
    files,
    central,
    eocd,
    centralOffset,
    length: centralOffset + central.length + eocd.length,
    createdAt: Date.now(),
  };
}

export async function getKrkrArchive(source, id, apply) {
  const key = String(id);
  const existing = archiveCache.get(key);
  if (existing && path.resolve(existing.source) === path.resolve(source)) return existing;
  const archive = await buildArchive(source, apply);
  archiveCache.set(key, archive);
  return archive;
}

export function clearKrkrArchive(id) {
  archiveCache.delete(String(id));
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  if (!match) return { invalid: true };
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return { invalid: true };
  }
  if (start < 0 || start > end || start >= size) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}

async function writeChunk(res, chunk) {
  if (!chunk.length || res.destroyed) return;
  if (!res.write(chunk)) await once(res, 'drain');
}

async function writeFileSlice(res, file, start, end) {
  if (start > end || res.destroyed) return;
  if(file.buffer){await writeChunk(res,file.buffer.subarray(start,end+1));return}
  if(file.virtualParts){
    for(const part of file.virtualParts){
      const from=Math.max(start,part.start),to=Math.min(end,part.end);if(from>to)continue;
      if(part.buffer)await writeChunk(res,part.buffer.subarray(from-part.start,to-part.start+1));
      else{const stream=fs.createReadStream(file.source,{start:part.sourceStart+(from-part.start),end:part.sourceStart+(to-part.start)});try{for await(const chunk of stream)await writeChunk(res,chunk)}finally{stream.destroy()}}
    }
    return;
  }
  const stream = fs.createReadStream(file.source, { start, end });
  try {
    for await (const chunk of stream) await writeChunk(res, chunk);
  } finally {
    stream.destroy();
  }
}

async function writeArchiveRange(res, archive, start, end) {
  const emitBuffer = async (buffer, offset) => {
    const from = Math.max(start, offset);
    const to = Math.min(end, offset + buffer.length - 1);
    if (from <= to) await writeChunk(res, buffer.subarray(from - offset, to - offset + 1));
  };

  for (const file of archive.files) {
    await emitBuffer(file.local, file.localOffset);
    if (start <= file.dataOffset + file.size - 1 && end >= file.dataOffset) {
      const from = Math.max(start, file.dataOffset) - file.dataOffset;
      const to = Math.min(end, file.dataOffset + file.size - 1) - file.dataOffset;
      await writeFileSlice(res, file, from, to);
    }
  }
  await emitBuffer(archive.central, archive.centralOffset);
  await emitBuffer(archive.eocd, archive.centralOffset + archive.central.length);
}

export async function serveKrkrArchive(req, res, source, id, apply) {
  const archive = await getKrkrArchive(source, id, apply);
  const range = parseRange(req.headers.range, archive.length);
  const common = {
    // 注意：Chrome/Edge 150+ 会拦截 fetch/XHR 读取 application/zip 响应（同源返回 204、跨源 Failed to fetch），
    // 导致 KRKR 运行时加载 assets.zip/game.zip 失败卡死。必须用 application/octet-stream，运行时按字节读取不受影响。
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    'X-KRKR-Archive': 'virtual-stored-zip',
  };
  if (range?.invalid) {
    res.writeHead(416, { ...common, 'Content-Range': `bytes */${archive.length}` });
    return res.end();
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? archive.length - 1;
  const status = range ? 206 : 200;
  res.writeHead(status, {
    ...common,
    'Content-Length': end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${archive.length}` } : {}),
  });
  if (req.method === 'HEAD') return res.end();
  try {
    await writeArchiveRange(res, archive, start, end);
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (!res.destroyed) res.destroy(error);
  }
}
