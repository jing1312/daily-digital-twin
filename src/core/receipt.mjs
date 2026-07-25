// 中文注释：递归掩盖用户给出的敏感文本，防止验证码进入回执。
function redact(value, sensitiveValues) {
  if (typeof value === 'string') return sensitiveValues.reduce((result, secret) => result.replaceAll(secret, '***'), value);
  if (Array.isArray(value)) return value.map((item) => redact(item, sensitiveValues));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, sensitiveValues)]));
  return value;
}

// 中文注释：生成可发送给用户的最终任务回执。
export function createReceipt({ taskId, state, summary, evidence = {}, sensitiveValues = [] }) {
  return { taskId, state, summary: redact(summary, sensitiveValues), evidence: redact(evidence, sensitiveValues), createdAt: new Date().toISOString() };
}
