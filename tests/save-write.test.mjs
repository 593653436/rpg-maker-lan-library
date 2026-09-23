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
    console.log(`  (对照：裸并发 rename 失败 ${rawFail}/25${rawFail === 0 ? '（本次环境未复现占用，属正常波动）' : ''})`);
    // 注：裸并发是否触发占用冲突取决于环境时序（快盘/快机可能 0 失败），对照组仅作诊断输出，不作断言。

    // 串行化语义（确定性、不依赖 OS 竞争）：前一个写未放行前，后一个写不得开始
    {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const order = [];
      const gated = serializeSaveWrite(path.resolve(file), async () => {
        order.push('w1-start');
        await gate;
        order.push('w1-end');
        await atomicWriteSave(file, Buffer.from('one'));
      });
      const follower = serializeSaveWrite(path.resolve(file), async () => {
        order.push('w2-start');
        await atomicWriteSave(file, Buffer.from('two'));
      });
      for (let i = 0; i < 200 && !order.includes('w1-start'); i++) await new Promise(r => setTimeout(r, 5));
      assert.ok(order.includes('w1-start'), '第一个写应已开始');
      await new Promise(r => setTimeout(r, 60)); // 抢跑窗口：串行化若失效，后写会在此窗口内开始
      assert.ok(!order.includes('w2-start'), '后一个写必须等前一个写完成');
      release();
      await Promise.all([gated, follower]);
      assert.deepEqual(order, ['w1-start', 'w1-end', 'w2-start']);
    }

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
