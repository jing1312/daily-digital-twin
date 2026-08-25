import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/core/task-store.mjs';
import { handleFeishuText } from '../src/core/feishu-adapter.mjs';
import { resolveIncomingMessage } from '../src/core/message-router.mjs';
import { VerificationBroker } from '../src/gateway/verification-broker.mjs';
import { createFeishuController } from '../src/gateway/feishu-controller.mjs';

test('控制命令接受 DT 任务号，并支持看证据', () => {
  const store = new TaskStore(':memory:');
  const task = handleFeishuText(store, '打开 Biomni', { openId: 'ou_owner' }).task;

  assert.deepEqual(resolveIncomingMessage(store, `暂停 ${task.publicId}`), {
    kind: '暂停',
    taskRef: task.publicId
  });
  assert.equal(handleFeishuText(store, `暂停 ${task.publicId}`, { openId: 'ou_owner' }).task.paused, true);

  store.resume(task.id);
  store.transition(task.id, 'running');
  store.transition(task.id, 'completed', { summary: '完成' });
  store.createTerminalReceipt(task.id, { summary: '完成', evidenceRefs: ['E-20260730-1'] });
  const evidence = handleFeishuText(store, `看证据 ${task.publicId}`, { openId: 'ou_owner' });
  assert.equal(evidence.action, 'evidence');
  assert.deepEqual(evidence.receipt.evidenceRefs, ['E-20260730-1']);
  store.close();
});

test('飞书先回 DT 编号，再在后台提交 Multica', async () => {
  const store = new TaskStore(':memory:');
  const order = [];
  const controller = createFeishuController({
    store,
    sendText: async (text) => order.push(['reply', text]),
    dispatchTask: async (task) => {
      order.push(['dispatch', task.publicId]);
      return { issueId: 'MUL-7' };
    }
  });

  const handled = await controller.handle({ text: '整理今天的实验记录', sender: { openId: 'ou_owner' } });
  assert.equal(order[0][0], 'reply');
  assert.match(order[0][1], new RegExp(handled.result.task.publicId));
  await handled.background;
  assert.deepEqual(order.map(([kind]) => kind), ['reply', 'dispatch']);
  assert.equal(store.getTask(handled.result.task.id).multicaIssueId, 'MUL-7');
  assert.equal(store.getTask(handled.result.task.id).taskKind, 'complex');
  store.close();
});

test('固定动作在首次回执前标记为 deterministic，复杂任务标记为 complex', async () => {
  const store = new TaskStore(':memory:');
  const controller = createFeishuController({ store, sendText: async () => {} });
  const fixed = await controller.handle({ text: '打开 Omicos', sender: { openId: 'ou_owner' } });
  assert.equal(store.getTask(fixed.result.task.id).taskKind, 'deterministic');
  store.pause(fixed.result.task.id);
  const complex = await controller.handle({ text: '分析实验数据', sender: { openId: 'ou_owner' } });
  assert.equal(store.getTask(complex.result.task.id).taskKind, 'complex');
  store.close();
});

test('状态命令完全本地处理，不触发 Multica 或模型', async () => {
  const store = new TaskStore(':memory:');
  let dispatches = 0;
  const replies = [];
  const controller = createFeishuController({
    store,
    sendText: async (text) => replies.push(text),
    dispatchTask: async () => { dispatches += 1; }
  });

  await controller.handle({ text: '状态', sender: { openId: 'ou_owner' } });
  assert.equal(dispatches, 0);
  assert.match(replies[0], /当前没有未结束任务/);
  store.close();
});

test('验证码从飞书直达内存 broker，不进入 Multica、日志或数据库', async () => {
  const store = new TaskStore(':memory:');
  const created = handleFeishuText(store, '登录 Biomni', { openId: 'ou_owner' }).task;
  store.transition(created.id, 'running');
  store.transition(created.id, 'waiting_for_user', { reason: '需要验证码' });

  const broker = new VerificationBroker();
  let received = null;
  broker.wait(created.id, (code) => { received = code; return true; });
  let dispatches = 0;
  const controller = createFeishuController({
    store,
    verificationBroker: broker,
    sendText: async () => {},
    dispatchTask: async () => { dispatches += 1; }
  });

  const handled = await controller.handle({ text: '739105', sender: { openId: 'ou_owner' } });
  assert.equal(received, '739105');
  assert.equal(dispatches, 0);
  assert.equal(JSON.stringify(handled).includes('739105'), false);
  const dump = ['tasks', 'task_events', 'verification_waits'].flatMap((table) => store.db.prepare(`SELECT * FROM ${table}`).all()).map(JSON.stringify).join('\n');
  assert.equal(dump.includes('739105'), false);
  store.close();
});

test('继续未暂停的登录等待任务会重新排队，并清理失效的内存验证码等待器', async () => {
  const store = new TaskStore(':memory:');
  const created = handleFeishuText(store, '登录 Biomni', { openId: 'ou_owner' }).task;
  store.transition(created.id, 'running');
  store.transition(created.id, 'waiting_for_user', { reason: '需要登录' });
  const broker = new VerificationBroker();
  broker.wait(created.id, () => true);
  const replies = [];
  const controller = createFeishuController({
    store,
    verificationBroker: broker,
    sendText: async (text) => replies.push(text)
  });

  const handled = await controller.handle({ text: `继续 ${created.publicId}`, sender: { openId: 'ou_owner' } });

  assert.equal(handled.result.action, 'resumed');
  assert.equal(store.getTask(created.id).state, 'queued');
  assert.equal(broker.has(created.id), false);
  assert.match(replies[0], /已继续/);
  store.close();
});

