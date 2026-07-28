import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskStore } from '../src/core/task-store.mjs';
import { resolveIncomingMessage } from '../src/core/message-router.mjs';
import { handleFeishuText } from '../src/core/feishu-adapter.mjs';

function createStore() {
  return new TaskStore(':memory:');
}

test('B3：没有任务等待验证码时，纯数字不得静默变成新任务', () => {
  const store = createStore();
  // 修复前：'123456' 直接落成 { kind: 'new_task', request: '123456' }，
  // 修复前：一条验证码就变成一个莫名其妙的任务。
  const routed = resolveIncomingMessage(store, '123456');
  assert.equal(routed.kind, 'ambiguous_digits');
  assert.match(routed.message, /没有任务在等待验证码/);
  assert.equal(store.listActiveTasks().length, 0);
});

test('B3b：过期的等待窗口不再接收验证码', () => {
  const store = new TaskStore(':memory:', { verificationTtlSeconds: -1 });
  const task = store.createTask({ request: '登录站点' });
  store.transition(task.id, 'running');
  store.transition(task.id, 'waiting_for_user', { reason: '需要验证码' });

  assert.equal(store.listVerificationWaiters().length, 0, '已过期的窗口不应被列出');
  assert.equal(resolveIncomingMessage(store, '123456').kind, 'ambiguous_digits');
});

test('B4：不带编号的暂停必须解析出真实任务或要求补充编号', () => {
  const store = createStore();
  // 修复前：taskId 为 null 直接传进数据库，用户只收到 "任务 null 不存在"。
  const routed = resolveIncomingMessage(store, '暂停');
  assert.equal(routed.kind, '暂停');
  assert.equal(routed.taskId, null);

  const empty = handleFeishuText(store, '暂停', { openId: 'ou_owner' });
  assert.equal(empty.action, 'needs_clarification');
  assert.equal(empty.reason, 'no_candidates');
  assert.match(empty.message, /没有可暂停的任务/);
});

test('B4b：只有一个候选任务时不带编号的暂停与继续应直接生效', () => {
  const store = createStore();
  const created = handleFeishuText(store, '整理文献', { openId: 'ou_owner' });

  const paused = handleFeishuText(store, '暂停', { openId: 'ou_owner' });
  assert.equal(paused.action, 'paused');
  assert.equal(paused.task.id, created.task.id);

  const resumed = handleFeishuText(store, '继续', { openId: 'ou_owner' });
  assert.equal(resumed.action, 'resumed');
  assert.equal(resumed.task.paused, false);
});

test('B4c：多个候选任务时要求补充编号并列出候选', () => {
  const store = createStore();
  handleFeishuText(store, '任务甲', { openId: 'ou_owner' });
  handleFeishuText(store, '任务乙', { openId: 'ou_owner' });

  const result = handleFeishuText(store, '暂停', { openId: 'ou_owner' });
  assert.equal(result.action, 'needs_clarification');
  assert.equal(result.reason, 'need_task_id');
  assert.equal(result.candidates.length, 2, '必须把候选任务列出来供用户选择');
  assert.match(result.message, /暂停 <编号>/);
});

test('B4d：暂停时只把未暂停的任务算作候选', () => {
  const store = createStore();
  const first = handleFeishuText(store, '任务甲', { openId: 'ou_owner' });
  handleFeishuText(store, '任务乙', { openId: 'ou_owner' });
  store.pause(first.task.id);

  const result = handleFeishuText(store, '暂停', { openId: 'ou_owner' });
  assert.equal(result.action, 'paused', '已暂停的任务不应再算候选，剩下唯一一个可直接暂停');

  const resumed = handleFeishuText(store, '继续', { openId: 'ou_owner' });
  assert.equal(resumed.action, 'needs_clarification');
  assert.equal(resumed.reason, 'need_task_id', '此时有两个暂停任务，继续必须要求编号');
});

test('命令允许不带空格，且指定不存在的编号会得到可读错误', () => {
  const store = createStore();
  assert.equal(resolveIncomingMessage(store, '暂停3').taskId, 3);
  assert.equal(resolveIncomingMessage(store, '暂停 3').taskId, 3);
  assert.equal(resolveIncomingMessage(store, '状态').kind, 'status');

  const missing = handleFeishuText(store, '暂停 99', { openId: 'ou_owner' });
  assert.equal(missing.action, 'needs_clarification');
  assert.match(missing.message, /任务 99 不存在/);
});

test('空消息与普通文本被正确区分', () => {
  const store = createStore();
  assert.equal(resolveIncomingMessage(store, '   ').kind, 'empty');
  assert.deepEqual(resolveIncomingMessage(store, '打开 Biomni'), {
    kind: 'new_task',
    request: '打开 Biomni'
  });
});
