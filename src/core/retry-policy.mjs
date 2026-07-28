// 中文注释：将瞬时失败限制在有限次数，并返回下一次重试等待时间。退避表可由配置覆盖（配合 B20）。

export const DEFAULT_RETRY = {
  maxAttempts: 3,
  backoffSeconds: [30, 120, 300]
};

// 中文注释：第二个参数兼容两种写法：数字（旧的 maxAttempts）或配置对象。
export function getRetryPlan(attempt, options = DEFAULT_RETRY.maxAttempts) {
  if (!Number.isInteger(attempt) || attempt < 0) throw new TypeError(`重试次数必须是非负整数：${attempt}`);
  const settings = typeof options === 'number' ? { maxAttempts: options } : (options ?? {});
  const maxAttempts = Number.isInteger(settings.maxAttempts) ? settings.maxAttempts : DEFAULT_RETRY.maxAttempts;
  const delays = Array.isArray(settings.backoffSeconds) && settings.backoffSeconds.length > 0
    ? settings.backoffSeconds
    : DEFAULT_RETRY.backoffSeconds;
  if (attempt >= maxAttempts) return null;
  return { nextAttempt: attempt + 1, delaySeconds: delays[attempt] ?? delays.at(-1) };
}
