// 中文注释：解析飞书文本为本机控制动作，避免验证码落盘。
export function resolveIncomingMessage(store, message) {
  const text = message.trim();
  const command = text.match(/^(状态|暂停|继续|取消)(?:\s+(\d+))?$/);
  if (command) return { kind: command[1] === '状态' ? 'status' : command[1], taskId: command[2] ? Number(command[2]) : null };
  const qualifiedCode = text.match(/^任务\s*(\d+)\s*[：:]\s*(\d{4,10})$/);
  if (qualifiedCode) return { kind: 'verification_code', taskId: Number(qualifiedCode[1]), code: qualifiedCode[2] };
  if (/^\d{4,10}$/.test(text)) {
    const waiters = store.listVerificationWaiters();
    if (waiters.length === 1) return { kind: 'verification_code', taskId: waiters[0].id, code: text };
    if (waiters.length > 1) return { kind: 'ambiguous', message: '多个任务在等待验证码，请使用“任务 <编号>：验证码”' };
  }
  return { kind: 'new_task', request: text };
}
