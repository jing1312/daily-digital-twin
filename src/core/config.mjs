import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_RESOURCE_LIMITS } from './resource-policy.mjs';
import { DEFAULT_RETRY } from './retry-policy.mjs';

// 中文注释：真实生效的配置加载器。原先 config/runtime.example.json 是装饰品，所有阈值都硬编码在代码里（修 B20）。

export const CONFIG_FILE = 'config/runtime.json';

export const DEFAULT_CONFIG = {
  database: 'data/runtime.sqlite',
  maxSlots: DEFAULT_RESOURCE_LIMITS.maxSlots,
  openTaskLimit: 16,
  busyTimeoutMs: 5000,
  resource: {
    cpuLimitPercent: DEFAULT_RESOURCE_LIMITS.cpuLimitPercent,
    minAvailableMemoryGb: DEFAULT_RESOURCE_LIMITS.minAvailableMemoryGb,
    minDiskFreeGb: DEFAULT_RESOURCE_LIMITS.minDiskFreeGb,
    batterySlotLimit: DEFAULT_RESOURCE_LIMITS.batterySlotLimit,
    maxSlots: DEFAULT_RESOURCE_LIMITS.maxSlots
  },
  retries: {
    maxAttempts: DEFAULT_RETRY.maxAttempts,
    backoffSeconds: [...DEFAULT_RETRY.backoffSeconds]
  },
  verification: {
    ttlSeconds: 600
  },
  scheduler: {
    // 中文注释：默认休眠，必须由用户显式启用（按约定的调度开关策略）。
    enabled: false,
    pollSeconds: 5,
    maxParallelWorkers: 2,
    maxForegroundTasks: 1
  },
  browser: {
    // 中文注释：默认使用受管浏览器，不碰用户日常浏览器的登录态。详见 docs/BROWSER-PROFILES.md。
    defaultProfile: 'openclaw',
    signedInProfile: null,
    snapshotMode: 'efficient',
    edgeUserDataDir: null,
    // 中文注释：路线 C 的代价是"每个站点要在受管浏览器里单独登录一次"，而这件事没有任何自动记录。
    // 中文注释：把已登录过的域名登记在这里，路由时就能提前警告"这个站点还没登录过"，
    // 中文注释：而不是等任务撞上登录墙、再被当成执行失败去排查。
    // 中文注释：写法：'example.com' 精确匹配；'.example.com' 同时匹配其子域名。
    managedLoggedInHosts: []
  },
  storage: {
    maxCacheMb: 2048,
    maxScreenshotsMb: 2048,
    maxLogsMb: 512,
    keepFreeDiskGb: 20,
    logRotateMb: 32,
    logKeepFiles: 7
  },
  execution: {
    requireEvidence: true
  }
};

