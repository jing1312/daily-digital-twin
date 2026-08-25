import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeterministicExecutor, classifyTaskMode } from '../src/execution/deterministic-executor.mjs';
import { TaskStore, VERIFICATION_REASON } from '../src/core/task-store.mjs';
import { VerificationBroker } from '../src/gateway/verification-broker.mjs';

test('Biomni 固定流程按 open/fill/submit/wait/capture 执行且不调用 planner', async () => {
  const calls = [];
  const executor = createDeterministicExecutor({
    browserExecutor: {
      async open(args) { calls.push(['open', args]); },
      async fill(args) { calls.push(['fill', args]); },
      async submit(args) { calls.push(['submit', args]); },
      async wait(args) { calls.push(['wait', args]); },
      async capture(args) { calls.push(['capture', args]); return { evidenceRef: 'E-7' }; }
    },
    appExecutor: { async launch() { throw new Error('不应调用软件执行器'); } },
    catalog: { websites: [{ id: 'biomni', resultCondition: '任务完成' }] }
  });
  const result = await executor({ task: { id: 7, publicId: 'DT-20260730-0007', request: '打开 Biomni，在输入框中输入 分析数据 X 并运行' } });
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(calls.map(([name]) => name), ['open', 'fill', 'submit', 'wait', 'capture']);
  assert.equal(calls[1][1].text, '分析数据 X');
  assert.equal(calls[1][1].field, 'prompt');
  assert.equal(calls[2][1].action, 'run');
});

test('Omicos 固定流程只启动已登记软件并要求进程证据', async () => {
  const executor = createDeterministicExecutor({
    browserExecutor: {},
    appExecutor: { async launch(args) { return { ...args, evidenceRef: 'E-3', processId: 99 }; } },
    catalog: { websites: [] }
  });
  const result = await executor({ task: { id: 3, publicId: 'DT-20260730-0003', request: '打开 Omicos' } });
  assert.equal(result.outcome, 'completed');
  assert.match(result.summary, /Omicos/);
});

test('Edge 未连接或需要登录时进入 waiting_for_user，不伪装成失败或改用 Chrome', async () => {
  const waiting = Object.assign(new Error('Edge 扩展未连接'), { waitingForUser: true, code: 'edge_disconnected' });
  const executor = createDeterministicExecutor({
    browserExecutor: { async open() { throw waiting; } },
    appExecutor: {},
    catalog: { websites: [{ id: 'biomni', resultCondition: '任务完成' }] }
  });
  const result = await executor({ task: { id: 1, publicId: 'DT-20260730-0001', request: '打开 Biomni，输入 X 并运行' } });
  assert.equal(result.outcome, 'waiting_for_user');
  assert.match(result.reason, /Edge/);
});

test('只有已知固定动作判为 deterministic，其余交给 complex planner', () => {
  assert.equal(classifyTaskMode('打开 Omicos'), 'deterministic');
  assert.equal(classifyTaskMode('打开 Biomni，输入 X 并运行'), 'deterministic');
  assert.equal(classifyTaskMode('分析三组数据并写报告'), 'complex');
});

test('Biomni 检测到验证码后注册本机等待器，飞书代码填入页面并重新排队', async () => {
  const store = new TaskStore(':memory:');
  const created = store.createTask({ request: '打开 Biomni，输入 X 并运行' });
  store.setTaskKind(created.id, 'deterministic');
  store.transition(created.id, 'running');
  const broker = new VerificationBroker();
  const delivered = [];
  const browserExecutor = {
    async open() {},
    async detectUserGate() { return { kind: 'verification' }; },
    async provideVerification({ code }) { delivered.push(code); return { accepted: true }; },
    async fill() { throw new Error('验证码完成前不应填写任务正文'); },
    async submit() {}, async wait() {}, async capture() { return { evidenceRef: 'E-1' }; }
  };
  const executor = createDeterministicExecutor({
    browserExecutor,
    appExecutor: {},
    catalog: { websites: [{ id: 'biomni', resultCondition: '任务完成' }] },
    verificationBroker: broker
  });

  const result = await executor({ task: store.getTask(created.id), store });
  assert.deepEqual(result, { outcome: 'waiting_for_user', reason: VERIFICATION_REASON });
  store.transition(created.id, 'waiting_for_user', { reason: result.reason });
  assert.equal(broker.has(created.id), true);

  await store.deliverVerificationCode(created.id, '739105', (code) => broker.deliver(created.id, code));
  assert.deepEqual(delivered, ['739105']);
  assert.equal(store.getTask(created.id).state, 'queued');
  assert.equal(broker.has(created.id), false);
  const dump = ['tasks', 'task_events', 'verification_waits']
    .flatMap((table) => store.db.prepare(`SELECT * FROM ${table}`).all())
    .map(JSON.stringify).join('\n');
  assert.equal(dump.includes('739105'), false);
  store.close();
});

test('Biomni 需要手动登录时进入等待，但不创建验证码等待器', async () => {
  const broker = new VerificationBroker();
  const executor = createDeterministicExecutor({
    browserExecutor: {
      async open() {},
      async detectUserGate() { return { kind: 'login' }; }
    },
    appExecutor: {},
    catalog: { websites: [{ id: 'biomni', resultCondition: '任务完成' }] },
    verificationBroker: broker
  });
  const result = await executor({
    task: { id: 9, publicId: 'DT-20260730-0009', request: '打开 Biomni，输入 X 并运行' },
    store: { saveResumeState() {} }
  });
  assert.equal(result.outcome, 'waiting_for_user');
  assert.match(result.reason, /登录/);
  assert.equal(broker.has(9), false);
});

test('提交后出现验证码时保存检查点，验证码完成后的续跑不得重复提交', async () => {
  const store = new TaskStore(':memory:');
  const created = store.createTask({ request: '打开 Biomni，输入 X 并运行' });
  store.setTaskKind(created.id, 'deterministic');
  store.transition(created.id, 'running');
  const broker = new VerificationBroker();
  const calls = [];
  let needsVerification = true;
  const browserExecutor = {
    async open() { calls.push('open'); },
    async detectUserGate() { calls.push('gate'); return null; },
    async fill() { calls.push('fill'); },
    async submit() { calls.push('submit'); },
    async provideVerification() { calls.push('verification'); needsVerification = false; return { accepted: true }; },
    async wait() {
      calls.push('wait');
      return needsVerification ? { status: 'verification_required', gate: { kind: 'verification' } } : { status: 'ready' };
    },
    async capture() { calls.push('capture'); return { evidenceRef: 'E-2' }; }
  };
  const executor = createDeterministicExecutor({
    browserExecutor,
    appExecutor: {},
    catalog: { websites: [{ id: 'biomni', resultCondition: '任务完成' }] },
    verificationBroker: broker
  });

  const first = await executor({ task: store.getTask(created.id), store });
  assert.deepEqual(first, { outcome: 'waiting_for_user', reason: VERIFICATION_REASON });
  assert.equal(store.getResumeState(created.id).stage, 'submitted');
  store.transition(created.id, 'waiting_for_user', { reason: first.reason });
  await store.deliverVerificationCode(created.id, '739105', (code) => broker.deliver(created.id, code));
  store.transition(created.id, 'running');

  const second = await executor({ task: store.getTask(created.id), store });

  assert.equal(second.outcome, 'completed');
  assert.equal(calls.filter((item) => item === 'submit').length, 1);
  assert.equal(calls.filter((item) => item === 'fill').length, 1);
  assert.deepEqual(calls.slice(-2), ['wait', 'capture']);
  assert.equal(store.getResumeState(created.id), null);
  store.close();
});
