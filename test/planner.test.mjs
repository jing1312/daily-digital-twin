import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planTasks, validatePlan, passthroughPlan, groupByParent, PlannerError } from '../src/core/planner.mjs';

describe('planner — 透传模式', () => {
  test('没有配置 API 时透传，不报错', async () => {
    const tasks = ['写一篇文章', '查一下天气'];
    const plan = await planTasks(tasks, {});
    assert.equal(plan.length, 2);
    assert.equal(plan[0].parentIndex, 0);
    assert.equal(plan[0].request, '写一篇文章');
    assert.equal(plan[0].taskType, 'unknown');
  });

  test('apiEndpoint 为 null 时透传', async () => {
    const tasks = ['任务A'];
    const plan = await planTasks(tasks, { apiEndpoint: null, apiKey: 'test' });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].taskType, 'unknown');
  });

  test('apiKey 为 null 时透传', async () => {
    const tasks = ['任务A'];
    const plan = await planTasks(tasks, { apiEndpoint: 'https://api.example.com', apiKey: null });
    assert.equal(plan.length, 1);
  });
});

describe('planner — validatePlan', () => {
  test('合法计划通过校验', () => {
    const plan = [
      { parentIndex: 0, request: '子任务1', taskType: 'ai_call', priority: 3 },
      { parentIndex: 0, request: '子任务2', taskType: 'browser', priority: 2 }
    ];
    const result = validatePlan(plan, 1);
    assert.equal(result.length, 2);
  });

  test('parentIndex 越界时抛异常', () => {
    const plan = [{ parentIndex: 5, request: '子任务', taskType: 'ai_call', priority: 1 }];
    assert.throws(() => validatePlan(plan, 2), PlannerError);
  });

  test('空 request 抛异常', () => {
    const plan = [{ parentIndex: 0, request: '', taskType: 'ai_call', priority: 1 }];
    assert.throws(() => validatePlan(plan, 1), PlannerError);
  });

  test('非数组抛异常', () => {
    assert.throws(() => validatePlan({}, 1), PlannerError);
  });

  test('空数组抛异常', () => {
    assert.throws(() => validatePlan([], 1), PlannerError);
  });

  test('未知 taskType 归为 unknown', () => {
    const plan = [{ parentIndex: 0, request: '任务', taskType: 'invalid_type', priority: 1 }];
    const result = validatePlan(plan, 1);
    assert.equal(result[0].taskType, 'unknown');
  });

  test('priority 超范围被截断到 1-5', () => {
    const plan = [
      { parentIndex: 0, request: '任务', taskType: 'ai_call', priority: 100 },
      { parentIndex: 0, request: '任务2', taskType: 'ai_call', priority: -5 }
    ];
    const result = validatePlan(plan, 1);
    assert.equal(result[0].priority, 5);
    assert.equal(result[1].priority, 1);
  });
});

describe('planner — passthroughPlan', () => {
  test('每个任务变成一条 unknown 类型子任务', () => {
    const tasks = ['任务A', '任务B', '任务C'];
    const plan = passthroughPlan(tasks);
    assert.equal(plan.length, 3);
    assert.equal(plan[0].parentIndex, 0);
    assert.equal(plan[1].parentIndex, 1);
    assert.equal(plan[2].parentIndex, 2);
    plan.forEach((item) => assert.equal(item.taskType, 'unknown'));
  });
});

describe('planner — groupByParent', () => {
  test('按 parentIndex 分组', () => {
    const plan = [
      { parentIndex: 0, request: 'A1', taskType: 'ai_call', priority: 3 },
      { parentIndex: 1, request: 'B1', taskType: 'browser', priority: 2 },
      { parentIndex: 0, request: 'A2', taskType: 'desktop', priority: 1 }
    ];
    const groups = groupByParent(plan);
    assert.equal(groups.size, 2);
    assert.equal(groups.get(0).length, 2);
    assert.equal(groups.get(1).length, 1);
  });
});

describe('planner — 空任务列表', () => {
  test('空数组抛异常', async () => {
    await assert.rejects(() => planTasks([], {}), PlannerError);
  });

  test('非数组抛异常', async () => {
    await assert.rejects(() => planTasks(null, {}), PlannerError);
  });
});
