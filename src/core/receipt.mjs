import { redactValue } from './redact.mjs';

// 中文注释：生成可发送给用户的最终任务回执。
// 中文注释：脱敏不再依赖调用方传的 sensitiveValues —— 那份列表只是补充，主防线是键名与值形态规则（修 B5/B5b）。
export function createReceipt({
  taskId,
  state,
  summary,
  evidence = {},
  sensitiveValues = [],
  tokenUsage = null,
  verification = null
}) {
  const receipt = {
    taskId,
    state,
    summary: redactValue(summary, sensitiveValues),
    evidence: redactValue(evidence, sensitiveValues),
    createdAt: new Date().toISOString()
  };
  if (tokenUsage) receipt.tokenUsage = redactValue(tokenUsage, sensitiveValues);
  if (verification) receipt.verification = redactValue(verification, sensitiveValues);
  return receipt;
}
