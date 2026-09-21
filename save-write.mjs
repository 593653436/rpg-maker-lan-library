// mist: 存档写入的串行化与原子替换。
// 并发写同一存档文件时，Windows 上 rename 覆盖已存在目标会 EPERM（实测 25 并发有 16 个失败）；
// 因此同一路径（key）的写入排队执行，且 rename 遇瞬时占用（EPERM/EACCES/EBUSY）退避重试。
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const chains = new Map();

/** 同一 key（存档文件绝对路径）的写入排队执行，避免并发 rename 竞争。 */
export function serializeSaveWrite(key, task) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(task, task);
  const settled = run.then(() => {}, () => {});
  chains.set(key, settled);
  settled.then(() => { if (chains.get(key) === settled) chains.delete(key); });
  return run;
}

/** 写临时文件后原子改名；rename 遇瞬时占用（EPERM/EACCES/EBUSY）退避重试。 */
export async function atomicWriteSave(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmp, data);
    let lastError;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try { await fsp.rename(tmp, file); return; }
      catch (error) {
        lastError = error;
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * attempt));
      }
    }
    throw lastError;
  } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
}
