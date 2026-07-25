// 中文注释：解析控制平面 CLI 参数，便于脚本和人工复用同一入口。
export function parseRuntimeCommand(args) {
  const [command, ...rest] = args;
  if (command === 'create') return { command, request: rest.join(' ').trim() };
  if (['pause', 'resume', 'cancel'].includes(command)) return { command, taskId: Number(rest[0]) };
  if (command === 'status') return { command };
  if (command === 'init') return { command, home: rest[0] };
  throw new Error(`未知控制命令：${command ?? '(空)'}`);
}
