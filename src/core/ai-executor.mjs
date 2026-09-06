// 中文注释：AI 执行器 —— 对 taskType=ai_call 的任务，调用 AI API 实际执行。
// 中文注释：这是 scheduler-loop executor 契约的具体实现之一。
// 中文注释：executor 契约：入参 { task, store, config }，返回 { outcome, summary?, reason?, evidence?: [] }
// 中文注释：零依赖：用 Node 18+ 内置的 fetch。

import { join } from 'node:path';
import { writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { resolveContainedPath } from './path-boundary.mjs';

export const DEFAULT_EXECUTOR_CONFIG = {
  apiEndpoint: null,
  apiKey: null,
  model: 'gpt-4o-mini',
  // 中文注释：视觉模型。任务引用私有目录内的图片文件时，自动改用该模型并携带图片。
  // 中文注释：为空则回落到主模型（部分服务商同一模型同时支持文本与视觉）。
  visionModel: null,
  // 中文注释：系统提示词：告诉 AI 它是一个任务执行者。
  systemPrompt: `你是一个任务执行者。用户会给你一个具体的任务描述，你需要尽可能好地完成它。
直接输出你的工作结果，不要输出多余的解释。`,
  // 中文注释：执行结果保存目录（相对于私有 home）。
  outputDir: 'data/outputs',
  // 中文注释：API 调用超时（毫秒）。
  timeoutMs: 60000,
  // 中文注释：单次任务最多携带的图片数量，防止 payload 失控。
  maxImages: 8
};

const IMAGE_EXTENSIONS = [
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp']
];

const MAX_IMAGES_PER_TASK = 8;

// 中文注释：任务描述里引用的图片路径提取器。
// 中文注释：只认私有目录（home）内的图片 —— 越界路径直接丢弃，这是"私密外置"原则的延伸：
// 中文注释任务文本可能来自远端 planner（不受信任），绝不能让它指挥本机去读 home 之外的文件。
// 中文注释限制：路径中含空格时无法识别（按空白分词），这是接受的取舍。
export function extractImagePaths(requestText, home) {
  const tokens = String(requestText ?? '').split(/[\s"'，。；！？、（）()【】<>]+/).filter(Boolean);
  const seen = new Set();
  const found = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const ext = IMAGE_EXTENSIONS.find(([suffix]) => lower.endsWith(suffix));
    if (!ext) continue;
    // 中文注释：解析并强制限制在私有目录内；越界（../、别的盘符、UNC）返回 null。
    const resolved = resolveContainedPath(home, token);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    found.push({ path: resolved, mime: ext[1] });
    if (found.length >= MAX_IMAGES_PER_TASK) break; // 中文注释：硬上限，防止异常长文本。
  }
  return found;
}

// 中文注释：读图片并转 base64 data URI；文件不存在或读取失败返回 null（调用方跳过）。
async function readImageAsDataUri(image) {
  try {
    const info = await stat(image.path);
    if (!info.isFile()) return null;
    const buf = await readFile(image.path);
    return `data:${image.mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export class ExecutorError extends Error {
  constructor(message, code = 'executor_error') {
    super(message);
    this.name = 'ExecutorError';
    this.code = code;
  }
}

// 中文注释：调用 AI API 执行任务。返回 AI 的回答文本。
async function callAI({ apiEndpoint, apiKey, model, messages, timeoutMs, reasoningEffort = null }) {
  if (!apiEndpoint) throw new ExecutorError('未配置 executor.apiEndpoint', 'missing_endpoint');
  if (!apiKey) throw new ExecutorError('未配置 executor.apiKey', 'missing_key');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 60000));

  try {
    const payload = { model, messages, temperature: 0.3 };
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
      // 中文注释：视觉路由 —— 任务引用了私有目录内的图片时，改走多模态消息并换用视觉模型。
      const images = home ? extractImagePaths(task.request, home) : [];
      const dataUris = [];
      for (const image of images) {
        const uri = await readImageAsDataUri(image);
        if (uri) dataUris.push(uri);
      }
      const routedToVision = dataUris.length > 0;
      const usedModel = routedToVision
        ? (executorConfig.visionModel || executorConfig.model)
        : executorConfig.model;

      const userContent = routedToVision
        ? [
            { type: 'text', text: task.request },
            ...dataUris.map((url) => ({ type: 'image_url', image_url: { url } }))
          ]
        : task.request;

      const { content, usage } = await callAI({
        apiEndpoint: executorConfig.apiEndpoint,
        apiKey: executorConfig.apiKey,
        model: usedModel,
        timeoutMs: executorConfig.timeoutMs,
        reasoningEffort: executorConfig.reasoningEffort ?? null,
        messages: [
          { role: 'system', content: executorConfig.systemPrompt },
          { role: 'user', content: userContent }
        ]
      });

      // 中文注释：记录 token 用量到账本，模型记实际使用的那个。
      if (usage && store) {
        try {
          store.recordTokenUsage({
            taskId: task.id,
            workerId: 'ai-executor',
            model: usedModel,
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

      // 中文注释：诚实标注 —— 引用了图片但部分没读到的，必须让用户知道模型没看到全部。
      const skipped = images.length - dataUris.length;
      const note = skipped > 0 ? `（注意：${skipped} 个引用图片无法读取或越界，已跳过）` : '';

      return {
        outcome: evidence.length > 0 ? 'completed' : 'partial',
        summary: content.slice(0, 200) + note,
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
