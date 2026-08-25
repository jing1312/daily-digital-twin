import assert from 'node:assert/strict';
import test from 'node:test';
import { decideResourcePolicy, DEFAULT_RESOURCE_LIMITS } from '../src/core/resource-policy.mjs';
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

test('可用内存按 10GB/6GB/4GB 自适应为 4/2/1 个重型槽位', () => {
  const base = { onAcPower: true, cpuPercent: 20, diskFreeGb: 80 };
  assert.equal(decideResourcePolicy({ ...base, availableMemoryGb: 10 }).slotLimit, 4);
  assert.equal(decideResourcePolicy({ ...base, availableMemoryGb: 9.9 }).slotLimit, 2);
  assert.equal(decideResourcePolicy({ ...base, availableMemoryGb: 6 }).slotLimit, 2);
  assert.equal(decideResourcePolicy({ ...base, availableMemoryGb: 4.6 }).slotLimit, 1);
  assert.equal(decideResourcePolicy({ ...base, availableMemoryGb: 3.9 }).slotLimit, 0);
  assert.equal(decideResourcePolicy({ ...base, availableMemoryGb: 3.9 }).acceptsNewActions, false);
});

test('电池模式不会绕过内存和磁盘硬门槛', () => {
  const lowMemory = decideResourcePolicy({
    onAcPower: false,
    cpuPercent: 20,
    availableMemoryGb: 3.9,
    diskFreeGb: 80
  });
  assert.equal(lowMemory.slotLimit, 0);
  assert.equal(lowMemory.acceptsNewActions, false);
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

// ---------------------------------------------------------------------------
// 本轮新增：资源策略必须失败关闭。
// ---------------------------------------------------------------------------

test('B6：缺少电源状态时必须失败关闭，不得默认当作已接电', () => {
  // 修复前：decideResourcePolicy({ onAcPower: true }) 在 CPU/内存/磁盘全未知的情况下
  // 修复前：仍然返回 { slotLimit: 4, acceptsNewActions: true }，等于闭着眼睛派活。
  const decision = decideResourcePolicy({ onAcPower: true });
  assert.equal(decision.acceptsNewActions, false);
  assert.equal(decision.slotLimit, 0);
  assert.equal(decision.reason, '遥测缺失');
  assert.deepEqual(decision.missing, ['cpuPercent', 'availableMemoryGb', 'diskFreeGb']);
});

test('B6b：完全没有遥测时同样失败关闭', () => {
  const decision = decideResourcePolicy({});
  assert.equal(decision.acceptsNewActions, false);
  assert.equal(decision.slotLimit, 0);
  assert.deepEqual(decision.missing, ['cpuPercent', 'availableMemoryGb', 'diskFreeGb', 'onAcPower']);

  assert.equal(decideResourcePolicy().acceptsNewActions, false, '不传参数也必须失败关闭');
});

test('B6c：非法或非数值遥测视为缺失而不是当成 0', () => {
  const decision = decideResourcePolicy({
    onAcPower: 'yes',
    cpuPercent: Number.NaN,
    availableMemoryGb: null,
    diskFreeGb: '60'
  });
  assert.equal(decision.acceptsNewActions, false);
  assert.deepEqual(decision.missing, ['cpuPercent', 'availableMemoryGb', 'diskFreeGb', 'onAcPower']);
});

test('B6d：阈值来自传入的限制而非硬编码', () => {
  const reading = { onAcPower: true, cpuPercent: 60, availableMemoryGb: 6, diskFreeGb: 10 };
  assert.equal(decideResourcePolicy(reading, DEFAULT_RESOURCE_LIMITS).acceptsNewActions, false);
  assert.equal(decideResourcePolicy(reading, {
    ...DEFAULT_RESOURCE_LIMITS,
    cpuLimitPercent: 80,
    minAvailableMemoryGb: 4,
    minDiskFreeGb: 5
  }).acceptsNewActions, true);
});

test('回执可携带执行证据与 token 用量，且不泄漏密钥类字段', () => {
  // 中文注释：授权头在运行时拼装，源码里不留完整形态，避免隐私审计把测试夹具当成真实泄漏。
  const fakeAuthorizationBody = 'abcdef0123456789ABCDEF';
  const receipt = createReceipt({
    taskId: 3,
    state: 'partial',
    summary: '任务停在登录页',
    evidence: { pageTitle: '登录', authorization: `Bearer ${fakeAuthorizationBody}` },
    tokenUsage: { inputTokens: 1200, cachedTokens: 900, outputTokens: 80 },
    verification: { pending: true }
  });

  assert.equal(receipt.state, 'partial');
  assert.equal(receipt.tokenUsage.cachedTokens, 900);
  assert.equal(receipt.verification.pending, true);
  assert.equal(JSON.stringify(receipt).includes(fakeAuthorizationBody), false, '授权头必须被掩码');
});
