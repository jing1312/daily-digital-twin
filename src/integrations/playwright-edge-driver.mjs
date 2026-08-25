import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function resultText(result) {
  return (result?.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

function parseCurrentIndex(text) {
  const match = String(text).match(/^-\s*(\d+):\s*\(current\)/m);
  if (!match) throw new Error('Playwright MCP 没有返回当前 Edge 标签索引');
  return Number(match[1]);
}

function encodeTarget(index, marker) {
  return `edge:${index}:${encodeURIComponent(marker)}`;
}

function decodeTarget(targetId) {
  const match = String(targetId ?? '').match(/^edge:(\d+):(.+)$/);
  if (!match) throw new Error('无效的 Edge targetId');
  return { index: Number(match[1]), marker: decodeURIComponent(match[2]) };
}

function parseSimpleValue(text) {
  const trimmed = String(text ?? '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const quoted = trimmed.match(/"((?:\\.|[^"\\])*)"/g)?.at(-1);
    if (!quoted) return trimmed;
    try { return JSON.parse(quoted); } catch { return trimmed; }
  }
}

export function buildPlaywrightMcpArgs({ outputDir }) {
  return [
    '--browser', 'msedge',
    '--extension',
    '--caps', 'devtools',
    '--snapshot-mode', 'none',
    '--image-responses', 'omit',
    '--output-mode', 'file',
    '--output-dir', outputDir
  ];
}

export function buildPlaywrightMcpLaunch({ command = 'playwright-mcp', outputDir } = {}) {
  const args = buildPlaywrightMcpArgs({ outputDir });
  if (String(command).trim().toLowerCase() === 'playwright-mcp') {
    const cliPath = fileURLToPath(new URL('../../node_modules/@playwright/mcp/cli.js', import.meta.url));
    return { command: process.execPath, args: [cliPath, ...args] };
  }
  return { command, args };
}

export async function connectPlaywrightEdge({ command = 'playwright-mcp', outputDir, cwd, env } = {}) {
  if (!outputDir) throw new Error('Playwright Edge 需要私有截图目录');
  const client = new Client({ name: 'daily-twin-edge-driver', version: '0.2.0' });
  const launch = buildPlaywrightMcpLaunch({ command, outputDir });
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd,
    env,
    stderr: 'pipe'
  });
  await client.connect(transport);
  return new PlaywrightEdgeDriver({ client, outputDir, close: () => client.close() });
}

export function createLazyPlaywrightEdge({ connect } = {}) {
  if (typeof connect !== 'function') throw new Error('惰性 Edge 驱动缺少连接函数');
  let driver = null;
  let connecting = null;

  async function getDriver() {
    if (driver) return driver;
    if (!connecting) {
      connecting = Promise.resolve().then(connect).then((connected) => {
        if (!connected) throw new Error('Edge 连接没有返回驱动');
        driver = connected;
        return connected;
      }).finally(() => {
        connecting = null;
      });
    }
    return connecting;
  }

  const lazy = {};
  for (const method of ['open', 'ownsTarget', 'recoverTarget', 'fill', 'fillSensitive', 'readValue', 'isVisible', 'submit', 'wait', 'capture']) {
    lazy[method] = async (...args) => {
      const connected = await getDriver();
      if (typeof connected[method] !== 'function') throw new Error(`Edge 驱动缺少方法：${method}`);
      return connected[method](...args);
    };
  }
  lazy.close = async () => {
    const connected = driver;
    driver = null;
    connecting = null;
    await connected?.close?.();
  };
  return lazy;
}

export class PlaywrightEdgeDriver {
  constructor({ client, outputDir, close = null } = {}) {
    if (!client || !outputDir) throw new Error('Playwright Edge driver 需要 client 和 outputDir');
    this.client = client;
    this.outputDir = outputDir;
    this.closeClient = close;
  }

  async call(name, args) {
    const result = await this.client.callTool({ name, arguments: args });
    if (result?.isError) throw new Error(resultText(result) || `${name} 失败`);
    return resultText(result);
  }

  async select(targetId) {
    const target = decodeTarget(targetId);
    await this.call('browser_tabs', { action: 'select', index: target.index });
    return target;
  }

  async open({ url, taskId }) {
    const tabs = await this.call('browser_tabs', { action: 'new', url });
    const index = parseCurrentIndex(tabs);
    const marker = `DT:${taskId}`;
    const functionText = `() => { window.name = ${JSON.stringify(marker)}; return window.name; }`;
    await this.call('browser_evaluate', { function: functionText });
    return { targetId: encodeTarget(index, marker), url };
  }

  async ownsTarget(targetId) {
    const target = decodeTarget(targetId);
    const tabs = await this.call('browser_tabs', { action: 'list' });
    if (!new RegExp(`^-\\s*${target.index}:`, 'm').test(tabs)) return false;
    await this.call('browser_tabs', { action: 'select', index: target.index });
    const marker = parseSimpleValue(await this.call('browser_evaluate', { function: '() => window.name' }));
    return marker === target.marker;
  }

  async recoverTarget({ targetId, marker }) {
    const expected = String(marker || decodeTarget(targetId).marker);
    const tabs = await this.call('browser_tabs', { action: 'list' });
    const indexes = [...String(tabs).matchAll(/^-\s*(\d+):/gm)].map((match) => Number(match[1]));
    for (const index of indexes) {
      try {
        await this.call('browser_tabs', { action: 'select', index });
        const actual = parseSimpleValue(await this.call('browser_evaluate', { function: '() => window.name' }));
        if (actual === expected) return encodeTarget(index, expected);
      } catch {
        // 标签在扫描期间关闭时继续检查其余候选。
      }
    }
    return null;
  }

