import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskStore, VERIFICATION_REASON } from '../src/core/task-store.mjs';
import { resolveIncomingMessage } from '../src/core/message-router.mjs';

// 中文注释：创建独立内存仓库，避免测试间共享状态。
function createStore(options) {
  return new TaskStore(':memory:', options);
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

// ---------------------------------------------------------------------------
// 以下为本轮修复的回归测试，测试名与缺陷编号一一对应。
// ---------------------------------------------------------------------------

test('B1：暂停不得摧毁 waiting_for_user 状态与验证码等待窗口', () => {
  const store = createStore();
  const task = store.createTask({ request: '登录教务系统' });
  store.transition(task.id, 'running');
  store.transition(task.id, 'waiting_for_user', { reason: VERIFICATION_REASON });
  assert.equal(store.listVerificationWaiters().length, 1);

  const paused = store.pause(task.id);

  // 修复前：state 被强写成 queued，等待窗口消失，验证码被当成新任务。
  assert.equal(paused.state, 'waiting_for_user', '暂停必须保留原状态');
  assert.equal(paused.paused, true);
  assert.equal(paused.pausedFrom, 'waiting_for_user', '必须记录暂停前的状态');
  assert.equal(store.listVerificationWaiters().length, 1, '等待验证码的窗口不能被暂停清掉');
  assert.equal(resolveIncomingMessage(store, '123456').kind, 'verification_code');
});

test('B1b：只有 running 任务暂停时才回落到 queued，且暂停可重复调用', () => {
  const store = createStore();
  const task = store.createTask({ request: '整理实验记录' });
  store.transition(task.id, 'running');

  const paused = store.pause(task.id);
  assert.equal(paused.state, 'queued', 'running 任务暂停后应让出运行位');
  assert.equal(paused.pausedFrom, 'running');

  const again = store.pause(task.id);
  assert.equal(again.paused, true, '重复暂停必须幂等');
  assert.equal(again.pausedFrom, 'running', '重复暂停不能覆盖首次记录的来源状态');
});

test('B2：暂停的任务不再占用活跃槽位', () => {
  const store = createStore();
  const tasks = [];
  for (let index = 0; index < 4; index += 1) {
    tasks.push(store.createTask({ request: `任务 ${index}` }));
  }
  for (const task of tasks) store.pause(task.id);

  // 修复前：四个暂停任务仍占满槽位，第五个任务直接被拒。
  assert.equal(store.countRunnableTasks(), 0, '暂停任务不计入可运行槽位');
  assert.equal(store.countOpenTasks(), 4, '但它们仍是未结束任务');
  const fifth = store.createTask({ request: '第五个任务' });
  assert.equal(fifth.state, 'queued');
  assert.equal(store.listActiveTasks().length, 5, '暂停任务仍要能被列出，不能凭空消失');
});

test('B2b：继续任务时若槽位已满则拒绝，并保持暂停状态', () => {
  const store = createStore({ maxSlots: 1 });
  const first = store.createTask({ request: '任务一' });
  store.pause(first.id);
  const second = store.createTask({ request: '任务二' });

  const result = store.resume(first.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'slots_full');
  assert.match(result.message, /槽位|上限/);
  assert.equal(store.getTask(first.id).paused, true, '拒绝继续后任务必须仍是暂停态');
  assert.equal(store.getTask(second.id).state, 'queued');
});

test('B2c：继续一个未暂停的任务应被明确拒绝而不是静默成功', () => {
  const store = createStore();
  const task = store.createTask({ request: '任务' });
  const result = store.resume(task.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_paused');
});

test('B9：终态流转不得擦掉原因，并且失败原因可持久追溯', () => {
  const store = createStore();
  const task = store.createTask({ request: '发送邮件' });
  store.transition(task.id, 'running');
  store.transition(task.id, 'waiting_for_user', { reason: '需要人工确认发送' });

  const finished = store.transition(task.id, 'partial', { summary: '已停在确认页' });

  // 修复前：不带 reason 的流转会把 reason 写成 null，事后无法解释任务为何没做完。
  assert.equal(finished.reason, '需要人工确认发送', '未显式改写时必须保留原因');
  assert.equal(finished.summary, '已停在确认页');
  assert.ok(finished.failureReason, '非成功终态必须落一条失败原因');
});

test('B9b：显式传入 reason 才允许改写，传 null 才允许清空', () => {
  const store = createStore();
  const task = store.createTask({ request: '任务' });
  store.transition(task.id, 'running');
  store.transition(task.id, 'waiting_for_user', { reason: '需要验证码' });

  const cleared = store.transition(task.id, 'running', { reason: null });
  assert.equal(cleared.reason, null, '显式传 null 应清空原因');
});

test('B10：重试次数持久化在任务行上，可跨进程读取', () => {
  const store = createStore();
  const task = store.createTask({ request: '上传附件' });
  assert.equal(task.attempt, 0, '新任务尝试次数应为 0');

  assert.equal(store.bumpAttempt(task.id), 1);
  assert.equal(store.bumpAttempt(task.id), 2);
  assert.equal(store.getTask(task.id).attempt, 2, '尝试次数必须落库而不是只存内存');
});

test('B10b：断点续跑状态可保存并读回', () => {
  const store = createStore();
  const task = store.createTask({ request: '分批下载文献' });
  store.saveResumeState(task.id, { page: 3 });
  assert.deepEqual(store.getResumeState(task.id), { page: 3 }, '对象应自动序列化与反序列化');

  store.saveResumeState(task.id, null);
  assert.equal(store.getResumeState(task.id), null, '清空检查点应读回 null');
});

test('取消任务会释放它持有的全部资源锁', () => {
  const store = createStore();
  const first = store.createTask({ request: '占用浏览器' });
  const second = store.createTask({ request: '也要浏览器' });
  store.acquireLock(first.id, 'browser:default');

  store.transition(first.id, 'cancelled', { reason: '用户取消' });

  assert.equal(store.listLocks(first.id).length, 0, '终态任务不得继续持锁');
  assert.equal(store.tryAcquireLock(second.id, 'browser:default').ok, true);
});
