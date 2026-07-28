import { DatabaseSync } from 'node:sqlite';
import { applyPragmas, migrate, SCHEMA_VERSION } from './schema.mjs';

const TERMINAL_STATES = new Set(['completed', 'partial', 'failed', 'cancelled']);
const OPEN_STATES = ['queued', 'running', 'waiting_for_user', 'retrying'];
const FAILURE_STATES = new Set(['failed', 'partial', 'retrying']);
export const VERIFICATION_REASON = '需要验证码';

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

const DEFAULTS = {
  maxSlots: 4,
  openTaskLimit: 16,
  busyTimeoutMs: 5000,
  verificationTtlSeconds: 600,
  busyRetries: 5,
  busyRetryDelayMs: 120
};

// 中文注释：返回统一的 ISO 时间，便于任务、事件和回执关联。
function now() {
  return new Date().toISOString();
}

// 中文注释：同步睡眠，用于遇到 SQLITE_BUSY 时的退避。node:sqlite 是同步 API，不能用 await。
function sleepSync(milliseconds) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, Math.max(1, milliseconds));
}

function isBusyError(error) {
  return /database is locked|SQLITE_BUSY|database table is locked/i.test(String(error?.message ?? ''));
}

// 中文注释：将 SQLite 任务行转换为对外稳定的对象。
function mapTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    request: row.request,
    state: row.state,
    paused: Boolean(row.paused),
    pausedFrom: row.paused_from ?? null,
    reason: row.reason,
    summary: row.summary,
    failureReason: row.failure_reason ?? null,
    attempt: Number(row.attempt ?? 0),
    resumeState: row.resume_state ?? null,
    ownerOpenId: row.owner_open_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class TaskStore {
  // 中文注释：初始化私有 SQLite 数据库，统一设置并发参数并执行版本化迁移。
  constructor(filename, options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.db = new DatabaseSync(filename);
    this.pragmas = applyPragmas(this.db, { busyTimeoutMs: this.options.busyTimeoutMs });
    this.migration = migrate(this.db);
    this.schemaVersion = SCHEMA_VERSION;
    this._txDepth = 0;
  }

  // 中文注释：连接诊断信息，供测试和本机体检脚本核对 WAL 是否真的生效。
  pragmaInfo() {
    return {
      journalMode: String(this.db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? ''),
      busyTimeout: Number(this.db.prepare('PRAGMA busy_timeout').get()?.timeout ?? 0),
      schemaVersion: this.schemaVersion
    };
  }

  // 中文注释：短写事务 + 遇忙重试。WAL 只解决读写并发，长事务仍会互锁，所以事务体必须保持短小。
  writeTransaction(work) {
    if (this._txDepth > 0) return work();
    const attempts = Math.max(1, Number(this.options.busyRetries));
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        this._txDepth += 1;
        try {
          const result = work();
          this.db.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            this.db.exec('ROLLBACK');
          } catch {
            // 中文注释：回滚本身失败时保留原始错误，避免掩盖真实原因。
          }
          throw error;
        } finally {
          this._txDepth -= 1;
        }
      } catch (error) {
        lastError = error;
        if (!isBusyError(error) || attempt === attempts - 1) throw error;
        sleepSync(this.options.busyRetryDelayMs * (attempt + 1));
      }
    }
    throw lastError;
  }

  // 中文注释：创建任务。槽位只统计"未暂停的未结束任务"，暂停即让出槽位（修 B2）。
  createTask({ request, ownerOpenId = null } = {}) {
    if (!request?.trim()) throw new Error('任务内容不能为空');
    return this.writeTransaction(() => {
      if (this.countRunnableTasks() >= this.options.maxSlots) {
        throw new Error(`最多同时保留四个活跃任务（当前上限 ${this.options.maxSlots}）`);
      }
      if (this.countOpenTasks() >= this.options.openTaskLimit) {
        throw new Error(`未结束任务已达上限 ${this.options.openTaskLimit}，请先取消或完成部分任务`);
      }
      const timestamp = now();
      const result = this.db.prepare(`
        INSERT INTO tasks (request, state, created_at, updated_at, owner_open_id)
        VALUES (?, 'queued', ?, ?, ?)
      `).run(request.trim(), timestamp, timestamp, ownerOpenId);
      const taskId = Number(result.lastInsertRowid);
      this.recordEvent(taskId, 'queued', null);
      return this.getTask(taskId);
    });
  }

  // 中文注释：按状态机推进任务。reason/summary 只在显式传入时写入，终态不再擦除既有原因（修 B9）。
  transition(taskId, nextState, options = {}) {
    return this.writeTransaction(() => {
      const task = this.requireTask(taskId);
      if (!TRANSITIONS[task.state]?.has(nextState)) throw new Error(`不允许从 ${task.state} 转为 ${nextState}`);
      if (task.paused && nextState === 'running') throw new Error('任务已暂停，需先继续');

      const assignments = ['state = ?', 'updated_at = ?'];
      const values = [nextState, now()];
      if ('reason' in options) {
        assignments.push('reason = ?');
        values.push(options.reason ?? null);
      }
      if ('summary' in options) {
        assignments.push('summary = ?');
        values.push(options.summary ?? null);
      }
      values.push(task.id);
      this.db.prepare(`UPDATE tasks SET ${assignments.join(', ')} WHERE id = ?`).run(...values);

      const effectiveReason = 'reason' in options ? options.reason : task.reason;
      if (FAILURE_STATES.has(nextState)) {
        this.recordFailureReason(task.id, options.failureReason ?? effectiveReason ?? `状态 ${nextState}`);
      } else if (options.failureReason) {
        this.recordFailureReason(task.id, options.failureReason);
      }

      this.recordEvent(task.id, nextState, options.summary ?? effectiveReason ?? null);

      if (nextState === 'waiting_for_user' && (effectiveReason ?? '') === VERIFICATION_REASON) {
        this.requestVerification(task.id);
      } else if (task.state === 'waiting_for_user' && nextState !== 'waiting_for_user') {
        this.clearVerification(task.id);
      }

      if (TERMINAL_STATES.has(nextState)) {
        this.releaseLocks(task.id);
        this.clearVerification(task.id);
      }
      return this.getTask(task.id);
    });
  }

  // 中文注释：暂停任务。只写 paused 标记并记录暂停前状态，绝不把 waiting_for_user 拍平成 queued（修 B1）。
  // 中文注释：唯一例外是 running —— 在执行中的动作已被放弃，必须回到 queued 才能重新派发。
  pause(taskId) {
    return this.writeTransaction(() => {
      const task = this.requireTask(taskId);
      if (TERMINAL_STATES.has(task.state)) throw new Error('已结束任务不能暂停');
      if (task.paused) return this.getTask(task.id);
      const nextState = task.state === 'running' ? 'queued' : task.state;
      this.db.prepare(`
        UPDATE tasks SET state = ?, paused = 1, paused_from = ?, updated_at = ? WHERE id = ?
      `).run(nextState, task.state, now(), task.id);
      this.releaseLocks(task.id);
      this.recordEvent(task.id, nextState, '已暂停');
      return this.getTask(task.id);
    });
  }

  // 中文注释：继续任务。槽位已满时明确拒绝并保持暂停态，不抛裸异常（修 B2）。
  resume(taskId) {
    return this.writeTransaction(() => {
      const task = this.requireTask(taskId);
      if (!task.paused) return { ok: false, code: 'not_paused', message: '任务未暂停', task };
      if (this.countRunnableTasks() >= this.options.maxSlots) {
        return {
          ok: false,
          code: 'slots_full',
          message: `执行槽已满（上限 ${this.options.maxSlots}），任务保持暂停`,
          task
        };
      }
      this.db.prepare(`UPDATE tasks SET paused = 0, paused_from = NULL, updated_at = ? WHERE id = ?`).run(now(), task.id);
      this.recordEvent(task.id, task.state, '已继续');
      return { ok: true, code: null, message: null, task: this.getTask(task.id) };
    });
  }

  // 中文注释：获取单个任务的当前公开状态。
  getTask(taskId) {
    return mapTask(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
  }

  // 中文注释：列出所有未结束任务，含已暂停任务，供状态回执展示。
  listActiveTasks() {
    return this.db.prepare(`
      SELECT * FROM tasks WHERE state IN (${OPEN_STATES.map(() => '?').join(', ')}) ORDER BY id ASC
    `).all(...OPEN_STATES).map(mapTask);
  }

  // 中文注释：列出可被调度器领取的任务，排除已暂停任务。
  listRunnableTasks() {
    return this.db.prepare(`
      SELECT * FROM tasks WHERE paused = 0 AND state IN (${OPEN_STATES.map(() => '?').join(', ')}) ORDER BY id ASC
    `).all(...OPEN_STATES).map(mapTask);
  }

  // 中文注释：列出已暂停任务，供"继续"命令在未指定编号时给出候选。
  listPausedTasks() {
    return this.db.prepare(`
      SELECT * FROM tasks WHERE paused = 1 AND state IN (${OPEN_STATES.map(() => '?').join(', ')}) ORDER BY id ASC
    `).all(...OPEN_STATES).map(mapTask);
  }

  // 中文注释：列出仍在有效等待窗口内的验证码任务；过期等待不再接收裸数字（修 B3）。
  listVerificationWaiters() {
    return this.db.prepare(`
      SELECT tasks.* FROM tasks
      JOIN verification_waits ON verification_waits.task_id = tasks.id
      WHERE tasks.state = 'waiting_for_user' AND tasks.reason = ? AND verification_waits.expires_at > ?
      ORDER BY tasks.id ASC
    `).all(VERIFICATION_REASON, now()).map(mapTask);
  }

  // 中文注释：登记验证码等待窗口，只存时间戳，不存验证码本身。
  requestVerification(taskId, { ttlSeconds = this.options.verificationTtlSeconds } = {}) {
    const requestedAt = new Date();
    const expiresAt = new Date(requestedAt.getTime() + Math.max(0, Number(ttlSeconds)) * 1000);
    this.db.prepare(`
      INSERT INTO verification_waits (task_id, requested_at, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET requested_at = excluded.requested_at, expires_at = excluded.expires_at
    `).run(taskId, requestedAt.toISOString(), expiresAt.toISOString());
    return { taskId, requestedAt: requestedAt.toISOString(), expiresAt: expiresAt.toISOString() };
  }

  clearVerification(taskId) {
    this.db.prepare('DELETE FROM verification_waits WHERE task_id = ?').run(taskId);
  }

  // 中文注释：原子获取资源锁。单条 upsert 取代 SELECT-then-INSERT（修 B12）。
  // 中文注释：exclusiveClass 非空时受部分唯一索引约束，实现"同类动作全局只允许一个"。
  tryAcquireLock(taskId, resource, { exclusiveClass = null } = {}) {
    this.requireTask(taskId);
    if (!resource?.trim()) throw new Error('资源名不能为空');
    try {
      const result = this.db.prepare(`
        INSERT INTO resource_locks (resource, task_id, exclusive_class, acquired_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(resource) DO UPDATE SET acquired_at = excluded.acquired_at
        WHERE resource_locks.task_id = excluded.task_id
      `).run(resource.trim(), taskId, exclusiveClass, now());
      if (Number(result.changes) === 1) return { ok: true, code: null, holderTaskId: taskId };
      const holder = this.db.prepare('SELECT task_id FROM resource_locks WHERE resource = ?').get(resource.trim());
      return { ok: false, code: 'resource_busy', holderTaskId: holder ? Number(holder.task_id) : null };
    } catch (error) {
      if (/UNIQUE constraint failed: resource_locks.exclusive_class/.test(String(error?.message ?? ''))) {
        const holder = this.db.prepare('SELECT task_id FROM resource_locks WHERE exclusive_class = ?').get(exclusiveClass);
        return { ok: false, code: 'exclusive_class_busy', holderTaskId: holder ? Number(holder.task_id) : null };
      }
      throw error;
    }
  }

  // 中文注释：抛异常版本，保留原有调用方式；新代码建议用 tryAcquireLock 做流程控制。
  acquireLock(taskId, resource, options = {}) {
    const result = this.tryAcquireLock(taskId, resource, options);
    if (result.ok) return result;
    if (result.code === 'exclusive_class_busy') {
      throw new Error(`同类互斥动作已被任务 ${result.holderTaskId} 占用`);
    }
    throw new Error(`资源已被任务 ${result.holderTaskId} 占用`);
  }

  // 中文注释：释放任务的全部资源锁，用于完成、取消或暂停。
  releaseLocks(taskId) {
    this.db.prepare('DELETE FROM resource_locks WHERE task_id = ?').run(taskId);
  }

  releaseLock(taskId, resource) {
    this.db.prepare('DELETE FROM resource_locks WHERE task_id = ? AND resource = ?').run(taskId, resource);
  }

  // 中文注释：列出任务持有的资源，供状态回执和调度诊断使用。
  listLocks(taskId) {
    return this.db.prepare(`
      SELECT resource, task_id AS taskId, exclusive_class AS exclusiveClass, acquired_at AS acquiredAt
      FROM resource_locks WHERE task_id = ? ORDER BY resource ASC
    `).all(taskId);
  }

  // 中文注释：持久化重试次数，重启后不再从零开始（修 B10）。
  bumpAttempt(taskId) {
    return this.writeTransaction(() => {
      this.requireTask(taskId);
      this.db.prepare('UPDATE tasks SET attempt = attempt + 1, updated_at = ? WHERE id = ?').run(now(), taskId);
      return Number(this.db.prepare('SELECT attempt FROM tasks WHERE id = ?').get(taskId).attempt);
    });
  }

  // 中文注释：保存任务检查点，供暂停后继续或重试时恢复上下文。
  saveResumeState(taskId, resumeState) {
    this.requireTask(taskId);
    const payload = resumeState === null || resumeState === undefined
      ? null
      : (typeof resumeState === 'string' ? resumeState : JSON.stringify(resumeState));
    this.db.prepare('UPDATE tasks SET resume_state = ?, updated_at = ? WHERE id = ?').run(payload, now(), taskId);
    return payload;
  }

  getResumeState(taskId) {
    const row = this.db.prepare('SELECT resume_state FROM tasks WHERE id = ?').get(taskId);
    if (!row?.resume_state) return null;
    try {
      return JSON.parse(row.resume_state);
    } catch {
      return row.resume_state;
    }
  }

  // 中文注释：失败原因写一次就固定，后续状态变化不能覆盖（修 B9）。
  recordFailureReason(taskId, text) {
    if (!text) return null;
    this.db.prepare(`
      UPDATE tasks SET failure_reason = ?, updated_at = ? WHERE id = ? AND failure_reason IS NULL
    `).run(String(text), now(), taskId);
    return this.db.prepare('SELECT failure_reason FROM tasks WHERE id = ?').get(taskId)?.failure_reason ?? null;
  }

  // 中文注释：关闭数据库连接，供测试和进程退出时调用。
  close() {
    this.db.close();
  }

  // 中文注释：可被调度器领取的任务数，作为执行槽上限的持久化依据。
  countRunnableTasks() {
    return Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM tasks WHERE paused = 0 AND state IN (${OPEN_STATES.map(() => '?').join(', ')})
    `).get(...OPEN_STATES).count);
  }

  // 中文注释：所有未结束任务数（含暂停），防止暂停任务无限堆积。
  countOpenTasks() {
    return Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM tasks WHERE state IN (${OPEN_STATES.map(() => '?').join(', ')})
    `).get(...OPEN_STATES).count);
  }

  // 中文注释：保留旧名字，语义与 countRunnableTasks 一致，供既有调用方使用。
  countActiveTasks() {
    return this.countRunnableTasks();
  }

  // 中文注释：确保调用方引用的是存在的任务。
  requireTask(taskId) {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`任务 ${taskId} 不存在`);
    return task;
  }

  // 中文注释：记录状态变化，不存储验证码等敏感输入。
  recordEvent(taskId, state, detail) {
    this.db.prepare(`
      INSERT INTO task_events (task_id, state, detail, created_at) VALUES (?, ?, ?, ?)
    `).run(taskId, state, detail ?? null, now());
  }

  listEvents(taskId) {
    return this.db.prepare(`
      SELECT id, state, detail, created_at AS createdAt FROM task_events WHERE task_id = ? ORDER BY id ASC
    `).all(taskId);
  }

  // 中文注释：首次配对即锁定归属账号，后续账号一律拒绝（修 B17）。
  claimOwner(openId) {
    const id = String(openId ?? '').trim();
    if (!id) throw new Error('发送者标识不能为空');
    return this.writeTransaction(() => {
      const result = this.db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES ('owner_open_id', ?, ?)
        ON CONFLICT(key) DO NOTHING
      `).run(id, now());
      return { ownerOpenId: this.getOwner(), claimed: Number(result.changes) === 1 };
    });
  }

  getOwner() {
    return this.getSetting('owner_open_id');
  }

  // 中文注释：换手机或换账号时使用，必须在本机执行，不接受远程触发。
  resetOwner() {
    const previous = this.getOwner();
    this.db.prepare(`DELETE FROM settings WHERE key = 'owner_open_id'`).run();
    return { previousOwnerOpenId: previous };
  }

  getSetting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, String(value), now());
    return this.getSetting(key);
  }

  // 中文注释：写入执行验证证据。没有证据的任务不允许标记完成（见 execution-verifier）。
  insertExecutionEvidence({ taskId, kind, target = null, processId = null, processName = null, detail = null }) {
    this.requireTask(taskId);
    this.db.prepare(`
      INSERT INTO execution_evidence (task_id, kind, target, process_id, process_name, detail, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, kind, target, processId, processName, detail, now());
    return this.listExecutionEvidence(taskId).at(-1);
  }

  listExecutionEvidence(taskId) {
    return this.db.prepare(`
      SELECT id, kind, target, process_id AS processId, process_name AS processName, detail,
             verified_at AS verifiedAt
      FROM execution_evidence WHERE task_id = ? ORDER BY id ASC
    `).all(taskId);
  }

  // 中文注释：Token 用量落库，供成本与缓存命中率分析（修 B16b）。
  recordTokenUsage(usage) {
    this.db.prepare(`
      INSERT INTO token_ledger
        (task_id, worker_id, model, input_tokens, cached_tokens, output_tokens, cache_hit, latency_ms, estimated_cost, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      usage.taskId,
      String(usage.workerId ?? 'local'),
      String(usage.model ?? 'unknown'),
      Number(usage.inputTokens ?? 0),
      Number(usage.cachedTokens ?? 0),
      Number(usage.outputTokens ?? 0),
      usage.cacheHit ? 1 : 0,
      Number(usage.latencyMs ?? 0),
      usage.estimatedCost ?? null,
      now()
    );
    return this.summarizeTokenUsage(usage.taskId);
  }

  summarizeTokenUsage(taskId) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS calls,
             COALESCE(SUM(input_tokens), 0) AS inputTokens,
             COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
             COALESCE(SUM(output_tokens), 0) AS outputTokens,
             COALESCE(SUM(cache_hit), 0) AS cacheHits,
             COALESCE(SUM(estimated_cost), 0) AS estimatedCost
      FROM token_ledger WHERE task_id = ?
    `).get(taskId);
    return {
      taskId,
      calls: Number(row.calls),
      inputTokens: Number(row.inputTokens),
      cachedTokens: Number(row.cachedTokens),
      outputTokens: Number(row.outputTokens),
      cacheHits: Number(row.cacheHits),
      estimatedCost: Number(row.estimatedCost)
    };
  }
}
