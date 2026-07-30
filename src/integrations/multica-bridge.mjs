import { calculateUsageCost } from '../core/pricing.mjs';
import { decideResourcePolicy } from '../core/resource-policy.mjs';
import { extractPlannerPlan, PlannerContractError, validatePlannerPlan } from './planner-contract.mjs';

const RUNNING = new Set(['queued', 'claimed', 'dispatched', 'in_progress', 'in progress', 'running', 'started', 'working']);
const COMPLETED = new Set(['done', 'completed', 'closed', 'succeeded', 'success']);
const FAILED = new Set(['failed', 'error']);
const CANCELLED = new Set(['cancelled', 'canceled']);
const WORKER_TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function rows(payload, keys) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}

function runs(payload) {
  return rows(payload, ['runs', 'items', 'data', 'tasks']);
}

function usageRows(payload) {
  const values = rows(payload, ['runs', 'items', 'usage', 'data']);
  if (values.length) return values;
  return payload && typeof payload === 'object'
    && (payload.model || payload.input_tokens !== undefined || payload.total_input_tokens !== undefined)
    ? [payload]
    : [];
}

function statusValue(value) {
  return String(value?.status?.key ?? value?.status?.name ?? value?.status ?? value?.state ?? '').trim().toLowerCase();
}

function runId(run) {
  return run?.id ?? run?.task_id ?? run?.taskId ?? run?.run_id ?? run?.runId ?? null;
}

function latestRun(payload) {
  return runs(payload).at(-1) ?? null;
}

function ensureRunning(store, task) {
  if (task.state === 'running') return task;
  if (task.state === 'queued' || task.state === 'retrying' || task.state === 'waiting_for_user') {
    return store.transition(task.id, 'running');
  }
  return task;
}

function textFromMessages(payload) {
  const messages = rows(payload, ['messages', 'items', 'data']);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index]?.content ?? messages[index]?.text ?? messages[index]?.message?.content;
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 4_000);
  }
  return null;
}

function workerDescription(task, subtask) {
  return [
    `Daily Twin 根任务：${task.publicId}`,
    `子任务：${subtask.id} ${subtask.title}`,
    '',
    subtask.instructions,
    '',
    '只使用分配给本 worker 的 Daily Twin MCP 高层工具；不要请求或扩大本机权限。',
    '最终回复给出结构化结果，至少包含 outcome 和 summary。'
  ].join('\n');
}

function finalSummary(workers) {
  const completed = workers.filter((item) => item.state === 'completed');
  const failed = workers.filter((item) => item.state === 'failed');
  const cancelled = workers.filter((item) => item.state === 'cancelled');
  const details = workers.map((item) => `${item.subtaskId}:${item.state}${item.summary ? ` ${item.summary}` : ''}`).join('；');
  return `${completed.length}/${workers.length} 个子任务完成，失败 ${failed.length}，取消 ${cancelled.length}。${details}`.slice(0, 8_000);
}

