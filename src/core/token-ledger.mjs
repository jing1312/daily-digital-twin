import { migrate } from './schema.mjs';

// 中文注释：记录每次模型调用的用量，但不保存提示词和任务正文。
// 中文注释：建表已并入 schema.mjs 的版本化迁移，这里只保留兼容入口（修 B16b 的前置件）。
export function ensureTokenLedger(db) {
  return migrate(db);
}

// 中文注释：写入结构化 Token 账本，供成本、缓存命中率和延迟分析使用。
// 中文注释：推荐直接用 TaskStore#recordTokenUsage —— 它已接入任务收尾流程。
export function recordTokenUsage(db, usage) {
  ensureTokenLedger(db);
  db.prepare(`
    INSERT INTO token_ledger
      (task_id, worker_id, model, input_tokens, cached_tokens, output_tokens, cache_hit,
       latency_ms, estimated_cost, external_usage_id, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, external_usage_id) WHERE external_usage_id IS NOT NULL DO UPDATE SET
      worker_id = excluded.worker_id,
      model = excluded.model,
      input_tokens = excluded.input_tokens,
      cached_tokens = excluded.cached_tokens,
      output_tokens = excluded.output_tokens,
      cache_hit = excluded.cache_hit,
      latency_ms = excluded.latency_ms,
      estimated_cost = excluded.estimated_cost,
      recorded_at = excluded.recorded_at
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
    usage.usageId ? String(usage.usageId) : null,
    new Date().toISOString()
  );
}
