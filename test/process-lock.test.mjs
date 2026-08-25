import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireProcessLock } from '../src/core/process-lock.mjs';

test('同一私有目录只允许一个控制平面持锁，释放后可以重新启动', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ddt-process-lock-'));
  try {
    const first = await acquireProcessLock({ home, name: 'control-plane' });
    await assert.rejects(
      () => acquireProcessLock({ home, name: 'control-plane' }),
      (error) => error.code === 'instance_already_running'
    );
    await first.release();
    const second = await acquireProcessLock({ home, name: 'control-plane' });
    await second.release();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('死进程遗留的锁会被接管，但不会覆盖仍存活的 owner', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ddt-stale-lock-'));
  try {
    const lockDirectory = join(home, 'data', 'locks');
    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(join(lockDirectory, 'control-plane.lock'), JSON.stringify({ pid: 999999, token: 'stale' }), 'utf8');
    const lock = await acquireProcessLock({
      home,
      name: 'control-plane',
      isProcessAlive: (pid) => pid !== 999999
    });
    await lock.release();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
