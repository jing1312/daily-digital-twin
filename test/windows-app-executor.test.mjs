import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsAppExecutor, PowerShellAppLauncher } from '../src/execution/windows-app-executor.mjs';
import { TaskStore } from '../src/core/task-store.mjs';

test('未登记软件被拒绝，launcher 不会收到猜测路径', async () => {
  const store = new TaskStore(':memory:');
  const task = store.createTask({ request: '打开未知软件' });
  store.transition(task.id, 'running');
  let calls = 0;
  const executor = new WindowsAppExecutor({
    store,
    catalog: { apps: [] },
    launcher: { async launch() { calls += 1; } }
  });
  await assert.rejects(() => executor.launch({ taskId: task.id, alias: '不存在' }), /未登记应用/);
  assert.equal(calls, 0);
  store.close();
});
test('已登记软件必须返回进程证据才算启动成功', async () => {
  const store = new TaskStore(':memory:');
  const task = store.createTask({ request: '打开 Omicos' });
  store.transition(task.id, 'running');
  const executor = new WindowsAppExecutor({
    store,
    catalog: { apps: [{ id: 'omicos', aliases: ['Omicos'], path: 'D:\\Apps\\Omicos.exe', resource: 'app:omicos' }] },
    launcher: { async launch() { return { status: 'started', processId: 42, processName: 'Omicos', target: 'D:\\Apps\\Omicos.exe' }; } }
  });
  const result = await executor.launch({ taskId: task.id, alias: 'Omicos' });
  assert.match(result.evidenceRef, /^E-\d+$/);
  assert.equal(store.listExecutionEvidence(task.id)[0].processId, 42);
  store.close();
});

test('PowerShell launcher 使用 execFile 参数数组和 shell:false，并解析 JSON 回执', async () => {
  const calls = [];
  const launcher = new PowerShellAppLauncher({
    pwshPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    scriptPath: 'D:\\repo\\Start-DailyTwinApp.ps1',
    catalogPath: 'D:\\private\\apps.json',
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: JSON.stringify({ status: 'started', processId: 99, processName: 'Omicos' }), stderr: '' };
    }
  });
  const result = await launcher.launch('Omicos');
  assert.equal(result.processId, 99);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].args.slice(0, 4), ['-NoProfile', '-File', 'D:\\repo\\Start-DailyTwinApp.ps1', '-CatalogPath']);
});
