import { resolveIncomingMessage } from './message-router.mjs';

// 中文注释：把单用户飞书私聊转换为控制平面动作，不处理群聊。
// 中文注释：必须携带发送者身份；首个发送者成为归属账号，其余账号一律拒绝（修 B17）。

// 中文注释：校验发送者。第一次配对写入 settings，后续比对；不接受匿名调用。
export function authorizeSender(store, sender) {
  const openId = typeof sender === 'string' ? sender.trim() : String(sender?.openId ?? '').trim();
  if (!openId) {
    return { ok: false, code: 'sender_required', message: '缺少发送者身份，已拒绝执行。' };
  }
  const owner = store.claimOwner(openId);
  if (owner.ownerOpenId !== openId) {
    return { ok: false, code: 'not_owner', message: '此替身只接受首次配对的账号指令，已拒绝执行。' };
  }
  return { ok: true, code: null, openId, pairedNow: owner.claimed };
}

// 中文注释：验证码只放在不可枚举属性上，JSON.stringify 拿不到，日志和回执自然不会带上它。
function withHiddenCode(result, code) {
  if (code === undefined || code === null) return result;
  Object.defineProperty(result, 'code', { value: String(code), enumerable: false, configurable: true });
  return result;
}

// 中文注释：未指定任务编号时给出候选，不再让 taskId=null 直接穿到数据库（修 B4）。
function resolveTarget(store, kind, taskId) {
  if (taskId !== null && taskId !== undefined) {
    const task = store.getTask(taskId);
    if (!task) return { ok: false, code: 'not_found', message: `任务 ${taskId} 不存在`, taskId };
    return { ok: true, task };
  }
  const candidates = kind === '继续' ? store.listPausedTasks() : store.listActiveTasks();
  const eligible = kind === '暂停' ? candidates.filter((task) => !task.paused) : candidates;
  if (eligible.length === 0) {
    return { ok: false, code: 'no_candidates', message: `当前没有可${kind}的任务。` };
  }
  if (eligible.length > 1) {
    return {
      ok: false,
      code: 'need_task_id',
      message: `有 ${eligible.length} 个任务可${kind}，请使用“${kind} <编号>”。`,
      candidates: eligible.map((task) => ({ id: task.id, state: task.state, paused: task.paused, request: task.request }))
    };
  }
  return { ok: true, task: eligible[0] };
}

export function handleFeishuText(store, text, sender) {
  const identity = authorizeSender(store, sender);
  if (!identity.ok) return { action: 'rejected', reason: identity.code, message: identity.message };

  const routed = resolveIncomingMessage(store, text);

  if (routed.kind === 'new_task') {
    const task = store.createTask({ request: routed.request, ownerOpenId: identity.openId });
    return { action: 'created', task, pairedNow: identity.pairedNow };
  }

  if (routed.kind === 'status') {
    return { action: 'status', tasks: store.listActiveTasks() };
  }

  if (routed.kind === '暂停' || routed.kind === '继续' || routed.kind === '取消') {
    const target = resolveTarget(store, routed.kind, routed.taskId);
    if (!target.ok) {
      return { action: 'needs_clarification', reason: target.code, message: target.message, candidates: target.candidates ?? [] };
    }
    if (routed.kind === '暂停') return { action: 'paused', task: store.pause(target.task.id) };
    if (routed.kind === '继续') {
      const result = store.resume(target.task.id);
      if (!result.ok) return { action: 'resume_refused', reason: result.code, message: result.message, task: result.task };
      return { action: 'resumed', task: result.task };
    }
    return {
      action: 'cancelled',
      task: store.transition(target.task.id, 'cancelled', { reason: '用户取消' })
    };
  }

  if (routed.kind === 'verification_code') {
    const task = store.getTask(routed.taskId);
    if (!task) return { action: 'needs_clarification', reason: 'not_found', message: `任务 ${routed.taskId} 不存在` };
    if (task.paused) {
      // 中文注释：暂停期间收到验证码不建新任务，也不丢弃，提示先继续任务（修 B1 的连带问题）。
      return withHiddenCode(
        { action: 'verification_deferred', taskId: task.id, message: `任务 ${task.id} 已暂停，请先发送“继续 ${task.id}”。` },
        routed.code
      );
    }
    return withHiddenCode({ action: 'verification_code', taskId: task.id }, routed.code);
  }

  if (routed.kind === 'ambiguous' || routed.kind === 'ambiguous_digits' || routed.kind === 'empty') {
    return { action: 'needs_clarification', reason: routed.kind, message: routed.message };
  }

  return { action: 'unhandled', reason: routed.kind };
}
