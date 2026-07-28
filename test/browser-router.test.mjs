import assert from 'node:assert/strict';
import test from 'node:test';
import { routeBrowserAction, describeProfile, BROWSER_PROFILES } from '../src/core/browser-router.mjs';
import { DEFAULT_CONFIG } from '../src/core/config.mjs';

test('B15：浏览器路由已有实现，不再只是一份设计文档', () => {
  // 修复前：仓库里只有 126 行路由设计文档，src/ 里没有任何实现，
  // 修复前：而 PowerShell 脚本把 --browser-profile chrome 硬编码死。
  const route = routeBrowserAction({ url: 'https://example.invalid', config: DEFAULT_CONFIG });
  assert.equal(route.allowed, true);
  assert.equal(route.profile, 'openclaw', '默认应使用受管浏览器');
  assert.deepEqual(route.cliArgs, ['--browser-profile', 'openclaw'], 'profile 必须由路由决定并传给脚本');
});

test('B15b：内置 chrome profile 驱动的是 Chrome，不是 Edge', () => {
  // 中文注释：这是本轮最关键的事实澄清 —— README 曾声称"Edge 动作通过已配对的 chrome profile 执行"，
  // 中文注释：而该 profile 按定义就是 Chrome 扩展模式，它永远不会打开 Edge。
  assert.equal(BROWSER_PROFILES.chrome.browser, 'chrome');
  assert.equal(BROWSER_PROFILES.chrome.driver, 'extension');

  const route = routeBrowserAction({
    preferredBrowser: 'edge',
    config: { browser: { defaultProfile: 'chrome' } }
  });
  assert.equal(route.allowed, true);
  assert.equal(route.browser, 'chrome');
  assert.ok(
    route.warnings.some((text) => /实际驱动 chrome/.test(text)),
    '要求 Edge 却路由到 Chrome 时必须显式警告，而不是默默打开另一个浏览器'
  );
});

test('B15c：无人值守任务不得路由到需要人工授权的 profile', () => {
  for (const profileName of ['user', 'edge-existing-session']) {
    const route = routeBrowserAction({
      unattended: true,
      config: { browser: { defaultProfile: profileName } }
    });
    assert.equal(route.allowed, false, `${profileName} 不应用于无人值守`);
    assert.equal(route.reason, 'requires_human_at_computer');
    assert.ok(route.warnings.some((text) => /有人在电脑前/.test(text)));
  }
});

test('有人在电脑前时允许使用挂接真实登录态的 profile', () => {
  const route = routeBrowserAction({
    unattended: false,
    requiresSignedInSession: true,
    config: { browser: { defaultProfile: 'openclaw', signedInProfile: 'user' } }
  });
  assert.equal(route.allowed, true);
  assert.equal(route.profile, 'user');
  assert.equal(route.browser, 'chrome');
});

test('未验证的 Edge 扩展方案会被明确标注为未验证', () => {
  const route = routeBrowserAction({
    requiresSignedInSession: true,
    config: { browser: { defaultProfile: 'openclaw', signedInProfile: 'edge-extension' } }
  });
  assert.equal(route.allowed, true, 'Edge 扩展理论上可无人值守');
  assert.equal(describeProfile('edge-extension').documented, false);
  assert.ok(
    route.warnings.some((text) => /未验证|尚未在官方文档/.test(text)),
    '未验证的方案必须警告，不能让用户以为它已经能用'
  );
});

test('需要已登录会话但未配置 signedInProfile 时给出可操作提示', () => {
  const route = routeBrowserAction({ requiresSignedInSession: true, config: DEFAULT_CONFIG });
  assert.equal(route.allowed, true);
  assert.equal(route.profile, 'openclaw');
  assert.ok(route.warnings.some((text) => /signedInProfile/.test(text)));
  assert.ok(route.warnings.some((text) => /单独登录/.test(text)), '要说明受管浏览器需要单独登录一次');
});

test('挂接现有 Edge 会话缺少用户数据目录时给出提示', () => {
  const route = routeBrowserAction({
    unattended: false,
    config: { browser: { defaultProfile: 'edge-existing-session' } }
  });
  assert.ok(route.warnings.some((text) => /edgeUserDataDir/.test(text)));
});

test('未知 profile 名称被拒绝并列出可选值', () => {
  const route = routeBrowserAction({ config: { browser: { defaultProfile: 'firefox' } } });
  assert.equal(route.allowed, false);
  assert.equal(route.reason, 'unknown_profile');
  assert.ok(route.warnings[0].includes('openclaw'), '要告诉用户有哪些合法取值');
  assert.equal(describeProfile('firefox'), null);
});

test('快照模式默认取 efficient 以压低上下文开销', () => {
  assert.equal(routeBrowserAction({ config: DEFAULT_CONFIG }).snapshotMode, 'efficient');
  assert.equal(
    routeBrowserAction({ config: { browser: { defaultProfile: 'openclaw', snapshotMode: 'full' } } }).snapshotMode,
    'full'
  );
});
