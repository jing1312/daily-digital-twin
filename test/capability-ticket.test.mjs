import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/core/task-store.mjs';
import {
  CapabilityError,
  issueCapabilityTicket,
  verifyCapabilityTicket
} from '../src/core/capability-ticket.mjs';

const SECRET = Buffer.from('test-only-capability-secret-with-32-bytes');
const NOW = new Date('2026-07-30T02:00:00.000Z');

function payload(overrides = {}) {
  return {
    taskId: 'DT-20260730-0001',
    multicaIssueId: 'MUL-42',
    workerId: 'worker-browser-1',
    websites: ['biomni'],
    apps: [],
    directories: ['D:\\TwinTasks\\DT-20260730-0001'],
    actions: ['browser.open', 'browser.fill', 'browser.submit', 'browser.capture'],
    expiresAt: '2026-07-30T02:05:00.000Z',
    nonce: 'nonce-000000000001',
    ...overrides
  };
}

test('能力票必须覆盖任务、Multica issue、worker、资源、动作、过期时间和 nonce', () => {
  const ticket = issueCapabilityTicket({ secret: SECRET, payload: payload() });
  const store = new TaskStore(':memory:');

  const verified = verifyCapabilityTicket(ticket, {
    secret: SECRET,
    store,
    now: NOW,
    request: {
      taskId: 'DT-20260730-0001',
      multicaIssueId: 'MUL-42',
      workerId: 'worker-browser-1',
      action: 'browser.fill',
      website: 'biomni'
    }
  });

  assert.equal(verified.taskId, 'DT-20260730-0001');
  assert.equal(verified.workerId, 'worker-browser-1');
  assert.equal(verified.nonce, 'nonce-000000000001');
  store.close();
});
test('篡改、过期、错误 worker 和未授权动作全部失败', () => {
  const original = issueCapabilityTicket({ secret: SECRET, payload: payload() });
  const [body, signature] = original.split('.');
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  const tampered = `${Buffer.from(JSON.stringify({ ...decoded, actions: ['app.launch'] })).toString('base64url')}.${signature}`;

  assert.throws(
    () => verifyCapabilityTicket(tampered, { secret: SECRET, now: NOW, request: { action: 'app.launch' } }),
    (error) => error instanceof CapabilityError && error.code === 'invalid_signature'
  );

  assert.throws(
    () => verifyCapabilityTicket(original, { secret: SECRET, now: new Date('2026-07-30T02:06:00Z'), request: { action: 'browser.open' } }),
    (error) => error.code === 'expired'
  );

  assert.throws(
    () => verifyCapabilityTicket(original, { secret: SECRET, now: NOW, request: { workerId: 'worker-other', action: 'browser.open' } }),
    (error) => error.code === 'worker_mismatch'
  );

  assert.throws(
    () => verifyCapabilityTicket(original, { secret: SECRET, now: NOW, request: { action: 'file.delete' } }),
    (error) => error.code === 'action_denied'
  );
});

test('显式目录权限使用字面路径边界，不能用前缀绕过', () => {
  const ticket = issueCapabilityTicket({ secret: SECRET, payload: payload() });

  assert.doesNotThrow(() => verifyCapabilityTicket(ticket, {
    secret: SECRET,
    now: NOW,
    request: { action: 'browser.capture', directory: 'D:\\TwinTasks\\DT-20260730-0001\\evidence' }
  }));

  assert.throws(
    () => verifyCapabilityTicket(ticket, {
      secret: SECRET,
      now: NOW,
      request: { action: 'browser.capture', directory: 'D:\\TwinTasks\\DT-20260730-00010\\escape' }
    }),
    (error) => error.code === 'directory_denied'
  );
});

test('POSIX 目录权限不能被 Windows 宿主的大小写语义放宽', () => {
  const ticket = issueCapabilityTicket({
    secret: SECRET,
    payload: payload({ directories: ['/srv/TwinTasks/DT-20260730-0001'] })
  });

  assert.doesNotThrow(() => verifyCapabilityTicket(ticket, {
    secret: SECRET,
    now: NOW,
    request: { action: 'browser.capture', directory: '/srv/TwinTasks/DT-20260730-0001/evidence' }
  }));

  assert.throws(
    () => verifyCapabilityTicket(ticket, {
      secret: SECRET,
      now: NOW,
      request: { action: 'browser.capture', directory: '/srv/twintasks/DT-20260730-0001/evidence' }
    }),
    (error) => error.code === 'directory_denied'
  );
});

test('nonce 只能消费一次，重放必须失败', () => {
  const ticket = issueCapabilityTicket({ secret: SECRET, payload: payload() });
  const store = new TaskStore(':memory:');
  const options = {
    secret: SECRET,
    store,
    consume: true,
    now: NOW,
    request: { action: 'browser.submit', taskId: 'DT-20260730-0001', workerId: 'worker-browser-1' }
  };

  assert.equal(verifyCapabilityTicket(ticket, options).nonce, 'nonce-000000000001');
  assert.throws(
    () => verifyCapabilityTicket(ticket, options),
    (error) => error.code === 'replayed'
  );
  store.close();
});
