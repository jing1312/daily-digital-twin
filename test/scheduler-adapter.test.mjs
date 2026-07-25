import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskStore } from '../src/core/task-store.mjs';
import { handleFeishuText } from '../src/core/feishu-adapter.mjs';
import { canSchedule } from '../src/core/scheduler.mjs';

test('飞书文本适配器创建任务并返回任务号', () => {
  const store = new TaskStore(':memory:');
  const result = handleFeishuText(store, '打开 Biomni');
  assert.equal(result.action, 'created');
  assert.equal(result.task.state, 'queued');
});

test('前台动作互斥且后台网页可以继续使用剩余槽位', () => {
  const resource = { onAcPower: true, cpuPercent: 30, availableMemoryGb: 16, diskFreeGb: 80 };
  assert.equal(canSchedule({ activeCount: 1, foregroundBusy: true, requiresForeground: true, resource }).allowed, false);
  assert.equal(canSchedule({ activeCount: 1, foregroundBusy: true, requiresForeground: false, resource }).allowed, true);
});
