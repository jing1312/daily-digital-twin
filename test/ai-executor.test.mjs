import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAIExecutor, createCompositeExecutor, ExecutorError } from '../src/core/ai-executor.mjs';

describe('ai-executor — 未配置 API', () => {
  test('没有 API 配置时返回 partial，不谎报完成', async () => {
    const executor = await createAIExecutor({ config: {} });
    const result = await executor({
      task: { id: 1, request: '写一篇文章', taskType: 'ai_call' },
      store: null,
      config: {}
    });
    assert.equal(result.outcome, 'partial');
    assert.ok(result.reason.includes('未配置'));
  });

  test('apiEndpoint 为 null 时返回 partial', async () => {
    const executor = await createAIExecutor({
      config: { executor: { apiEndpoint: null, apiKey: 'test' } }
    });
    const result = await executor({
      task: { id: 1, request: '任务', taskType: 'ai_call' },
      store: null,
      config: {}
    });
    assert.equal(result.outcome, 'partial');
  });
});

describe('ai-executor — 任务类型路由', () => {
  test('desktop 类型返回 partial 并说明需要桌面执行器', async () => {
    const executor = await createAIExecutor({ config: {} });
    const result = await executor({
      task: { id: 1, request: '打开 Excel', taskType: 'desktop' },
      store: null,
      config: {}
    });
    assert.equal(result.outcome, 'partial');
    assert.ok(result.reason.includes('desktop'));
  });

  test('browser 类型返回 partial 并说明需要浏览器执行器', async () => {
    const executor = await createAIExecutor({ config: {} });
    const result = await executor({
      task: { id: 1, request: '登录网站', taskType: 'browser' },
      store: null,
      config: {}
    });
    assert.equal(result.outcome, 'partial');
    assert.ok(result.reason.includes('browser'));
  });
});

describe('ai-executor — 复合执行器', () => {
  test('ai_call 类型交给 AI 执行器', async () => {
    const executor = await createCompositeExecutor({ config: {} });
    const result = await executor({
      task: { id: 1, request: '写文案', taskType: 'ai_call' },
      store: null,
      config: {}
    });
    // 没有配置 API，所以是 partial
    assert.equal(result.outcome, 'partial');
  });

  test('desktop 类型返回 partial', async () => {
    const executor = await createCompositeExecutor({ config: {} });
    const result = await executor({
      task: { id: 1, request: '打开 Excel', taskType: 'desktop' },
      store: null,
      config: {}
    });
    assert.equal(result.outcome, 'partial');
    assert.ok(result.reason.includes('desktop'));
  });

  test('browser 类型返回 partial', async () => {
    const executor = await createCompositeExecutor({ config: {} });
    const result = await executor({
      task: { id: 1, request: '登录网站', taskType: 'browser' },
      store: null,
      config: {}
    });
    assert.equal(result.outcome, 'partial');
    assert.ok(result.reason.includes('browser'));
  });

  test('unknown 类型尝试用 AI 执行', async () => {
    const executor = await createCompositeExecutor({ config: {} });
    const result = await executor({
      task: { id: 1, request: '随便做点什么', taskType: 'unknown' },
      store: null,
      config: {}
    });
    // 没有配置 API，所以是 partial，但不应该是"不处理"的原因
    assert.equal(result.outcome, 'partial');
  });
});

describe('ai-executor — mock fetch', () => {
  test('配置了 API 时调用 fetch 并返回 completed（有文件证据）', async () => {
    // 中文注释：mock global.fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '这是 AI 的回答' } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 }
        })
      };
    };

    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const os = await import('node:os');
      const tmpDir = join(os.tmpdir(), `ai-executor-test-${Date.now()}`);

      const executor = await createAIExecutor({
        home: tmpDir,
        config: {
          executor: {
            apiEndpoint: 'YOUR_API_ENDPOINT',
            apiKey: 'YOUR_API_KEY',
            model: 'gpt-4o-mini'
          }
        }
      });

      const result = await executor({
        task: { id: 42, request: '写一段关于猫的文案', taskType: 'ai_call' },
        store: null,
        config: {}
      });

      assert.equal(result.outcome, 'completed');
      assert.ok(result.summary);
      assert.ok(result.evidence.length > 0);
      assert.equal(result.evidence[0].kind, 'file');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('API 返回错误时返回 failed', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error'
    });

    try {
      const executor = await createAIExecutor({
        config: {
          executor: {
            apiEndpoint: 'YOUR_API_ENDPOINT',
            apiKey: 'YOUR_API_KEY',
            model: 'gpt-4o-mini'
          }
        }
      });

      const result = await executor({
        task: { id: 1, request: '任务', taskType: 'ai_call' },
        store: null,
        config: {}
      });

      assert.equal(result.outcome, 'failed');
      assert.ok(result.reason.includes('500'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
