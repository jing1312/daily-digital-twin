import test from 'node:test';
import assert from 'node:assert/strict';

const planner = await import('../src/integrations/planner-contract.mjs').catch(() => ({}));

function subtask(index, capabilities = {}) {
  return {
    id: `S${index}`,
    title: `子任务 ${index}`,
    instructions: `只完成第 ${index} 部分并写结构化结果`,
    capabilities: {
      websites: capabilities.websites ?? [],
      apps: capabilities.apps ?? [],
      directories: capabilities.directories ?? [],
      actions: capabilities.actions ?? ['task.checkpoint']
    }
  };
}

test('planner 输出最多四个结构化子任务，ID 唯一', () => {
  assert.equal(typeof planner.validatePlannerPlan, 'function');
  const valid = planner.validatePlannerPlan({ summary: '拆成四份', subtasks: [1, 2, 3, 4].map(subtask) }, {
    allowed: { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] }
  });
  assert.equal(valid.subtasks.length, 4);
  assert.throws(
    () => planner.validatePlannerPlan({ summary: '过多', subtasks: [1, 2, 3, 4, 5].map(subtask) }, {
      allowed: { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] }
    }),
    (error) => error.code === 'planner_too_many_subtasks'
  );
  assert.throws(
    () => planner.validatePlannerPlan({ summary: '重复', subtasks: [subtask(1), subtask(1)] }, {
      allowed: { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] }
    }),
    (error) => error.code === 'planner_duplicate_subtask'
  );
});

test('Multica planner 不能扩大本机预授权能力', () => {
  assert.throws(
    () => planner.validatePlannerPlan({
      summary: '越权',
      subtasks: [subtask(1, { websites: ['unapproved.example'], actions: ['browser.open'] })]
    }, {
      allowed: { websites: ['biomni'], apps: [], directories: [], actions: ['browser.open', 'task.checkpoint'] }
    }),
    (error) => error.code === 'planner_capability_denied'
  );
});

test('planner 未退出时不能占着槽位同时启动 worker；结束后每个 worker 独立准备', async () => {
  assert.equal(typeof planner.provisionCodexWorkers, 'function');
  const plan = { summary: '两份', subtasks: [subtask(1), subtask(2)] };
  const allowed = { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] };
  await assert.rejects(
    () => planner.provisionCodexWorkers({ plannerStatus: 'running', plan, allowed }),
    (error) => error.code === 'planner_still_running'
  );
  const prepared = [];
  const result = await planner.provisionCodexWorkers({
    plannerStatus: 'completed',
    plan,
    allowed,
    task: { publicId: 'DT-20260730-0001', multicaIssueId: 'MUL-1' },
    prepareWorker: async (options) => {
      prepared.push(options);
      return { workerId: options.workerId, workspace: `private/${options.workerId}` };
    }
  });
  assert.deepEqual(result.map((item) => item.workerId), ['worker-1', 'worker-2']);
  assert.notEqual(result[0].workspace, result[1].workspace);
  assert.deepEqual(prepared[0].scopes.actions, ['task.checkpoint']);
});

test('从 Multica run-messages 的最后一条结构化文本提取 planner 计划', () => {
  assert.equal(typeof planner.extractPlannerPlan, 'function');
  const plan = planner.extractPlannerPlan({
    messages: [
      { type: 'text', content: '正在分析任务' },
      {
        role: 'assistant',
        content: '```json\n{"summary":"两份","subtasks":[{"id":"S1","title":"第一份","instructions":"处理 A","capabilities":{"websites":[],"apps":[],"directories":[],"actions":["task.checkpoint"]}}]}\n```'
      }
    ]
  });
  assert.equal(plan.summary, '两份');
  assert.equal(plan.subtasks[0].id, 'S1');
  assert.throws(
    () => planner.extractPlannerPlan({ messages: [{ content: '没有结构化结果' }] }),
    (error) => error.code === 'planner_output_missing'
  );
});

test('本机只给任务文字明确提到的已登记网站或软件授权', () => {
  assert.equal(typeof planner.deriveTaskCapabilities, 'function');
  const allowed = planner.deriveTaskCapabilities({
    task: { request: '在 Biomni 里分析数据，结果写到已授权目录' },
    catalog: {
      websites: [{ id: 'biomni', aliases: ['Biomni'] }],
      apps: [{ id: 'omicos', aliases: ['Omicos'] }]
    },
    allowedDirectories: ['D:\\PrivateData']
  });
  assert.deepEqual(allowed.websites, ['biomni']);
  assert.deepEqual(allowed.apps, []);
  assert.deepEqual(allowed.directories, ['D:\\PrivateData']);
  assert.ok(allowed.actions.includes('browser.open'));
  assert.equal(allowed.actions.includes('app.launch'), false);
});