test('验证码填入页面失败时明确回复失败，并保留等待器供用户重试', async () => {
  const store = new TaskStore(':memory:');
  const created = handleFeishuText(store, '登录 Biomni', { openId: 'ou_owner' }).task;
  store.transition(created.id, 'running');
  store.transition(created.id, 'waiting_for_user', { reason: '需要验证码' });
  const broker = new VerificationBroker();
  broker.wait(created.id, async () => { throw Object.assign(new Error('验证码输入框已消失'), { code: 'verification_field_missing' }); });
  const replies = [];
  const controller = createFeishuController({
    store,
    verificationBroker: broker,
    sendText: async (text) => replies.push(text),
    logger: { error() {} }
  });

  const handled = await controller.handle({ text: '739105', sender: { openId: 'ou_owner' } });

  assert.equal(handled.result.action, 'verification_failed');
  assert.match(replies[0], /未能填入|失败/);
  assert.equal(store.getTask(created.id).state, 'waiting_for_user');
  assert.equal(store.listVerificationWaiters().length, 1);
  assert.equal(broker.has(created.id), true);
  assert.equal(JSON.stringify(handled).includes('739105'), false);
  store.close();
});

test('看证据会发送本机已登记截图，飞书文字不泄露原始路径', async () => {
  const store = new TaskStore(':memory:');
  const created = handleFeishuText(store, '打开 Biomni', { openId: 'ou_owner' }).task;
  store.transition(created.id, 'running');
  const evidence = store.insertExecutionEvidence({
    taskId: created.id,
    kind: 'page',
    target: 'D:\\Private\\screenshots\\evidence.png'
  });
  store.transition(created.id, 'completed', { summary: '完成' });
  store.createTerminalReceipt(created.id, { summary: '完成', evidenceRefs: [`E-${evidence.id}`] });
  const texts = [];
  const images = [];
  const controller = createFeishuController({
    store,
    sendText: async (text) => texts.push(text),
    sendEvidence: async (item) => images.push(item)
  });
  await controller.handle({ text: `看证据 ${created.publicId}`, sender: { openId: 'ou_owner' } });
  assert.equal(images.length, 1);
  assert.equal(images[0].id, evidence.id);
  assert.equal(images[0].target, 'D:\\Private\\screenshots\\evidence.png');
  assert.doesNotMatch(texts.join('\n'), /D:\\Private/);
  store.close();
});

test('Multica 派发失败时复杂任务进入 failed，固定流程仍留给本机调度器', async () => {
  const store = new TaskStore(':memory:');
  const controller = createFeishuController({
    store,
    sendText: async () => {},
    dispatchTask: async () => { throw new Error('not authenticated'); },
    logger: { error() {} }
  });
  const complex = await controller.handle({ text: '分析实验数据', sender: { openId: 'ou_owner' } });
  await complex.background;
  assert.equal(store.getTask(complex.result.task.id).state, 'failed');
  assert.match(store.getTask(complex.result.task.id).failureReason, /Multica 派发失败/);

  const fixed = await controller.handle({ text: '打开 Omicos', sender: { openId: 'ou_owner' } });
  await fixed.background;
  assert.equal(store.getTask(fixed.result.task.id).state, 'queued');
  assert.equal(store.getTask(fixed.result.task.id).taskKind, 'deterministic');
  store.close();
});

test('暂停、继续和取消复杂任务会同步调用远端生命周期控制并如实回复失败', async () => {
  const store = new TaskStore(':memory:');
  const calls = [];
  const replies = [];
  const controller = createFeishuController({
    store,
    sendText: async (text) => replies.push(text),
    taskLifecycle: {
      async pauseTask(taskId) { calls.push(['pause', taskId]); return { ok: true }; },
      async resumeTask(taskId) { calls.push(['resume', taskId]); return { ok: false, failures: ['MUL-1'] }; },
      async cancelTask(taskId) { calls.push(['cancel', taskId]); return { ok: true }; }
    }
  });
  const created = await controller.handle({ text: '分析实验数据', sender: { openId: 'ou_owner' } });
  store.bindMulticaIssue(created.result.task.id, 'MUL-1');

  await controller.handle({ text: `暂停 ${created.result.task.publicId}`, sender: { openId: 'ou_owner' } });
  await controller.handle({ text: `继续 ${created.result.task.publicId}`, sender: { openId: 'ou_owner' } });
  await controller.handle({ text: `取消 ${created.result.task.publicId}`, sender: { openId: 'ou_owner' } });

  assert.deepEqual(calls, [
    ['pause', created.result.task.id],
    ['resume', created.result.task.id],
    ['cancel', created.result.task.id]
  ]);
  assert.match(replies.at(-2), /远端.*未确认|Multica.*失败/);
  store.close();
});
