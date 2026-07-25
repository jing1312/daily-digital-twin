import { DatabaseSync } from 'node:sqlite';

// 中文注释：记录每次模型调用的用量，但不保存提示词和任务正文。
export function ensureTokenLedger(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      worker_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_hit INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL,
      recorded_at TEXT NOT NULL
    )
  `);
}

// 中文注释：写入结构化 Token 账本，供成本和延迟分析使用。
export function recordTokenUsage(db, usage) {
  ensureTokenLedger(db);
  db.prepare(`
    INSERT INTO token_ledger
      (task_id, worker_id, model, input_tokens, output_tokens, cache_hit, latency_ms, estimated_cost, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    usage.taskId,
    usage.workerId,
    usage.model,
    usage.inputTokens ?? 0,
    usage.outputTokens ?? 0,
    usage.cacheHit ? 1 : 0,
    usage.latencyMs ?? 0,
    usage.estimatedCost ?? null,
    new Date().toISOString()
  );
}
