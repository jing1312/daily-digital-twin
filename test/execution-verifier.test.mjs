import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskStore } from '../src/core/task-store.mjs';
import {
  validateEvidence,
  recordExecutionEvidence,
  verifyExecution,
  finalizeTask,
  EvidenceError
} from '../src/core/execution-verifier.mjs';

function runningTask(store, request = '打开 VS Code') {
  const task = store.createTask({ request });
  store.transition(task.id, 'running');
  return task;
}

test('没有任何执行证据时不允许标记完成，只能落 partial', () => {
  // 中文注释：这条测试对应一次真实事故 —— 模型声称"VS Code 已直接打开、进程已确认在运行"，
  // 中文注释：交叉核查后发现该软件根本没有安装。没有证据就不许写 completed。
  const store = new TaskStore(':memory:');
  const task = runningTask(store);

  const result = finalizeTask(store, task.id, { summary: 'VS Code 已直接打开，进程已确认在运行' });

  assert.equal(result.state, 'partial', '无证据时不得写 completed');
  assert.equal(result.verified, false);
  assert.equal(store.getTask(task.id).state, 'partial');
  assert.match(store.getTask(task.id).failureReason, /证据/);
  store.close();
});

test('有真实进程证据时才允许标记完成', () => {
  const store = new TaskStore(':memory:');
  const task = runningTask(store);

  recordExecutionEvidence(store, task.id, {
    kind: 'process',
    processId: 4321,
    processName: 'Code',
    target: 'Visual Studio Code'
  });

  const result = finalizeTask(store, task.id, { summary: 'VS Code 已启动' });
  assert.equal(result.state, 'completed');
  assert.equal(result.verified, true);
  assert.equal(result.check.evidenceCount, 1);
  store.close();
});

test('process 证据必须带正整数 PID 和进程名', () => {
  assert.throws(() => validateEvidence({ kind: 'process', processName: 'Code' }), EvidenceError);
  assert.throws(() => validateEvidence({ kind: 'process', processId: 0, processName: 'Code' }), /正整数 processId/);
  assert.throws(() => validateEvidence({ kind: 'process', processId: 1.5, processName: 'Code' }), /正整数 processId/);
  assert.throws(() => validateEvidence({ kind: 'process', processId: 12, processName: '  ' }), /processName/);

  const ok = validateEvidence({ kind: 'process', processId: '12', processName: ' Code ' });
  assert.equal(ok.processId, 12);
  assert.equal(ok.processName, 'Code');
});

test('窗口、页面与文件证据必须带 target', () => {
  for (const kind of ['window', 'page', 'file']) {
    assert.throws(() => validateEvidence({ kind }), new RegExp(`${kind} 证据需要 target`));
    assert.equal(validateEvidence({ kind, target: 'X' }).kind, kind);
  }
});

test('未知证据类型被拒绝', () => {
  assert.throws(() => validateEvidence({ kind: 'vibes', target: '看起来成功了' }), /证据类型必须是/);
  assert.throws(() => validateEvidence(null), /证据必须是对象/);
  assert.throws(() => validateEvidence('process'), /证据必须是对象/);
});

test('可以要求特定类型的证据，类型不符视为未验证', () => {
  const store = new TaskStore(':memory:');
  const task = runningTask(store, '生成报告文件');
  recordExecutionEvidence(store, task.id, { kind: 'window', target: 'Visual Studio Code' });

  assert.equal(verifyExecution(store, task.id).verified, true);
  assert.equal(verifyExecution(store, task.id, { requiredKinds: ['file'] }).verified, false);

  const result = finalizeTask(store, task.id, { summary: '文件已生成', requiredKinds: ['file'] });
  assert.equal(result.state, 'partial', '要求文件证据但只有窗口证据时不得判成功');
  store.close();
});

test('显式关闭证据要求时允许直接完成（供不涉及本机动作的任务使用）', () => {
  const store = new TaskStore(':memory:');
  const task = runningTask(store, '仅整理文本');
  const result = finalizeTask(store, task.id, { summary: '已整理', requireEvidence: false });
  assert.equal(result.state, 'completed');
  assert.equal(result.verified, false, '仍应如实报告未获得证据');
  store.close();
});

test('证据落库后可完整读回，并留下事件轨迹', () => {
  const store = new TaskStore(':memory:');
  const task = runningTask(store);
  recordExecutionEvidence(store, task.id, {
    kind: 'process',
    processId: 999,
    processName: 'Code',
    detail: '由 Start-DailyTwinApp.ps1 启动'
  });

  const stored = store.listExecutionEvidence(task.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].processId, 999);
  assert.equal(stored[0].detail, '由 Start-DailyTwinApp.ps1 启动');
  assert.ok(store.listEvents(task.id).some((event) => /执行证据/.test(event.detail ?? '')));
  store.close();
});
