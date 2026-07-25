import assert from 'node:assert/strict';
import test from 'node:test';
import { getRetryPlan } from '../src/core/retry-policy.mjs';

test('瞬时失败使用三次有限退避', () => {
  assert.deepEqual(getRetryPlan(0), { nextAttempt: 1, delaySeconds: 30 });
  assert.deepEqual(getRetryPlan(1), { nextAttempt: 2, delaySeconds: 120 });
  assert.deepEqual(getRetryPlan(2), { nextAttempt: 3, delaySeconds: 300 });
  assert.equal(getRetryPlan(3), null);
});
