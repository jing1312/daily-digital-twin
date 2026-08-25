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
  // 中文注释：内存数据库，测试完自动销毁。
  return new TaskStore(':memory:');
}

describe('task-store v3 — 父子任务关系', { skip: !canRun }, () => {
  test('createTask 包含新字段 parentTaskId/taskType/priority', () => {
    const store = createStore();
    const task = store.createTask({ request: '父任务', taskType: 'ai_call', priority: 3 });
    assert.equal(task.parentTaskId, null);
    assert.equal(task.taskType, 'ai_call');
    assert.equal(task.priority, 3);
    store.close();
  });

  test('createSubTask 创建子任务并关联父任务', () => {
    const store = createStore();
    const parent = store.createTask({ request: '写一篇文章', taskType: 'unknown', priority: 5 });
    const sub1 = store.createSubTask(parent.id, { request: '调研素材', taskType: 'ai_call', priority: 3 });
    const sub2 = store.createSubTask(parent.id, { request: '写初稿', taskType: 'ai_call', priority: 2 });

    assert.equal(sub1.parentTaskId, parent.id);
    assert.equal(sub2.parentTaskId, parent.id);
    assert.equal(sub1.taskType, 'ai_call');
    store.close();
  });

  test('listSubTasks 返回指定父任务的子任务，按 priority 降序', () => {
    const store = createStore();
    const parent = store.createTask({ request: '父任务', priority: 5 });
    store.createSubTask(parent.id, { request: '低优先级', priority: 1 });
    store.createSubTask(parent.id, { request: '高优先级', priority: 4 });
    store.createSubTask(parent.id, { request: '中优先级', priority: 2 });

    const subs = store.listSubTasks(parent.id);
    assert.equal(subs.length, 3);
    assert.equal(subs[0].request, '高优先级');
    assert.equal(subs[1].request, '中优先级');
    assert.equal(subs[2].request, '低优先级');
    store.close();
  });

  test('listTopLevelTasks 只返回没有父任务的顶层任务', () => {
    const store = createStore();
    const parent1 = store.createTask({ request: '父任务1', priority: 3 });
    const parent2 = store.createTask({ request: '父任务2', priority: 5 });
    store.createSubTask(parent1.id, { request: '子任务', priority: 1 });

    const topLevel = store.listTopLevelTasks();
    assert.equal(topLevel.length, 2);
    // 按 priority 降序
    assert.equal(topLevel[0].id, parent2.id);
    assert.equal(topLevel[1].id, parent1.id);
    store.close();
  });

  test('getTaskTree 返回完整任务树', () => {
    const store = createStore();
    const parent = store.createTask({ request: '父任务', priority: 5 });
    store.createSubTask(parent.id, { request: '子任务A', taskType: 'ai_call', priority: 2 });
    store.createSubTask(parent.id, { request: '子任务B', taskType: 'browser', priority: 1 });

    const tree = store.getTaskTree();
    assert.equal(tree.length, 1);
    assert.equal(tree[0].id, parent.id);
    assert.equal(tree[0].subTasks.length, 2);
    assert.equal(tree[0].subTasks[0].request, '子任务A');
    store.close();
  });

  test('allSubTasksCompleted 检查子任务是否全部终态', () => {
    const store = createStore();
    const parent = store.createTask({ request: '父任务', priority: 5 });
    const sub1 = store.createSubTask(parent.id, { request: '子任务1', priority: 1 });
    const sub2 = store.createSubTask(parent.id, { request: '子任务2', priority: 1 });

    // 没有子任务完成
    assert.equal(store.allSubTasksCompleted(parent.id), false);

    // 完成一个
    store.transition(sub1.id, 'running');
    store.transition(sub1.id, 'completed');
    assert.equal(store.allSubTasksCompleted(parent.id), false);

    // 全部完成
    store.transition(sub2.id, 'running');
    store.transition(sub2.id, 'completed');
    assert.equal(store.allSubTasksCompleted(parent.id), true);
    store.close();
  });

  test('非法 taskType 抛异常', () => {
    const store = createStore();
    assert.throws(() => store.createTask({ request: '任务', taskType: 'invalid' }));
    store.close();
  });

  test('createSubTask 父任务不存在时抛异常', () => {
    const store = createStore();
    assert.throws(() => store.createSubTask(999, { request: '子任务' }));
    store.close();
  });

  test('子任务继承父任务的 owner', () => {
    const store = createStore();
    const parent = store.createTask({ request: '父任务', ownerOpenId: 'user123' });
    const sub = store.createSubTask(parent.id, { request: '子任务' });
    assert.equal(sub.ownerOpenId, 'user123');
    store.close();
  });
});

describe('task-store — schema 迁移（v7：并入 Multica 控制面 schema）', { skip: !canRun }, () => {
  test('新库迁移到 v7', () => {
    const store = createStore();
    assert.equal(store.schemaVersion, 7);
    assert.ok(store.migration.migrated || store.migration.fromVersion === 7);
    store.close();
  });

  test('重复打开不重复迁移', () => {
    const store = createStore();
    const report1 = store.migration;
    store.close();

    // 中文注释：内存库无法重开，这里只验证迁移报告结构正确。
    assert.ok('fromVersion' in report1);
    assert.ok('toVersion' in report1);
  });
});
