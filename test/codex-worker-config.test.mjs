import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskStore } from '../src/core/task-store.mjs';

const workerModule = await import('../src/integrations/codex-worker-config.mjs').catch(() => ({}));

test('Codex worker 配置固定 workspace-write + never，只接 Daily Twin stdio MCP', () => {
  assert.equal(typeof workerModule.renderCodexWorkerConfig, 'function');
  const text = workerModule.renderCodexWorkerConfig({
    nodePath: 'C:\\Node\\node.exe',
    runtimePath: 'D:\\Repo\\src\\runtime.mjs',
    home: 'D:\\Private\\Twin',
    bindingPath: 'D:\\Private\\Twin\\data\\workers\\binding.json'
  });
  assert.match(text, /^approval_policy = "never"/m);
  assert.match(text, /^sandbox_mode = "workspace-write"/m);
  assert.match(text, /^\[mcp_servers\.daily_twin\]$/m);
  assert.match(text, /"mcp"/);
  assert.match(text, /"--binding"/);
  assert.doesNotMatch(text, /api[_-]?key|token|pat|secret/i);
  assert.doesNotMatch(text, /playwright|powershell|shell/i);
});

test('每个 worker 生成独立 CODEX_HOME、工作目录和本地绑定文件，绑定文件不含 HMAC 密钥', async () => {
  assert.equal(typeof workerModule.prepareCodexWorker, 'function');
  const home = mkdtempSync(join(tmpdir(), 'ddt-codex-worker-'));
  const store = new TaskStore(':memory:');
  try {
    const created = store.createTask({ request: '分析数据' });
    store.bindMulticaIssue(created.id, 'MUL-44');
    const task = store.getTask(created.id);
    const result = await workerModule.prepareCodexWorker({
      home,
      task,
      workerId: 'worker-1',
      capabilitySecret: '0123456789abcdef0123456789abcdef',
      scopes: {
        websites: ['biomni'], apps: [], directories: [],
        actions: ['browser.open', 'browser.fill']
      },
      nodePath: process.execPath,
      runtimePath: 'D:\\Repo\\src\\runtime.mjs'
    });
    assert.match(result.codexHome, /worker-1[\\/]codex-home$/);
    assert.match(result.workspace, /worker-1[\\/]workspace$/);
    assert.equal(result.env.CODEX_HOME, result.codexHome);
    assert.equal(result.env.DAILY_TWIN_HOME, undefined);
    const binding = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(result.bindingPath, 'utf8')));
    assert.equal(binding.workerId, 'worker-1');
    assert.equal(typeof binding.ticket, 'string');
    assert.doesNotMatch(JSON.stringify(binding), /0123456789abcdef0123456789abcdef/);
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Multica worker 使用固定本机 slot binding，不自行伪造另一套 CODEX_HOME', async () => {
  assert.equal(typeof workerModule.prepareMulticaWorkerBinding, 'function');
  const home = mkdtempSync(join(tmpdir(), 'ddt-multica-slot-'));
  const store = new TaskStore(':memory:');
  try {
    const created = store.createTask({ request: '分析数据' });
    store.bindMulticaIssue(created.id, 'MUL-55');
    const result = await workerModule.prepareMulticaWorkerBinding({
      home,
      task: store.getTask(created.id),
      workerId: 'dt-worker-1',
      capabilitySecret: '0123456789abcdef0123456789abcdef',
      scopes: { websites: [], apps: [], directories: [], actions: ['task.checkpoint'] }
    });
    assert.equal(result.bindingPath, 'data/workers/slots/dt-worker-1/capability.binding.json');
    assert.equal('codexHome' in result, false, 'CODEX_HOME 由 Multica 按单次任务隔离');
    const absolute = join(home, ...result.bindingPath.split('/'));
    const binding = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(absolute, 'utf8')));
    assert.equal(binding.workerId, 'dt-worker-1');
    assert.equal(typeof binding.ticket, 'string');
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
