import { redactText } from '../core/redact.mjs';

function formatTerminalReceipt(task, receipt) {
  const stateLabel = {
    completed: '完成',
    partial: '部分完成',
    failed: '失败',
    cancelled: '已取消'
  }[receipt.state] ?? receipt.state;
  const evidence = receipt.evidenceRefs.length > 0 ? `\n证据：${receipt.evidenceRefs.join('、')}` : '';
  return redactText(`${task.publicId}｜${stateLabel}\n${receipt.summary}${evidence}`);
}

export function createTerminalReceiptPump({ store, sendText, logger = console } = {}) {
  if (!store || typeof sendText !== 'function') throw new Error('终态回执泵缺少 store 或 sendText');
  return {
    async flush() {
      for (const task of store.listTerminalTasksWithoutReceipt()) {
        const evidenceRefs = store.listExecutionEvidence(task.id).map((item) => `E-${item.id}`);
        store.createTerminalReceipt(task.id, {
          summary: task.summary ?? task.failureReason ?? task.reason ?? `任务以 ${task.state} 结束`,
          evidenceRefs
        });
      }
      let sent = 0;
      let failed = 0;
      for (const pending of store.listUnsentTerminalReceipts()) {
        if (!pending.replyChatId) continue;
        const claim = store.claimTerminalReceiptForSending(pending.taskId);
        if (!claim.claimed) continue;
        try {
          const task = store.requireTask(pending.taskId);
          await sendText(pending.replyChatId, formatTerminalReceipt(task, claim.receipt));
          store.markTerminalReceiptSent(pending.taskId);
          sent += 1;
        } catch (error) {
          failed += 1;
          store.releaseTerminalReceiptClaim(pending.taskId);
          logger.error?.({ event: 'terminal_receipt_send_failed', taskId: pending.taskId, message: error.message });
        }
      }
      return { sent, failed };
    }
  };
}
