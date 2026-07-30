import { resolveWebsite } from '../core/app-catalog.mjs';

export class BrowserExecutionError extends Error {
  constructor(message, code, { waitingForUser = false } = {}) {
    super(message);
    this.name = 'BrowserExecutionError';
    this.code = code;
    this.waitingForUser = waitingForUser;
  }
}

export class TaskBrowserExecutor {
  constructor({ store, catalog, driver } = {}) {
    if (!store || !catalog || !driver) throw new Error('浏览器执行器需要 store、catalog 和 driver');
    this.store = store;
    this.catalog = catalog;
    this.driver = driver;
    this.targets = new Map();
  }

  async open({ taskId, website }) {
    const task = this.store.requireTask(taskId);
    const entry = resolveWebsite(this.catalog, website);
    if (String(entry.browser ?? 'edge').toLowerCase() !== 'edge') {
      throw new BrowserExecutionError(`站点 ${entry.id} 未登记为 Edge`, 'edge_required', { waitingForUser: true });
    }
    const persisted = this.store.getBrowserSession(task.id);
    if (persisted) {
      if (persisted.websiteId !== entry.id) {
        throw new BrowserExecutionError('任务已绑定到另一个站点标签页', 'task_tab_website_mismatch', { waitingForUser: true });
      }
      const context = await this.requireOwned(task.id);
      return { targetId: context.targetId, website: entry.id, url: entry.url, reused: true };
    }
    try {
      const opened = await this.driver.open({
        browser: 'msedge',
        extension: true,
        url: entry.url,
        taskId: task.publicId
      });
      if (!opened?.targetId) throw new Error('没有返回 targetId');
      const marker = `DT:${task.publicId}`;
      this.targets.set(task.id, { targetId: opened.targetId, websiteId: entry.id, entry, marker });
      this.store.saveBrowserSession(task.id, { websiteId: entry.id, targetId: opened.targetId, marker });
      return { targetId: opened.targetId, website: entry.id, url: opened.url ?? entry.url };
    } catch (error) {
      if (error instanceof BrowserExecutionError) throw error;
      throw new BrowserExecutionError(`Edge 扩展未连接：${error.message}`, 'edge_disconnected', { waitingForUser: true });
    }
  }

  async requireOwned(taskId) {
    this.store.requireTask(taskId);
    let context = this.targets.get(Number(taskId));
    if (!context) {
      const persisted = this.store.getBrowserSession(taskId);
      if (persisted) {
        const entry = resolveWebsite(this.catalog, persisted.websiteId);
        context = { ...persisted, entry };
        this.targets.set(Number(taskId), context);
      }
    }
    if (!context) throw new BrowserExecutionError('任务尚未创建 Edge 标签页', 'task_tab_missing', { waitingForUser: true });
    let owned = false;
    let recovered = null;
    try {
      owned = await this.driver.ownsTarget(context.targetId);
      if (!owned && typeof this.driver.recoverTarget === 'function') {
        recovered = await this.driver.recoverTarget({ targetId: context.targetId, marker: context.marker });
      }
    } catch (error) {
      if (error instanceof BrowserExecutionError) throw error;
      throw new BrowserExecutionError(`Edge 扩展未连接：${error.message}`, 'edge_disconnected', { waitingForUser: true });
    }
    if (!owned) {
      if (!recovered) {
        this.targets.delete(Number(taskId));
        throw new BrowserExecutionError('任务标签已被移出 Daily Twin 控制范围', 'task_tab_not_owned', { waitingForUser: true });
      }
      context.targetId = recovered;
      this.store.saveBrowserSession(taskId, {
        websiteId: context.websiteId,
        targetId: recovered,
        marker: context.marker
      });
    }
    return context;
  }

  async fill({ taskId, field, text }) {
    const context = await this.requireOwned(taskId);
    const selector = context.entry.fields?.[field];
    if (!selector) throw new BrowserExecutionError(`站点未登记输入框：${field}`, 'field_not_registered');
    await this.driver.fill({ targetId: context.targetId, selector, text: String(text) });
    const actual = await this.driver.readValue({ targetId: context.targetId, selector, expected: String(text) });
    if (actual !== String(text)) {
      throw new BrowserExecutionError('输入框回读值与目标内容不一致', 'fill_verification_failed');
    }
    return { verified: true, field, targetId: context.targetId };
  }

  async submit({ taskId, action }) {
    const context = await this.requireOwned(taskId);
    const selector = context.entry.actions?.[action];
    if (!selector) throw new BrowserExecutionError(`站点未登记动作：${action}`, 'action_not_registered');
    const result = await this.driver.submit({ targetId: context.targetId, selector });
    return { targetId: context.targetId, ...result };
  }

  async detectUserGate({ taskId }) {
    const context = await this.requireOwned(taskId);
    const verificationField = context.entry.verification?.field;
    if (verificationField && await this.driver.isVisible({ targetId: context.targetId, selector: verificationField })) {
      return { kind: 'verification' };
    }
    const loginSelector = context.entry.loginRequiredSelector;
    if (loginSelector && await this.driver.isVisible({ targetId: context.targetId, selector: loginSelector })) {
      return { kind: 'login' };
    }
    return null;
  }

  async provideVerification({ taskId, code }) {
    const context = await this.requireOwned(taskId);
    const verification = context.entry.verification;
    if (!verification?.field) {
      throw new BrowserExecutionError('站点未登记验证码输入框', 'verification_field_not_registered');
    }
    await this.driver.fillSensitive({
      targetId: context.targetId,
      selector: verification.field,
      text: String(code ?? '')
    });
    if (verification.submit) {
      await this.driver.submit({ targetId: context.targetId, selector: verification.submit });
    }
    return { accepted: true };
  }

  async wait({ taskId, condition, timeoutMs = 60_000 }) {
    const context = await this.requireOwned(taskId);
    const result = await this.driver.wait({
      targetId: context.targetId,
      condition,
      timeoutMs,
      verificationSelector: context.entry.verification?.field ?? null,
      loginSelector: context.entry.loginRequiredSelector ?? null
    });
    const gate = result?.status === 'verification_required'
      ? { kind: 'verification' }
      : (result?.status === 'login_required' ? { kind: 'login' } : null);
    return { targetId: context.targetId, ...result, ...(gate ? { gate } : {}) };
  }

  async capture({ taskId }) {
    const context = await this.requireOwned(taskId);
    const sensitiveSelectors = [context.entry.verification?.field].filter((value) => typeof value === 'string' && value.trim());
    const captured = await this.driver.capture({
      targetId: context.targetId,
      taskId: this.store.getTask(taskId).publicId,
      sensitiveSelectors
    });
    if (!captured?.path) throw new BrowserExecutionError('截图没有返回本机证据路径', 'capture_failed');
    const evidence = this.store.insertExecutionEvidence({
      taskId,
      kind: 'page',
      target: captured.path,
      detail: JSON.stringify({ website: context.websiteId, targetId: context.targetId })
    });
    return { evidenceRef: `E-${evidence.id}`, targetId: context.targetId };
  }
}
