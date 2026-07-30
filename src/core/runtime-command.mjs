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
  'runtime pause|resume|cancel <编号>     控制单个任务',
  'runtime scheduler status|enable|disable  查看或切换调度器开关（默认休眠）',
  'runtime owner show|reset               查看或重置飞书归属账号',
  'runtime daemon                         前台运行调度循环（需先 enable）',
  'runtime serve                          启动飞书 + Multica + 本机控制平面',
  'runtime mcp --binding-slot <worker>    启动绑定到 Multica worker 的高层 MCP（stdio）',
  'runtime doctor                         打印运行环境自检信息'
].join('\n');

// 中文注释：抽出 --home，其余位置参数原样保留，保证任务正文不被拆坏。
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

function extractValue(args, name) {
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === name) {
      const next = args[index + 1];
      if (!next || String(next).startsWith('--')) {
        throw new RuntimeCommandError(`${name} 需要一个路径参数`, `missing_${name.slice(2).replaceAll('-', '_')}_value`);
      }
      return String(next);
    }
    if (String(value).startsWith(prefix)) {
      const next = String(value).slice(prefix.length);
      if (!next) throw new RuntimeCommandError(`${name} 需要一个路径参数`, `missing_${name.slice(2).replaceAll('-', '_')}_value`);
      return next;
    }
  }
  return null;
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

  if (command === 'mcp') {
    const binding = extractValue(tail, '--binding');
    const bindingSlot = extractValue(tail, '--binding-slot');
    if (binding && bindingSlot) {
      throw new RuntimeCommandError('--binding 与 --binding-slot 不能同时使用', 'conflicting_binding_source');
    }
    if (bindingSlot && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(bindingSlot)) {
      throw new RuntimeCommandError('binding slot 名称非法', 'invalid_binding_slot');
    }
    return withHome(binding ? { command, binding } : (bindingSlot ? { command, bindingSlot } : { command }));
  }

  if (command === 'status' || command === 'daemon' || command === 'serve' || command === 'doctor') {
    return withHome({ command });
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

  throw new RuntimeCommandError(`未知控制命令：${command ?? '(空)'}\n\n${USAGE}`, 'unknown_command');
}
