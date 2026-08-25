import { assertCapabilityRequest, verifyCapabilityTicket } from '../core/capability-ticket.mjs';

export const DAILY_TWIN_TOOL_NAMES = [
  'browser_open',
  'browser_fill',
  'browser_submit',
  'browser_wait',
  'browser_capture',
  'app_launch',
  'task_checkpoint',
  'task_checkpoint_read'
];

const ACTIONS = {
  browser_open: 'browser.open',
  browser_fill: 'browser.fill',
  browser_submit: 'browser.submit',
  browser_wait: 'browser.wait',
  browser_capture: 'browser.capture',
  app_launch: 'app.launch',
  task_checkpoint: 'task.checkpoint',
  task_checkpoint_read: 'task.checkpoint'
};

export function createTaskToolService({ store, capabilitySecret, boundCapability = null, browserExecutor, appExecutor } = {}) {
  if (!store || (!capabilitySecret && !boundCapability)) throw new Error('MCP 工具层需要 store 和能力票密钥或已绑定能力');

  return {
    names: DAILY_TWIN_TOOL_NAMES,
    bound: Boolean(boundCapability),
    async invoke(name, args = {}) {
      const action = ACTIONS[name];
      if (!action) throw Object.assign(new Error(`未知 Daily Twin 工具：${name}`), { code: 'unknown_tool' });
      const request = {
        workerId: boundCapability ? boundCapability.workerId : args.workerId,
        action,
        website: args.website,
        app: args.app,
        directory: args.directory
      };
      const capability = boundCapability
        ? assertCapabilityRequest(boundCapability, request)
        : verifyCapabilityTicket(args.ticket, {
            secret: capabilitySecret,
            store,
            consume: true,
            request
          });
      const task = store.getTaskByPublicId(capability.taskId);
      if (!task || task.multicaIssueId !== capability.multicaIssueId) {
        throw Object.assign(new Error('能力票绑定的本机任务不存在或 issue 不匹配'), { code: 'task_binding_mismatch' });
      }

      if (name === 'browser_open') return browserExecutor.open({ taskId: task.id, website: args.website });
      if (name === 'browser_fill') return browserExecutor.fill({ taskId: task.id, field: args.field, text: args.text });
      if (name === 'browser_submit') return browserExecutor.submit({ taskId: task.id, action: args.action });
      if (name === 'browser_wait') return browserExecutor.wait({ taskId: task.id, condition: args.condition, timeoutMs: args.timeoutMs });
      if (name === 'browser_capture') return browserExecutor.capture({ taskId: task.id });
      if (name === 'app_launch') return appExecutor.launch({ taskId: task.id, alias: args.app });
      if (name === 'task_checkpoint_read') {
        const saved = store.getWorkerCheckpoint(task.id, capability.workerId);
        return saved ? { checkpoint: saved.checkpoint, savedAt: saved.savedAt } : { checkpoint: null, savedAt: null };
      }
      store.saveWorkerCheckpoint(task.id, capability.workerId, args.checkpoint);
      return { saved: true, taskId: task.publicId };
    }
  };
}