export function createMulticaBridge({
  store,
  client,
  priceTable = { models: {} },
  telemetry = () => ({}),
  resourceLimits,
  workerAgents = [],
  allowedCapabilities = { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] },
  prepareWorker = null,
  workerMaxMinutes = 90,
  now = () => Date.now(),
  logger = console
} = {}) {
  if (!store || !client) throw new Error('Multica 同步桥缺少 store 或 client');

  function taskIssues(taskId) {
    const task = store.requireTask(taskId);
    const issues = [{ issueId: task.multicaIssueId, workerRowId: null }];
    for (const worker of store.listTaskWorkers(task.id)) {
      if (worker.multicaIssueId && ['dispatched', 'running'].includes(worker.state)) {
        issues.push({ issueId: worker.multicaIssueId, workerRowId: worker.id });
      }
    }
    return issues.filter((item) => item.issueId);
  }

  function allTaskIssues(taskId) {
    const task = store.requireTask(taskId);
    return [
      { issueId: task.multicaIssueId, workerRowId: null },
      ...store.listTaskWorkers(task.id).map((worker) => ({
        issueId: worker.multicaIssueId,
        workerRowId: worker.id
      }))
    ].filter((item) => item.issueId);
  }

  async function interruptRemoteRuns(taskId, { remember }) {
    const cancelled = [];
    const failures = [];
    for (const item of taskIssues(taskId)) {
      try {
        const run = latestRun(await client.getIssueRuns(item.issueId));
        const id = runId(run);
        if (!id || !RUNNING.has(statusValue(run))) continue;
        await client.cancelTask(id);
        cancelled.push({ issueId: item.issueId, runId: String(id) });
      } catch (error) {
        failures.push({ issueId: item.issueId, message: error.message });
      }
    }
    if (remember) {
      store.saveMulticaPausedRuns(taskId, [...store.getMulticaPausedRuns(taskId), ...cancelled]);
    } else {
      store.clearMulticaPausedRuns(taskId);
    }
    return { ok: failures.length === 0, cancelled, failures };
  }

  async function resumeRemoteRuns(taskId) {
    const pending = store.getMulticaPausedRuns(taskId);
    const rerun = [];
    const failures = [];
    for (const item of pending) {
      try {
        await client.rerunIssue(item.issueId);
        rerun.push(item.issueId);
      } catch (error) {
        failures.push({ issueId: item.issueId, message: error.message });
      }
    }
    store.saveMulticaPausedRuns(taskId, pending.filter((item) => failures.some((failure) => failure.issueId === item.issueId)));
    return { ok: failures.length === 0, rerun, failures };
  }

  async function cleanupTerminalRemoteRuns() {
    if (typeof store.listMulticaTerminalTasksPendingCleanup !== 'function') return [];
    const cleaned = [];
    for (const task of store.listMulticaTerminalTasksPendingCleanup()) {
      let pending = store.listTaskWorkers(task.id).some((worker) => (
        worker.state === 'dispatching' && !worker.multicaIssueId
      ));
      const failures = [];
      for (const item of allTaskIssues(task.id)) {
        try {
          const run = latestRun(await client.getIssueRuns(item.issueId));
          if (!run) {
            pending = true;
            continue;
          }
          const status = statusValue(run);
          if (RUNNING.has(status)) {
            const id = runId(run);
            if (!id || typeof client.cancelTask !== 'function') {
              pending = true;
              continue;
            }
            await client.cancelTask(id);
            if (item.workerRowId) {
              store.transitionTaskWorker(item.workerRowId, 'cancelled', {
                failureReason: '根任务已结束，远端 worker 已停止'
              });
            }
            continue;
          }
          const remoteState = COMPLETED.has(status)
            ? 'completed'
            : (FAILED.has(status) ? 'failed' : (CANCELLED.has(status) ? 'cancelled' : null));
          if (!remoteState) {
            pending = true;
            continue;
          }
          if (item.workerRowId) {
            store.transitionTaskWorker(item.workerRowId, remoteState, {
              failureReason: remoteState === 'completed' ? null : `根任务结束后发现远端 worker 状态为 ${remoteState}`
            });
          }
        } catch (error) {
          pending = true;
          failures.push({ issueId: item.issueId, message: error.message });
        }
      }
      if (!pending && failures.length === 0) {
        store.markMulticaTerminalCleanupComplete(task.id);
        cleaned.push(task.id);
      } else if (failures.length) {
        logger.error?.({ event: 'multica_terminal_cleanup_failed', taskId: task.publicId, failures });
      }
    }
    return cleaned;
  }

  async function syncUsage(issueId, taskId, workerId) {
    if (typeof client.getIssueUsage !== 'function') return;
    const payload = await client.getIssueUsage(issueId).catch(() => ({ runs: [] }));
    for (const row of usageRows(payload)) {
      const normalized = client.normalizeUsage(row, { issueId, taskId, workerId });
      normalized.estimatedCost = calculateUsageCost(normalized, priceTable);
      store.recordTokenUsage(normalized);
    }
  }

  async function syncWorker(worker) {
    if (!worker.multicaIssueId || !['dispatched', 'running'].includes(worker.state)) return worker;
    const run = latestRun(await client.getIssueRuns(worker.multicaIssueId));
    if (!run) return worker;
    const status = statusValue(run);
    await syncUsage(worker.multicaIssueId, worker.taskId, worker.workerId ?? 'multica-worker');
    if (RUNNING.has(status)) {
      if (worker.state !== 'running') return store.transitionTaskWorker(worker.id, 'running');
      const startedAt = Date.parse(worker.updatedAt);
      const elapsedMs = Number(now()) - startedAt;
      const budgetMs = Math.max(1, Number(workerMaxMinutes)) * 60_000;
      if (!Number.isFinite(startedAt) || !Number.isFinite(elapsedMs) || elapsedMs < budgetMs) return worker;

      const id = runId(run);
      const savedCheckpoint = store.getWorkerCheckpoint(worker.taskId, worker.workerId);
      const checkpointSavedAt = Date.parse(savedCheckpoint?.savedAt ?? '');
      const checkpoint = Number.isFinite(checkpointSavedAt) && checkpointSavedAt >= startedAt
        ? savedCheckpoint
        : null;
      if (!checkpoint) {
        if (id && typeof client.cancelTask === 'function') await client.cancelTask(id);
        return store.transitionTaskWorker(worker.id, 'failed', {
          failureReason: `worker 超过 ${workerMaxMinutes} 分钟且没有保存检查点，已停止本轮`
        });
      }
      if (!id || typeof prepareWorker !== 'function' || typeof client.cancelTask !== 'function' || typeof client.rerunIssue !== 'function') {
        if (id && typeof client.cancelTask === 'function') await client.cancelTask(id);
        return store.transitionTaskWorker(worker.id, 'failed', {
          failureReason: 'worker 已到时间预算，但续跑链路不完整'
        });
      }
      const task = store.requireTask(worker.taskId);
      const prepared = await prepareWorker({
        task,
        workerId: worker.workerId,
        scopes: worker.capabilities,
        subtask: {
          id: worker.subtaskId,
          title: worker.title,
          instructions: worker.instructions,
          capabilities: worker.capabilities
        }
      });
      await client.cancelTask(id);
      await client.rerunIssue(worker.multicaIssueId);
      return store.renewTaskWorkerRun(worker.id, { bindingPath: prepared.bindingPath });
    }
    const id = runId(run);
    const message = id ? textFromMessages(await client.getRunMessages(id).catch(() => null)) : null;
    if (COMPLETED.has(status)) return store.transitionTaskWorker(worker.id, 'completed', { summary: message ?? 'worker 已完成' });
    if (FAILED.has(status)) return store.transitionTaskWorker(worker.id, 'failed', { failureReason: message ?? 'Multica worker 失败' });
    if (CANCELLED.has(status)) return store.transitionTaskWorker(worker.id, 'cancelled', { failureReason: message ?? 'Multica worker 已取消' });
    return worker;
  }

  async function ensurePlannerPlan(task) {
    const existing = store.listTaskWorkers(task.id);
    if (existing.length) return existing;
    const plannerRun = latestRun(await client.getIssueRuns(task.multicaIssueId));
    if (!plannerRun) return [];
    const status = statusValue(plannerRun);
    await syncUsage(task.multicaIssueId, task.id, 'planner');
    if (RUNNING.has(status)) {
      ensureRunning(store, store.getTask(task.id));
      return [];
    }
    if (FAILED.has(status) || CANCELLED.has(status)) {
      const state = CANCELLED.has(status) ? 'cancelled' : 'failed';
      const current = ensureRunning(store, store.getTask(task.id));
      store.transition(current.id, state, { reason: `Multica planner ${state}` });
      return [];
    }
    if (!COMPLETED.has(status)) return [];
    const id = runId(plannerRun);
    if (!id) throw Object.assign(new Error('Multica planner 完成但没有 run ID'), { code: 'planner_run_id_missing' });
    const plan = validatePlannerPlan(extractPlannerPlan(await client.getRunMessages(id)), {
      allowed: typeof allowedCapabilities === 'function' ? allowedCapabilities(task) : allowedCapabilities,
      maxSubtasks: 4
    });
    ensureRunning(store, store.getTask(task.id));
    return store.saveWorkerPlan(task.id, plan.subtasks);
  }

  async function dispatchPlanned(task) {
    if (typeof prepareWorker !== 'function' || typeof client.createWorkerIssue !== 'function') return [];
    const policy = decideResourcePolicy(telemetry(), resourceLimits);
    if (!policy.acceptsNewActions || policy.slotLimit <= 0) return [];
    const active = store.listActiveWorkerRuns();
    let available = Math.max(0, policy.slotLimit - active.length);
    const busyAgents = new Set(active.map((item) => item.workerId).filter(Boolean));
    const results = [];
    for (const subtask of store.listTaskWorkers(task.id).filter((item) => item.state === 'planned')) {
      if (available <= 0) break;
      const workerId = workerAgents.find((candidate) => !busyAgents.has(candidate));
      if (!workerId) break;
      const prepared = await prepareWorker({
        task: store.getTask(task.id),
        workerId,
        scopes: subtask.capabilities,
        subtask
      });
      const dispatching = store.markWorkerDispatching(subtask.id, {
        workerId,
        bindingPath: prepared.bindingPath
      });
      try {
        const marker = `${task.publicId}:${subtask.subtaskId}`;
        const created = await client.createWorkerIssue({
          parentIssueId: task.multicaIssueId,
          marker,
          title: subtask.title,
          description: workerDescription(task, subtask),
          agent: workerId
        });
        results.push(store.bindWorkerIssue(dispatching.id, created.issueId));
        busyAgents.add(workerId);
        available -= 1;
      } catch (error) {
        store.resetWorkerDispatch(dispatching.id, { failureReason: error.message });
        logger.error?.({ event: 'multica_worker_dispatch_failed', taskId: task.publicId, subtaskId: subtask.subtaskId, message: error.message });
        break;
      }
    }
    return results;
  }

  function finalizeTask(task) {
    const workers = store.listTaskWorkers(task.id);
    if (!workers.length || workers.some((item) => !WORKER_TERMINAL.has(item.state))) return store.getTask(task.id);
    let current = ensureRunning(store, store.getTask(task.id));
    if (['completed', 'partial', 'failed', 'cancelled'].includes(current.state)) return current;
    const completed = workers.filter((item) => item.state === 'completed').length;
    const nextState = completed === workers.length ? 'completed' : (completed > 0 ? 'partial' : 'failed');
    return store.transition(current.id, nextState, {
      summary: finalSummary(workers),
      reason: nextState === 'failed' ? '所有 Multica worker 均未完成' : undefined
    });
  }

  return {
    pauseTask(taskId) {
      return interruptRemoteRuns(taskId, { remember: true });
    },

    resumeTask(taskId) {
      return resumeRemoteRuns(taskId);
    },

    cancelTask(taskId) {
      return interruptRemoteRuns(taskId, { remember: false });
    },

    async sync() {
      const results = [];
      await cleanupTerminalRemoteRuns();
      const pausedTasks = store.listActiveTasks().filter((task) => (
        task.taskKind === 'complex' && task.multicaIssueId && task.paused
      ));
      for (const task of pausedTasks) {
        const interrupted = await interruptRemoteRuns(task.id, { remember: true });
        results.push({ taskId: task.id, state: task.state, paused: true, remote: interrupted });
      }
      const tasks = store.listActiveTasks().filter((task) => task.taskKind === 'complex' && task.multicaIssueId && !task.paused);
      for (const initial of tasks) {
        try {
          await ensurePlannerPlan(initial);
          for (const worker of store.listTaskWorkers(initial.id)) await syncWorker(worker);
          await dispatchPlanned(initial);
          const task = finalizeTask(initial);
          results.push({ taskId: task.id, state: task.state, workers: store.listTaskWorkers(task.id).length });
        } catch (error) {
          if (error instanceof PlannerContractError) {
            const current = ensureRunning(store, store.getTask(initial.id));
            if (!['completed', 'partial', 'failed', 'cancelled'].includes(current.state)) {
              store.transition(current.id, 'failed', {
                reason: `Multica planner 输出无效：${error.message}`,
                failureReason: error.message
              });
            }
          }
          logger.error?.({ event: 'multica_sync_failed', taskId: initial.publicId, message: error.message });
          results.push({ taskId: initial.id, error: error.message });
        }
      }
      return results;
    }
  };
}
