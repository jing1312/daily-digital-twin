import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/core/task-store.mjs';
import { migrate, readSchemaVersion, listColumns, tableExists, SCHEMA_VERSION } from '../src/core/schema.mjs';

function withTempDatabase(work) {
  const directory = mkdtempSync(join(tmpdir(), 'ddt-migrate-'));
  const path = join(directory, 'runtime.sqlite');
  try {
    return work(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// 中文注释：模拟旧版（v1）数据库：只有最初那几列，没有 attempt / failure_reason / paused_from。
function createLegacyDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request TEXT NOT NULL,
      state TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      state TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE resource_locks (
      resource TEXT PRIMARY KEY,
      task_id INTEGER NOT NULL,
      acquired_at TEXT NOT NULL
    );
  `);
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO tasks (request, state, paused, reason, summary, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
    .run('旧版遗留任务', 'waiting_for_user', '需要验证码', null, stamp, stamp);
  return db;
}

test('旧库升级到 v2 时保留原有任务数据', () => {
  withTempDatabase((path) => {
    const legacy = createLegacyDatabase(path);
    assert.equal(readSchemaVersion(legacy), null, '旧库没有版本记录');
    legacy.close();

    const store = new TaskStore(path);
    // 中文注释：迁移绝不能丢数据 —— 她的 OpenClaw 数据必须原样保留，这里同样验证任务数据不丢。
    const tasks = store.listActiveTasks();
    assert.equal(tasks.length, 1, '迁移后旧任务必须还在');
    assert.equal(tasks[0].request, '旧版遗留任务');
    assert.equal(tasks[0].state, 'waiting_for_user', '迁移不得改动任务状态');
    assert.equal(tasks[0].reason, '需要验证码');

    assert.equal(store.migration.fromVersion, 1, '有存量任务的无版本库应识别为 v1');
    assert.equal(store.migration.toVersion, SCHEMA_VERSION);
    assert.equal(store.migration.migrated, true);
    assert.ok(store.migration.addedColumns.length > 0, '应报告新增的列');
    store.close();
  });
});

test('迁移补齐新列并给出可用默认值', () => {
  withTempDatabase((path) => {
    createLegacyDatabase(path).close();
    const store = new TaskStore(path);

    const columns = listColumns(store.db, 'tasks');
    for (const expected of ['paused_from', 'attempt', 'failure_reason', 'resume_state', 'owner_open_id']) {
      assert.ok(columns.includes(expected), `tasks 应新增列 ${expected}`);
    }
    assert.ok(listColumns(store.db, 'resource_locks').includes('exclusive_class'));

    const task = store.listActiveTasks()[0];
    assert.equal(task.attempt, 0, '旧行的新列必须有可用默认值而不是 null');
    assert.equal(task.pausedFrom, null);
    store.close();
  });
});

test('迁移建立本轮新增的表', () => {
  withTempDatabase((path) => {
    createLegacyDatabase(path).close();
    const store = new TaskStore(path);
    for (const table of ['settings', 'verification_waits', 'execution_evidence', 'token_ledger', 'task_browser_sessions', 'schema_meta']) {
      assert.equal(tableExists(store.db, table), true, `应创建表 ${table}`);
    }
    store.close();
  });
});

test('迁移是幂等的，重复打开不会报错也不会重复升级', () => {
  withTempDatabase((path) => {
    createLegacyDatabase(path).close();

    const first = new TaskStore(path);
    assert.equal(first.migration.migrated, true);
    first.close();

    const second = new TaskStore(path);
    assert.equal(second.migration.migrated, false, '第二次打开不应再次迁移');
    assert.equal(second.migration.fromVersion, SCHEMA_VERSION);
    assert.deepEqual(second.migration.addedColumns, []);
    assert.equal(readSchemaVersion(second.db), SCHEMA_VERSION);
    second.close();
  });
});

test('全新空库直接建成当前版本', () => {
  withTempDatabase((path) => {
    const store = new TaskStore(path);
    assert.equal(store.migration.fromVersion, 0, '空库应识别为版本 0');
    assert.equal(readSchemaVersion(store.db), SCHEMA_VERSION);
    assert.equal(store.pragmaInfo().schemaVersion, SCHEMA_VERSION);
    store.close();
  });
});

test('迁移函数可对同一连接安全重复调用', () => {
  const db = new DatabaseSync(':memory:');
  const first = migrate(db);
  const second = migrate(db);
  assert.equal(first.toVersion, SCHEMA_VERSION);
  assert.equal(second.migrated, false);
  db.close();
});

test('升级后旧任务仍可正常流转，并能记录新字段', () => {
  withTempDatabase((path) => {
    createLegacyDatabase(path).close();
    const store = new TaskStore(path);
    const task = store.listActiveTasks()[0];

    store.pause(task.id);
    assert.equal(store.getTask(task.id).pausedFrom, 'waiting_for_user');
    assert.equal(store.resume(task.id).ok, true);
    assert.equal(store.bumpAttempt(task.id), 1);

    store.transition(task.id, 'running');
    const finished = store.transition(task.id, 'partial', { summary: '收尾' });
    assert.equal(finished.reason, '需要验证码', '迁移后仍要保留原因');
    assert.ok(finished.failureReason);
    store.close();
  });
});

// 中文注释：B31 —— 回填 public_id 之后，daily_task_counters 必须跳过已经用掉的序号。
//           修复前：回填把旧任务写成 DT-<今天>-0001，但计数器表仍然是空的，
//           createTask 于是从 1 重新发号，撞上 tasks_public_id 唯一索引。
//           而 createTask 整个包在 writeTransaction 里，撞索引会整笔回滚、
//           计数器永远不前进 —— 表现是"迁移之后当天再也建不了任务"，
//           不是"重试几次就好"。所以这条断言的是"能建"，而不是"报错友好"。
//           时序前提：旧任务的 created_at 与随后的 createTask 落在同一个 UTC 日期。
//           createLegacyDatabase 用的就是 new Date()，整条测试跑完只要几十毫秒。
test('B31：回填 public_id 后计数器跳过已用序号，迁移当天仍能建新任务', () => {
  withTempDatabase((path) => {
    createLegacyDatabase(path).close();
    const store = new TaskStore(path);

    const legacyTask = store.listActiveTasks()[0];
    assert.match(legacyTask.publicId, /^DT-\d{8}-0001$/, '回填应从 0001 开始');
    const dateKey = legacyTask.publicId.slice(3, 11);

    const counter = store.db
      .prepare('SELECT next_value FROM daily_task_counters WHERE date_key = ?')
      .get(dateKey);
    assert.ok(counter, '回填后必须写入当天的计数器行，不能留一张空表');
    assert.equal(counter.next_value, 2, '下一个可用序号应为 2');

    // 中文注释：这一句在修复前抛 UNIQUE constraint failed: tasks.public_id。
    assert.equal(store.createTask({ request: '迁移之后的新任务' }).publicId, `DT-${dateKey}-0002`);
    // 中文注释：再建一个，确认计数器是真的在前进，而不是每次都靠 MAX 兜一下。
    assert.equal(store.createTask({ request: '再来一个' }).publicId, `DT-${dateKey}-0003`);

    store.close();
  });
});

// 中文注释：B31b —— 反向对照。库里已经有更靠前的计数器时，同步必须用 MAX 合并，
//           不能把计数器往回压（否则修好一个洞、又开一个）。
//           注意：不能靠"重新打开一次 TaskStore"来触发同步 —— migrate 在
//           fromVersion >= SCHEMA_VERSION 时会提前返回，回填根本不会跑，那样这条测试
//           会是假绿灯。所以这里手工造出"计数器已发到 900、旧任务还没有 public_id、
//           schema_version 仍低于当前版本"的库形状，并断言 migrated === true。
test('B31b：已有更靠前的计数器时，回填同步必须用 MAX 合并而不是往回压', () => {
  withTempDatabase((path) => {
    const legacy = createLegacyDatabase(path);
    legacy.exec(`
      CREATE TABLE daily_task_counters (
        date_key TEXT PRIMARY KEY,
        next_value INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const dateKey = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    legacy
      .prepare('INSERT INTO daily_task_counters (date_key, next_value, updated_at) VALUES (?, 900, ?)')
      .run(dateKey, new Date().toISOString());
    legacy.close();

    const store = new TaskStore(path);
    assert.equal(store.migration.migrated, true, '这个库必须真的跑过一次迁移，否则本条什么都没测到');
    assert.equal(
      store.db.prepare('SELECT next_value FROM daily_task_counters WHERE date_key = ?').get(dateKey).next_value,
      900,
      '同步必须用 MAX 合并，不能把 900 压回 2'
    );
    assert.equal(store.createTask({ request: '第 900 号' }).publicId, `DT-${dateKey}-0900`);
    store.close();
  });
});
