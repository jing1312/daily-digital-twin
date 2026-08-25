import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { issueCapabilityTicket } from '../core/capability-ticket.mjs';
import { createWorkerContext } from '../core/worker-context.mjs';

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function renderCodexWorkerConfig({ nodePath, runtimePath, home, bindingPath } = {}) {
  const missing = Object.entries({ nodePath, runtimePath, home, bindingPath })
    .filter(([, value]) => !String(value ?? '').trim())
    .map(([key]) => key);
  if (missing.length) throw new Error(`Codex worker 配置缺少：${missing.join(', ')}`);
  const args = [runtimePath, 'mcp', '--home', home, '--binding', bindingPath]
    .map(tomlString)
    .join(', ');
  return [
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    '',
    '[mcp_servers.daily_twin]',
    `command = ${tomlString(nodePath)}`,
    `args = [${args}]`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 900',
    ''
  ].join('\n');
}

export async function prepareCodexWorker({
  home,
  task,
  workerId,
  capabilitySecret,
  scopes,
  nodePath,
  runtimePath,
  expiresInMinutes = 100
} = {}) {
  if (!task?.publicId || !task?.multicaIssueId) {
    throw new Error('Codex worker 必须绑定本机任务号和 Multica issue');
  }
  const context = await createWorkerContext({ home, taskId: task.publicId, workerId });
  const codexHome = join(context.root, 'codex-home');
  await mkdir(codexHome, { recursive: true });
  const bindingPath = join(context.root, 'capability.binding.json');
  const expiresAt = new Date(Date.now() + Math.max(1, Number(expiresInMinutes)) * 60_000).toISOString();
  const ticket = issueCapabilityTicket({
    secret: capabilitySecret,
    payload: {
      taskId: task.publicId,
      multicaIssueId: task.multicaIssueId,
      workerId,
      websites: scopes?.websites ?? [],
      apps: scopes?.apps ?? [],
      directories: scopes?.directories ?? [],
      actions: scopes?.actions ?? [],
      expiresAt,
      nonce: randomUUID()
    }
  });
  await writeFile(bindingPath, `${JSON.stringify({ workerId, ticket })}\n`, 'utf8');
  const configPath = join(codexHome, 'config.toml');
  await writeFile(configPath, renderCodexWorkerConfig({
    nodePath,
    runtimePath,
    home,
    bindingPath
  }), 'utf8');
  return {
    taskId: task.publicId,
    multicaIssueId: task.multicaIssueId,
    workerId,
    workspace: context.workspace,
    summaryDir: context.summaryDir,
    checkpointDir: context.checkpointDir,
    codexHome,
    configPath,
    bindingPath,
    expiresAt,
    env: { CODEX_HOME: codexHome }
  };
}

function validateWorkerSlot(workerId) {
  const value = String(workerId ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw Object.assign(new Error('Multica worker slot 非法'), { code: 'invalid_worker_slot' });
  }
  return value;
}

export async function prepareMulticaWorkerBinding({
  home,
  task,
  workerId,
  capabilitySecret,
  scopes,
  expiresInMinutes = 100
} = {}) {
  if (!task?.publicId || !task?.multicaIssueId) {
    throw new Error('Multica worker 必须绑定本机任务号和父 issue');
  }
  const slot = validateWorkerSlot(workerId);
  await createWorkerContext({ home, taskId: task.publicId, workerId: slot });
  const relativeBindingPath = `data/workers/slots/${slot}/capability.binding.json`;
  const slotRoot = join(home, 'data', 'workers', 'slots', slot);
  await mkdir(slotRoot, { recursive: true });
  const bindingPath = join(slotRoot, 'capability.binding.json');
  const expiresAt = new Date(Date.now() + Math.max(1, Number(expiresInMinutes)) * 60_000).toISOString();
  const ticket = issueCapabilityTicket({
    secret: capabilitySecret,
    payload: {
      taskId: task.publicId,
      multicaIssueId: task.multicaIssueId,
      workerId: slot,
      websites: scopes?.websites ?? [],
      apps: scopes?.apps ?? [],
      directories: scopes?.directories ?? [],
      actions: scopes?.actions ?? [],
      expiresAt,
      nonce: randomUUID()
    }
  });
  const temporary = join(slotRoot, `capability.binding.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ workerId: slot, ticket })}\n`, 'utf8');
  await rename(temporary, bindingPath);
  return { taskId: task.publicId, workerId: slot, bindingPath: relativeBindingPath, expiresAt };
}
