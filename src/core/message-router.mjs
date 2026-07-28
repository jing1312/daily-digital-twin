// 中文注释：解析飞书文本为本机控制动作，避免验证码落盘或被误当成新任务。

const COMMAND_PATTERN = /^(状态|暂停|继续|取消)(?:\s*(\d+))?$/;
const QUALIFIED_CODE_PATTERN = /^任务\s*(\d+)\s*[：:]\s*(\d{4,10})$/;
const BARE_CODE_PATTERN = /^\d{4,10}$/;

export function resolveIncomingMessage(store, message) {
  const text = String(message ?? '').trim();
  if (!text) return { kind: 'empty', message: '消息为空，未执行任何动作。' };

  const command = text.match(COMMAND_PATTERN);
  if (command) {
    return {
      kind: command[1] === '状态' ? 'status' : command[1],
      taskId: command[2] ? Number(command[2]) : null
    };
  }

  const qualifiedCode = text.match(QUALIFIED_CODE_PATTERN);
  if (qualifiedCode) return { kind: 'verification_code', taskId: Number(qualifiedCode[1]), code: qualifiedCode[2] };

  if (BARE_CODE_PATTERN.test(text)) {
    const waiters = store.listVerificationWaiters();
    if (waiters.length === 1) return { kind: 'verification_code', taskId: waiters[0].id, code: text };
    if (waiters.length > 1) {
      return { kind: 'ambiguous', message: '多个任务在等待验证码，请使用“任务 <编号>：验证码”' };
    }
    // 中文注释：没有任何有效等待窗口时，纯数字绝不静默变成新任务（修 B3）。
    return {
      kind: 'ambiguous_digits',
      message: '当前没有任务在等待验证码。若这是验证码请先让任务进入等待状态；若确实要新建任务，请补充文字说明。'
    };
  }

  return { kind: 'new_task', request: text };
}
