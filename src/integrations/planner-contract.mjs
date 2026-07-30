import { prepareCodexWorker } from './codex-worker-config.mjs';

export class PlannerContractError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PlannerContractError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new PlannerContractError(message, code);
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    fail(`planner ${field} 必须是非空字符串数组`, 'planner_invalid_subtask');
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function validateCapabilities(capabilities, allowed) {
  const result = {};
  for (const field of ['websites', 'apps', 'directories', 'actions']) {
    const requested = stringList(capabilities?.[field] ?? [], `capabilities.${field}`);
    const allowedValues = new Set(stringList(allowed?.[field] ?? [], `allowed.${field}`));
    const denied = requested.filter((item) => !allowedValues.has(item));
    if (denied.length) fail(`planner 请求了未授权的 ${field}：${denied.join(', ')}`, 'planner_capability_denied');
    result[field] = requested;
  }
  return result;
}

export function validatePlannerPlan(plan, { allowed, maxSubtasks = 4 } = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('planner 输出必须是对象', 'planner_invalid_plan');
  if (typeof plan.summary !== 'string' || !plan.summary.trim()) fail('planner summary 不能为空', 'planner_invalid_plan');
  if (!Array.isArray(plan.subtasks) || plan.subtasks.length === 0) fail('planner 至少需要一个子任务', 'planner_invalid_plan');
  if (plan.subtasks.length > maxSubtasks) fail(`planner 子任务超过上限 ${maxSubtasks}`, 'planner_too_many_subtasks');

  const ids = new Set();
  const subtasks = plan.subtasks.map((subtask) => {
    const id = String(subtask?.id ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(id)) fail(`planner 子任务 ID 非法：${id}`, 'planner_invalid_subtask');
    if (ids.has(id)) fail(`planner 子任务 ID 重复：${id}`, 'planner_duplicate_subtask');
    ids.add(id);
    const title = String(subtask?.title ?? '').trim();
    const instructions = String(subtask?.instructions ?? '').trim();
    if (!title || !instructions) fail(`planner 子任务 ${id} 缺少 title 或 instructions`, 'planner_invalid_subtask');
    return {
      id,
      title: title.slice(0, 160),
      instructions: instructions.slice(0, 8_000),
      capabilities: validateCapabilities(subtask.capabilities, allowed)
    };
  });
  return { summary: plan.summary.trim().slice(0, 2_000), subtasks };
}

function messageRows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['messages', 'items', 'data']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function messageText(message) {
  const value = message?.content ?? message?.text ?? message?.message?.content ?? message?.message?.text;
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === 'string' ? item : item?.text ?? item?.content ?? '').join('\n').trim();
  }
  return '';
}

function parseJsonObject(text) {
  const unfenced = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractPlannerPlan(payload) {
  const rows = messageRows(payload);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const parsed = parseJsonObject(messageText(rows[index]));
    if (parsed?.summary && Array.isArray(parsed?.subtasks)) return parsed;
  }
  fail('Multica planner 没有返回结构化计划', 'planner_output_missing');
}

function mentionedEntries(entries, request) {
  const text = String(request ?? '').toLowerCase();
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const names = [entry?.id, ...(Array.isArray(entry?.aliases) ? entry.aliases : [])];
    return names.some((name) => {
      const candidate = String(name ?? '').trim().toLowerCase();
      return candidate && text.includes(candidate);
    });
  }).map((entry) => String(entry.id));
}

export function deriveTaskCapabilities({ task, catalog, allowedDirectories = [] } = {}) {
  const websites = mentionedEntries(catalog?.websites, task?.request);
  const apps = mentionedEntries(catalog?.apps, task?.request);
  const actions = ['task.checkpoint'];
  if (websites.length) actions.push('browser.open', 'browser.fill', 'browser.submit', 'browser.wait', 'browser.capture');
  if (apps.length) actions.push('app.launch');
  return {
    websites: [...new Set(websites)],
    apps: [...new Set(apps)],
    directories: [...new Set((allowedDirectories ?? []).map((item) => String(item).trim()).filter(Boolean))],
    actions
  };
}

export async function provisionCodexWorkers({
  plannerStatus,
  plan,
  allowed,
  task,
  prepareWorker = prepareCodexWorker,
  workerOptions = {},
  workerIds = null
} = {}) {
  if (String(plannerStatus).toLowerCase() !== 'completed') {
    fail('planner 必须先结束，不能与 worker 同时占槽', 'planner_still_running');
  }
  if (typeof prepareWorker !== 'function') fail('缺少 Codex worker 准备器', 'worker_preparer_missing');
  const validated = validatePlannerPlan(plan, { allowed, maxSubtasks: 4 });
  const ids = workerIds ?? validated.subtasks.map((_, index) => `worker-${index + 1}`);
  if (!Array.isArray(ids) || ids.length < validated.subtasks.length) {
    fail('可用 Codex worker 数量不足', 'worker_slots_missing');
  }
  return Promise.all(validated.subtasks.map((subtask, index) => prepareWorker({
    ...workerOptions,
    task,
    workerId: ids[index],
    scopes: subtask.capabilities,
    subtask
  })));
}
