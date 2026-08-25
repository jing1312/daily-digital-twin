import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { createWorkerContext } from '../src/core/worker-context.mjs';
import { createWorkerBudget } from '../src/core/worker-budget.mjs';
import { calculateUsageCost } from '../src/core/pricing.mjs';

test('worker 上下文按任务和 worker 隔离，且不能逃出私有 home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ddt-worker-home-'));
  try {
    const first = await createWorkerContext({ home, taskId: 'DT-20260730-0001', workerId: 'worker-1' });
    const second = await createWorkerContext({ home, taskId: 'DT-20260730-0001', workerId: 'worker-2' });
    assert.notEqual(first.workspace, second.workspace);
    assert.equal(relative(home, first.workspace).startsWith('..'), false);
    assert.equal(relative(home, first.summaryDir).startsWith('..'), false);
    await assert.rejects(
      () => createWorkerContext({ home, taskId: 'DT-20260730-0001', workerId: '..\\escape' }),
      (error) => error.code === 'invalid_worker_id'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('worker 到 90 分钟时必须写检查点并结束本轮', () => {
  const startedAt = Date.parse('2026-07-30T00:00:00.000Z');
  const budget = createWorkerBudget({ startedAt, maxMinutes: 90 });
  assert.equal(budget.shouldCheckpoint(startedAt + 89 * 60_000), false);
  assert.equal(budget.shouldCheckpoint(startedAt + 90 * 60_000), true);
  assert.equal(budget.deadlineAt, '2026-07-30T01:30:00.000Z');
});

test('费用只使用本地价格表，缓存输入不重复计费，未知模型保持 null', () => {
  const usage = { model: 'gpt-5.6-sol', inputTokens: 1_000_000, cachedTokens: 500_000, outputTokens: 250_000 };
  const prices = {
    models: {
      'gpt-5.6-sol': { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 }
    }
  };
  assert.equal(calculateUsageCost(usage, prices), 3.25);
  assert.equal(calculateUsageCost({ ...usage, model: 'relay/custom' }, prices), null);
});
