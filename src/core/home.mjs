import { join, resolve } from 'node:path';

// 中文注释：私有运行目录解析。init / create / status 全部走这一个函数，杜绝各命令各算一套（修 B13b）。
// 中文注释：没有配置就失败关闭，绝不回退到公开源码目录旁的 runtime/（修 B14）。

export const HOME_ENV = 'DAILY_TWIN_HOME';

export const HOME_HINT = [
  `未配置私有运行目录。请先设置 ${HOME_ENV}，或给命令加 --home <目录>。`,
  '当前会话临时设置（PowerShell）：',
  "  $env:DAILY_TWIN_HOME = 'D:\\DailyTwin\\home'",
  '永久设置（当前用户，PowerShell）：',
  "  [Environment]::SetEnvironmentVariable('DAILY_TWIN_HOME', 'D:\\DailyTwin\\home', 'User')",
  '首次初始化：',
  '  npm run runtime -- init --home D:\\DailyTwin\\home'
].join('\n');

export class HomeResolutionError extends Error {
  constructor(message = HOME_HINT) {
    super(message);
    this.name = 'HomeResolutionError';
    this.code = 'home_not_configured';
  }
}

// 中文注释：优先级 --home > 环境变量 > 失败。不猜、不回退。
export function resolveHome({ cliHome = null, env = process.env } = {}) {
  const candidate = [cliHome, env?.[HOME_ENV]].find((value) => typeof value === 'string' && value.trim().length > 0);
  if (!candidate) throw new HomeResolutionError();
  return resolve(candidate.trim());
}

// 中文注释：数据库路径由 home 与配置中的相对路径拼出，保证所有命令指向同一个库。
export function databasePath(home, relativePath = 'data/runtime.sqlite') {
  return join(home, relativePath.replaceAll('\\', '/'));
}

// 中文注释：私有目录分层，任务数据、截图、日志和缓存都不进公开仓。
export const HOME_DIRECTORIES = [
  'data/tasks',
  'data/receipts',
  'data/screenshots',
  'data/cache',
  'data/logs',
  'config',
  'backups'
];
