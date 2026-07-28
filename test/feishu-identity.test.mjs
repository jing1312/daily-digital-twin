import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskStore } from '../src/core/task-store.mjs';
import { handleFeishuText, authorizeSender } from '../src/core/feishu-adapter.mjs';

function createStore() {
  return new TaskStore(':memory:');
}

test('B17：缺少发送者身份的消息一律拒绝执行', () => {
  const store = createStore();
  // 修复前：适配器不看发送者，任何能把消息投进来的人都能在她电脑上开程序。
  const result = handleFeishuText(store, '打开 VS Code');
  assert.equal(result.action, 'rejected');
  assert.equal(result.reason, 'sender_required');
  assert.equal(store.listActiveTasks().length, 0, '被拒绝的消息不得留下任务');
});

test('B17b：首个发送者自动成为归属账号，其他账号被拒绝', () => {
  const store = createStore();

  const first = handleFeishuText(store, '整理今天的实验记录', { openId: 'ou_owner' });
  assert.equal(first.action, 'created');
  assert.equal(first.pairedNow, true, '首次消息应完成配对');
  assert.equal(first.task.ownerOpenId, 'ou_owner', '任务要记录归属账号');

  const second = handleFeishuText(store, '打开 VS Code', { openId: 'ou_stranger' });
  assert.equal(second.action, 'rejected');
  assert.equal(second.reason, 'not_owner');
  assert.equal(store.listActiveTasks().length, 1, '陌生账号不得创建任务');

  const again = handleFeishuText(store, '状态', { openId: 'ou_owner' });
  assert.equal(again.action, 'status');
  assert.equal(again.pairedNow, undefined, '后续消息不应再报告"刚配对"');
});

test('B17c：验证码不出现在任何可序列化输出里', () => {
  const store = createStore();
  const created = handleFeishuText(store, '登录教务系统', { openId: 'ou_owner' });
  store.transition(created.task.id, 'running');
  store.transition(created.task.id, 'waiting_for_user', { reason: '需要验证码' });

  const result = handleFeishuText(store, '123456', { openId: 'ou_owner' });
  assert.equal(result.action, 'verification_code');
  assert.equal(result.taskId, created.task.id);
  // 修复前：返回值里带明文 code，一旦被日志或回执 JSON 化就落盘了。
  assert.equal(JSON.stringify(result).includes('123456'), false, '序列化后不得出现验证码');
  assert.equal(result.code, '123456', '执行器仍需能直接读到验证码');
  assert.equal(Object.keys(result).includes('code'), false, 'code 不能是可枚举属性');
});

test('B17d：authorizeSender 接受字符串与对象两种形态，并拒绝空白', () => {
  const store = createStore();
  assert.equal(authorizeSender(store, 'ou_owner').ok, true);
  assert.equal(authorizeSender(store, { openId: 'ou_owner' }).ok, true);
  assert.equal(authorizeSender(store, '   ').code, 'sender_required');
  assert.equal(authorizeSender(store, null).code, 'sender_required');
  assert.equal(authorizeSender(store, 'ou_other').code, 'not_owner');
});

test('归属账号可以在本机重置后重新配对', () => {
  const store = createStore();
  assert.equal(authorizeSender(store, 'ou_first').ok, true);
  assert.equal(store.getOwner(), 'ou_first');

  store.resetOwner();
  assert.equal(store.getOwner(), null);

  const rebound = authorizeSender(store, 'ou_second');
  assert.equal(rebound.ok, true);
  assert.equal(rebound.pairedNow, true, '重置后首个账号应重新完成配对');
});

test('暂停中的任务收到验证码时提示先继续，而不是丢弃或新建任务', () => {
  const store = createStore();
  const created = handleFeishuText(store, '登录站点', { openId: 'ou_owner' });
  store.transition(created.task.id, 'running');
  store.transition(created.task.id, 'waiting_for_user', { reason: '需要验证码' });
  store.pause(created.task.id);

  const result = handleFeishuText(store, '123456', { openId: 'ou_owner' });
  assert.equal(result.action, 'verification_deferred');
  assert.match(result.message, /继续/);
  assert.equal(store.listActiveTasks().length, 1, '不得因验证码新建任务');
  assert.equal(JSON.stringify(result).includes('123456'), false);
});
