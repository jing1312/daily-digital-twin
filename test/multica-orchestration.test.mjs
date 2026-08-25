import test from 'node:test';
import assert from 'node:assert/strict';

import { TaskStore } from '../src/core/task-store.mjs';
import { createMulticaBridge } from '../src/integrations/multica-bridge.mjs';

function plannerPlan() {
  return {
    summary: '拆成两份',
    subtasks: [1, 2].map((index) => ({
      id: `S${index}`,
      title: `子任务 ${index}`,
      instructions: `只处理第 ${index} 份`,
      capabilities: { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] }
    }))
  };
}

test('worker 计划和远端 issue 状态会持久化，重启后可继续调度', () => {
  const store = new TaskStore(':memory:');
  const task = store.createTask({ request: '分析两份数据' });
  store.setTaskKind(task.id, 'complex');
  store.saveWorkerPlan(task.id, plannerPlan().subtasks);
  const workers = store.listTaskWorkers(task.id);
  assert.equal(workers.length, 2);
  assert.equal(workers[0].state, 'planned');
  store.markWorkerDispatching(workers[0].id, { workerId: 'dt-worker-1', bindingPath: 'data/workers/slots/dt-worker-1/capability.binding.json' });
  store.bindWorkerIssue(workers[0].id, 'MUL-201');
  assert.equal(store.listActiveWorkerRuns().length, 1);
  assert.equal(store.getTaskWorker(workers[0].id).multicaIssueId, 'MUL-201');
  store.close();
});

test('planner 结束后按资源档位派发 worker，所有 worker 结束后才生成本机终态', async () => {
  const store = new TaskStore(':memory:');
  const created = store.createTask({ request: '分析两份数据并汇总' });
  store.setTaskKind(created.id, 'complex');
  store.bindMulticaIssue(created.id, 'MUL-100');

  const childStates = new Map();
  const dispatches = [];
  const client = {
    async getIssueRuns(issueId) {
      if (issueId === 'MUL-100') return { runs: [{ id: 'planner-run', status: 'completed' }] };
      return { runs: [{ id: `${issueId}-run`, status: childStates.get(issueId) ?? 'running' }] };
    },
    async getRunMessages(runId) {
      if (runId === 'planner-run') return { messages: [{ content: JSON.stringify(plannerPlan()) }] };
      return { messages: [{ content: JSON.stringify({ outcome: childStates.get(runId.replace(/-run$/, '')), summary: `结果 ${runId}` }) }] };
    },
    async createWorkerIssue(input) {
      const issueId = `MUL-${200 + dispatches.length + 1}`;
      dispatches.push({ ...input, issueId });
      childStates.set(issueId, 'running');
      return { issueId };
    },
    async getIssueUsage() { return { runs: [] }; },
    normalizeUsage() { throw new Error('没有 usage 时不应调用'); }
  };
  const prepared = [];
  const bridge = createMulticaBridge({
    store,
    client,
    telemetry: () => ({ cpuPercent: 10, availableMemoryGb: 4.5, diskFreeGb: 100, onAcPower: true }),
    resourceLimits: {
      cpuLimitPercent: 55, minAvailableMemoryGb: 4, oneSlotMemoryGb: 4,
      twoSlotMemoryGb: 6, fourSlotMemoryGb: 10, minDiskFreeGb: 20,
      batterySlotLimit: 1, maxSlots: 4
    },
    workerAgents: ['dt-worker-1', 'dt-worker-2', 'dt-worker-3', 'dt-worker-4'],
    allowedCapabilities: { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] },
    prepareWorker: async (options) => {
      prepared.push(options);
      return { bindingPath: `data/workers/slots/${options.workerId}/capability.binding.json` };
    },
    logger: { error() {} }
  });

  await bridge.sync();
  assert.equal(dispatches.length, 1, '4.5 GB 可用内存只能派发一个重型 worker');
  assert.equal(store.listTaskWorkers(created.id).filter((item) => item.state === 'planned').length, 1);
  assert.equal(store.getTask(created.id).state, 'running');
  assert.equal(prepared[0].task.multicaIssueId, 'MUL-100');

  childStates.set('MUL-201', 'completed');
  await bridge.sync();
  assert.equal(dispatches.length, 2, '前一个结束后才释放 slot 派发下一个');

  childStates.set('MUL-202', 'failed');
  await bridge.sync();
  const finished = store.getTask(created.id);
  assert.equal(finished.state, 'partial');
  assert.match(finished.summary, /1\/2/);
  assert.equal(store.listTaskWorkers(created.id).map((item) => item.state).sort().join(','), 'completed,failed');
  store.close();
});

