// 中文注释：AI 规划器 —— 把用户早晨提交的原始任务列表发给 AI 模型，让它分解成可执行的子任务。
// 中文注释：这是"早晨把所有任务发给 AI，它帮我分出去"的核心组件。
// 中文注释：零依赖：用 Node 18+ 内置的 fetch 调用 OpenAI 兼容 API。

export const DEFAULT_PLANNER_CONFIG = {
  apiEndpoint: null,
  apiKey: null,
  model: 'gpt-4o-mini',
  // 中文注释：系统提示词：告诉 AI 它是一个任务规划器，需要把任务分解为可执行的子任务。
  systemPrompt: `你是一个任务规划器。用户会给你一组原始任务描述，你需要：

1. 理解每个任务的意图
2. 把复杂任务分解成 1-4 个可执行的子任务
3. 为每个子任务判断类型：
   - ai_call：可以用 AI 直接完成的（写文案、做分析、查资料、翻译、总结等）
   - desktop：需要操作桌面软件的（打开 Excel、编辑文档等）
   - browser：需要浏览器操作的（登录网站、填表单等）
4. 为每个子任务设置优先级（1-5，5 最高）

输出格式为 JSON 数组，每个元素：
{
  "parentIndex": 0,        // 对应原始任务的序号（从 0 开始）
  "request": "子任务描述",   // 具体可执行的描述
  "taskType": "ai_call",   // ai_call | desktop | browser
  "priority": 3            // 1-5
}

只输出 JSON 数组，不要输出其他内容。如果原始任务本身已经足够简单不需要分解，就原样输出一条。`,
  // 中文注释：允许跳过 AI 调用的最大任务数。少于这个数时直接透传，省 token。
  directPassthroughThreshold: 0,
  // 中文注释：API 调用超时（毫秒）。
  timeoutMs: 30000
};

export class PlannerError extends Error {
  constructor(message, code = 'planner_error') {
    super(message);
    this.name = 'PlannerError';
    this.code = code;
  }
}

// 中文注释：校验 AI 返回的规划结果结构。
export function validatePlan(plan, taskCount) {
  if (!Array.isArray(plan)) throw new PlannerError('规划结果必须是数组', 'invalid_plan_shape');
  if (plan.length === 0) throw new PlannerError('规划结果不能为空', 'empty_plan');

  const validTypes = new Set(['ai_call', 'desktop', 'browser', 'unknown']);
  const result = [];

  for (let i = 0; i < plan.length; i += 1) {
    const item = plan[i];
    if (!item || typeof item !== 'object') {
      throw new PlannerError(`规划结果第 ${i + 1} 项不是对象`, 'invalid_plan_item');
    }
    const parentIndex = Number(item.parentIndex);
    if (!Number.isInteger(parentIndex) || parentIndex < 0 || parentIndex >= taskCount) {
      throw new PlannerError(`规划结果第 ${i + 1} 项的 parentIndex 越界：${item.parentIndex}`, 'invalid_parent_index');
    }
    const request = String(item.request ?? '').trim();
    if (!request) throw new PlannerError(`规划结果第 ${i + 1} 项的 request 为空`, 'empty_request');
    const taskType = validTypes.has(item.taskType) ? item.taskType : 'unknown';
    const priority = Math.max(1, Math.min(5, Number(item.priority) || 1));
    result.push({ parentIndex, request, taskType, priority });
  }

  return result;
}

// 中文注释：不调 AI 的透传模式 —— 每个原始任务直接变成一条 taskType=unknown 的子任务。
// 中文注释：用于没有配置 API 或 API 不可用时的降级。
export function passthroughPlan(tasks) {
  return tasks.map((request, index) => ({
    parentIndex: index,
    request,
    taskType: 'unknown',
    priority: 1
  }));
}

// 中文注释：调用 OpenAI 兼容 API。fetch 是 Node 18+ 内置的，不需要额外依赖。
async function callChatAPI({ apiEndpoint, apiKey, model, messages, timeoutMs, reasoningEffort = null }) {
  if (!apiEndpoint) throw new PlannerError('未配置 planner.apiEndpoint', 'missing_endpoint');
  if (!apiKey) throw new PlannerError('未配置 planner.apiKey', 'missing_key');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 30000));

  try {
    const payload = { model, messages, temperature: 0.3, response_format: { type: 'json_object' } };
    // 中文注释：推理力度（reasoning_effort）只在显式配置时携带，兼容不支持该参数的服务商。
    if (reasoningEffort) payload.reasoning_effort = reasoningEffort;
    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        // 中文注释：部分中转站按 User-Agent 放行客户端（实测缺失时 401），统一标识为 codex CLI。
        'User-Agent': 'codex_cli_rs/0.21.0'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new PlannerError(`API 返回 ${response.status}：${text.slice(0, 200)}`, 'api_error');
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new PlannerError('API 返回中没有 content', 'empty_response');
    return content;
  } catch (error) {
    if (error instanceof PlannerError) throw error;
    if (error.name === 'AbortError') throw new PlannerError('API 调用超时', 'timeout');
    throw new PlannerError(`API 调用失败：${error.message}`, 'fetch_error');
  } finally {
    clearTimeout(timer);
  }
}

// 中文注释：从 AI 返回的文本中提取 JSON 数组。AI 有时会包裹 markdown 代码块。
function extractJSON(text) {
  const trimmed = String(text).trim();
  // 中文注释：去掉 markdown 代码块包裹。
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  // 中文注释：找到第一个 [ 和最后一个 ]，提取中间内容。
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1) throw new PlannerError('AI 返回中找不到 JSON 数组', 'no_json_array');
  return JSON.parse(candidate.slice(start, end + 1));
}

// 中文注释：主入口。把原始任务列表发给 AI，拿回分解后的子任务计划。
// 中文注释：config 是 planner 配置段（apiEndpoint, apiKey, model, systemPrompt 等）。
// 中文注释：返回 [{ parentIndex, request, taskType, priority }]。
export async function planTasks(tasks, config = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new PlannerError('任务列表不能为空', 'empty_tasks');
  }

  const merged = { ...DEFAULT_PLANNER_CONFIG, ...config };

  // 中文注释：没有配置 API 就透传，不报错 —— 让用户先跑起来再说。
  if (!merged.apiEndpoint || !merged.apiKey) {
    return passthroughPlan(tasks);
  }

  // 中文注释：任务太少时也可以透传，省 token。
  if (merged.directPassthroughThreshold > 0 && tasks.length <= merged.directPassthroughThreshold) {
    return passthroughPlan(tasks);
  }

  const userContent = JSON.stringify(tasks, null, 2);
  const content = await callChatAPI({
    apiEndpoint: merged.apiEndpoint,
    apiKey: merged.apiKey,
    model: merged.model,
    timeoutMs: merged.timeoutMs,
    reasoningEffort: merged.reasoningEffort ?? null,
    messages: [
      { role: 'system', content: merged.systemPrompt },
      { role: 'user', content: `这是我的任务列表：\n\n${userContent}` }
    ]
  });

  const plan = extractJSON(content);
  return validatePlan(plan, tasks.length);
}

// 中文注释：把规划结果按 parentIndex 分组，方便后续创建父子任务。
export function groupByParent(plan) {
  const groups = new Map();
  for (const item of plan) {
    if (!groups.has(item.parentIndex)) groups.set(item.parentIndex, []);
    groups.get(item.parentIndex).push(item);
  }
  return groups;
}
