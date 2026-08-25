import test from 'node:test';
import assert from 'node:assert/strict';
import { MulticaClient } from '../src/integrations/multica-client.mjs';

function fakeRunner(responses) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, run };
}

test('先创建 issue；固定流程不分配模型 agent', async () => {
  const fake = fakeRunner([{ stdout: JSON.stringify({ key: 'MUL-9', id: 'uuid-9' }), stderr: '' }]);
  const client = new MulticaClient({ command: 'multica.exe', runner: fake.run, plannerAgent: 'dt-planner' });

  const result = await client.dispatch({ publicId: 'DT-20260730-0001', request: '打开 Biomni，输入 X 并运行' }, { mode: 'deterministic' });

  assert.equal(result.issueId, 'MUL-9');
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].args.slice(0, 3), ['issue', 'create', '--title']);
  assert.ok(fake.calls[0].args.includes('--description'));
  assert.equal(fake.calls[0].args.includes('--assignee'), false);
  assert.ok(fake.calls[0].args.includes('--output'));
  assert.equal(fake.calls[0].options.shell, false);
});

test('复杂任务一次创建就带完整正文并分配 planner', async () => {
  const request = `分析三组数据并形成报告 ${'长任务正文 '.repeat(30)}`;
  const fake = fakeRunner([{ stdout: JSON.stringify({ key: 'MUL-10' }), stderr: '' }]);
  const client = new MulticaClient({ command: 'multica.exe', runner: fake.run, plannerAgent: 'dt-planner' });

  const result = await client.dispatch({ publicId: 'DT-20260730-0002', request }, { mode: 'complex' });

  assert.equal(result.issueId, 'MUL-10');
  assert.equal(fake.calls.length, 1);
  const args = fake.calls[0].args;
  assert.equal(args[args.indexOf('--description') + 1], request.trim());
  assert.equal(args[args.indexOf('--assignee') + 1], 'dt-planner');
});

test('CLI 失败返回结构化错误，不伪造 issue 或成功', async () => {
  const failure = Object.assign(new Error('exit 1'), { stderr: 'not authenticated' });
  const fake = fakeRunner([failure]);
  const client = new MulticaClient({ command: 'multica.exe', runner: fake.run });

  await assert.rejects(
    () => client.dispatch({ publicId: 'DT-20260730-0003', request: '任务' }, { mode: 'complex' }),
    (error) => error.code === 'multica_cli_failed' && /not authenticated/.test(error.message)
  );
});

test('usage 字段归一化为本地 Token 账本格式', () => {
  const client = new MulticaClient();
  assert.deepEqual(client.normalizeUsage({
    model: 'gpt-5.6-sol',
    input_tokens: 120,
    output_tokens: 30,
    cache_read_tokens: 80,
    duration_ms: 2400,
    estimated_cost: null
  }, { taskId: 7, workerId: 'worker-2' }), {
    usageId: null,
    taskId: 7,
    workerId: 'worker-2',
    model: 'gpt-5.6-sol',
    inputTokens: 120,
    cachedTokens: 80,
    outputTokens: 30,
    cacheHit: true,
    latencyMs: 2400,
    estimatedCost: null
  });
});

test('读取官方 issue usage 聚合响应并生成稳定快照 ID', async () => {
  const fake = fakeRunner([{ stdout: JSON.stringify({
    total_input_tokens: 120,
    total_output_tokens: 30,
    total_cache_read_tokens: 80,
    total_cache_write_tokens: 4,
    task_count: 2
  }), stderr: '' }]);
  const client = new MulticaClient({ command: 'multica.exe', runner: fake.run });

  const payload = await client.getIssueUsage('MUL-88');
  const normalized = client.normalizeUsage(payload, {
    issueId: 'MUL-88', taskId: 7, workerId: 'worker-2'
  });

  assert.deepEqual(fake.calls[0].args, ['issue', 'usage', 'MUL-88', '--output', 'json']);
  assert.deepEqual(normalized, {
    usageId: 'multica:issue:MUL-88:aggregate',
    taskId: 7,
    workerId: 'worker-2',
    model: 'multica-aggregate',
    inputTokens: 120,
    cachedTokens: 80,
    outputTokens: 30,
    cacheHit: true,
    latencyMs: 0,
    estimatedCost: null
  });
});

test('读取 planner 运行记录和消息使用官方文档化 CLI 参数', async () => {
  const fake = fakeRunner([
    { stdout: JSON.stringify({ runs: [{ id: 'run-1', status: 'completed' }] }), stderr: '' },
    { stdout: JSON.stringify({ messages: [{ content: '{"summary":"ok","subtasks":[]}' }] }), stderr: '' }
  ]);
  const client = new MulticaClient({ command: 'multica.exe', runner: fake.run });
  await client.getIssueRuns('MUL-12');
  await client.getRunMessages('run-1');
  assert.deepEqual(fake.calls[0].args, ['issue', 'runs', 'MUL-12', '--full-id', '--output', 'json']);
  assert.deepEqual(fake.calls[1].args, ['issue', 'run-messages', 'run-1', '--output', 'json']);
});

test('worker 子 issue 在一次创建中写描述、父 issue 和固定 agent', async () => {
  const fake = fakeRunner([{ stdout: JSON.stringify({ key: 'MUL-13' }), stderr: '' }]);
  const client = new MulticaClient({ command: 'multica.exe', runner: fake.run });
  const result = await client.createWorkerIssue({
    parentIssueId: 'MUL-12',
    marker: 'DT-20260730-0001:S1',
    title: '第一份',
    description: '只处理 A',
    agent: 'dt-worker-1'
  });
  assert.equal(result.issueId, 'MUL-13');
  assert.deepEqual(fake.calls[0].args, [
    'issue', 'create', '--title', '[DT-20260730-0001:S1] 第一份',
    '--description', '只处理 A', '--parent', 'MUL-12', '--assignee', 'dt-worker-1',
    '--output', 'json'
  ]);
});

test('暂停与取消使用官方 cancel-task，继续使用官方 rerun', async () => {
  const fake = fakeRunner([
    { stdout: JSON.stringify({ status: 'cancelled' }), stderr: '' },
    { stdout: JSON.stringify({ status: 'queued' }), stderr: '' }
  ]);
  const client = new MulticaClient({ command: 'multica.exe', runner: fake.run });

  await client.cancelTask('run-123');
  await client.rerunIssue('MUL-12');

  assert.deepEqual(fake.calls[0].args, ['issue', 'cancel-task', 'run-123']);
  assert.deepEqual(fake.calls[1].args, ['issue', 'rerun', 'MUL-12']);
});