export class ConfigError extends Error {
  constructor(problems) {
    super(`配置无效：\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.code = 'invalid_config';
    this.problems = problems;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 中文注释：只深合并普通对象，数组整体替换，避免用户配置与默认值交错产生半截数组。
export function mergeConfig(base, override) {
  if (!isPlainObject(override)) return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? mergeConfig(result[key], value) : structuredClone(value);
  }
  return result;
}

function checkPositiveInteger(problems, path, value) {
  if (!Number.isInteger(value) || value <= 0) problems.push(`${path} 必须是正整数，实际为 ${JSON.stringify(value)}`);
}

function checkNumberInRange(problems, path, value, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    problems.push(`${path} 必须是 ${min}~${max} 之间的数值，实际为 ${JSON.stringify(value)}`);
  }
}

function checkBoolean(problems, path, value) {
  if (typeof value !== 'boolean') problems.push(`${path} 必须是布尔值，实际为 ${JSON.stringify(value)}`);
}

// 中文注释：校验后再交给策略模块，避免把 "4" 这类字符串当成数字用。
export function validateConfig(config) {
  const problems = [];
  checkPositiveInteger(problems, 'maxSlots', config.maxSlots);
  checkPositiveInteger(problems, 'openTaskLimit', config.openTaskLimit);
  checkPositiveInteger(problems, 'busyTimeoutMs', config.busyTimeoutMs);
  if (typeof config.database !== 'string' || config.database.trim().length === 0) {
    problems.push('database 必须是相对于私有目录的路径字符串');
  }

  checkNumberInRange(problems, 'resource.cpuLimitPercent', config.resource?.cpuLimitPercent, 1, 100);
  checkNumberInRange(problems, 'resource.minAvailableMemoryGb', config.resource?.minAvailableMemoryGb, 0, 1024);
  checkNumberInRange(problems, 'resource.minDiskFreeGb', config.resource?.minDiskFreeGb, 0, 10240);
  checkPositiveInteger(problems, 'resource.batterySlotLimit', config.resource?.batterySlotLimit);

  checkPositiveInteger(problems, 'retries.maxAttempts', config.retries?.maxAttempts);
  const backoff = config.retries?.backoffSeconds;
  if (!Array.isArray(backoff) || backoff.length === 0 || backoff.some((value) => !Number.isFinite(value) || value < 0)) {
    problems.push('retries.backoffSeconds 必须是非负数值数组');
  }

  checkPositiveInteger(problems, 'verification.ttlSeconds', config.verification?.ttlSeconds);
  checkBoolean(problems, 'scheduler.enabled', config.scheduler?.enabled);
  checkPositiveInteger(problems, 'scheduler.pollSeconds', config.scheduler?.pollSeconds);
  checkPositiveInteger(problems, 'scheduler.maxParallelWorkers', config.scheduler?.maxParallelWorkers);
  checkBoolean(problems, 'execution.requireEvidence', config.execution?.requireEvidence);

  if (typeof config.browser?.defaultProfile !== 'string' || config.browser.defaultProfile.trim().length === 0) {
    problems.push('browser.defaultProfile 必须是 profile 名称字符串');
  }

  // 中文注释：snapshotMode 会被原样传给 Invoke-DailyTwinBrowser.ps1 的 ValidateSet，
  // 中文注释：在这里拦下拼写错误，好过等到 PowerShell 侧抛一个看不懂的参数校验错误。
  // 中文注释：三个值分别对应 --efficient / --format ai / --format aria，映射见那个脚本里的实测说明。
  if (!['efficient', 'full', 'aria'].includes(config.browser?.snapshotMode)) {
    problems.push("browser.snapshotMode 只能是 'efficient'、'full' 或 'aria'");
  }

  if (!Array.isArray(config.browser?.managedLoggedInHosts)) {
    problems.push('browser.managedLoggedInHosts 必须是域名数组');
  } else if (config.browser.managedLoggedInHosts.some((host) => typeof host !== 'string' || host.trim().length === 0)) {
    problems.push('browser.managedLoggedInHosts 的每一项都必须是非空域名字符串');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  // 中文注释：maxSlots 是对外唯一入口，同步进 resource 供资源策略使用，避免两处不一致。
  config.resource.maxSlots = config.maxSlots;
  return config;
}

// 中文注释：从私有目录读取配置；文件不存在就用默认值，存在但格式错误必须报错而不是静默忽略。
export async function loadConfig(home, { fileName = CONFIG_FILE } = {}) {
  const path = join(home, fileName.replaceAll('\\', '/'));
  let raw = null;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { config: validateConfig(mergeConfig(DEFAULT_CONFIG, {})), source: null, path };
    }
    throw error;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError([`${fileName} 不是合法 JSON：${error.message}`]);
  }
  return { config: validateConfig(mergeConfig(DEFAULT_CONFIG, parsed)), source: fileName, path };
}

// 中文注释：把配置拆成 TaskStore 需要的部分，集中一处避免字段名漂移。
export function storeOptionsFromConfig(config) {
  return {
    maxSlots: config.maxSlots,
    openTaskLimit: config.openTaskLimit,
    busyTimeoutMs: config.busyTimeoutMs,
    verificationTtlSeconds: config.verification.ttlSeconds
  };
}