  async fill({ targetId, selector, text }) {
    await this.select(targetId);
    const code = `async (page) => { const locator = page.locator(${JSON.stringify(selector)}); await locator.fill(${JSON.stringify(text)}); return await locator.inputValue(); }`;
    await this.call('browser_run_code_unsafe', { code });
  }

  async fillSensitive({ targetId, selector, text }) {
    await this.select(targetId);
    const code = `async (page) => { await page.locator(${JSON.stringify(selector)}).fill(${JSON.stringify(text)}); return true; }`;
    await this.call('browser_run_code_unsafe', { code });
  }

  async isVisible({ targetId, selector }) {
    await this.select(targetId);
    const code = `async (page) => await page.locator(${JSON.stringify(selector)}).first().isVisible().catch(() => false)`;
    return parseSimpleValue(await this.call('browser_run_code_unsafe', { code })) === true;
  }

  async readValue({ targetId, selector }) {
    await this.select(targetId);
    const functionText = `() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('registered field missing'); return element.value; }`;
    return parseSimpleValue(await this.call('browser_evaluate', { function: functionText }));
  }

  async submit({ targetId, selector }) {
    await this.select(targetId);
    const code = `async (page) => { await page.locator(${JSON.stringify(selector)}).click(); return { status: 'submitted' }; }`;
    await this.call('browser_run_code_unsafe', { code });
    return { status: 'submitted' };
  }

  async wait({ targetId, condition, timeoutMs, verificationSelector = null, loginSelector = null }) {
    await this.select(targetId);
    const timeout = Math.max(100, Math.min(30 * 60_000, Number(timeoutMs ?? 60_000)));
    const verificationCheck = verificationSelector
      ? `if (await page.locator(${JSON.stringify(verificationSelector)}).first().isVisible().catch(() => false)) return 'verification_required';`
      : '';
    const loginCheck = loginSelector
      ? `if (await page.locator(${JSON.stringify(loginSelector)}).first().isVisible().catch(() => false)) return 'login_required';`
      : '';
    const resultCheck = condition
      ? `if (await page.getByText(${JSON.stringify(condition)}, { exact: false }).first().isVisible().catch(() => false)) return 'ready';`
      : `return 'ready';`;
    const code = `async (page) => {
      const deadline = Date.now() + ${timeout};
      while (Date.now() < deadline) {
        ${verificationCheck}
        ${loginCheck}
        ${resultCheck}
        await page.waitForTimeout(500);
      }
      throw new Error('等待页面结果超时');
    }`;
    const status = parseSimpleValue(await this.call('browser_run_code_unsafe', { code }));
    if (!['ready', 'verification_required', 'login_required'].includes(status)) {
      throw new Error('无法解析页面等待结果');
    }
    return { status };
  }

  async capture({ targetId, taskId, sensitiveSelectors = [] }) {
    await this.select(targetId);
    const selectors = [...new Set([
      'input[type="password"]',
      'input[autocomplete="one-time-code"]',
      'input[name*="password" i]',
      'input[id*="password" i]',
      'input[name*="otp" i]',
      'input[id*="otp" i]',
      'input[name*="verification" i]',
      'input[id*="verification" i]',
      ...(Array.isArray(sensitiveSelectors) ? sensitiveSelectors : [])
    ].filter((value) => typeof value === 'string' && value.trim()))];
    const marker = `data-daily-twin-mask-${randomUUID()}`;
    const maskSensitiveInputs = `() => {
      const selectors = ${JSON.stringify(selectors)};
      for (const element of document.querySelectorAll(selectors.join(','))) {
        element.setAttribute(${JSON.stringify(marker)}, JSON.stringify({
          present: element.hasAttribute('style'),
          styleText: element.getAttribute('style')
        }));
        element.style.setProperty('color', 'transparent', 'important');
        element.style.setProperty('text-shadow', 'none', 'important');
        element.style.setProperty('caret-color', 'transparent', 'important');
      }
      return { masked: document.querySelectorAll(selectors.join(',')).length };
    }`;
    const restoreSensitiveInputs = `() => {
      for (const element of document.querySelectorAll(${JSON.stringify(`[${marker}]`)})) {
        try {
          const saved = JSON.parse(element.getAttribute(${JSON.stringify(marker)}));
          if (saved.present) element.setAttribute('style', saved.styleText ?? '');
          else element.removeAttribute('style');
        } finally {
          element.removeAttribute(${JSON.stringify(marker)});
        }
      }
      return true;
    }`;
    await this.call('browser_evaluate', { function: maskSensitiveInputs });
    const filename = `${taskId}/evidence.png`;
    let screenshotFailure = null;
    try {
      await this.call('browser_take_screenshot', { type: 'png', filename, fullPage: true });
    } catch (error) {
      screenshotFailure = error;
    }
    try {
      await this.call('browser_evaluate', { function: restoreSensitiveInputs });
    } catch (error) {
      if (!screenshotFailure) throw error;
    }
    if (screenshotFailure) throw screenshotFailure;
    return { path: join(this.outputDir, filename) };
  }

  async close() {
    await this.closeClient?.();
  }
}