test('planner 已结束但输出非法时根任务必须失败并等待终态回执', async () => {
  const store = new TaskStore(':memory:');
  const created = store.createTask({ request: '拆分一个复杂任务' });
  store.setTaskKind(created.id, 'complex');
  store.bindMulticaIssue(created.id, 'MUL-BAD-PLAN');
  const bridge = createMulticaBridge({
    store,
    client: {
      async getIssueRuns() { return { runs: [{ id: 'planner-run', status: 'completed' }] }; },
      async getRunMessages() { return { messages: [{ content: '这不是结构化计划' }] }; },
      async getIssueUsage() { return { runs: [] }; }
    },
    logger: { error() {} }
  });

  await bridge.sync();

  const task = store.getTask(created.id);
  assert.equal(task.state, 'failed');
  assert.match(task.failureReason, /planner|结构化计划/i);
  assert.deepEqual(store.listTerminalTasksWithoutReceipt().map((item) => item.id), [created.id]);
  store.close();
});

test('worker issue 派发失败后退回 planned，不占槽且下一轮可以重试', async () => {
  const store = new TaskStore(':memory:');
  const created = store.createTask({ request: '运行一个复杂子任务' });
  store.setTaskKind(created.id, 'complex');
  store.bindMulticaIssue(created.id, 'MUL-RETRY');
  let createAttempts = 0;
  const bridge = createMulticaBridge({
    store,
    client: {
      async getIssueRuns(issueId) {
        if (issueId === 'MUL-RETRY') return { runs: [{ id: 'planner-run', status: 'completed' }] };
        return { runs: [] };
      },
      async getRunMessages() {
        return { messages: [{ content: JSON.stringify({
          summary: '单一子任务',
          subtasks: [{
            id: 'S1',
            title: '执行',
            instructions: '执行子任务',
            capabilities: { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] }
          }]
        }) }] };
      },
      async createWorkerIssue() {
        createAttempts += 1;
        if (createAttempts === 1) throw new Error('temporary dispatch failure');
        return { issueId: 'MUL-WORKER-1' };
      },
      async getIssueUsage() { return { runs: [] }; }
    },
    telemetry: () => ({ cpuPercent: 10, availableMemoryGb: 12, diskFreeGb: 100, onAcPower: true }),
    resourceLimits: {
      cpuLimitPercent: 55, minAvailableMemoryGb: 4, oneSlotMemoryGb: 4,
      twoSlotMemoryGb: 6, fourSlotMemoryGb: 10, minDiskFreeGb: 20,
      batterySlotLimit: 1, maxSlots: 4
    },
    workerAgents: ['dt-worker-1'],
    allowedCapabilities: { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] },
    prepareWorker: async () => ({ bindingPath: 'data/workers/slots/dt-worker-1/capability.binding.json' }),
    logger: { error() {} }
  });

  await bridge.sync();
  assert.equal(store.listTaskWorkers(created.id)[0].state, 'planned');
  assert.equal(store.listActiveWorkerRuns().length, 0);

  await bridge.sync();
  assert.equal(createAttempts, 2);
  assert.equal(store.listTaskWorkers(created.id)[0].state, 'dispatched');
  store.close();
});

