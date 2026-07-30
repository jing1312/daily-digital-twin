import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PlaywrightEdgeDriver, buildPlaywrightMcpArgs, buildPlaywrightMcpLaunch } from '../src/integrations/playwright-edge-driver.mjs';
import * as edgeModule from '../src/integrations/playwright-edge-driver.mjs';

function fakeClient() {
  const calls = [];
  return {
    calls,
    async callTool(request) {
      calls.push(request);
      if (request.name === 'browser_tabs' && request.arguments.action === 'new') {
        return { content: [{ type: 'text', text: '- 0: (current) [Biomni](https://biomni.example.invalid)' }] };
      }
      if (request.name === 'browser_tabs' && request.arguments.action === 'list') {
        return { content: [{ type: 'text', text: '- 0: (current) [Biomni](https://biomni.example.invalid)' }] };
      }
      if (request.name === 'browser_evaluate') {
        const text = request.arguments.function.includes('window.name') ? '"DT:task-1"' : '"目标内容"';
        return { content: [{ type: 'text', text }] };
      }
      if (request.name === 'browser_take_screenshot') {
        return { content: [{ type: 'text', text: 'Screenshot saved to DT-1/evidence.png' }] };
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  };
}

test('Playwright MCP 固定使用 msedge + extension，不含 Chrome 回退', () => {
  const args = buildPlaywrightMcpArgs({ outputDir: 'D:\\private\\screenshots' });
  assert.deepEqual(args.slice(0, 4), ['--browser', 'msedge', '--extension', '--caps']);
  assert.ok(args.includes('devtools'));
  assert.ok(args.includes('--image-responses'));
  assert.equal(args.includes('chrome'), false);
});

test('默认 Playwright MCP 使用仓库内已安装 CLI，不依赖系统 PATH', () => {
  const launch = buildPlaywrightMcpLaunch({
    command: 'playwright-mcp',
    outputDir: 'D:\\private\\screenshots'
  });
  assert.equal(launch.command, process.execPath);
  assert.match(launch.args[0].replaceAll('\\', '/'), /node_modules\/@playwright\/mcp\/cli\.js$/);
  assert.deepEqual(launch.args.slice(1, 5), ['--browser', 'msedge', '--extension', '--caps']);
});

test('新建任务标签后写入本机归属标记，后续按标记确认所有权', async () => {
  const client = fakeClient();
  const driver = new PlaywrightEdgeDriver({ client, outputDir: 'D:\\private\\screenshots' });
  const opened = await driver.open({ url: 'https://biomni.example.invalid', taskId: 'task-1' });
  assert.match(opened.targetId, /^edge:0:/);
  assert.deepEqual(client.calls[0], {
    name: 'browser_tabs', arguments: { action: 'new', url: 'https://biomni.example.invalid' }
  });
  assert.equal(client.calls[1].name, 'browser_evaluate');
  assert.equal(await driver.ownsTarget(opened.targetId), true);
});

test('window.name 只允许完整相等，包含任务标记的其他页面不算归属页', async () => {
  const client = {
    async callTool(request) {
      if (request.name === 'browser_tabs' && request.arguments.action === 'list') {
        return { content: [{ type: 'text', text: '- 0: (current) [Other](https://other.test)' }] };
      }
      if (request.name === 'browser_evaluate') {
        return { content: [{ type: 'text', text: '"OTHER-DT:task-1"' }] };
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  };
  const driver = new PlaywrightEdgeDriver({ client, outputDir: 'D:\\private\\screenshots' });
  assert.equal(await driver.ownsTarget('edge:0:DT%3Atask-1'), false);
});

test('fill 的 selector 和文本用 JSON 字面量封装，不允许拼出额外代码', async () => {
  const client = fakeClient();
  const driver = new PlaywrightEdgeDriver({ client, outputDir: 'D:\\private\\screenshots' });
  await driver.fill({ targetId: 'edge:0:DT%3Atask-1', selector: 'input[name="q"]', text: 'x\"); throw new Error("boom' });
  const code = client.calls.at(-1).arguments.code;
  assert.match(code, /page\.locator/);
  assert.match(code, /\.fill/);
  assert.doesNotMatch(code, /fill\("x"\); throw/);
});

test('截图文件始终落在指定私有 outputDir 下', async () => {
  const client = fakeClient();
  const outputDir = 'D:\\private\\screenshots';
  const driver = new PlaywrightEdgeDriver({ client, outputDir });
  const captured = await driver.capture({ targetId: 'edge:0:DT%3Atask-1', taskId: 'DT-1' });
  assert.equal(captured.path, join(outputDir, 'DT-1', 'evidence.png'));
  assert.equal(client.calls.some((call) => call.name === 'browser_take_screenshot'), true);
});

test('Edge 连接按首次网页动作惰性建立，启动机器人本身不连接浏览器', async () => {
  assert.equal(typeof edgeModule.createLazyPlaywrightEdge, 'function');
  let connects = 0;
  const calls = [];
  const lazy = edgeModule.createLazyPlaywrightEdge({
    connect: async () => {
      connects += 1;
      return {
        async open(args) { calls.push(args); return { targetId: 'edge:1:task' }; },
        async close() { calls.push('close'); }
      };
    }
  });
  assert.equal(connects, 0);
  await lazy.open({ url: 'https://example.test', taskId: 'DT-20260730-0001' });
  await lazy.open({ url: 'https://example.test/2', taskId: 'DT-20260730-0002' });
  assert.equal(connects, 1);
  await lazy.close();
  assert.equal(calls.at(-1), 'close');
});

test('Edge 首次配对失败不会缓存失败，下一次任务可以重新连接', async () => {
  assert.equal(typeof edgeModule.createLazyPlaywrightEdge, 'function');
  let connects = 0;
  const lazy = edgeModule.createLazyPlaywrightEdge({
    connect: async () => {
      connects += 1;
      if (connects === 1) throw new Error('extension not connected');
      return { async open() { return { targetId: 'edge:2:task' }; } };
    }
  });
  await assert.rejects(() => lazy.open({}), /extension not connected/);
  assert.deepEqual(await lazy.open({}), { targetId: 'edge:2:task' });
  assert.equal(connects, 2);
});

test('截图前隐藏密码和验证码输入框，不读取其中的值', async () => {
  const client = fakeClient();
  const driver = new PlaywrightEdgeDriver({ client, outputDir: 'D:\\Private\\screenshots' });
  await driver.capture({
    targetId: 'edge:0:DT%3Atask-1',
    taskId: 'DT-20260730-0001',
    sensitiveSelectors: ['#challenge-code']
  });
  const names = client.calls.map((call) => call.name);
  assert.ok(names.indexOf('browser_evaluate') < names.indexOf('browser_take_screenshot'));
  const mask = client.calls.find((call) => call.name === 'browser_evaluate')?.arguments?.function ?? '';
  assert.match(mask, /input\[type=.*password/i);
  assert.match(mask, /one-time-code/i);
  assert.match(mask, /#challenge-code/);
  assert.doesNotMatch(mask, /\.value\b|inputValue/i);
});

test('截图完成或失败后都恢复敏感输入框样式，不污染日常 Edge 页面', async () => {
  const calls = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      if (request.name === 'browser_take_screenshot') {
        return { isError: true, content: [{ type: 'text', text: 'screenshot failed' }] };
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  };
  const driver = new PlaywrightEdgeDriver({ client, outputDir: 'D:\\Private\\screenshots' });

  await assert.rejects(
    () => driver.capture({ targetId: 'edge:0:DT%3Atask-1', taskId: 'DT-20260730-0001' }),
    /screenshot failed/
  );

  const evaluations = calls.filter((call) => call.name === 'browser_evaluate');
  assert.equal(evaluations.length, 2, '遮罩后必须再执行一次恢复');
  assert.match(evaluations[0].arguments.function, /setProperty\('color'/);
  assert.match(evaluations[1].arguments.function, /removeAttribute|setAttribute/);
  assert.doesNotMatch(evaluations[1].arguments.function, /\.value\b|inputValue/i);
});

test('Edge 标签索引变化后按 window.name 标记重新定位任务标签', async () => {
  let selected = 0;
  const client = {
    async callTool(request) {
      if (request.name === 'browser_tabs' && request.arguments.action === 'list') {
        return { content: [{ type: 'text', text: '- 0: [Other](https://other.test)\n- 1: (current) [Biomni](https://biomni.test)' }] };
      }
      if (request.name === 'browser_tabs' && request.arguments.action === 'select') {
        selected = request.arguments.index;
        return { content: [{ type: 'text', text: 'selected' }] };
      }
      if (request.name === 'browser_evaluate') {
        return { content: [{ type: 'text', text: JSON.stringify(selected === 1 ? 'DT:task-1' : '') }] };
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  };
  const driver = new PlaywrightEdgeDriver({ client, outputDir: 'D:\\private\\screenshots' });

  const recovered = await driver.recoverTarget({ targetId: 'edge:0:DT%3Atask-1', marker: 'DT:task-1' });

  assert.equal(recovered, 'edge:1:DT%3Atask-1');
});

test('页面等待在本机同时观察结果和人机阻断，保留 15 分钟配置', async () => {
  const client = fakeClient();
  const original = client.callTool.bind(client);
  client.callTool = async (request) => {
    if (request.name === 'browser_run_code_unsafe') {
      client.calls.push(request);
      return { content: [{ type: 'text', text: '"verification_required"' }] };
    }
    return original(request);
  };
  const driver = new PlaywrightEdgeDriver({ client, outputDir: 'D:\\private\\screenshots' });

  const result = await driver.wait({
    targetId: 'edge:0:DT%3Atask-1',
    condition: '任务完成',
    timeoutMs: 900_000,
    verificationSelector: 'input[autocomplete="one-time-code"]',
    loginSelector: 'form[action*="login"]'
  });

  assert.deepEqual(result, { status: 'verification_required' });
  const code = client.calls.find((call) => call.name === 'browser_run_code_unsafe').arguments.code;
  assert.match(code, /900000/);
  assert.match(code, /one-time-code/);
  assert.match(code, /form\[action/);
});

test('验证码使用敏感填写通道且不回读输入值', async () => {
  const client = fakeClient();
  const driver = new PlaywrightEdgeDriver({ client, outputDir: 'D:\\private\\screenshots' });

  await driver.fillSensitive({
    targetId: 'edge:0:DT%3Atask-1',
    selector: 'input[autocomplete="one-time-code"]',
    text: '739105""); throw new Error("leak'
  });

  const code = client.calls.find((call) => call.name === 'browser_run_code_unsafe').arguments.code;
  assert.match(code, /\.fill\(/);
  assert.doesNotMatch(code, /inputValue|\.value\b/);
  assert.doesNotMatch(code, /fill\("739105""\); throw/);
});
