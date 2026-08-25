import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyConfigPatch, renderPage, startServer, testChatEndpoint } from '../scripts/config-ui.mjs';
import { loadConfig } from '../src/core/config.mjs';

// 中文注释：与 config.test.mjs 同款套路：临时目录当私有 home，用完即删。
function withHome(work) {
  const home = mkdtempSync(join(tmpdir(), 'ddt-config-ui-'));
  try {
    return work(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('applyConfigPatch：空配置 + 合法补丁 = 生成完整可校验的配置', () => {
  const outcome = applyConfigPatch('', {
    planner: { apiKey: 'EXAMPLE-key-0000000000' }
  });
  assert.equal(outcome.ok, true);
  const parsed = JSON.parse(outcome.text);
  // 中文注释：没填的字段保持"用户未设置"，由默认值兜底，不该被写成 undefined。
  assert.equal(parsed.planner.apiKey, 'EXAMPLE-key-0000000000');
  assert.equal(parsed.planner.model, undefined);
});

test('applyConfigPatch：只动表单管的字段，其余既有字段原样保留', () => {
  const raw = `${JSON.stringify({
    planner: { model: 'deepseek-chat', apiKey: 'keep-me' },
    integrations: { multica: { enabled: false } },
    myExtraKey: { note: '用户自己加的' }
  }, null, 2)}\n`;
  const outcome = applyConfigPatch(raw, { executor: { apiKey: 'new-key' } });
  assert.equal(outcome.ok, true);
  const parsed = JSON.parse(outcome.text);
  assert.equal(parsed.planner.model, 'deepseek-chat');
  assert.equal(parsed.planner.apiKey, 'keep-me');
  assert.equal(parsed.integrations.multica.enabled, false);
  assert.deepEqual(parsed.myExtraKey, { note: '用户自己加的' });
  assert.equal(parsed.executor.apiKey, 'new-key');
});

test('applyConfigPatch：非法值必须整单拒绝且给出字段级原因', () => {
  const outcome = applyConfigPatch('', {
    execution: { workerMaxMinutes: 'abc' },
    scheduler: { pollSeconds: -1 }
  });
  assert.equal(outcome.ok, false);
  assert.ok(Array.isArray(outcome.problems));
  assert.ok(outcome.problems.some((p) => p.includes('execution.workerMaxMinutes')));
  assert.ok(outcome.problems.some((p) => p.includes('scheduler.pollSeconds')));
});

test('applyConfigPatch：现有文件坏了要报 fatal，绝不在坏底子上继续写', () => {
  const outcome = applyConfigPatch('{ "planner": ', {});
  assert.equal(outcome.ok, false);
  assert.match(outcome.fatal, /不是合法 JSON/);
});

test('applyConfigPatch：module 留空存 null（合法），填了非空串也合法', () => {
  assert.equal(applyConfigPatch('', { execution: { module: null } }).ok, true);
  assert.equal(applyConfigPatch('', { execution: { module: 'executor/index.mjs' } }).ok, true);
  assert.equal(applyConfigPatch('', { execution: { module: '   ' } }).ok, false);
});

test('renderPage：注入的 INITIAL 转义了 <，不会提前闭合 script 标签', () => {
  const html = renderPage({ planner: { apiKey: '</script><b>x' } }, { home: 'h', configPath: 'p', exists: false });
  assert.ok(html.includes('<!doctype html>'));
  assert.ok(!html.includes('</script><b>x'));
});

withHome((home) => {
  test('本地服务端到端：读页、保存落盘、连通测试返回结构化结果', async (t) => {
    const server = startServer({ home, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;

    const page = await (await fetch(base)).text();
    assert.ok(page.includes('Daily Twin 私有配置'));

    const saveRes = await fetch(`${base}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { planner: { apiKey: 'EXAMPLE-e2e-key-000000', model: 'test-model' } } })
    });
    const saved = await saveRes.json();
    assert.equal(saved.ok, true);

    const configPath = join(home, 'config', 'runtime.json');
    assert.equal(existsSync(configPath), true);
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(onDisk.planner.model, 'test-model');

    const { config } = await loadConfig(home);
    assert.equal(config.planner.model, 'test-model');

    // 中文注释：把测试请求打回本服务的 /api/save——它返回的是 JSON 但没有
    // 中文注释：choices 字段，正好走"通了但响应不对"的结构化失败路径，不依赖外网。
    const testRes = await fetch(`${base}/api/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiEndpoint: `${base}/api/save`, apiKey: 'EXAMPLE-stub', model: 'x' })
    });
    const tested = await testRes.json();
    assert.equal(tested.ok, false);
    assert.ok(tested.code === 'bad_json' || tested.code === 'empty_reply');

    const missing = await testChatEndpoint({});
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'missing_config');
  });
});
