import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const healthModule = await import('../src/core/health-reporter.mjs').catch(() => ({}));

test('控制平面健康文件记录同一实例的启动、心跳和停止，不伪造连续运行', async () => {
  assert.equal(typeof healthModule.createControlPlaneHealth, 'function');
  const home = mkdtempSync(join(tmpdir(), 'ddt-health-'));
  let now = new Date('2026-07-30T00:00:00.000Z');
  try {
    const reporter = healthModule.createControlPlaneHealth({ home, now: () => now, pid: 1234 });
    await reporter.start();
    now = new Date('2026-07-30T00:01:00.000Z');
    await reporter.heartbeat();
    let saved = JSON.parse(readFileSync(join(home, 'data', 'control-plane-health.json'), 'utf8'));
    assert.equal(saved.startedAt, '2026-07-30T00:00:00.000Z');
    assert.equal(saved.lastHeartbeatAt, '2026-07-30T00:01:00.000Z');
    assert.equal(saved.status, 'running');
    assert.equal(saved.pid, 1234);

    now = new Date('2026-07-30T00:02:00.000Z');
    await reporter.stop();
    saved = JSON.parse(readFileSync(join(home, 'data', 'control-plane-health.json'), 'utf8'));
    assert.equal(saved.status, 'stopped');
    assert.equal(saved.stoppedAt, '2026-07-30T00:02:00.000Z');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
