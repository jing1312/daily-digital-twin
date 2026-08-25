export function createWorkerBudget({ startedAt = Date.now(), maxMinutes = 90 } = {}) {
  const start = startedAt instanceof Date ? startedAt.getTime() : Number(startedAt);
  const minutes = Number(maxMinutes);
  if (!Number.isFinite(start) || !Number.isFinite(minutes) || minutes <= 0) {
    throw Object.assign(new Error('worker 时间预算无效'), { code: 'invalid_worker_budget' });
  }
  const deadline = start + minutes * 60_000;
  return {
    startedAt: new Date(start).toISOString(),
    deadlineAt: new Date(deadline).toISOString(),
    maxMinutes: minutes,
    shouldCheckpoint(now = Date.now()) {
      const current = now instanceof Date ? now.getTime() : Number(now);
      return Number.isFinite(current) && current >= deadline;
    },
    remainingMs(now = Date.now()) {
      const current = now instanceof Date ? now.getTime() : Number(now);
      return Number.isFinite(current) ? Math.max(0, deadline - current) : 0;
    }
  };
}
