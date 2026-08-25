import test from 'node:test';
import assert from 'node:assert/strict';

import { TaskStore } from '../src/core/task-store.mjs';
import { createSchedulerLoop } from '../src/core/scheduler-loop.mjs';

function config(maxParallelWorkers = 4) {
  return {
    scheduler: { enabled: true, pollSeconds: 5, maxParallelWorkers },
    resource: {
      cpuLimitPercent: 55,
      minAvailableMemoryGb: 4,
      oneSlotMemoryGb: 4,
      twoSlotMemoryGb: 6,
      fourSlotMemoryGb: 10,
      minDiskFreeGb: 20,
      batterySlotLimit: 1,
      maxSlots: 4
    },
    retries: { maxAttempts: 3, backoffSeconds: [30, 120, 300] },
    execution: { requireEvidence: false }
  };
}

function seed(store, count) {
  for (let index = 0; index < count; index += 1) store.createTask({ request: `后台任务 ${index + 1}` });
}

test('资源充足时四个后台任务真正并发执行，不是串行 await', async () => {
  const store = new TaskStore(':memory:');
  seed(store, 4);
  let active = 0;
  let peak = 0;
  const loop = createSchedulerLoop({
    store,
    config: config(),
    telemetry: () => ({ onAcPower: true, cpuPercent: 20, availableMemoryGb: 12, diskFreeGb: 80 }),
    executor: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { outcome: 'partial', summary: '测试完成' };
    }
  });
  const result = await loop.tick();
  assert.equal(result.picked, 4);
  assert.equal(peak, 4);
  store.close();
});

test('当前约 4.6GB 可用内存时只启动一个重型 worker，其余继续排队', async () => {
  const store = new TaskStore(':memory:');
  seed(store, 4);
  const loop = createSchedulerLoop({
    store,
    config: config(),
    telemetry: () => ({ onAcPower: true, cpuPercent: 20, availableMemoryGb: 4.6, diskFreeGb: 80 }),
    executor: async () => ({ outcome: 'partial', summary: '测试完成' })
  });
  const result = await loop.tick();
  assert.equal(result.picked, 1);
  assert.equal(store.listRunnableTasks().length, 3);
  store.close();
});

test('两个前台任务同批领取时只有一个能持有 foreground 互斥锁', async () => {
  const store = new TaskStore(':memory:');
  seed(store, 2);
  const loop = createSchedulerLoop({
    store,
    config: config(),
    telemetry: () => ({ onAcPower: true, cpuPercent: 20, availableMemoryGb: 12, diskFreeGb: 80 }),
    requiresForeground: () => true,
    executor: async () => ({ outcome: 'partial', summary: '测试完成' })
  });
  const result = await loop.tick();
  assert.equal(result.results.filter((item) => item.outcome === 'partial').length, 1);
  assert.equal(result.results.filter((item) => item.outcome === 'skipped').length, 1);
  store.close();
});

test('本机固定流程调度器不会误领交给 Multica 的 complex 任务', async () => {
  const store = new TaskStore(':memory:');
  const complex = store.createTask({ request: '分析三组数据' });
  store.setTaskKind(complex.id, 'complex');
  const fixed = store.createTask({ request: '打开 Omicos' });
  store.setTaskKind(fixed.id, 'deterministic');
  const executed = [];
  const loop = createSchedulerLoop({
    store,
    config: config(),
    telemetry: () => ({ onAcPower: true, cpuPercent: 20, availableMemoryGb: 12, diskFreeGb: 80 }),
    eligibleTask: (task) => task.taskKind === 'deterministic',
    executor: async ({ task }) => { executed.push(task.id); return { outcome: 'partial', summary: '测试完成' }; }
  });
  const result = await loop.tick();
  assert.equal(result.picked, 1);
  assert.deepEqual(executed, [fixed.id]);
  assert.equal(store.getTask(complex.id).state, 'queued');
  store.close();
});

