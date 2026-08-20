// 中文注释：解析控制平面 CLI 参数，便于脚本和人工复用同一入口。

export class RuntimeCommandError extends Error {
  constructor(message, code = 'invalid_command') {
    super(message);
    this.name = 'RuntimeCommandError';
    this.code = code;
  }
}

const TASK_COMMANDS = new Set(['pause', 'resume', 'cancel']);
const SCHEDULER_ACTIONS = new Set(['status', 'enable', 'disable']);
const OWNER_ACTIONS = new Set(['show', 'reset']);

export const USAGE = [
  'runtime init [--home <目录>]           初始化私有运行目录',
  'runtime create <任务描述> [--home ..]  创建任务',
  'runtime status [--home ..]             查看未结束任务',
  'runtime tree [--home ..]               查看完整任务树（含父子关系）',
  'runtime history [--limit N] [--home ..] 查看已结束任务（默认最近 20 条）',
  'runtime show <编号> [--home ..]        查看单个任务详情（含事件、证据、token 用量）',
  'runtime cost [--home ..]               查看 token 用量汇总',
  'runtime pause|resume|cancel <编号>     控制单个任务（cancel 父任务会级联取消子任务）',
  'runtime scheduler status|enable|disable  查看或切换调度器开关（默认休眠）',
  'runtime owner show|reset               查看或重置飞书归属账号',
  'runtime batch <文件路径>               从文件批量导入任务（每行一个）',
  'runtime morning <文件路径> [--enable] [--dry-run]  晨间工作流：AI 规划 + 批量创建 + 可选启动调度',
  'runtime daemon                         前台运行调度循环（需先 enable）',
  'runtime doctor                         打印运行环境自检信息'
].join('\n');

// 中文注释：抽出 --home 和其他 flags，其余位置参数原样保留，保证任务正文不被拆坏。
function extractHome(args) {
  const rest = [];
  let home = null;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--home') {
      home = args[index + 1] ?? null;
      if (!home || home.startsWith('--')) throw new RuntimeCommandError('--home 需要一个目录参数', 'missing_home_value');
      index += 1;
      continue;
    }
    if (typeof token === 'string' && token.startsWith('--home=')) {
      home = token.slice('--home='.length);
      if (!home) throw new RuntimeCommandError('--home 需要一个目录参数', 'missing_home_value');
      continue;
    }
    rest.push(token);
  }
  return { home, rest };
}

// 中文注释：任务编号必须是正整数。旧实现用 Number() 直接转，'abc' 会变成 NaN 一路传到数据库（修 B7）。
function parseTaskId(raw, command) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new RuntimeCommandError(`${command} 需要任务编号`, 'missing_task_id');
  }
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) throw new RuntimeCommandError(`任务编号必须是正整数：${text}`, 'invalid_task_id');
  const value = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeCommandError(`任务编号超出范围：${text}`, 'invalid_task_id');
  }
  return value;
}

// 中文注释：从 tail 中提取 --limit N 参数，默认 20。
function parseLimit(tail, defaultValue = 20) {
  const idx = tail.indexOf('--limit');
  if (idx !== -1 && tail[idx + 1]) {
    const n = Number.parseInt(tail[idx + 1], 10);
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return defaultValue;
}

export function parseRuntimeCommand(args) {
  const { home, rest } = extractHome(Array.isArray(args) ? args : []);
  const [command, ...tail] = rest;
  const withHome = (payload) => (home ? { ...payload, home } : payload);

  if (command === 'create') {
    const request = tail.join(' ').trim();
    if (!request) throw new RuntimeCommandError('create 需要任务描述', 'missing_request');
    return withHome({ command, request });
  }

  if (TASK_COMMANDS.has(command)) {
    return withHome({ command, taskId: parseTaskId(tail[0], command) });
  }

  if (command === 'status' || command === 'daemon' || command === 'doctor' || command === 'tree' || command === 'cost') {
    return withHome({ command });
  }

  // 中文注释：F4：history 命令，查看已结束任务，支持 --limit。
  if (command === 'history') {
    const limit = parseLimit(tail, 20);
    return withHome({ command, limit });
  }

  // 中文注释：F4：show 命令，查看单个任务详情。
  if (command === 'show') {
    return withHome({ command, taskId: parseTaskId(tail[0], command) });
  }

  if (command === 'init') {
    // 中文注释：兼容旧写法 `init <目录>`，同时支持 --home。
    const positional = tail.find((token) => typeof token === 'string' && !token.startsWith('--'));
    const target = home ?? positional ?? null;
    return target ? { command, home: target } : { command };
  }

  if (command === 'scheduler') {
    const action = tail[0] ?? 'status';
    if (!SCHEDULER_ACTIONS.has(action)) {
      throw new RuntimeCommandError(`scheduler 只接受 ${[...SCHEDULER_ACTIONS].join(' / ')}`, 'invalid_scheduler_action');
    }
    return withHome({ command, action });
  }

  if (command === 'owner') {
    const action = tail[0] ?? 'show';
    if (!OWNER_ACTIONS.has(action)) {
      throw new RuntimeCommandError(`owner 只接受 ${[...OWNER_ACTIONS].join(' / ')}`, 'invalid_owner_action');
    }
    return withHome({ command, action });
  }

  // 中文注释：批量导入任务。从文件读取，每行一个任务。
  if (command === 'batch') {
    const filePath = tail[0];
    if (!filePath) throw new RuntimeCommandError('batch 需要文件路径', 'missing_file');
    return withHome({ command, filePath });
  }

  // 中文注释：晨间工作流。读取任务文件 → AI 规划分解 → 批量创建父子任务 → 可选启动调度。
  // 中文注释：F6：--dry-run 只打规划结果不建任务。
  if (command === 'morning') {
    const filePath = tail[0];
    if (!filePath) throw new RuntimeCommandError('morning 需要文件路径', 'missing_file');
    const enableScheduler = tail.includes('--enable');
    const dryRun = tail.includes('--dry-run');
    return withHome({ command, filePath, enableScheduler, dryRun });
  }

  throw new RuntimeCommandError(`未知控制命令：${command ?? '(空)'}\n\n${USAGE}`, 'unknown_command');
}
