import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskStore } from '../src/core/task-store.mjs';
import { resolveIncomingMessage } from '../src/core/message-router.mjs';

// 中文注释：创建独立内存仓库，避免测试间共享状态。
function createStore() {
  return new TaskStore(':memory:');
}

test('任务状态只能沿规定路径流转', () => {
  const store = createStore();
  const task = store.createTask({ request: '打开 Biomni 并输入 TEST_TEXT' });

  store.transition(task.id, 'running');
  store.transition(task.id, 'waiting_for_user', { reason: '需要验证码' });
  store.transition(task.id, 'running');
  store.transition(task.id, 'completed', { summary: '页面已验证' });

  assert.equal(store.getTask(task.id).state, 'completed');
  assert.throws(() => store.transition(task.id, 'running'), /不允许/);
});

test('全局最多同时保留四个活跃任务', () => {
  const store = createStore();

  for (let index = 0; index < 4; index += 1) {
    store.createTask({ request: `任务 ${index}` });
  }

  assert.throws(() => store.createTask({ request: '第五个任务' }), /四个/);
});

test('单一等待验证码任务可直接接收数字回复', () => {
  const store = createStore();
  const task = store.createTask({ request: '登录 Biomni' });
  store.transition(task.id, 'running');
  store.transition(task.id, 'waiting_for_user', { reason: '需要验证码' });

  assert.deepEqual(resolveIncomingMessage(store, '123456'), {
    kind: 'verification_code',
    taskId: task.id,
    code: '123456'
  });
});

test('多个等待验证码任务时必须指明任务号', () => {
  const store = createStore();
  const first = store.createTask({ request: '登录站点 A' });
  const second = store.createTask({ request: '登录站点 B' });

  for (const task of [first, second]) {
    store.transition(task.id, 'running');
    store.transition(task.id, 'waiting_for_user', { reason: '需要验证码' });
  }

  assert.deepEqual(resolveIncomingMessage(store, `任务 ${second.id}：654321`), {
    kind: 'verification_code',
    taskId: second.id,
    code: '654321'
  });
  assert.equal(resolveIncomingMessage(store, '654321').kind, 'ambiguous');
});

test('同一资源只能被一个任务锁定', () => {
  const store = createStore();
  const first = store.createTask({ request: '编辑报告' });
  const second = store.createTask({ request: '编辑报告副本' });

  store.acquireLock(first.id, 'file:report.xlsx');
  assert.throws(() => store.acquireLock(second.id, 'file:report.xlsx'), /占用/);
  store.releaseLocks(first.id);
  store.acquireLock(second.id, 'file:report.xlsx');

  assert.equal(store.listLocks(second.id)[0].resource, 'file:report.xlsx');
});
