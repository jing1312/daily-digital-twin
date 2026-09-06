// 中文注释：视觉路由测试 —— 任务引用私有目录内图片时，执行器自动换用视觉模型并携带图片。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractImagePaths, createAIExecutor } from '../src/core/ai-executor.mjs';

// 中文注释：每个用例一个独立临时 home，测完删掉；回调可为异步。
async function withTempHome(work) {
  const home = mkdtempSync(join(tmpdir(), 'dt-vision-'));
  try {
    return await work(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('extractImagePaths — 图片路径提取', () => {
  test('识别相对路径并解析到私有目录内', async () => {
    await withTempHome(async (home) => {
      mkdirSync(join(home, 'data', 'shots'), { recursive: true });
      const found = extractImagePaths('看看 data/shots/a.png 里的布局', home);
      assert.equal(found.length, 1);
      assert.equal(found[0].path, join(home, 'data', 'shots', 'a.png'));
      assert.equal(found[0].mime, 'image/png');
    });
  });

  test('识别私有目录内的绝对路径', async () => {
    await withTempHome(async (home) => {
      const inside = join(home, 'shot.jpg');
      const found = extractImagePaths(`分析 ${inside} 的内容`, home);
      assert.equal(found.length, 1);
      assert.equal(found[0].mime, 'image/jpeg');
    });
  });

  test('越界路径一律丢弃 —— 远端 planner 不能指挥本机读 home 之外的文件', async () => {
    await withTempHome(async (home) => {
      const outside = 'C:\\Windows\\system32\\evil.png';
      const found = extractImagePaths(`看看 ${outside} 和 ..\\..\\secret.png`, home);
      assert.equal(found.length, 0);
    });
  });

  test('重复引用去重；非图片扩展名忽略', async () => {
    await withTempHome(async (home) => {
      const inside = join(home, 'a.webp');
      const text = `看 ${inside} 和 ${inside}，还有 notes.txt`;
      const found = extractImagePaths(text, home);
      assert.equal(found.length, 1);
      assert.equal(found[0].mime, 'image/webp');
    });
  });

  test('中文粘连写法（a.png里的内容）也能提取', async () => {
    await withTempHome(async (home) => {
      mkdirSync(join(home, 'data', 'shots'), { recursive: true });
      const found = extractImagePaths('描述data/shots/b.png里的主要内容', home);
      assert.equal(found.length, 1);
      assert.equal(found[0].path, join(home, 'data', 'shots', 'b.png'));
    });
  });
});

describe('ai-executor — 视觉路由', () => {
  function makePngBytes() {
    // 中文注释：不需要是合法 PNG —— 执行器只做 base64 转发，不解析图片内容。
    return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  }

  test('引用图片时换用 visionModel 并携带 data URI', async () => {
    await withTempHome(async (home) => {
      const shots = join(home, 'data', 'shots');
      mkdirSync(shots, { recursive: true });
      const bytes = makePngBytes();
      writeFileSync(join(shots, 'a.png'), bytes);

      const originalFetch = globalThis.fetch;
      let captured = null;
      globalThis.fetch = async (url, options) => {
        captured = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '图里是一个登录页' } }],
            usage: { prompt_tokens: 200, completion_tokens: 10 }
          })
        };
      };

      try {
        const usedModels = [];
        const store = {
          recordTokenUsage(entry) { usedModels.push(entry.model); }
        };
        const executor = await createAIExecutor({
          home,
          config: {
            executor: {
              apiEndpoint: 'https://example.invalid/v1/chat/completions',
              apiKey: 'k',
              model: 'text-model',
              visionModel: 'vision-model'
            }
          }
        });
        const result = await executor({
          task: { id: 7, request: '描述 data/shots/a.png 里的内容', taskType: 'ai_call' },
          store,
          config: {}
        });

        assert.equal(result.outcome, 'completed');
        assert.equal(captured.model, 'vision-model');
        const userContent = captured.messages[1].content;
        assert.ok(Array.isArray(userContent));
        assert.equal(userContent[0].type, 'text');
        assert.equal(userContent[1].type, 'image_url');
        assert.ok(userContent[1].image_url.url.startsWith('data:image/png;base64,'));
        assert.ok(userContent[1].image_url.url.includes(bytes.toString('base64')));
        assert.deepEqual(usedModels, ['vision-model']);
        assert.ok(!result.summary.includes('跳过'));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  test('没有图片时保持纯文本、用主模型', async () => {
    await withTempHome(async (home) => {
      const originalFetch = globalThis.fetch;
      let captured = null;
      globalThis.fetch = async (url, options) => {
        captured = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '好' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          })
        };
      };
      try {
        const executor = await createAIExecutor({
          home,
          config: { executor: { apiEndpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'k', model: 'text-model', visionModel: 'vision-model' } }
        });
        const result = await executor({
          task: { id: 1, request: '写一句话', taskType: 'ai_call' },
          store: null,
          config: {}
        });
        assert.equal(result.outcome, 'completed');
        assert.equal(captured.model, 'text-model');
        assert.equal(typeof captured.messages[1].content, 'string');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  test('visionModel 未配置时回落到主模型（不失败）', async () => {
    await withTempHome(async (home) => {
      mkdirSync(join(home, 'data'), { recursive: true });
      writeFileSync(join(home, 'data', 'a.png'), makePngBytes());
      const originalFetch = globalThis.fetch;
      let captured = null;
      globalThis.fetch = async (url, options) => {
        captured = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '好' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          })
        };
      };
      try {
        const executor = await createAIExecutor({
          home,
          config: { executor: { apiEndpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'k', model: 'text-model' } }
        });
        const result = await executor({
          task: { id: 2, request: '描述 data/a.png', taskType: 'ai_call' },
          store: null,
          config: {}
        });
        assert.equal(captured.model, 'text-model');
        assert.ok(Array.isArray(captured.messages[1].content));
        assert.equal(result.outcome, 'completed');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  test('引用的图片读不到时跳过并在摘要里如实标注', async () => {
    await withTempHome(async (home) => {
      const originalFetch = globalThis.fetch;
      let captured = null;
      globalThis.fetch = async (url, options) => {
        captured = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '我看不到图' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          })
        };
      };
      try {
        const executor = await createAIExecutor({
          home,
          config: { executor: { apiEndpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'k', model: 'text-model' } }
        });
        const result = await executor({
          task: { id: 3, request: '描述 data/missing.png', taskType: 'ai_call' },
          store: null,
          config: {}
        });
        assert.ok(!Array.isArray(captured.messages[1].content));
        assert.ok(result.summary.includes('1 个引用图片'));
        assert.ok(result.summary.includes('跳过'));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
