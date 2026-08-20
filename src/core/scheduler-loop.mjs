import { canSchedule } from './scheduler.mjs';
import { getRetryPlan } from './retry-policy.mjs';
import { finalizeTask, recordExecutionEvidence } from './execution-verifier.mjs';

const TERMINAL_STATES = new Set(['completed', 'partial', 'failed', 'cancelled']);

// 中文注释：真正执行任务的调度循环。原先只有 canSchedule 这个判断函数，没有任何东西会去跑任务（修 B16）。
// 中文注释：默认休眠 —— config.scheduler.enabled 为 false 时 start() 直接拒绝，必须由用户手动启用。

const FOREGROUND_CLASS = 'foreground';

// 中文注释：executor 契约：
// 中文注释：  入参 { task, store, config }
// 中文注释：  返回 { outcome: 'completed'|'partial'|'failed'|'waiting_for_user', summary?, reason?, evidence?: [] }
export function createSchedulerLoop({
  store,
  config,
  executor,
  telemetry = null,
  logger = console,
  requiresForeground = () => false
} = {}) {
  if (!store) throw new Error('调度循环需要 store');
  if (typeof executor !== 'function') throw new Error('调度循环需要 executor 函数');

  const schedulerConfig = config?.scheduler ?? {};
  const enabled = schedulerConfig.enabled === true;
  let timer = null;
  let running = false;

  // 中文注释：读取遥测。没有遥测提供者就返回空对象，资源策略会因此失败关闭（符合 B6 的修法）。
  function readTelemetry() {
    if (typeof telemetry !== 'function') return {};
    try {
      return telemetry() ?? {};
    } catch (error) {
      logger.error?.(`遥测读取失败：${error.message}`);
      return {};
    }
  }

  async function runOne(task) {
    const attempt = store.bumpAttempt(task.id);
    let result = null;
    try {
      result = await executor({ task, store, config });
    } catch (error) {
      result = { outcome: 'failed', reason: `执行抛出异常：${error.message}` };
    }

    for (const evidence of result?.evidence ?? []) {
      try {
        recordExecutionEvidence(store, task.id, evidence);
      } catch (error) {
        logger.error?.(`任务 ${task.id} 证据无效，已忽略：${error.message}`);
      }
    }

    const outcome = result?.outcome ?? 'failed';

    let runResult;
    if (outcome === 'waiting_for_user') {
      store.transition(task.id, 'waiting_for_user', { reason: result?.reason ?? '需要人工确认' });
      store.releaseLocks(task.id);
      runResult = { taskId: task.id, outcome, attempt };
    } else if (outcome === 'completed' || outcome === 'partial') {
      const finalized = finalizeTask(store, task.id, {
        summary: result?.summary ?? null,
        requireEvidence: config?.execution?.requireEvidence !== false && outcome === 'completed'
      });
      runResult = { taskId: task.id, outcome: finalized.state, attempt, verified: finalized.verified };
    } else {
      const plan = getRetryPlan(attempt, config?.retries);
      if (plan) {
        store.transition(task.id, 'retrying', { reason: result?.reason ?? '瞬时失败，准备重试' });
        store.releaseLocks(task.id);
        runResult = { taskId: task.id, outcome: 'retrying', attempt, retryInSeconds: plan.delaySeconds };
      } else {
        store.transition(task.id, 'failed', { reason: result?.reason ?? '重试次数已用尽' });
        runResult = { taskId: task.id, outcome: 'failed', attempt };
      }
    }

    // 中文注释：F1：子任务到终态后检查父任务是否可以自动收尾。
    if (task.parentTaskId && TERMINAL_STATES.has(runResult.outcome)) {
      try {
        const parentFinalized = store.finalizeParentTask(task.parentTaskId);
        if (parentFinalized) runResult.parentFinalized = { taskId: parentFinalized.id, state: parentFinalized.state };
      } catch (error) {
        logger.error?.(`父任务 ${task.parentTaskId} 自动收尾失败：${error.message}`);
      }
    }

    return runResult;
  }

  // 中文注释：单次调度。测试直接调 tick()，不需要真正起定时器。
  async function tick() {
    if (running) return { skipped: true, reason: 'tick_in_progress' };
    running = true;
    try {
      const policy = canSchedule({
        activeCount: 0,
        foregroundBusy: false,
        requiresForeground: false,
        resource: readTelemetry(),
        limits: config?.resource
      });
      if (!policy.allowed) return { picked: 0, reason: policy.reason, policy: policy.policy };

      const candidates = store.listRunnableTasks().filter((task) => task.state === 'queued' || task.state === 'retrying');
      if (candidates.length === 0) return { picked: 0, reason: 'no_runnable_tasks', policy: policy.policy };

      const parallelLimit = Math.min(
        Number(schedulerConfig.maxParallelWorkers ?? 2),
        Number(policy.policy.slotLimit ?? 1)
      );
      const results = [];
      for (const task of candidates.slice(0, Math.max(1, parallelLimit))) {
        const needsForeground = Boolean(requiresForeground(task));
        const lock = store.tryAcquireLock(task.id, `task:${task.id}`, {
          exclusiveClass: needsForeground ? FOREGROUND_CLASS : null
        });
        if (!lock.ok) {
          results.push({ taskId: task.id, outcome: 'skipped', reason: lock.code, holderTaskId: lock.holderTaskId });
          continue;
        }
        if (task.state === 'retrying') store.transition(task.id, 'running');
        else store.transition(task.id, 'running');
        results.push(await runOne(store.getTask(task.id)));
      }
      return { picked: results.length, results, policy: policy.policy };
    } finally {
      running = false;
    }
  }

  // 中文注释：启动定时循环。默认休眠，未启用时明确拒绝并说明如何开启。
  function start({ keepAlive = true } = {}) {
    if (!enabled) {
      return {
        started: false,
        reason: 'scheduler_disabled',
        message: '调度器默认休眠。启用方式：npm run runtime -- scheduler enable'
      };
    }
    if (timer) return { started: true, alreadyRunning: true };
    const intervalMs = Math.max(1, Number(schedulerConfig.pollSeconds ?? 5)) * 1000;
    timer = setInterval(() => {
      tick().catch((error) => logger.error?.(`调度循环异常：${error.message}`));
    }, intervalMs);
    if (!keepAlive) timer.unref();
    return { started: true, intervalMs };
  }

  function stop() {
    if (!timer) return { stopped: false };
    clearInterval(timer);
    timer = null;
    return { stopped: true };
  }

  return { enabled, start, stop, tick, isRunning: () => Boolean(timer) };
}
