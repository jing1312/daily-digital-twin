import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_RESOURCE_LIMITS } from './resource-policy.mjs';
import { DEFAULT_RETRY } from './retry-policy.mjs';

// 中文注释：真实生效的配置加载器。原先 config/runtime.example.json 是装饰品，所有阈值都硬编码在代码里（修 B20）。

export const CONFIG_FILE = 'config/runtime.json';

export const DEFAULT_CONFIG = {
  database: 'data/runtime.sqlite',
  maxSlots: DEFAULT_RESOURCE_LIMITS.maxSlots,
  openTaskLimit: 4,
  busyTimeoutMs: 5000,
  resource: {
    cpuLimitPercent: DEFAULT_RESOURCE_LIMITS.cpuLimitPercent,
    minAvailableMemoryGb: DEFAULT_RESOURCE_LIMITS.minAvailableMemoryGb,
    oneSlotMemoryGb: DEFAULT_RESOURCE_LIMITS.oneSlotMemoryGb,
    twoSlotMemoryGb: DEFAULT_RESOURCE_LIMITS.twoSlotMemoryGb,
    fourSlotMemoryGb: DEFAULT_RESOURCE_LIMITS.fourSlotMemoryGb,
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
    maxParallelWorkers: 4,
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
    managedLoggedInHosts: [],
    // 中文注释：Multica 控制面使用的浏览器通道配置（PR #2）。
    defaultBrowser: 'msedge',
    extension: true,
    playwrightCommand: 'playwright-mcp'
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
    requireEvidence: true,
    workerMaxMinutes: 90
  },
  // 中文注释：AI 规划器配置。用于 morning 命令的任务分解。
  // 中文注释：apiEndpoint 和 apiKey 不写真实值，从私有目录的 config/runtime.json 读取。
  planner: {
    apiEndpoint: null,
    apiKey: null,
    model: 'gpt-4o-mini',
    directPassthroughThreshold: 0,
    timeoutMs: 30000
  },
  // 中文注释：AI 执行器配置。用于 ai_call 类型任务的实际执行。
  executor: {
    apiEndpoint: null,
    apiKey: null,
    model: 'gpt-4o-mini',
    outputDir: 'data/outputs',
    timeoutMs: 60000
  },
  integrations: {
    appCatalog: 'config/apps.json',
    pricing: 'config/pricing.json',
    capabilitySecretFile: 'config/capability-hmac.secret',
    feishu: {
      appId: null,
      appSecretFile: 'config/feishu-app-secret.secret',
      allowedOpenIds: [],
      // 中文注释：首次配对开关。默认 false = 失败关闭：名单为空且还没绑定归属账号时一律拒绝。
      //           只在第一次配对那几分钟临时设为 true，绑定完成后立刻改回 false。
      allowFirstPairing: false
    },
    multica: {
      enabled: true,
      command: 'multica',
      plannerAgent: 'dt-planner',
      workerAgents: ['dt-worker-1', 'dt-worker-2', 'dt-worker-3', 'dt-worker-4'],
      allowedDirectories: []
    }
  },
  windows: {
    pwshPath: null
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

function checkIntegerInRange(problems, path, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${path} 必须是 ${min}~${max} 之间的整数，实际为 ${JSON.stringify(value)}`);
  }
}

function checkNumberInRange(problems, path, value, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    problems.push(`${path} 必须是 ${min}~${max} 之间的数值，实际为 ${JSON.stringify(value)}`);
  }
}

function checkBoolean(problems, path, value) {
  if (typeof value !== 'boolean') problems.push(`${path} 必须是布尔值，实际为 ${JSON.stringify(value)}`);
}

function checkPrivateRelativePath(problems, path, value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const portable = text.replaceAll('\\', '/');
  const segments = portable.split('/');
  if (!text || portable.startsWith('/') || /^[A-Za-z]:\//.test(portable) || portable.startsWith('//') || segments.includes('..')) {
    problems.push(`${path} 必须是 DAILY_TWIN_HOME 内的相对路径，实际为 ${JSON.stringify(value)}`);
  }
}

// 中文注释：校验后再交给策略模块，避免把 "4" 这类字符串当成数字用。
export function validateConfig(config) {
  const problems = [];
  checkIntegerInRange(problems, 'maxSlots', config.maxSlots, 1, 4);
  checkIntegerInRange(problems, 'openTaskLimit', config.openTaskLimit, 1, 4);
  checkPositiveInteger(problems, 'busyTimeoutMs', config.busyTimeoutMs);
  checkPrivateRelativePath(problems, 'database', config.database);

  checkNumberInRange(problems, 'resource.cpuLimitPercent', config.resource?.cpuLimitPercent, 1, 100);
  checkNumberInRange(problems, 'resource.minAvailableMemoryGb', config.resource?.minAvailableMemoryGb, 0, 1024);
  checkNumberInRange(problems, 'resource.oneSlotMemoryGb', config.resource?.oneSlotMemoryGb, 0, 1024);
  checkNumberInRange(problems, 'resource.twoSlotMemoryGb', config.resource?.twoSlotMemoryGb, 0, 1024);
  checkNumberInRange(problems, 'resource.fourSlotMemoryGb', config.resource?.fourSlotMemoryGb, 0, 1024);
  checkNumberInRange(problems, 'resource.minDiskFreeGb', config.resource?.minDiskFreeGb, 0, 10240);
  checkIntegerInRange(problems, 'resource.batterySlotLimit', config.resource?.batterySlotLimit, 1, 1);

  checkPositiveInteger(problems, 'retries.maxAttempts', config.retries?.maxAttempts);
  const backoff = config.retries?.backoffSeconds;
  if (!Array.isArray(backoff) || backoff.length === 0 || backoff.some((value) => !Number.isFinite(value) || value < 0)) {
    problems.push('retries.backoffSeconds 必须是非负数值数组');
  }

  checkPositiveInteger(problems, 'verification.ttlSeconds', config.verification?.ttlSeconds);
  checkBoolean(problems, 'scheduler.enabled', config.scheduler?.enabled);
  checkPositiveInteger(problems, 'scheduler.pollSeconds', config.scheduler?.pollSeconds);
  checkIntegerInRange(problems, 'scheduler.maxParallelWorkers', config.scheduler?.maxParallelWorkers, 1, 4);
  checkIntegerInRange(problems, 'scheduler.maxForegroundTasks', config.scheduler?.maxForegroundTasks, 1, 1);
  checkBoolean(problems, 'execution.requireEvidence', config.execution?.requireEvidence);
  checkPositiveInteger(problems, 'execution.workerMaxMinutes', config.execution?.workerMaxMinutes);

  if (config.browser?.defaultBrowser !== 'msedge') problems.push('browser.defaultBrowser 必须固定为 msedge');
  checkBoolean(problems, 'browser.extension', config.browser?.extension);
  if (typeof config.browser?.playwrightCommand !== 'string' || !config.browser.playwrightCommand.trim()) {
    problems.push('browser.playwrightCommand 必须是命令名称或已核验路径');
  }

  checkPrivateRelativePath(problems, 'integrations.appCatalog', config.integrations?.appCatalog);
  checkPrivateRelativePath(problems, 'integrations.pricing', config.integrations?.pricing);
  checkPrivateRelativePath(problems, 'integrations.capabilitySecretFile', config.integrations?.capabilitySecretFile);
  checkPrivateRelativePath(problems, 'integrations.feishu.appSecretFile', config.integrations?.feishu?.appSecretFile);
  const feishu = config.integrations?.feishu;
  if (!Array.isArray(feishu?.allowedOpenIds) || feishu.allowedOpenIds.some((value) => typeof value !== 'string' || !value.trim())) {
    problems.push('integrations.feishu.allowedOpenIds 必须是非空字符串组成的数组（可以为空数组）');
  }
  checkBoolean(problems, 'integrations.feishu.allowFirstPairing', feishu?.allowFirstPairing);

  const multica = config.integrations?.multica;
  checkBoolean(problems, 'integrations.multica.enabled', multica?.enabled);
  for (const field of ['command', 'plannerAgent']) {
    if (typeof multica?.[field] !== 'string' || !multica[field].trim()) {
      problems.push(`integrations.multica.${field} 必须是非空字符串`);
    }
  }
  const workerAgents = multica?.workerAgents;
  if (!Array.isArray(workerAgents) || workerAgents.length < 1 || workerAgents.length > 4 ||
      workerAgents.some((item) => typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item)) ||
      new Set(workerAgents).size !== workerAgents.length) {
    problems.push('integrations.multica.workerAgents 必须包含 1~4 个唯一的安全名称');
  }
  if (!Array.isArray(multica?.allowedDirectories) || multica.allowedDirectories.some((item) => typeof item !== 'string' || !item.trim())) {
    problems.push('integrations.multica.allowedDirectories 必须是非空字符串组成的数组');
  }

  const memory = config.resource ?? {};
  if (!(memory.minAvailableMemoryGb <= memory.oneSlotMemoryGb && memory.oneSlotMemoryGb <= memory.twoSlotMemoryGb && memory.twoSlotMemoryGb <= memory.fourSlotMemoryGb)) {
    problems.push('资源内存档位必须满足 min <= oneSlot <= twoSlot <= fourSlot');
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

  // 中文注释：校验 planner 配置。
  if (config.planner) {
    if (typeof config.planner.apiEndpoint !== 'string' && config.planner.apiEndpoint !== null) {
      problems.push('planner.apiEndpoint 必须是字符串或 null');
    }
    if (typeof config.planner.apiKey !== 'string' && config.planner.apiKey !== null) {
      problems.push('planner.apiKey 必须是字符串或 null');
    }
    if (typeof config.planner.model !== 'string' || config.planner.model.trim().length === 0) {
      problems.push('planner.model 必须是非空字符串');
    }
  }

  // 中文注释：校验 executor 配置。
  if (config.executor) {
    if (typeof config.executor.apiEndpoint !== 'string' && config.executor.apiEndpoint !== null) {
      problems.push('executor.apiEndpoint 必须是字符串或 null');
    }
    if (typeof config.executor.apiKey !== 'string' && config.executor.apiKey !== null) {
      problems.push('executor.apiKey 必须是字符串或 null');
    }
    if (typeof config.executor.model !== 'string' || config.executor.model.trim().length === 0) {
      problems.push('executor.model 必须是非空字符串');
    }
  }

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