test('瞬时失败按 30 秒退避，下一次 tick 不会立即烧第二次尝试', async () => {
  const store = new TaskStore(':memory:');
  store.createTask({ request: '打开 Omicos' });
  let calls = 0;
  const loop = createSchedulerLoop({
    store,
    config: config(),
    telemetry: () => ({ onAcPower: true, cpuPercent: 20, availableMemoryGb: 12, diskFreeGb: 80 }),
    executor: async () => { calls += 1; return { outcome: 'failed', reason: '瞬时错误' }; }
  });
  const first = await loop.tick();
  assert.equal(first.results[0].outcome, 'retrying');
  assert.ok(store.getTask(1).retryAfter);
  const immediate = await loop.tick();
  assert.equal(immediate.picked, 0);
  assert.equal(calls, 1);
  store.close();
});

test('等待登录或验证码不消耗瞬时失败的重试次数', async () => {
  const store = new TaskStore(':memory:');
  const task = store.createTask({ request: '打开 Biomni' });
  let calls = 0;
  const loop = createSchedulerLoop({
    store,
    config: config(),
    telemetry: () => ({ onAcPower: true, cpuPercent: 20, availableMemoryGb: 12, diskFreeGb: 80 }),
    executor: async () => {
      calls += 1;
      return calls === 1
        ? { outcome: 'waiting_for_user', reason: '需要登录' }
        : { outcome: 'failed', reason: '瞬时网络错误' };
    }
  });

  await loop.tick();
  assert.equal(store.getTask(task.id).attempt, 0);
  assert.equal(store.continueTask(task.id).ok, true);
  const failedRun = await loop.tick();

  assert.equal(failedRun.results[0].outcome, 'retrying');
  assert.equal(store.getTask(task.id).attempt, 1);
  store.close();
});

test('已有网页任务长时间等待时，后来的任务仍可使用剩余执行槽', async () => {
  const store = new TaskStore(':memory:');
  const first = store.createTask({ request: '等待网页结果' });
  let releaseFirst;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  const loop = createSchedulerLoop({
    store,
    config: config(),
    telemetry: () => ({ onAcPower: true, cpuPercent: 20, availableMemoryGb: 12, diskFreeGb: 80 }),
    executor: async ({ task }) => {
      if (task.id === first.id) {
        signalStarted();
        await blocked;
      }
      return { outcome: 'partial', summary: '测试完成' };
    }
  });

  const firstTick = loop.tick();
  await started;
  const second = store.createTask({ request: '后来到达的软件任务' });
  const secondTick = await loop.tick();

  assert.equal(secondTick.picked, 1);
  assert.equal(secondTick.results[0].taskId, second.id);
  releaseFirst();
  await firstTick;
  store.close();
});

test('控制平面重启时把中断的确定性任务重新排队，但不碰 Multica 任务', () => {
  const store = new TaskStore(':memory:');
  const fixed = store.createTask({ request: '打开 Biomni，输入 TEST 并运行' });
  store.setTaskKind(fixed.id, 'deterministic');
  store.tryAcquireLock(fixed.id, `task:${fixed.id}`);
  store.transition(fixed.id, 'running');

  const complex = store.createTask({ request: '分析三组数据' });
  store.setTaskKind(complex.id, 'complex');
  store.transition(complex.id, 'running');

  const loop = createSchedulerLoop({
    store,
    config: config(),
    telemetry: () => ({ onAcPower: true, cpuPercent: 20, availableMemoryGb: 12, diskFreeGb: 80 }),
    eligibleTask: (task) => task.taskKind === 'deterministic',
    executor: async () => ({ outcome: 'partial', summary: '测试完成' })
  });

  loop.start({ keepAlive: false });
  assert.equal(store.getTask(fixed.id).state, 'queued');
  assert.equal(store.listLocks(fixed.id).length, 0);
  assert.equal(store.getTask(complex.id).state, 'running');
  loop.stop();
  store.close();
});
