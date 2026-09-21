// mist: 存档写入并发安全测试。
// 复现并发写同一文件的 EPERM/占用冲突，并验证串行化 + 原子替换 + 重试后全部成功。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { serializeSaveWrite, atomicWriteSave } from '../save-write.mjs';

test('concurrent writes to the same save file all succeed (serialized + atomic)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mist-save-'));
  try {
    const file = path.join(dir, 'shared.rmmzsave');

    // 对照组：裸并发 rename 覆盖同一目标（Windows 上表现为随机失败，证明问题真实存在）
    const rawTarget = path.join(dir, 'raw.bin');
    await fsp.writeFile(rawTarget, 'seed');
    const rawResults = await Promise.allSettled(Array.from({ length: 25 }, async (_, i) => {
      const tmp = `${rawTarget}.${i}.tmp`;
      await fsp.writeFile(tmp, 'a'.repeat(100));
      await fsp.rename(tmp, rawTarget);
    }));
    const rawFail = rawResults.filter(r => r.status === 'rejected').length;
    console.log(`  (对照：裸并发 rename 失败 ${rawFail}/25)`);
    if (process.platform === 'win32') assert.ok(rawFail > 0, `Windows 上应能复现占用冲突（rawFail=${rawFail}）`);

    // 修复路径：串行化 + 原子替换，应全部成功
    const results = await Promise.allSettled(Array.from({ length: 25 }, (_, i) =>
      serializeSaveWrite(path.resolve(file), () => atomicWriteSave(file, Buffer.alloc(64, (i % 251) + 1)))
    ));
    const fails = results.filter(r => r.status === 'rejected');
    assert.equal(fails.length, 0, fails.map(r => r.reason?.code || r.reason?.message).join(','));
    assert.ok(((await fsp.stat(file).catch(() => null))?.size ?? 0) > 0, '最终文件应存在且非空');
    const strayTmp = (await fsp.readdir(dir)).filter(n => n.startsWith('shared.rmmzsave') && n.endsWith('.tmp'));
    assert.equal(strayTmp.length, 0, strayTmp.join(','));

    // 内容以最后一次写入为准
    await serializeSaveWrite(path.resolve(file), () => atomicWriteSave(file, Buffer.from('final')));
    assert.equal((await fsp.readFile(file)).toString(), 'final');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
