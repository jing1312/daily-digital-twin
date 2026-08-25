import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

function invalid(message, code) {
  throw Object.assign(new Error(message), { code });
}

function validateSegment(value, kind) {
  const text = String(value ?? '').trim();
  const pattern = kind === 'task'
    ? /^DT-\d{8}-\d{4,}$/
    : /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  if (!pattern.test(text)) invalid(`${kind === 'task' ? '任务号' : 'worker ID'} 非法`, `invalid_${kind}_id`);
  return text;
}

function assertInside(root, candidate) {
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) invalid('worker 目录逃出私有 home', 'worker_path_escape');
}

export async function createWorkerContext({ home, taskId, workerId } = {}) {
  const privateHome = resolve(String(home ?? ''));
  if (!home) invalid('缺少私有 home', 'missing_home');
  const safeTaskId = validateSegment(taskId, 'task');
  const safeWorkerId = validateSegment(workerId, 'worker');
  const root = resolve(privateHome, 'data', 'workers');
  const workerRoot = resolve(root, safeTaskId, safeWorkerId);
  assertInside(root, workerRoot);
  const workspace = join(workerRoot, 'workspace');
  const summaryDir = join(workerRoot, 'summaries');
  const checkpointDir = join(workerRoot, 'checkpoints');
  await Promise.all([workspace, summaryDir, checkpointDir].map((path) => mkdir(path, { recursive: true })));
  return { taskId: safeTaskId, workerId: safeWorkerId, root: workerRoot, workspace, summaryDir, checkpointDir };
}
