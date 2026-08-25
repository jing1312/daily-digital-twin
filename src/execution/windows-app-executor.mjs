import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveApp } from '../core/app-catalog.mjs';

const execFileAsync = promisify(execFile);

async function defaultRunner(command, args, options) {
  return execFileAsync(command, args, {
    ...options,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8'
  });
}
export class PowerShellAppLauncher {
  constructor({ pwshPath, scriptPath, catalogPath, runner = defaultRunner } = {}) {
    if (!pwshPath || !scriptPath || !catalogPath) throw new Error('PowerShell launcher 缺少路径配置');
    this.pwshPath = pwshPath;
    this.scriptPath = scriptPath;
    this.catalogPath = catalogPath;
    this.runner = runner;
  }

  async launch(alias) {
    const args = [
      '-NoProfile',
      '-File', this.scriptPath,
      '-CatalogPath', this.catalogPath,
      '-Alias', String(alias)
    ];
    const result = await this.runner(this.pwshPath, args, { shell: false });
    let parsed;
    try {
      parsed = JSON.parse(String(result.stdout ?? '').replace(/^\uFEFF/, '').trim());
    } catch {
      throw new Error('应用启动脚本没有返回合法 JSON 证据');
    }
    if (parsed.status !== 'started') throw new Error(`应用未通过启动验证：${parsed.reason ?? parsed.status ?? 'unknown'}`);
    return parsed;
  }
}

export class WindowsAppExecutor {
  constructor({ store, catalog, launcher } = {}) {
    if (!store || !catalog || !launcher) throw new Error('Windows 应用执行器需要 store、catalog 和 launcher');
    this.store = store;
    this.catalog = catalog;
    this.launcher = launcher;
  }

  async launch({ taskId, alias }) {
    this.store.requireTask(taskId);
    const entry = resolveApp(this.catalog, alias);
    const resource = entry.resource ?? `app:${entry.id}`;
    const lock = this.store.tryAcquireLock(taskId, resource, { exclusiveClass: 'foreground' });
    if (!lock.ok) throw new Error(`软件资源正被任务 ${lock.holderTaskId} 占用`);
    try {
      const result = await this.launcher.launch(entry.id);
      if (!Number.isInteger(Number(result.processId)) || Number(result.processId) <= 0 || !result.processName) {
        throw new Error('应用启动结果缺少进程验证证据');
      }
      const evidence = this.store.insertExecutionEvidence({
        taskId,
        kind: 'process',
        target: result.target ?? entry.path,
        processId: Number(result.processId),
        processName: String(result.processName),
        detail: result.windowTitle ? JSON.stringify({ windowTitle: result.windowTitle }) : null
      });
      return { app: entry.id, evidenceRef: `E-${evidence.id}`, processId: Number(result.processId) };
    } finally {
      this.store.releaseLock(taskId, resource);
    }
  }
}
