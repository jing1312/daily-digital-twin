import assert from 'node:assert/strict';
import test from 'node:test';
import { decideResourcePolicy } from '../src/core/resource-policy.mjs';
import { createReceipt } from '../src/core/receipt.mjs';

test('接电且资源充足时允许四个执行槽', () => {
  assert.deepEqual(decideResourcePolicy({
    onAcPower: true,
    cpuPercent: 40,
    availableMemoryGb: 12,
    diskFreeGb: 60
  }), { slotLimit: 4, acceptsNewActions: true, reason: null });
});

test('电池或资源不足时收缩执行槽并拒绝新动作', () => {
  assert.deepEqual(decideResourcePolicy({
    onAcPower: false,
    cpuPercent: 40,
    availableMemoryGb: 12,
    diskFreeGb: 60
  }), { slotLimit: 1, acceptsNewActions: true, reason: '电池模式' });

  assert.deepEqual(decideResourcePolicy({
    onAcPower: true,
    cpuPercent: 72,
    availableMemoryGb: 7,
    diskFreeGb: 15
  }), { slotLimit: 0, acceptsNewActions: false, reason: '资源不足' });
});

test('回执只记录脱敏证据而不保留验证码', () => {
  const receipt = createReceipt({
    taskId: 12,
    state: 'completed',
    summary: 'Biomni 已运行',
    evidence: { pageTitle: 'Biomni', screenshotPath: 'data/screenshots/task-12.png' },
    sensitiveValues: ['123456']
  });

  assert.equal(receipt.taskId, 12);
  assert.equal(JSON.stringify(receipt).includes('123456'), false);
  assert.equal(receipt.evidence.pageTitle, 'Biomni');
});
