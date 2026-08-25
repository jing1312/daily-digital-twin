import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/core/task-store.mjs';

test('每条任务获得可读的 DT 日期序号，且可绑定 Multica issue', () => {
  const store = new TaskStore(':memory:');
  const first = store.createTask({ request: '任务一' });
  const second = store.createTask({ request: '任务二' });

  assert.match(first.publicId, /^DT-\d{8}-0001$/);
  assert.equal(second.publicId, first.publicId.replace(/0001$/, '0002'));
  assert.equal(store.getTaskByPublicId(first.publicId).id, first.id);

  const bound = store.bindMulticaIssue(first.id, 'MUL-42');
  assert.equal(bound.multicaIssueId, 'MUL-42');
  assert.equal(store.getTaskByMulticaIssueId('MUL-42').publicId, first.publicId);
  store.close();
});
test('同一任务只能创建一份终态回执，重试发送不得改写内容', () => {
  const store = new TaskStore(':memory:');
  const task = store.createTask({ request: '打开 Biomni' });
  store.transition(task.id, 'running');
  store.transition(task.id, 'completed', { summary: '真实完成' });

  const first = store.createTerminalReceipt(task.id, {
    summary: '真实完成',
    evidenceRefs: ['E-1']
  });
  const duplicate = store.createTerminalReceipt(task.id, {
    summary: '不应覆盖',
    evidenceRefs: ['E-2']
  });

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.receipt.summary, '真实完成');
  assert.deepEqual(duplicate.receipt.evidenceRefs, ['E-1']);

  const claimed = store.claimTerminalReceiptForSending(task.id);
  assert.equal(claimed.claimed, true);
  assert.equal(store.claimTerminalReceiptForSending(task.id).claimed, false);
  store.close();
});

test('验证码永不进入数据库文本列', () => {
  const store = new TaskStore(':memory:');
  const task = store.createTask({ request: '登录 Biomni' });
  store.transition(task.id, 'running');
  store.transition(task.id, 'waiting_for_user', { reason: '需要验证码' });

  const code = '731905';
  store.deliverVerificationCode(task.id, code, () => ({ accepted: true }));

  const tables = ['tasks', 'task_events', 'verification_waits', 'terminal_receipts', 'settings'];
  const serialized = tables.flatMap((table) => store.db.prepare(`SELECT * FROM ${table}`).all()).map(JSON.stringify).join('\n');
  assert.equal(serialized.includes(code), false);
  store.close();
});
