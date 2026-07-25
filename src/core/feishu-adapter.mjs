import { resolveIncomingMessage } from './message-router.mjs';

// 中文注释：把单用户飞书私聊转换为控制平面动作，不处理群聊。
export function handleFeishuText(store, text) {
  const action = resolveIncomingMessage(store, text);
  if (action.kind === 'new_task') {
    const task = store.createTask({ request: action.request });
    return { action: 'created', task };
  }
  if (action.kind === 'status') return { action: 'status', tasks: store.listActiveTasks() };
  if (action.kind === '暂停') return { action: 'paused', task: store.pause(action.taskId) };
  if (action.kind === '继续') return { action: 'resumed', task: store.resume(action.taskId) };
  if (action.kind === '取消') return { action: 'cancelled', task: store.transition(action.taskId, 'cancelled', { reason: '用户取消' }) };
  if (action.kind === 'verification_code') return { action: 'verification_code', taskId: action.taskId, code: action.code };
  return action;
}
