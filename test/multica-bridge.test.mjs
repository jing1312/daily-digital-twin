import test from 'node:test';
import assert from 'node:assert/strict';

import { TaskStore } from '../src/core/task-store.mjs';
import { createMulticaBridge } from '../src/integrations/multica-bridge.mjs';

test('worker 完成后同步回本机，Multica issue 聚合 Token 按 issue 更新快照而不重复计费', async () => {
  const store = new TaskStore(':memory:');
  const task = store.createTask({ request: '分析三组数据' });
  store.setTaskKind(task.id, 'complex');
  store.bindMulticaIssue(task.id, 'MUL-7');
  let workerStatus = 'running';
  const client = {
    async getIssueRuns(issueId) {
      if (issueId === 'MUL-7') return { runs: [{ id: 'planner-run', status: 'completed' }] };
      return { runs: [{ id: 'run-1', status: workerStatus }] };
    },
    async getRunMessages(runId) {
      if (runId === 'planner-run') {
        return { messages: [{ content: JSON.stringify({
          summary: '单一子任务',
          subtasks: [{
            id: 'S1', title: '分析数据', instructions: '分析三组数据',
            capabilities: { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] }
          }]
        }) }] };
      }
      return { messages: [{ content: JSON.stringify({ outcome: 'completed', summary: '三组数据分析完成' }) }] };
    },
    async createWorkerIssue() { return { issueId: 'MUL-8' }; },
    async getIssueUsage(issueId) {
      if (issueId === 'MUL-7') return {
        total_input_tokens: 10,
        total_output_tokens: 2,
        total_cache_read_tokens: 4,
        total_cache_write_tokens: 0,
        task_count: 1
      };
      return {
        total_input_tokens: workerStatus === 'completed' ? 120 : 100,
        total_output_tokens: workerStatus === 'completed' ? 24 : 20,
        total_cache_read_tokens: workerStatus === 'completed' ? 48 : 40,
        total_cache_write_tokens: 0,
        task_count: 1
      };
    },
    normalizeUsage(usage, context) {
      return {
        usageId: `multica:issue:${context.issueId}:aggregate`,
        taskId: context.taskId,
        workerId: context.workerId,
        model: 'multica-aggregate',
        inputTokens: usage.total_input_tokens,
        cachedTokens: usage.total_cache_read_tokens,
        outputTokens: usage.total_output_tokens,
        cacheHit: usage.total_cache_read_tokens > 0,
        latencyMs: 0,
        estimatedCost: null
      };
    }
  };
  const bridge = createMulticaBridge({
    store,
    client,
    priceTable: { models: { 'gpt-5.6-sol': { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 } } },
    telemetry: () => ({ cpuPercent: 10, availableMemoryGb: 12, diskFreeGb: 100, onAcPower: true }),
    workerAgents: ['worker-2'],
    prepareWorker: async () => ({ bindingPath: 'data/workers/slots/worker-2/capability.binding.json' })
  });
  await bridge.sync();
  await bridge.sync();
  workerStatus = 'completed';
  await bridge.sync();
  assert.equal(store.getTask(task.id).state, 'completed');
  assert.match(store.getTask(task.id).summary, /三组数据分析完成/);
  const usage = store.summarizeTokenUsage(task.id);
  assert.equal(usage.calls, 2, 'planner 和 worker issue 各保留一份聚合快照');
  assert.equal(usage.inputTokens, 130, 'worker 完成后的最新值应覆盖旧快照，而不是累加');
  assert.equal(usage.cachedTokens, 52);
  assert.equal(usage.outputTokens, 26);
  assert.equal(usage.estimatedCost, null, '聚合响应不含模型名，不能把未知费用伪装成 0');
  store.close();
});

test('远端 running 只把 complex 任务推进为 running，不生成假终态', async () => {
  const store = new TaskStore(':memory:');
  const task = store.createTask({ request: '复杂任务' });
  store.setTaskKind(task.id, 'complex');
  store.bindMulticaIssue(task.id, 'MUL-8');
  const bridge = createMulticaBridge({
    store,
    client: {
      async getIssueRuns() { return { runs: [{ id: 'planner-run', status: 'in_progress' }] }; },
      async getIssueUsage() { return { runs: [] }; }
    },
    priceTable: { models: {} }
  });
  await bridge.sync();
  assert.equal(store.getTask(task.id).state, 'running');
  assert.equal(store.getTerminalReceipt(task.id), null);
  store.close();
});
