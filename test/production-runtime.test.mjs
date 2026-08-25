import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueCapabilityTicket } from '../src/core/capability-ticket.mjs';
import { TaskStore } from '../src/core/task-store.mjs';

const production = await import('../src/production-runtime.mjs').catch(() => ({}));

test('统一运行时启动飞书、调度、同步和回执，停止时释放全部本机资源', async () => {
  assert.equal(typeof production.createRuntimeSupervisor, 'function');
  const events = [];
  const timers = [];
  const supervisor = production.createRuntimeSupervisor({
    startFeishu: async () => {
      events.push('feishu:start');
      return { close: async () => events.push('feishu:stop') };
    },
    scheduler: {
      start() { events.push('scheduler:start'); return { started: true }; },
      stop() { events.push('scheduler:stop'); }
    },
    refreshTelemetry: async () => events.push('telemetry'),
    multicaBridge: { async sync() { events.push('multica'); } },
    receiptPump: { async flush() { events.push('receipts'); } },
    browser: { async close() { events.push('browser:stop'); } },
    store: { close() { events.push('store:stop'); } },
    processLock: { async release() { events.push('lock:release'); } },
    setIntervalFn(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn(timer) { events.push(`timer:stop:${timer.delay}`); },
    intervals: { telemetryMs: 1000, multicaMs: 2000, receiptsMs: 3000 }
  });

  const started = await supervisor.start();
  assert.equal(started.started, true);
  assert.deepEqual(events.slice(0, 5), ['telemetry', 'feishu:start', 'multica', 'receipts', 'scheduler:start']);
  assert.deepEqual(timers.map((timer) => timer.delay), [1000, 2000, 3000]);

  await supervisor.stop();
  assert.ok(events.includes('feishu:stop'));
  assert.ok(events.includes('scheduler:stop'));
  assert.ok(events.includes('browser:stop'));
  assert.deepEqual(events.slice(-2), ['store:stop', 'lock:release']);
});

test('统一运行时重复 start/stop 不创建第二套网关或重复关闭数据库', async () => {
  assert.equal(typeof production.createRuntimeSupervisor, 'function');
  let starts = 0;
  let closes = 0;
  const supervisor = production.createRuntimeSupervisor({
    startFeishu: async () => { starts += 1; return {}; },
    scheduler: { start: () => ({ started: false }), stop() {} },
    refreshTelemetry: async () => {},
    multicaBridge: { sync: async () => [] },
    receiptPump: { flush: async () => ({ sent: 0 }) },
    store: { close() { closes += 1; } },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {}
  });
  assert.equal((await supervisor.start()).started, true);
  assert.equal((await supervisor.start()).alreadyStarted, true);
  await supervisor.stop();
  await supervisor.stop();
  assert.equal(starts, 1);
  assert.equal(closes, 1);
});

test('统一运行时部分启动失败时立即回滚已打开资源，不留下假在线进程', async () => {
  const events = [];
  const supervisor = production.createRuntimeSupervisor({
    startFeishu: async () => {
      events.push('feishu:start');
      return { async close() { events.push('feishu:stop'); } };
    },
    scheduler: { start: () => ({ started: true }), stop() { events.push('scheduler:stop'); } },
    refreshTelemetry: async () => events.push('telemetry'),
    multicaBridge: { async sync() { events.push('multica'); throw new Error('initial sync failed'); } },
    receiptPump: { flush: async () => ({ sent: 0 }) },
    browser: { async close() { events.push('browser:stop'); } },
    healthReporter: { async stop() { events.push('health:stop'); } },
    store: { close() { events.push('store:stop'); } },
    processLock: { async release() { events.push('lock:release'); } },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn() {}
  });

  await assert.rejects(() => supervisor.start(), /initial sync failed/);
  assert.ok(events.includes('feishu:stop'));
  assert.ok(events.includes('browser:stop'));
  assert.deepEqual(events.slice(-2), ['store:stop', 'lock:release']);
  assert.equal((await supervisor.stop()).alreadyStopped, true);
});

test('单个资源关闭失败时仍继续释放浏览器、SQLite 和进程锁', async () => {
  const events = [];
  const supervisor = production.createRuntimeSupervisor({
    startFeishu: async () => ({ async close() { events.push('feishu:stop'); throw new Error('feishu close failed'); } }),
    scheduler: { start: () => ({ started: true }), stop() { events.push('scheduler:stop'); } },
    refreshTelemetry: async () => {},
    multicaBridge: { sync: async () => [] },
    receiptPump: { flush: async () => ({ sent: 0 }) },
    browser: { async close() { events.push('browser:stop'); } },
    healthReporter: { async start() {}, async stop() { events.push('health:stop'); } },
    store: { close() { events.push('store:stop'); } },
    processLock: { async release() { events.push('lock:release'); } },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn() {}
  });

  await supervisor.start();
  await assert.rejects(() => supervisor.stop(), /feishu close failed/);
  assert.ok(events.includes('browser:stop'));
  assert.ok(events.includes('health:stop'));
  assert.deepEqual(events.slice(-2), ['store:stop', 'lock:release']);
});

test('后台同步泵不允许重入，慢 Multica 轮询不会重复派发 worker', async () => {
  const timers = [];
  let syncCalls = 0;
  let releaseSlowSync;
  const slowSync = new Promise((resolve) => { releaseSlowSync = resolve; });
  const supervisor = production.createRuntimeSupervisor({
    startFeishu: async () => ({}),
    scheduler: { start: () => ({ started: true }), stop() {} },
    refreshTelemetry: async () => {},
    multicaBridge: {
      async sync() {
        syncCalls += 1;
        if (syncCalls > 1) await slowSync;
      }
    },
    receiptPump: { flush: async () => ({ sent: 0 }) },
    store: { close() {} },
    setIntervalFn(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
    intervals: { telemetryMs: 1000, multicaMs: 2000, receiptsMs: 3000 }
  });
  await supervisor.start();
  const multicaTimer = timers.find((timer) => timer.delay === 2000);

  multicaTimer.callback();
  await Promise.resolve();
  multicaTimer.callback();
  await Promise.resolve();

  assert.equal(syncCalls, 2, '第二个重叠 tick 必须跳过');
  releaseSlowSync();
  await new Promise((resolve) => setImmediate(resolve));
  multicaTimer.callback();
  await Promise.resolve();
  assert.equal(syncCalls, 3, '上一轮结束后下一 tick 可以继续');
  await supervisor.stop();
});

test('停止运行时先等待正在执行的后台泵，再关闭 SQLite', async () => {
  const timers = [];
  let syncCalls = 0;
  let releaseSlowSync;
  const slowSync = new Promise((resolve) => { releaseSlowSync = resolve; });
  let storeClosed = false;
  const supervisor = production.createRuntimeSupervisor({
    startFeishu: async () => ({}),
    scheduler: { start: () => ({ started: true }), stop() {} },
    refreshTelemetry: async () => {},
    multicaBridge: { async sync() { syncCalls += 1; if (syncCalls > 1) await slowSync; } },
    receiptPump: { flush: async () => ({ sent: 0 }) },
    store: { close() { storeClosed = true; } },
    setIntervalFn(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
    intervals: { telemetryMs: 1000, multicaMs: 2000, receiptsMs: 3000 }
  });
  await supervisor.start();
  timers.find((timer) => timer.delay === 2000).callback();
  await Promise.resolve();

  const stopping = supervisor.stop();
  await Promise.resolve();
  assert.equal(storeClosed, false);
  releaseSlowSync();
  await stopping;
  assert.equal(storeClosed, true);
});

function feishuEvent(text) {
  return {
    sender: { sender_id: { open_id: 'ou_owner' } },
    message: {
      message_id: 'om_biomni_1',
      chat_id: 'oc_owner',
      message_type: 'text',
      content: JSON.stringify({ text })
    }
  };
}

test('生产装配先回任务号，Edge 只在确定性任务执行时连接，并最终发唯一真实回执', async () => {
  assert.equal(typeof production.buildProductionRuntime, 'function');
  const home = mkdtempSync(join(tmpdir(), 'ddt-production-'));
  try {
    mkdirSync(join(home, 'config'), { recursive: true });
    mkdirSync(join(home, 'data', 'screenshots'), { recursive: true });
    writeFileSync(join(home, 'config', 'runtime.json'), JSON.stringify({
      scheduler: { enabled: true, pollSeconds: 60, maxParallelWorkers: 4, maxForegroundTasks: 1 },
      integrations: {
        appCatalog: 'config/apps.json',
        pricing: 'config/pricing.json',
        capabilitySecretFile: 'config/capability-hmac.secret',
        feishu: { appId: 'cli_test', appSecretFile: 'config/feishu.secret', allowedOpenIds: ['ou_owner'] },
        multica: { enabled: false, command: 'multica', plannerAgent: 'dt-planner' }
      }
    }), 'utf8');
    writeFileSync(join(home, 'config', 'apps.json'), JSON.stringify({
      apps: [],
      websites: [{
        id: 'biomni', aliases: ['Biomni'], url: 'https://biomni.test', browser: 'edge',
        fields: { prompt: 'textarea[name="prompt"]' }, actions: { run: 'button[data-action="run"]' },
        resultCondition: 'Done', resultTimeoutMs: 1000
      }]
    }), 'utf8');
    writeFileSync(join(home, 'config', 'pricing.json'), JSON.stringify({ models: {} }), 'utf8');
    writeFileSync(join(home, 'config', 'feishu.secret'), 'feishu-test-secret', 'utf8');

    const replies = [];
    let edgeConnections = 0;
    let lockAcquisitions = 0;
    let lockReleases = 0;
    let socketHandler = null;
    const runtime = await production.buildProductionRuntime({
      home,
      dependencies: {
        collectTelemetry: async () => ({
          reading: { cpuPercent: 10, availableMemoryGb: 12, diskFreeGb: 100, onAcPower: true }
        }),
        createFeishuTransport: () => ({
          base: { appId: 'cli_test' },
          sendText: async (chatId, text) => replies.push({ chatId, text })
        }),
        startFeishuSocket: ({ handleEvent }) => {
          socketHandler = handleEvent;
          return { close: async () => {} };
        },
        acquireProcessLock: async ({ home: lockHome, name }) => {
          assert.equal(lockHome, home);
          assert.equal(name, 'control-plane');
          lockAcquisitions += 1;
          return { async release() { lockReleases += 1; } };
        },
        connectEdge: async () => {
          edgeConnections += 1;
          let entered = '';
          return {
            async open() { return { targetId: 'edge:1:DT', url: 'https://biomni.test' }; },
            async ownsTarget() { return true; },
            async fill({ text }) { entered = text; },
            async readValue() { return entered; },
            async submit() { return { status: 'submitted' }; },
            async wait() { return { status: 'ready' }; },
            async capture() { return { path: join(home, 'data', 'screenshots', 'evidence.png') }; },
            async close() {}
          };
        }
      },
      supervisorOptions: {
        setIntervalFn: () => ({ unref() {} }),
        clearIntervalFn: () => {}
      }
    });

    await runtime.supervisor.start();
    assert.equal(lockAcquisitions, 1);
    assert.equal(existsSync(join(home, 'data', 'control-plane-health.json')), true);
    assert.equal(edgeConnections, 0);
    const handled = await socketHandler(feishuEvent('打开 Biomni，输入 TEST_TEXT 并运行'));
    await handled.background;
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /DT-\d{8}-\d{4}/);
    assert.equal(edgeConnections, 0);

    const tick = await runtime.services.scheduler.tick();
    assert.equal(tick.results[0].outcome, 'completed');
    assert.equal(edgeConnections, 1);
    await runtime.services.receiptPump.flush();
    assert.equal(replies.length, 2);
    assert.match(replies[1].text, /完成/);
    assert.match(replies[1].text, /E-\d+/);
    await runtime.supervisor.stop();
    assert.equal(lockReleases, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('MCP 装配只连接 stdio，读取私有 HMAC，启动时不连接 Edge', async () => {
  assert.equal(typeof production.buildMcpRuntime, 'function');
  const home = mkdtempSync(join(tmpdir(), 'ddt-mcp-runtime-'));
  try {
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(join(home, 'config', 'runtime.json'), JSON.stringify({
      integrations: {
        appCatalog: 'config/apps.json',
        pricing: 'config/pricing.json',
        capabilitySecretFile: 'config/capability-hmac.secret',
        feishu: { appId: null, appSecretFile: 'config/unused.secret', allowedOpenIds: [] },
        multica: { enabled: false, command: 'multica', plannerAgent: 'dt-planner' }
      }
    }), 'utf8');
    writeFileSync(join(home, 'config', 'apps.json'), JSON.stringify({ apps: [], websites: [] }), 'utf8');
    writeFileSync(join(home, 'config', 'capability-hmac.secret'), '0123456789abcdef0123456789abcdef', 'utf8');
    let edgeConnections = 0;
    let stdioConnections = 0;
    const runtime = await production.buildMcpRuntime({
      home,
      dependencies: {
        connectEdge: async () => { edgeConnections += 1; return {}; },
        connectMcp: async ({ server }) => {
          stdioConnections += 1;
          return { server, transport: { kind: 'stdio' } };
        }
      }
    });
    assert.equal(stdioConnections, 1);
    assert.equal(edgeConnections, 0);
    assert.deepEqual(runtime.toolService.names, [
      'browser_open', 'browser_fill', 'browser_submit', 'browser_wait',
      'browser_capture', 'app_launch', 'task_checkpoint', 'task_checkpoint_read'
    ]);
    await runtime.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('绑定 MCP 在启动时消费能力票，同一 binding 不能启动第二个 worker 进程', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ddt-bound-mcp-'));
  const secret = '0123456789abcdef0123456789abcdef';
  try {
    mkdirSync(join(home, 'config'), { recursive: true });
    mkdirSync(join(home, 'data', 'workers'), { recursive: true });
    writeFileSync(join(home, 'config', 'runtime.json'), JSON.stringify({
      integrations: {
        appCatalog: 'config/apps.json', pricing: 'config/pricing.json',
        capabilitySecretFile: 'config/capability-hmac.secret',
        feishu: { appId: null, appSecretFile: 'config/unused.secret', allowedOpenIds: [] },
        multica: { enabled: false, command: 'multica', plannerAgent: 'dt-planner' }
      }
    }), 'utf8');
    writeFileSync(join(home, 'config', 'apps.json'), JSON.stringify({ apps: [], websites: [] }), 'utf8');
    writeFileSync(join(home, 'config', 'capability-hmac.secret'), secret, 'utf8');
    const store = new TaskStore(join(home, 'data', 'runtime.sqlite'));
    const created = store.createTask({ request: 'worker binding' });
    store.bindMulticaIssue(created.id, 'MUL-99');
    const task = store.getTask(created.id);
    store.close();
    const ticket = issueCapabilityTicket({
      secret,
      payload: {
        taskId: task.publicId, multicaIssueId: 'MUL-99', workerId: 'worker-9',
        websites: [], apps: [], directories: [], actions: ['task.checkpoint'],
        expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: 'binding-replay-nonce-1'
      }
    });
    const binding = join(home, 'data', 'workers', 'binding.json');
    writeFileSync(binding, JSON.stringify({ workerId: 'worker-9', ticket }), 'utf8');
    const dependencies = { connectMcp: async ({ server }) => ({ server, transport: {} }) };
    const first = await production.buildMcpRuntime({ home, bindingPath: binding, dependencies });
    assert.equal(first.toolService.bound, true);
    assert.equal(existsSync(binding), false, '能力票绑定成功后立即删除 slot 文件');
    await first.close();
    await assert.rejects(
      () => production.buildMcpRuntime({ home, bindingPath: binding, dependencies }),
      (error) => ['replayed', 'private_json_unavailable'].includes(error.code)
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('生产装配把 planner、资源档位和一次性 slot binding 真正接入 Multica bridge', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ddt-production-multica-'));
  try {
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(join(home, 'config', 'runtime.json'), JSON.stringify({
      scheduler: { enabled: false, pollSeconds: 60, maxParallelWorkers: 4, maxForegroundTasks: 1 },
      integrations: {
        appCatalog: 'config/apps.json', pricing: 'config/pricing.json',
        capabilitySecretFile: 'config/capability-hmac.secret',
        feishu: { appId: 'cli_test', appSecretFile: 'config/feishu.secret', allowedOpenIds: [] },
        multica: {
          enabled: true, command: 'multica', plannerAgent: 'dt-planner',
          workerAgents: ['dt-worker-1', 'dt-worker-2', 'dt-worker-3', 'dt-worker-4'],
          allowedDirectories: []
        }
      }
    }), 'utf8');
    writeFileSync(join(home, 'config', 'apps.json'), JSON.stringify({
      apps: [], websites: [{ id: 'biomni', aliases: ['Biomni'], url: 'https://example.invalid', browser: 'edge' }]
    }), 'utf8');
    writeFileSync(join(home, 'config', 'pricing.json'), JSON.stringify({ models: {} }), 'utf8');
    writeFileSync(join(home, 'config', 'feishu.secret'), 'feishu-test-secret', 'utf8');
    writeFileSync(join(home, 'config', 'capability-hmac.secret'), '0123456789abcdef0123456789abcdef', 'utf8');
    const createdIssues = [];
    const fakeClient = {
      async dispatch() { return { issueId: 'MUL-parent' }; },
      async getIssueRuns(issueId) {
        return issueId === 'MUL-parent'
          ? { runs: [{ id: 'planner-run', status: 'completed' }] }
          : { runs: [{ id: 'worker-run', status: 'running' }] };
      },
      async getRunMessages() {
        return { messages: [{ content: JSON.stringify({
          summary: '一份',
          subtasks: [{ id: 'S1', title: 'Biomni', instructions: '打开 Biomni', capabilities: {
            websites: ['biomni'], apps: [], directories: [], actions: ['browser.open', 'task.checkpoint']
          } }]
        }) }] };
      },
      async createWorkerIssue(input) { createdIssues.push(input); return { issueId: 'MUL-child' }; },
      async getIssueUsage() { return { runs: [] }; },
      normalizeUsage() { throw new Error('没有 usage 时不应调用'); }
    };
    const runtime = await production.buildProductionRuntime({
      home,
      dependencies: {
        collectTelemetry: async () => ({ reading: { cpuPercent: 10, availableMemoryGb: 12, diskFreeGb: 100, onAcPower: true } }),
        createMulticaClient: () => fakeClient,
        createFeishuTransport: () => ({ sendText: async () => {} }),
        startFeishuSocket: () => ({ close: async () => {} })
      },
      supervisorOptions: { setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} }
    });
    const task = runtime.services.store.createTask({ request: '在 Biomni 里分析数据' });
    runtime.services.store.setTaskKind(task.id, 'complex');
    runtime.services.store.bindMulticaIssue(task.id, 'MUL-parent');
    await runtime.supervisor.start();
    assert.equal(createdIssues.length, 1);
    const workers = runtime.services.store.listTaskWorkers(task.id);
    assert.equal(workers[0].state, 'dispatched');
    assert.equal(existsSync(join(home, ...workers[0].bindingPath.split('/'))), true);
    await runtime.supervisor.stop();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
