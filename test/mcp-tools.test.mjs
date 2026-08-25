import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TaskStore } from '../src/core/task-store.mjs';
import { issueCapabilityTicket, verifyCapabilityTicket } from '../src/core/capability-ticket.mjs';
import { createTaskToolService, DAILY_TWIN_TOOL_NAMES } from '../src/mcp/task-tools.mjs';
import { createDailyTwinMcpServer } from '../src/mcp/server.mjs';
import * as mcpModule from '../src/mcp/server.mjs';

const SECRET = Buffer.from('mcp-test-secret-that-is-at-least-32-bytes');

function ticket(task, nonce, action, scopes = {}) {
  return issueCapabilityTicket({
    secret: SECRET,
    payload: {
      taskId: task.publicId,
      multicaIssueId: task.multicaIssueId,
      workerId: 'worker-1',
      websites: scopes.websites ?? ['biomni'],
      apps: scopes.apps ?? ['omicos'],
      directories: scopes.directories ?? ['D:\\TwinTasks\\task-1'],
      actions: [action],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce
    }
  });
}

function fixture() {
  const store = new TaskStore(':memory:');
  const created = store.createTask({ request: '任务' });
  store.bindMulticaIssue(created.id, 'MUL-12');
  store.transition(created.id, 'running');
  const task = store.getTask(created.id);
  const calls = [];
  const service = createTaskToolService({
    store,
    capabilitySecret: SECRET,
    browserExecutor: {
      async open(args) { calls.push(['open', args]); return { targetId: 'edge-1' }; },
      async fill(args) { calls.push(['fill', args]); return { verified: true }; },
      async submit(args) { calls.push(['submit', args]); return { submitted: true }; },
      async wait(args) { calls.push(['wait', args]); return { ready: true }; },
      async capture(args) { calls.push(['capture', args]); return { evidenceRef: 'E-1' }; }
    },
    appExecutor: {
      async launch(args) { calls.push(['launch', args]); return { evidenceRef: 'E-2' }; }
    }
  });
  return { store, task, calls, service };
}

test('只暴露高层工具，不暴露原始 Playwright、Shell 或通用电脑控制', () => {
  assert.deepEqual(DAILY_TWIN_TOOL_NAMES, [
    'browser_open', 'browser_fill', 'browser_submit', 'browser_wait', 'browser_capture', 'app_launch',
    'task_checkpoint', 'task_checkpoint_read'
  ]);
  const joined = DAILY_TWIN_TOOL_NAMES.join(' ');
  assert.doesNotMatch(joined, /shell|powershell|run_code|click|playwright|computer/i);
});

test('高层工具校验并消费能力票，重放同一 ticket 失败', async () => {
  const fx = fixture();
  const token = ticket(fx.task, 'mcp-nonce-00000001', 'browser.open');

  const result = await fx.service.invoke('browser_open', { ticket: token, workerId: 'worker-1', website: 'biomni' });
  assert.equal(result.targetId, 'edge-1');
  await assert.rejects(
    () => fx.service.invoke('browser_open', { ticket: token, workerId: 'worker-1', website: 'biomni' }),
    (error) => error.code === 'replayed'
  );
  fx.store.close();
});

test('MCP 协议真实列出的工具与高层白名单完全一致', async () => {
  const fx = fixture();
  const server = createDailyTwinMcpServer({ toolService: fx.service });
  const client = new Client({ name: 'daily-twin-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...DAILY_TWIN_TOOL_NAMES].sort());
  await client.close();
  await server.close();
  fx.store.close();
});

test('MCP 工具错误使用 isError 返回，不让服务器崩溃', async () => {
  const fx = fixture();
  const server = createDailyTwinMcpServer({ toolService: fx.service });
  const client = new Client({ name: 'daily-twin-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: 'browser_open', arguments: { ticket: 'bad', workerId: 'worker-1', website: 'biomni' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /能力票/);
  await client.close();
  await server.close();
  fx.store.close();
});

test('MCP 生产入口使用 stdio transport 连接 Codex，不开放网络监听端口', async () => {
  assert.equal(typeof mcpModule.connectDailyTwinMcpStdio, 'function');
  const transport = { kind: 'stdio' };
  const calls = [];
  const server = { async connect(value) { calls.push(value); } };
  const result = await mcpModule.connectDailyTwinMcpStdio({
    server,
    transportFactory: () => transport
  });
  assert.equal(result.transport, transport);
  assert.deepEqual(calls, [transport]);
});

test('worker 启动时消费一次能力票，后续高层调用不把票暴露给模型但仍逐项校验权限', async () => {
  const fx = fixture();
  const token = issueCapabilityTicket({
    secret: SECRET,
    payload: {
      taskId: fx.task.publicId,
      multicaIssueId: fx.task.multicaIssueId,
      workerId: 'worker-bound',
      websites: ['biomni'],
      apps: [],
      directories: [],
      actions: ['browser.open', 'browser.capture'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: 'bound-session-nonce-0001'
    }
  });
  const boundCapability = verifyCapabilityTicket(token, { secret: SECRET, store: fx.store, consume: true });
  const service = createTaskToolService({
    store: fx.store,
    capabilitySecret: SECRET,
    boundCapability,
    browserExecutor: {
      async open() { return { targetId: 'edge-bound' }; },
      async capture() { return { evidenceRef: 'E-bound' }; }
    },
    appExecutor: { async launch() { throw new Error('not allowed'); } }
  });
  assert.deepEqual(await service.invoke('browser_open', { website: 'biomni' }), { targetId: 'edge-bound' });
  await assert.rejects(
    () => service.invoke('browser_fill', { field: 'prompt', text: 'x' }),
    (error) => error.code === 'action_denied'
  );

  const server = createDailyTwinMcpServer({ toolService: service });
  const client = new Client({ name: 'bound-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const openSchema = listed.tools.find((tool) => tool.name === 'browser_open').inputSchema;
  assert.equal(openSchema.properties.ticket, undefined);
  assert.equal(openSchema.properties.workerId, undefined);
  await client.close();
  await server.close();
  fx.store.close();
});

test('不同 worker 的检查点按命名空间隔离，不覆盖根任务续跑状态', async () => {
  const fx = fixture();
  const makeService = (workerId) => createTaskToolService({
    store: fx.store,
    boundCapability: {
      taskId: fx.task.publicId,
      multicaIssueId: fx.task.multicaIssueId,
      workerId,
      websites: [], apps: [], directories: [], actions: ['task.checkpoint']
    },
    browserExecutor: {},
    appExecutor: {}
  });

  await makeService('worker-1').invoke('task_checkpoint', { checkpoint: { page: 2 } });
  await makeService('worker-2').invoke('task_checkpoint', { checkpoint: { page: 7 } });

  assert.deepEqual(await makeService('worker-1').invoke('task_checkpoint_read'), {
    checkpoint: { page: 2 },
    savedAt: fx.store.getWorkerCheckpoint(fx.task.id, 'worker-1').savedAt
  });
  assert.deepEqual(fx.store.getWorkerCheckpoint(fx.task.id, 'worker-2').checkpoint, { page: 7 });
  assert.equal(fx.store.getResumeState(fx.task.id), null);
  fx.store.close();
});
