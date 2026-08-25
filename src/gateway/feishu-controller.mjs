import { handleFeishuText } from '../core/feishu-adapter.mjs';
import { classifyTaskMode } from '../execution/deterministic-executor.mjs';

function taskLabel(task) {
  return task?.publicId ?? (task?.id ? `任务 ${task.id}` : '任务');
}

function formatReply(result) {
  if (result.action === 'created') return `已收到，任务号 ${taskLabel(result.task)}。完成或失败后我会发一条最终回执。`;
  if (result.action === 'status') {
    if (!result.tasks.length) return '当前没有未结束任务。';
    return result.tasks.map((task) => `${taskLabel(task)}｜${task.state}${task.paused ? '｜已暂停' : ''}`).join('\n');
  }
  if (result.action === 'paused') {
    return result.remote?.ok === false
      ? `${taskLabel(result.task)} 已在本机暂停，但 Multica 远端暂停未完全确认。`
      : `${taskLabel(result.task)} 已暂停。`;
  }
  if (result.action === 'resumed') {
    return result.remote?.ok === false
      ? `${taskLabel(result.task)} 继续失败，Multica 远端未确认，任务保持暂停。`
      : `${taskLabel(result.task)} 已继续。`;
  }
  if (result.action === 'cancelled') {
    return result.remote?.ok === false
      ? `${taskLabel(result.task)} 已在本机取消，但 Multica 远端取消未完全确认，请检查状态。`
      : `${taskLabel(result.task)} 已取消。`;
  }
  if (result.action === 'evidence') return `证据编号：${result.receipt.evidenceRefs.join('、') || '无可发送证据'}`;
  if (result.action === 'verification_code') return '验证码已交给正在等待的本机任务。';
  if (result.action === 'verification_failed') return `验证码未能填入任务页面（${result.reason}），请检查任务标签后重试。`;
  return result.message ?? '指令未执行。';
}

export function createFeishuController({
  store,
  sendText,
  dispatchTask = null,
  verificationBroker = null,
  sendEvidence = null,
  taskLifecycle = null,
  classifyMode = classifyTaskMode,
  logger = console
} = {}) {
  if (!store) throw new Error('飞书控制器需要 store');
  if (typeof sendText !== 'function') throw new Error('飞书控制器需要 sendText');

  return {
    async handle({ text, sender }) {
      const result = handleFeishuText(store, text, sender);
      const mode = result.action === 'created' ? classifyMode(result.task.request) : null;
      if (mode) result.task = store.setTaskKind(result.task.id, mode);

      if (result.action === 'verification_code') {
        let delivered = false;
        try {
          delivered = await store.deliverVerificationCode(result.taskId, result.code, (code) => (
            verificationBroker?.deliver(result.taskId, code) ?? false
          ));
        } catch (error) {
          const failed = {
            action: 'verification_failed',
            reason: error?.code ?? 'verification_delivery_failed',
            taskId: result.taskId
          };
          logger.error?.({ event: 'verification_delivery_failed', taskId: result.taskId, code: failed.reason });
          await sendText(formatReply(failed));
          return { result: failed, background: null };
        }
        const safeResult = delivered === false
          ? { action: 'needs_clarification', reason: 'executor_not_waiting', message: '任务记录在等待验证码，但本机执行器已断开，请先继续任务。' }
          : result;
        await sendText(formatReply(safeResult));
        return { result: safeResult, background: null };
      }

      if (result.action === 'cancelled' || (result.action === 'resumed' && result.task.state !== 'waiting_for_user')) {
        verificationBroker?.cancel(result.task.id);
      }

      const lifecycleMethod = {
        paused: 'pauseTask',
        resumed: 'resumeTask',
        cancelled: 'cancelTask'
      }[result.action];
      if (lifecycleMethod && result.task?.taskKind === 'complex' && result.task.multicaIssueId && typeof taskLifecycle?.[lifecycleMethod] === 'function') {
        try {
          result.remote = await taskLifecycle[lifecycleMethod](result.task.id);
        } catch (error) {
          result.remote = { ok: false, failures: [{ message: error.message }] };
          logger.error?.({ event: `multica_${lifecycleMethod}_failed`, taskId: result.task.publicId, message: error.message });
        }
        if (result.action === 'resumed' && result.remote?.ok === false) {
          result.task = store.pause(result.task.id);
        }
      }

      await sendText(formatReply(result));
      if (result.action === 'evidence' && typeof sendEvidence === 'function') {
        for (const reference of result.receipt.evidenceRefs) {
          const match = String(reference).match(/^E-(\d+)$/);
          const evidence = match ? store.getExecutionEvidence(Number(match[1])) : null;
          if (!evidence) continue;
          try {
            await sendEvidence(evidence);
          } catch (error) {
            logger.error?.({ event: 'evidence_send_failed', evidenceId: evidence.id, message: error.message });
            await sendText(`证据 E-${evidence.id} 发送失败：${error.code ?? 'send_failed'}`);
          }
        }
      }
      let background = null;
      if (result.action === 'created' && typeof dispatchTask === 'function') {
        background = Promise.resolve().then(async () => {
          try {
            const dispatched = await dispatchTask(result.task, { mode });
            if (dispatched?.issueId) store.bindMulticaIssue(result.task.id, dispatched.issueId);
            return dispatched;
          } catch (error) {
            const reason = `Multica 派发失败：${error.message}`;
            if (mode === 'complex') {
              store.recordFailureReason(result.task.id, reason);
              store.transition(result.task.id, 'failed', { reason });
            }
            logger.error?.({ event: 'multica_dispatch_failed', taskId: result.task.publicId, message: error.message });
            return { error: error.message, localExecutionContinues: mode === 'deterministic' };
          }
        });
      }
      return { result, background };
    }
  };
}