test('复杂任务暂停会取消远端 run，继续时按本机记录 rerun，取消不再续跑', async () => {
  const store = new TaskStore(':memory:');
  const created = store.createTask({ request: '运行远端任务' });
  store.setTaskKind(created.id, 'complex');
  store.bindMulticaIssue(created.id, 'MUL-PARENT');
  store.saveWorkerPlan(created.id, [{
    id: 'S1', title: '远端子任务', instructions: '执行',
    capabilities: { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] }
  }]);
  const worker = store.listTaskWorkers(created.id)[0];
  store.markWorkerDispatching(worker.id, {
    workerId: 'dt-worker-1',
    bindingPath: 'data/workers/slots/dt-worker-1/capability.binding.json'
  });
  store.bindWorkerIssue(worker.id, 'MUL-CHILD');
  store.transitionTaskWorker(worker.id, 'running');

  let childStatus = 'running';
  const cancelledRuns = [];
  const rerunIssues = [];
  const bridge = createMulticaBridge({
    store,
    client: {
      async getIssueRuns(issueId) {
        if (issueId === 'MUL-PARENT') return { runs: [{ id: 'planner-run', status: 'completed' }] };
        return { runs: [{ id: 'worker-run', status: childStatus }] };
      },
      async cancelTask(runId) { cancelledRuns.push(runId); return { status: 'cancelled' }; },
      async rerunIssue(issueId) { rerunIssues.push(issueId); return { status: 'queued' }; }
    },
    logger: { error() {} }
  });

  const paused = await bridge.pauseTask(created.id);
  assert.equal(paused.ok, true);
  assert.deepEqual(cancelledRuns, ['worker-run']);
  assert.deepEqual(store.getMulticaPausedRuns(created.id), [{ issueId: 'MUL-CHILD', runId: 'worker-run' }]);

  childStatus = 'cancelled';
  const resumed = await bridge.resumeTask(created.id);
  assert.equal(resumed.ok, true);
  assert.deepEqual(rerunIssues, ['MUL-CHILD']);
  assert.deepEqual(store.getMulticaPausedRuns(created.id), []);

  childStatus = 'running';
  const cancelled = await bridge.cancelTask(created.id);
  assert.equal(cancelled.ok, true);
  assert.deepEqual(cancelledRuns, ['worker-run', 'worker-run']);
  assert.deepEqual(store.getMulticaPausedRuns(created.id), []);
  store.close();
});

test('暂停后才出现的远端 run 会被后续同步补取消，避免后台继续耗 Token', async () => {
  const store = new TaskStore(':memory:');
  const created = store.createTask({ request: '稍后才启动的 planner' });
  store.setTaskKind(created.id, 'complex');
  store.bindMulticaIssue(created.id, 'MUL-LATE');
  store.pause(created.id);
  const cancelled = [];
  const bridge = createMulticaBridge({
    store,
    client: {
      async getIssueRuns() { return { runs: [{ id: 'late-run', status: 'running' }] }; },
      async cancelTask(runId) { cancelled.push(runId); return { status: 'cancelled' }; }
    },
    logger: { error() {} }
  });

  await bridge.sync();

  assert.deepEqual(cancelled, ['late-run']);
  assert.deepEqual(store.getMulticaPausedRuns(created.id), [{ issueId: 'MUL-LATE', runId: 'late-run' }]);
  assert.equal(store.getTask(created.id).paused, true);
  store.close();
});

