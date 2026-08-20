import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// 中文注释：这些测试需要 node:sqlite（Node 24+）。在低版本上跳过而不是失败。
let TaskStore;
try {
  TaskStore = (await import('../src/core/task-store.mjs')).TaskStore;
} catch {
  TaskStore = null;
}

const canRun = Boolean(TaskStore);

function createStore() {
  return new TaskStore(':memory:');
}

describe('F1 — 父任务自动收尾', { skip: !canRun }, () => {
  test('所有子任务 completed 时父任务自动 completed', () => {
    const store = createStore();
    const parent = store.createTask({ request: '父任务', priority: 5 });
    const sub1 = store.createSubTask(parent.id, { request: '子1', taskType: 'ai_call', priority: 2 });
    const sub2 = store.createSubTask(parent.id, { request: '子2', taskType: 'ai_call', priority: 1 });

    store.transition(sub1.id, 'running');
    store.transition(sub1.id, 'completed');
    store.transition(sub2.id, 'running');
    store.transition(sub2.id, 'completed');

    const result = store.finalizeParentTask(parent.id);
    assert.equal(result.state, 'completed');
    assert.ok(result.summary.includes('全部完成'));
    store.close();
  });

  test('任一子任务 failed 时父任务自动 partial', () => {
    const store = createStore();
    const parent = store.createTask({ request: '父任务', priority: 5 });
    const sub1 = store.createSubTask(parent.id, { request: '子1', priority: 2 });
    const sub2 = store.createSubTask(parent.id, { request: '子2', priority: 1 });

    store.transition(sub1.id, 'running');
    store.transition(sub1.id, 'completed');
    store.transition(sub2.id, 'running');
    store.transition(sub2.id, 'failed');

    const result = store.finalizeParentTask(parent.id);
    assert.equal(result.state, 'partial');
    assert.ok(result.summary.includes('部分失败'));
    store.close();
  });

  test('子任务未全部终态时不收尾', () => {
    const store = createStore();
    const parent = store.createTask({ request: '父任务', priority: 5 });
    const sub1 = store.createSubTask(parent.id, { request: '子1', priority: 1 });
    const sub2 = store.createSubTask(parent.id, { request: '子2', priority: 1 });

    store.transition(sub1.id, 'running');
    store.transition(sub1.id, 'completed');

    const result = store.finalizeParentTask(parent.id);
    assert.equal(result, null);
    assert.equal(store.getTask(parent.id).state, 'queued');
    store.close();
  });

  test('父任务已在终态时跳过', () => {
    const store = createStore();
    const parent = store.createTask({ request: '父任务', priority: 5 });
    store.transition(parent.id, 'cancelled');

    const result = store.finalizeParentTask(parent.id);
    assert.equal(result.state, 'cancelled');
    store.close();
  });

  test('没有子任务的父任务直接完成', () => {
    const store = createStore();
    const parent = store.createTask({ request: '独立任务', priority: 5 });
    const result = store.finalizeParentTask(parent.id);
    assert.equal(result.state, 'completed');
    store.close();
  });
});

describe('F2 — cancel 级联取消子任务', { skip: !canRun }, () => {
  test('取消父任务时所有未结束子任务也被取消', () => {
    const store = createStore();
    const parent = store.createTask({ request: '父任务', priority: 5 });
    const sub1 = store.createSubTask(parent.id, { request: '子1', priority: 1 });
    const sub2 = store.createSubTask(parent.id, { request: '子2', priority: 1 });
    const sub3 = store.createSubTask(parent.id, { request: '子3', priority: 1 });

    store.transition(sub1.id, 'running');
    store.transition(sub1.id, 'completed');

    const cancelled = store.cancelSubTasks(parent.id);
    assert.equal(cancelled.length, 2);
    assert.ok(cancelled.includes(sub2.id));
    assert.ok(cancelled.includes(sub3.id));

    assert.equal(store.getTask(sub2.id).state, 'cancelled');
    assert.equal(store.getTask(sub3.id).state, 'cancelled');
    assert.equal(store.getTask(sub1.id).state, 'completed');
    store.close();
  });

  test('没有子任务时 cancelSubTasks 返回空数组', () => {
    const store = createStore();
    const parent = store.createTask({ request: '独立任务', priority: 5 });
    const cancelled = store.cancelSubTasks(parent.id);
    assert.equal(cancelled.length, 0);
    store.close();
  });
});

describe('F4 — listCompletedTasks 和 getTaskDetail', { skip: !canRun }, () => {
  test('listCompletedTasks 返回已结束任务，按更新时间倒序', () => {
    const store = createStore();
    const t1 = store.createTask({ request: '任务1' });
    const t2 = store.createTask({ request: '任务2' });

    store.transition(t1.id, 'running');
    store.transition(t1.id, 'completed');
    store.transition(t2.id, 'running');
    store.transition(t2.id, 'failed');

    const history = store.listCompletedTasks(10);
    assert.equal(history.length, 2);
    assert.equal(history[0].id, t2.id);
    assert.equal(history[1].id, t1.id);
    store.close();
  });

  test('listCompletedTasks 支持 limit', () => {
    const store = createStore();
    for (let i = 0; i < 5; i++) {
      const t = store.createTask({ request: `任务${i}` });
      store.transition(t.id, 'running');
      store.transition(t.id, 'completed');
    }
    const history = store.listCompletedTasks(3);
    assert.equal(history.length, 3);
    store.close();
  });

  test('getTaskDetail 返回任务详情含事件和证据', () => {
    const store = createStore();
    const parent = store.createTask({ request: '父任务', priority: 5 });
    store.createSubTask(parent.id, { request: '子任务', taskType: 'ai_call', priority: 1 });

    const detail = store.getTaskDetail(parent.id);
    assert.ok(detail.task);
    assert.equal(detail.task.id, parent.id);
    assert.ok(Array.isArray(detail.events));
    assert.ok(Array.isArray(detail.evidence));
    assert.ok(detail.tokenSummary);
    assert.ok(Array.isArray(detail.subTasks));
    assert.equal(detail.subTasks.length, 1);
    store.close();
  });

  test('getTaskDetail 不存在的任务返回 null', () => {
    const store = createStore();
    assert.equal(store.getTaskDetail(999), null);
    store.close();
  });
});

describe('F5 — totalTokenUsage 全局汇总', { skip: !canRun }, () => {
  test('空库返回零值', () => {
    const store = createStore();
    const usage = store.totalTokenUsage();
    assert.equal(usage.calls, 0);
    assert.equal(usage.inputTokens, 0);
    assert.equal(usage.outputTokens, 0);
    assert.equal(usage.taskCount, 0);
    store.close();
  });

  test('有记录时正确汇总', () => {
    const store = createStore();
    const t1 = store.createTask({ request: '任务1' });
    store.recordTokenUsage({ taskId: t1.id, workerId: 'ai', model: 'gpt-4o', inputTokens: 100, outputTokens: 50, cachedTokens: 20, cacheHit: true, latencyMs: 500, estimatedCost: 0.01 });
    store.recordTokenUsage({ taskId: t1.id, workerId: 'ai', model: 'gpt-4o', inputTokens: 200, outputTokens: 80, cachedTokens: 0, cacheHit: false, latencyMs: 800, estimatedCost: 0.02 });

    const usage = store.totalTokenUsage();
    assert.equal(usage.calls, 2);
    assert.equal(usage.inputTokens, 300);
    assert.equal(usage.outputTokens, 130);
    assert.equal(usage.cachedTokens, 20);
    assert.equal(usage.cacheHits, 1);
    assert.equal(usage.taskCount, 1);
    store.close();
  });
});
