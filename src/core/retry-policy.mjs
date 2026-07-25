// 中文注释：将瞬时失败限制在三次，并返回下一次重试等待时间。
export function getRetryPlan(attempt, maxAttempts = 3) {
  const delays = [30, 120, 300];
  if (attempt >= maxAttempts) return null;
  return { nextAttempt: attempt + 1, delaySeconds: delays[attempt] ?? delays.at(-1) };
}