test('worker issue 创建途中取消根任务，后台仍会停止稍后出现的远端 run', async () => {
  const store = new TaskStore(':memory:');
  const created = store.createTask({ request: '派发途中取消' });
  store.setTaskKind(created.id, 'complex');
  store.bindMulticaIssue(created.id, 'MUL-RACE');
  let releasePrepare;
  let markPrepareStarted;
  const prepareStarted = new Promise((resolve) => { markPrepareStarted = resolve; });
  const prepared = new Promise((resolve) => { releasePrepare = resolve; });
  const cancelledRuns = [];
  const bridge = createMulticaBridge({
    store,
    client: {
      async getIssueRuns(issueId) {
        if (issueId === 'MUL-RACE') return { runs: [{ id: 'planner-run', status: 'completed' }] };
        return { runs: [{ id: 'late-worker-run', status: 'running' }] };
      },
      async getRunMessages() {
        return { messages: [{ content: JSON.stringify({
          summary: '一个子任务',
          subtasks: [{
            id: 'S1', title: '执行', instructions: '执行后汇报',
            capabilities: { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] }
          }]
        }) }] };
      },
      async createWorkerIssue() { return { issueId: 'MUL-RACE-CHILD' }; },
      async getIssueUsage() { return { runs: [] }; },
      async cancelTask(runId) { cancelledRuns.push(runId); }
    },
    telemetry: () => ({ cpuPercent: 10, availableMemoryGb: 12, diskFreeGb: 100, onAcPower: true }),
    workerAgents: ['dt-worker-1'],
    allowedCapabilities: { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] },
    prepareWorker: async () => {
      markPrepareStarted();
      return prepared;
    },
    logger: { error() {} }
  });

  const firstSync = bridge.sync();
  await prepareStarted;
  store.transition(created.id, 'cancelled', { reason: '用户取消' });
  releasePrepare({ bindingPath: 'data/workers/slots/dt-worker-1/capability.binding.json' });
  await firstSync;
  assert.equal(store.listTaskWorkers(created.id)[0].state, 'dispatched');

  await bridge.sync();

  assert.deepEqual(cancelledRuns, ['late-worker-run']);
  assert.equal(store.listTaskWorkers(created.id)[0].state, 'cancelled');
  assert.equal(store.getTask(created.id).state, 'cancelled');
  store.close();
});

test('根任务取消后才绑定 planner issue，后台仍会补取消 parent run', async () => {
  const store = new TaskStore(':memory:');
  const created = store.createTask({ request: 'planner 创建途中取消' });
  store.setTaskKind(created.id, 'complex');
  store.transition(created.id, 'cancelled', { reason: '用户取消' });
  store.bindMulticaIssue(created.id, 'MUL-LATE-PARENT');
  const cancelledRuns = [];
  const bridge = createMulticaBridge({
    store,
    client: {
      async getIssueRuns() { return { runs: [{ id: 'late-parent-run', status: 'running' }] }; },
      async cancelTask(runId) { cancelledRuns.push(runId); }
    },
    logger: { error() {} }
  });

  await bridge.sync();

  assert.deepEqual(cancelledRuns, ['late-parent-run']);
  assert.equal(store.isMulticaTerminalCleanupComplete(created.id), true);
  await bridge.sync();
  assert.deepEqual(cancelledRuns, ['late-parent-run'], '清理完成后不应每 15 秒重复调用 Multica');
  store.close();
});

test('worker 到 90 分钟且已有检查点时取消本轮、重签 binding 并 rerun', async () => {
  const store = new TaskStore(':memory:');
  const created = store.createTask({ request: '长时间分析' });
  store.setTaskKind(created.id, 'complex');
  store.bindMulticaIssue(created.id, 'MUL-LONG');
  store.saveWorkerPlan(created.id, [{
    id: 'S1', title: '长任务', instructions: '分段完成',
    capabilities: { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] }
  }]);
  const worker = store.listTaskWorkers(created.id)[0];
  store.markWorkerDispatching(worker.id, { workerId: 'dt-worker-1', bindingPath: 'old-binding.json' });
  store.bindWorkerIssue(worker.id, 'MUL-LONG-CHILD');
  store.transitionTaskWorker(worker.id, 'running');
  store.saveWorkerCheckpoint(created.id, 'dt-worker-1', { cursor: 42 });
  const startedAt = Date.parse(store.getTaskWorker(worker.id).updatedAt);
  const calls = [];
  const bridge = createMulticaBridge({
    store,
    client: {
      async getIssueRuns(issueId) {
        if (issueId === 'MUL-LONG') return { runs: [{ id: 'planner-run', status: 'completed' }] };
        return { runs: [{ id: 'worker-run', status: 'running' }] };
      },
      async getIssueUsage() { return { runs: [] }; },
      async cancelTask(runId) { calls.push(['cancel', runId]); },
      async rerunIssue(issueId) { calls.push(['rerun', issueId]); }
    },
    prepareWorker: async (options) => {
      calls.push(['prepare', options.workerId]);
      return { bindingPath: 'data/workers/slots/dt-worker-1/new-binding.json' };
    },
    workerMaxMinutes: 90,
    now: () => startedAt + 91 * 60_000,
    logger: { error() {} }
  });

  await bridge.sync();

  assert.deepEqual(calls, [
    ['prepare', 'dt-worker-1'],
    ['cancel', 'worker-run'],
    ['rerun', 'MUL-LONG-CHILD']
  ]);
  const renewed = store.getTaskWorker(worker.id);
  assert.equal(renewed.state, 'dispatched');
  assert.match(renewed.bindingPath, /new-binding/);
  store.close();
});

