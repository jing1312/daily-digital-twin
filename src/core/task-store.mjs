import { DatabaseSync } from 'node:sqlite';

const TERMINAL_STATES = new Set(['completed', 'partial', 'failed', 'cancelled']);
const TRANSITIONS = {
  queued: new Set(['running', 'cancelled']),
  running: new Set(['queued', 'waiting_for_user', 'retrying', 'completed', 'partial', 'failed', 'cancelled']),
  waiting_for_user: new Set(['running', 'partial', 'failed', 'cancelled']),
  retrying: new Set(['running', 'failed', 'cancelled']),
  completed: new Set(),
  partial: new Set(),
  failed: new Set(),
  cancelled: new Set()
};

// 中文注释：返回统一的 ISO 时间，便于任务、事件和回执关联。
function now() {
  return new Date().toISOString();
}

// 中文注释：将 SQLite 任务行转换为对外稳定的对象。
function mapTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    request: row.request,
    state: row.state,
    paused: Boolean(row.paused),
    reason: row.reason,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class TaskStore {
  // 中文注释：初始化私有 SQLite 数据库及任务相关表结构。
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request TEXT NOT NULL,
        state TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        state TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resource_locks (
        resource TEXT PRIMARY KEY,
        task_id INTEGER NOT NULL,
        acquired_at TEXT NOT NULL
      );
    `);
  }

  // 中文注释：创建任务前限制活跃任务数量，避免资源被过量占用。
  createTask({ request }) {
    if (!request?.trim()) throw new Error('任务内容不能为空');
    if (this.countActiveTasks() >= 4) throw new Error('最多同时保留四个活跃任务');
    const timestamp = now();
    const result = this.db.prepare(`
      INSERT INTO tasks (request, state, created_at, updated_at)
      VALUES (?, 'queued', ?, ?)
    `).run(request.trim(), timestamp, timestamp);
    const task = this.getTask(Number(result.lastInsertRowid));
    this.recordEvent(task.id, 'queued', null);
    return task;
  }

  // 中文注释：按状态机规则推进任务，并保存可审计事件。
  transition(taskId, nextState, { reason = null, summary = null } = {}) {
    const task = this.requireTask(taskId);
    if (!TRANSITIONS[task.state]?.has(nextState)) throw new Error(`不允许从 ${task.state} 转为 ${nextState}`);
    if (task.paused && nextState === 'running') throw new Error('任务已暂停，需先继续');
    const timestamp = now();
    this.db.prepare(`
      UPDATE tasks SET state = ?, reason = ?, summary = ?, updated_at = ? WHERE id = ?
    `).run(nextState, reason, summary, timestamp, task.id);
    this.recordEvent(task.id, nextState, reason ?? summary);
    if (TERMINAL_STATES.has(nextState)) this.releaseLocks(task.id);
    return this.getTask(task.id);
  }

  // 中文注释：暂停任务并释放占用资源，保留任务检查点。
  pause(taskId) {
    const task = this.requireTask(taskId);
    if (TERMINAL_STATES.has(task.state)) throw new Error('已结束任务不能暂停');
    this.db.prepare(`UPDATE tasks SET state = 'queued', paused = 1, updated_at = ? WHERE id = ?`).run(now(), task.id);
    this.releaseLocks(task.id);
    this.recordEvent(task.id, 'queued', '已暂停');
    return this.getTask(task.id);
  }

  // 中文注释：恢复暂停任务，使调度器可以再次领取它。
  resume(taskId) {
    const task = this.requireTask(taskId);
    if (!task.paused) throw new Error('任务未暂停');
    this.db.prepare(`UPDATE tasks SET paused = 0, updated_at = ? WHERE id = ?`).run(now(), task.id);
    this.recordEvent(task.id, 'queued', '已继续');
    return this.getTask(task.id);
  }

  // 中文注释：获取单个任务的当前公开状态。
  getTask(taskId) {
    return mapTask(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
  }

  // 中文注释：列出仍需要执行或等待人工输入的任务。
  listActiveTasks() {
    return this.db.prepare(`SELECT * FROM tasks WHERE state IN ('queued', 'running', 'waiting_for_user', 'retrying') ORDER BY id ASC`).all().map(mapTask);
  }

  // 中文注释：列出等待验证码的任务，但不保存验证码本身。
  listVerificationWaiters() {
    return this.db.prepare(`SELECT * FROM tasks WHERE state = 'waiting_for_user' AND reason = '需要验证码' ORDER BY id ASC`).all().map(mapTask);
  }

  // 中文注释：为文件、应用或标签页获取互斥资源锁。
  acquireLock(taskId, resource) {
    this.requireTask(taskId);
    const existing = this.db.prepare('SELECT task_id FROM resource_locks WHERE resource = ?').get(resource);
    if (existing && existing.task_id !== taskId) throw new Error(`资源已被任务 ${existing.task_id} 占用`);
    if (!existing) this.db.prepare(`INSERT INTO resource_locks (resource, task_id, acquired_at) VALUES (?, ?, ?)`).run(resource, taskId, now());
  }

  // 中文注释：释放任务的全部资源锁，用于完成、取消或暂停。
  releaseLocks(taskId) {
    this.db.prepare('DELETE FROM resource_locks WHERE task_id = ?').run(taskId);
  }

  // 中文注释：列出任务持有的资源，供状态回执和调度诊断使用。
  listLocks(taskId) {
    return this.db.prepare(`SELECT resource, task_id AS taskId, acquired_at AS acquiredAt FROM resource_locks WHERE task_id = ? ORDER BY resource ASC`).all(taskId);
  }

  // 中文注释：关闭数据库连接，供测试和进程退出时调用。
  close() {
    this.db.close();
  }

  // 中文注释：统计活跃任务，作为四槽上限的持久化依据。
  countActiveTasks() {
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE state IN ('queued', 'running', 'waiting_for_user', 'retrying')`).get().count);
  }

  // 中文注释：确保调用方引用的是存在的任务。
  requireTask(taskId) {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`任务 ${taskId} 不存在`);
    return task;
  }

  // 中文注释：记录状态变化，不存储验证码等敏感输入。
  recordEvent(taskId, state, detail) {
    this.db.prepare(`INSERT INTO task_events (task_id, state, detail, created_at) VALUES (?, ?, ?, ?)`).run(taskId, state, detail, now());
  }
}
