// 中文注释：结构化脱敏。不再依赖调用方手写敏感值列表，而是按"键名 + 值形态"双重判定。

export const REDACTED = '[REDACTED]';

// 中文注释：键名命中即整值替换，避免密钥因为形态不常见而漏网。
const SECRET_KEY_PATTERN =
  /^(api[_-]?key|apikey|secret|app[_-]?secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|bearer|password|passwd|pwd|cookie|cookies|set[_-]?cookie|authorization|auth[_-]?header|code|otp|verification[_-]?code|credential|credentials|private[_-]?key|session[_-]?id)$/i;

// 中文注释：值形态规则。命中片段替换为 [REDACTED]，保留其余上下文便于排错。
const VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(?:[A-Za-z]:\\Users\\)[^\\/\r\n"']+/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi
];

// 中文注释：过滤调用方传入的敏感值，空串会让 replaceAll 逐字符插入替换串，必须剔除（修 B5）。
// 中文注释：导出以便测试与隐私审计脚本复用同一套过滤规则。
export function normalizeSecrets(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length < 3) continue;
    seen.add(trimmed);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

// 中文注释：对单个字符串做脱敏，先按显式敏感值再按通用形态。
export function redactText(text, secrets = []) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let result = text;
  for (const secret of normalizeSecrets(secrets)) result = result.replaceAll(secret, REDACTED);
  for (const pattern of VALUE_PATTERNS) result = result.replace(pattern, REDACTED);
  return result;
}

// 中文注释：递归脱敏任意结构，带循环引用保护。
export function redactValue(value, secrets = [], seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (SECRET_KEY_PATTERN.test(key)) return [key, item === null || item === undefined ? item : REDACTED];
      return [key, redactValue(item, secrets, seen)];
    })
  );
}

// 中文注释：检测文本里是否仍有未脱敏的敏感形态，供隐私审计和测试复用同一套规则。
export function findLeaks(text) {
  if (typeof text !== 'string') return [];
  const leaks = [];
  for (const pattern of VALUE_PATTERNS) {
    const matches = text.match(new RegExp(pattern.source, pattern.flags));
    if (matches) leaks.push(...matches);
  }
  return leaks;
}
