// 中文注释：AI 执行器 —— 对 taskType=ai_call 的任务，调用 AI API 实际执行。
// 中文注释：这是 scheduler-loop executor 契约的具体实现之一。
// 中文注释：executor 契约：入参 { task, store, config }，返回 { outcome, summary?, reason?, evidence?: [] }
// 中文注释：零依赖：用 Node 18+ 内置的 fetch。

import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';

export const DEFAULT_EXECUTOR_CONFIG = {
  apiEndpoint: null,
  apiKey: null,
  model: 'gpt-4o-mini',
  // 中文注释：系统提示词：告诉 AI 它是一个任务执行者。
  systemPrompt: `你是一个任务执行者。用户会给你一个具体的任务描述，你需要尽可能好地完成它。
直接输出你的工作结果，不要输出多余的解释。`,
  // 中文注释：执行结果保存目录（相对于私有 home）。
  outputDir: 'data/outputs',
  // 中文注释：API 调用超时（毫秒）。
  timeoutMs: 60000
};

export class ExecutorError extends Error {
  constructor(message, code = 'executor_error') {
    super(message);
    this.name = 'ExecutorError';
    this.code = code;
  }
}

// 中文注释：调用 AI API 执行任务。返回 AI 的回答文本。
async function callAI({ apiEndpoint, apiKey, model, messages, timeoutMs }) {
  if (!apiEndpoint) throw new ExecutorError('未配置 executor.apiEndpoint', 'missing_endpoint');
  if (!apiKey) throw new ExecutorError('未配置 executor.apiKey', 'missing_key');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 60000));

  try {
    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages, temperature: 0.3 }),
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ExecutorError(`API 返回 ${response.status}：${text.slice(0, 200)}`, 'api_error');
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new ExecutorError('API 返回中没有 content', 'empty_response');

    // 中文注释：提取 token 用量信息，供 ledger 记账。
    const usage = data?.usage ?? null;
    return { content, usage };
  } catch (error) {
    if (error instanceof ExecutorError) throw error;
    if (error.name === 'AbortError') throw new ExecutorError('API 调用超时', 'timeout');
    throw new ExecutorError(`API 调用失败：${error.message}`, 'fetch_error');
  } finally {
    clearTimeout(timer);
  }
}

// 中文注释：把 AI 的输出保存到文件，作为执行证据。
// 中文注释：文件路径：<home>/data/outputs/task-<id>-<timestamp>.txt
async function saveOutput(home, taskId, content, outputDir) {
  const dir = join(home, outputDir);
  await mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `task-${taskId}-${timestamp}.txt`;
  const filepath = join(dir, filename);
  await writeFile(filepath, content, 'utf8');
  return filepath;
}

// 中文注释：主入口。符合 scheduler-loop 的 executor 契约。
// 中文注释：只处理 taskType=ai_call 的任务；其他类型返回 partial 并说明需要对应执行器。
export async function createAIExecutor({ home = null, config = {} } = {}) {
  const executorConfig = { ...DEFAULT_EXECUTOR_CONFIG, ...(config?.executor ?? {}) };

  return async function aiExecutor({ task, store, config: runtimeConfig }) {
    // 中文注释：只处理 ai_call 类型的任务。
    if (task.taskType && task.taskType !== 'ai_call') {
      return {
        outcome: 'partial',
        reason: `ai-executor 不处理 ${task.taskType} 类型任务，需要对应执行器`,
        summary: `任务 ${task.id} 类型为 ${task.taskType}，跳过`
      };
    }

    // 中文注释：没有配置 API 就诚实报告 partial，不谎报完成。
    if (!executorConfig.apiEndpoint || !executorConfig.apiKey) {
      return {
        outcome: 'partial',
        reason: '未配置 executor API，无法执行 AI 任务',
        summary: `任务 ${task.id} 需要 AI 执行但未配置 API`
      };
    }

    try {
      const { content, usage } = await callAI({
        apiEndpoint: executorConfig.apiEndpoint,
        apiKey: executorConfig.apiKey,
        model: executorConfig.model,
        timeoutMs: executorConfig.timeoutMs,
        messages: [
          { role: 'system', content: executorConfig.systemPrompt },
          { role: 'user', content: task.request }
        ]
      });

      // 中文注释：记录 token 用量到账本。
      if (usage && store) {
        try {
          store.recordTokenUsage({
            taskId: task.id,
            workerId: 'ai-executor',
            model: executorConfig.model,
            inputTokens: usage.prompt_tokens ?? 0,
            outputTokens: usage.completion_tokens ?? 0,
            cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
            cacheHit: Boolean(usage.prompt_tokens_details?.cached_tokens),
            latencyMs: 0,
            estimatedCost: null
          });
        } catch {
          // 中文注释：记账失败不影响执行结果。
        }
      }

      // 中文注释：保存输出到文件，作为执行证据。
      let evidence = [];
      if (home) {
        try {
          const filepath = await saveOutput(home, task.id, content, executorConfig.outputDir);
          evidence.push({ kind: 'file', target: filepath, detail: 'AI 执行结果输出文件' });
        } catch {
          // 中文注释：保存失败不阻止完成，但没有文件证据会被降级为 partial。
        }
      }

      return {
        outcome: evidence.length > 0 ? 'completed' : 'partial',
        summary: content.slice(0, 200),
        reason: evidence.length > 0 ? null : 'AI 执行成功但未能保存输出文件，缺少文件证据',
        evidence
      };
    } catch (error) {
      return {
        outcome: 'failed',
        reason: error.message,
        summary: `任务 ${task.id} AI 执行失败：${error.code ?? error.message}`
      };
    }
  };
}

// 中文注释：复合执行器：根据任务类型分发到不同执行器。
// 中文注释：内置 ai-executor 处理 ai_call / unknown；desktop 和 browser 优先交给
// 中文注释：私有执行器（PR #7 的 executor-loader 装载结果，经 delegate 传入），
// 中文注释：没有私有执行器时如实返回 partial。
export async function createCompositeExecutor({ home = null, config = {}, delegate = null } = {}) {
  const aiExecutor = await createAIExecutor({ home, config });

  return async function compositeExecutor({ task, store, config: runtimeConfig }) {
    const taskType = task.taskType ?? 'unknown';

    // 中文注释：ai_call 类型交给 AI 执行器。
    if (taskType === 'ai_call') {
      return aiExecutor({ task, store, config: runtimeConfig });
    }

    // 中文注释：desktop / browser 类型优先走私有执行器（遵循 executor 契约），
    // 中文注释：异常统一抛出，由 scheduler-loop 兜底转 failed。
    if ((taskType === 'desktop' || taskType === 'browser') && typeof delegate === 'function') {
      return delegate({ task, store, config: runtimeConfig });
    }

    // 中文注释：desktop 和 browser 类型暂未实现，诚实报告。
    if (taskType === 'desktop') {
      return {
        outcome: 'partial',
        reason: 'desktop 执行器尚未配置，请在私有目录提供桌面自动化执行器',
        summary: `任务 ${task.id} 需要桌面执行器`
      };
    }

    if (taskType === 'browser') {
      return {
        outcome: 'partial',
        reason: 'browser 执行器尚未配置，请在私有目录提供浏览器自动化执行器',
        summary: `任务 ${task.id} 需要浏览器执行器`
      };
    }

    // 中文注释：unknown 类型尝试用 AI 执行，可能能做也可能不能。
    return aiExecutor({ task, store, config: runtimeConfig });
  };
}