test('worker 到 90 分钟但没有检查点时必须失败，不能假装已续跑', async () => {
  const store = new TaskStore(':memory:');
  const created = store.createTask({ request: '未保存进度的长任务' });
  store.setTaskKind(created.id, 'complex');
  store.bindMulticaIssue(created.id, 'MUL-NO-CHECKPOINT');
  store.saveWorkerPlan(created.id, [{
    id: 'S1', title: '长任务', instructions: '执行',
    capabilities: { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] }
  }]);
  const worker = store.listTaskWorkers(created.id)[0];
  store.markWorkerDispatching(worker.id, { workerId: 'dt-worker-1', bindingPath: 'binding.json' });
  store.bindWorkerIssue(worker.id, 'MUL-NO-CHECKPOINT-CHILD');
  store.transitionTaskWorker(worker.id, 'running');
  const startedAt = Date.parse(store.getTaskWorker(worker.id).updatedAt);
  const cancelled = [];
  const bridge = createMulticaBridge({
    store,
    client: {
      async getIssueRuns(issueId) {
        if (issueId === 'MUL-NO-CHECKPOINT') return { runs: [{ id: 'planner-run', status: 'completed' }] };
        return { runs: [{ id: 'worker-run', status: 'running' }] };
      },
      async getIssueUsage() { return { runs: [] }; },
      async cancelTask(runId) { cancelled.push(runId); }
    },
    workerMaxMinutes: 90,
    now: () => startedAt + 91 * 60_000,
    logger: { error() {} }
  });

  await bridge.sync();

  assert.deepEqual(cancelled, ['worker-run']);
  assert.equal(store.getTaskWorker(worker.id).state, 'failed');
  assert.match(store.getTaskWorker(worker.id).failureReason, /检查点/);
  assert.equal(store.getTask(created.id).state, 'failed');
  store.close();
});

test('上一轮的旧检查点不能冒充本轮新进度而无限续跑', async () => {
  const store = new TaskStore(':memory:');
  const created = store.createTask({ request: '第二轮长任务' });
  store.setTaskKind(created.id, 'complex');
  store.bindMulticaIssue(created.id, 'MUL-STALE');
  store.saveWorkerPlan(created.id, [{
    id: 'S1', title: '长任务', instructions: '继续执行',
    capabilities: { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] }
  }]);
  const worker = store.listTaskWorkers(created.id)[0];
  store.markWorkerDispatching(worker.id, { workerId: 'dt-worker-1', bindingPath: 'binding.json' });
  store.bindWorkerIssue(worker.id, 'MUL-STALE-CHILD');
  store.saveWorkerCheckpoint(created.id, 'dt-worker-1', { cursor: 10 });
  await new Promise((resolve) => setTimeout(resolve, 2));
  store.transitionTaskWorker(worker.id, 'running');
  const startedAt = Date.parse(store.getTaskWorker(worker.id).updatedAt);
  const cancelled = [];
  const bridge = createMulticaBridge({
    store,
    client: {
      async getIssueRuns(issueId) {
        if (issueId === 'MUL-STALE') return { runs: [{ id: 'planner-run', status: 'completed' }] };
        return { runs: [{ id: 'worker-run', status: 'running' }] };
      },
      async getIssueUsage() { return { runs: [] }; },
      async cancelTask(runId) { cancelled.push(runId); }
    },
    workerMaxMinutes: 90,
    now: () => startedAt + 91 * 60_000,
    logger: { error() {} }
  });

  await bridge.sync();

  assert.deepEqual(cancelled, ['worker-run']);
  assert.equal(store.getTaskWorker(worker.id).state, 'failed');
  assert.match(store.getTaskWorker(worker.id).failureReason, /检查点/);
  store.close();
});
