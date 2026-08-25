import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/core/task-store.mjs';
import { TaskBrowserExecutor, BrowserExecutionError } from '../src/execution/browser-executor.mjs';

function createFixture(overrides = {}) {
  const calls = [];
  const driver = {
    async open(input) { calls.push(['open', input]); return { targetId: 'edge-tab-1', url: input.url }; },
    async ownsTarget(targetId) { calls.push(['owns', targetId]); return true; },
    async fill(input) { calls.push(['fill', input]); },
    async readValue(input) { calls.push(['read', input]); return input.expected; },
    async submit(input) { calls.push(['submit', input]); return { status: 'submitted' }; },
    async isVisible(input) { calls.push(['visible', input]); return false; },
    async fillSensitive(input) { calls.push(['fill-sensitive', input]); },
    async wait(input) { calls.push(['wait', input]); return { status: 'ready' }; },
    async capture(input) { calls.push(['capture', input]); return { path: 'D:\\private\\evidence.png' }; },
    ...overrides
  };
  const store = new TaskStore(':memory:');
  const task = store.createTask({ request: '打开 Biomni，输入 X 并运行' });
  store.bindMulticaIssue(task.id, 'MUL-11');
  store.transition(task.id, 'running');
  const catalog = {
    websites: [{
      id: 'biomni', aliases: ['Biomni'], url: 'https://biomni.example.invalid', browser: 'edge',
      fields: { prompt: '[data-dt=prompt]' }, actions: { submit: '[data-dt=submit]' },
      verification: { field: '[data-dt=otp]', submit: '[data-dt=otp-submit]' },
      loginRequiredSelector: '[data-dt=login]'
    }]
  };
  return { calls, driver, store, task: store.getTask(task.id), executor: new TaskBrowserExecutor({ store, catalog, driver }) };
}

test('任务页固定用 Edge 扩展创建，并记录归属 target', async () => {
  const fx = createFixture();
  const result = await fx.executor.open({ taskId: fx.task.id, website: 'biomni' });
  assert.equal(result.targetId, 'edge-tab-1');
  assert.deepEqual(fx.calls[0][1], {
    browser: 'msedge', extension: true, url: 'https://biomni.example.invalid', taskId: fx.task.publicId
  });
  fx.store.close();
});

test('填写后必须回读输入值，值不一致就失败', async () => {
  const fx = createFixture({ async readValue() { return '错误内容'; } });
  await fx.executor.open({ taskId: fx.task.id, website: 'biomni' });
  await assert.rejects(
    () => fx.executor.fill({ taskId: fx.task.id, field: 'prompt', text: '目标内容' }),
    (error) => error instanceof BrowserExecutionError && error.code === 'fill_verification_failed'
  );
  fx.store.close();
});

test('任务标签被移出归属后立即停止并等待用户，不改开 Chrome', async () => {
  const fx = createFixture({ async ownsTarget() { return false; } });
  await fx.executor.open({ taskId: fx.task.id, website: 'biomni' });
  await assert.rejects(
    () => fx.executor.submit({ taskId: fx.task.id, action: 'submit' }),
    (error) => error.code === 'task_tab_not_owned' && error.waitingForUser === true
  );
  assert.equal(fx.calls.some(([, input]) => input?.browser === 'chrome'), false);
  fx.store.close();
});

test('截图只返回证据编号，原始路径留在本机证据表', async () => {
  const fx = createFixture();
  await fx.executor.open({ taskId: fx.task.id, website: 'biomni' });
  const result = await fx.executor.capture({ taskId: fx.task.id });
  assert.match(result.evidenceRef, /^E-\d+$/);
  assert.equal('path' in result, false);
  assert.equal(fx.store.listExecutionEvidence(fx.task.id)[0].target, 'D:\\private\\evidence.png');
  const captureCall = fx.calls.find(([name]) => name === 'capture');
  assert.deepEqual(captureCall[1].sensitiveSelectors, ['[data-dt=otp]']);
  fx.store.close();
});

test('只按私有目录登记的 selector 检测登录和验证码，并通过敏感输入通道填写验证码', async () => {
  const fx = createFixture({
    async isVisible(input) {
      fx.calls.push(['visible', input]);
      return input.selector === '[data-dt=otp]';
    },
    async fillSensitive(input) { fx.calls.push(['fill-sensitive', input]); },
    async submit(input) { fx.calls.push(['submit', input]); return { status: 'submitted' }; }
  });
  await fx.executor.open({ taskId: fx.task.id, website: 'biomni' });

  assert.deepEqual(await fx.executor.detectUserGate({ taskId: fx.task.id }), { kind: 'verification' });
  const delivered = await fx.executor.provideVerification({ taskId: fx.task.id, code: '739105' });

  assert.deepEqual(delivered, { accepted: true });
  assert.equal(fx.calls.some(([name, input]) => name === 'fill-sensitive' && input.selector === '[data-dt=otp]'), true);
  assert.equal(fx.calls.some(([name, input]) => name === 'submit' && input.selector === '[data-dt=otp-submit]'), true);
  assert.equal(JSON.stringify(delivered).includes('739105'), false);
  fx.store.close();
});

test('控制平面重启后从 SQLite 恢复任务标签，不重复新建页面', async () => {
  const fx = createFixture();
  await fx.executor.open({ taskId: fx.task.id, website: 'biomni' });
  const restarted = new TaskBrowserExecutor({ store: fx.store, catalog: fx.executor.catalog, driver: fx.driver });

  await restarted.fill({ taskId: fx.task.id, field: 'prompt', text: '恢复后的内容' });

  assert.equal(fx.calls.filter(([name]) => name === 'open').length, 1);
  assert.equal(fx.calls.some(([name, input]) => name === 'fill' && input.text === '恢复后的内容'), true);
  fx.store.close();
});

test('恢复持久化标签时 Edge 扩展断开仍进入等待，不按普通失败重试', async () => {
  const fx = createFixture();
  await fx.executor.open({ taskId: fx.task.id, website: 'biomni' });
  const disconnected = {
    ...fx.driver,
    async ownsTarget() { throw new Error('extension connection closed'); }
  };
  const restarted = new TaskBrowserExecutor({ store: fx.store, catalog: fx.executor.catalog, driver: disconnected });

  await assert.rejects(
    () => restarted.open({ taskId: fx.task.id, website: 'biomni' }),
    (error) => error.code === 'edge_disconnected' && error.waitingForUser === true
  );
  fx.store.close();
});

test('等待页面结果时同时传入验证码和登录 selector，并返回人机阻断类型', async () => {
  const fx = createFixture({
    async wait(input) {
      fx.calls.push(['wait', input]);
      return { status: 'verification_required' };
    }
  });
  await fx.executor.open({ taskId: fx.task.id, website: 'biomni' });

  const result = await fx.executor.wait({ taskId: fx.task.id, condition: '任务完成', timeoutMs: 900_000 });

  assert.deepEqual(result.gate, { kind: 'verification' });
  const wait = fx.calls.find(([name]) => name === 'wait')[1];
  assert.equal(wait.verificationSelector, '[data-dt=otp]');
  assert.equal(wait.loginSelector, '[data-dt=login]');
  assert.equal(wait.timeoutMs, 900_000);
  fx.store.close();
});
