import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/core/task-store.mjs';

// 中文注释：并发相关的缺陷必须用真实文件数据库验证。:memory: 的 journal_mode 恒为 memory，
// 中文注释：两个连接也不会互相看见，用它测锁等于什么都没测。

function withFileStores(count, work) {
  const directory = mkdtempSync(join(tmpdir(), 'ddt-concurrency-'));
  const databaseFile = join(directory, 'runtime.sqlite');
  const stores = [];
  try {
    for (let index = 0; index < count; index += 1) stores.push(new TaskStore(databaseFile));
    return work(stores, databaseFile);
  } finally {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        // 中文注释：忽略重复关闭，测试清理不该掩盖真实断言失败。
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

test('B11：文件数据库启用 WAL 与 busy_timeout，多连接并发写不再直接报锁死', () => {
  withFileStores(2, ([first, second]) => {
    const info = first.pragmaInfo();
    // 修复前：journal_mode=delete、busy_timeout=0，第二个连接一写就 "database is locked"。
    assert.equal(info.journalMode, 'wal', '文件库必须走 WAL，否则读写互斥');
    assert.ok(info.busyTimeout >= 5000, `busy_timeout 必须大于 0，实际 ${info.busyTimeout}`);
    assert.equal(second.pragmaInfo().journalMode, 'wal');

    const task = first.createTask({ request: '并发写入测试' });
    // 中文注释：第二个连接立刻写同一行，WAL + busy_timeout 下应当成功而不是抛锁错误。
    second.transition(task.id, 'running');
    assert.equal(first.getTask(task.id).state, 'running', '另一连接的写入必须可见');
  });
});

test('B11b：内存数据库不把 journal_mode=memory 当成失败', () => {
  const store = new TaskStore(':memory:');
  assert.equal(store.pragmaInfo().journalMode, 'memory');
  assert.ok(store.pragmaInfo().busyTimeout >= 5000);
  store.close();
});

test('B12：资源锁是单条原子语句，不存在先查后插的竞态窗口', () => {
  withFileStores(2, ([first, second]) => {
    const taskA = first.createTask({ request: '任务 A' });
    const taskB = first.createTask({ request: '任务 B' });

    assert.deepEqual(first.tryAcquireLock(taskA.id, 'browser:default'), {
      ok: true,
      code: null,
      holderTaskId: taskA.id
    });

    // 修复前：SELECT 与 INSERT 之间另一个进程可以插进来，两个任务同时"拿到"同一把锁。
    const blocked = second.tryAcquireLock(taskB.id, 'browser:default');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'resource_busy');
    assert.equal(blocked.holderTaskId, taskA.id, '必须报出真正的持锁任务');

    // 中文注释：同一任务重复取锁应可重入，否则续跑逻辑会自锁。
    assert.equal(first.tryAcquireLock(taskA.id, 'browser:default').ok, true);

    first.releaseLock(taskA.id, 'browser:default');
    assert.equal(second.tryAcquireLock(taskB.id, 'browser:default').ok, true);
  });
});

test('B12b：前台互斥类同一时刻只允许一个任务，后台任务不受影响', () => {
  withFileStores(1, ([store]) => {
    const foregroundA = store.createTask({ request: '打开 VS Code' });
    const foregroundB = store.createTask({ request: '打开 Excel' });
    const background = store.createTask({ request: '后台抓取网页' });

    assert.equal(store.tryAcquireLock(foregroundA.id, `task:${foregroundA.id}`, {
      exclusiveClass: 'foreground'
    }).ok, true);

    const blocked = store.tryAcquireLock(foregroundB.id, `task:${foregroundB.id}`, {
      exclusiveClass: 'foreground'
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'exclusive_class_busy', '第二个前台任务必须被互斥类拦住');

    // 中文注释：后台任务没有互斥类，应当照常拿到自己的锁。
    assert.equal(store.tryAcquireLock(background.id, `task:${background.id}`).ok, true);

    store.releaseLocks(foregroundA.id);
    assert.equal(store.tryAcquireLock(foregroundB.id, `task:${foregroundB.id}`, {
      exclusiveClass: 'foreground'
    }).ok, true, '释放后前台位应可被接管');
  });
});

test('数据库文件重开后任务与尝试次数仍然存在', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ddt-persist-'));
  const databaseFile = join(directory, 'runtime.sqlite');
  try {
    const first = new TaskStore(databaseFile);
    const task = first.createTask({ request: '跨进程持久化' });
    first.bumpAttempt(task.id);
    first.close();

    const second = new TaskStore(databaseFile);
    const reloaded = second.getTask(task.id);
    assert.equal(reloaded.request, '跨进程持久化');
    assert.equal(reloaded.attempt, 1, '重启后尝试次数必须还在');
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
