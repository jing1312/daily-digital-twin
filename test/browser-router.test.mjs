import assert from 'node:assert/strict';
import test from 'node:test';
import {
  routeBrowserAction,
  describeProfile,
  hostnameOf,
  isHostLoggedIn,
  BROWSER_PROFILES
} from '../src/core/browser-router.mjs';
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

// 中文注释：以下是路线 C（受管隔离浏览器）落地后补的测试。
// 中文注释：路线 C 的唯一代价是"每个站点要单独登录一次"，而这件事没有任何自动记录，
// 中文注释：所以要在路由阶段就把"这个站点还没登录过"讲清楚，而不是让任务停在登录页再去猜原因。

test('受管浏览器上，未登记的站点要被明确警告', () => {
  const route = routeBrowserAction({
    url: 'https://mail.example.com/inbox',
    requiresSignedInSession: true,
    config: { browser: { defaultProfile: 'openclaw', managedLoggedInHosts: ['other.example.com'] } }
  });
  assert.equal(route.allowed, true, '只警告，不拒绝：登记表是人手维护的声明，不是观测结果');
  assert.equal(route.signedInHostKnown, false);
  assert.ok(route.warnings.some((text) => text.includes('mail.example.com') && /登录墙|登录页/.test(text)));
});

test('已登记的站点不再报"没登录"，但要提醒登录态可能过期', () => {
  const route = routeBrowserAction({
    url: 'https://mail.example.com/inbox',
    requiresSignedInSession: true,
    config: { browser: { defaultProfile: 'openclaw', managedLoggedInHosts: ['MAIL.EXAMPLE.COM'] } }
  });
  assert.equal(route.signedInHostKnown, true, '匹配必须忽略大小写');
  assert.ok(route.warnings.some((text) => /过期/.test(text)));
  assert.ok(
    !route.warnings.some((text) => text.includes('不在 browser.managedLoggedInHosts')),
    '已登记的站点不该再收到"未登记"那条警告'
  );
});

test('前导点号的条目匹配子域名，不带点号的只匹配自身', () => {
  assert.equal(isHostLoggedIn('open.feishu.cn', ['.feishu.cn']), true);
  assert.equal(isHostLoggedIn('feishu.cn', ['.feishu.cn']), true, '带点条目也要覆盖裸域名本身');
  assert.equal(isHostLoggedIn('open.feishu.cn', ['feishu.cn']), false, '不带点号时不得放大匹配范围');
  assert.equal(isHostLoggedIn('evilfeishu.cn', ['.feishu.cn']), false, '后缀匹配不能跨过点号边界');
  assert.equal(isHostLoggedIn('feishu.cn', []), false);
  assert.equal(isHostLoggedIn(null, ['.feishu.cn']), false);
});

test('URL 取不出主机名时退回通用提示，不做半截匹配', () => {
  assert.equal(hostnameOf('不是一个 URL'), null);
  assert.equal(hostnameOf(''), null);
  assert.equal(hostnameOf('https://Example.COM/x'), 'example.com');
  const route = routeBrowserAction({
    requiresSignedInSession: true,
    config: { browser: { defaultProfile: 'openclaw', managedLoggedInHosts: ['example.com'] } }
  });
  assert.equal(route.signedInHostKnown, null, '没有 URL 就不能声称知道登录状态');
  assert.ok(route.warnings.some((text) => /单独登录/.test(text)));
});

// 中文注释：这条盯的是全角空格。半角空格和 Tab/换行 new URL() 自己会处理，测了也白测；
// 中文注释：U+3000（中文输入法的空格）和 U+00A0 它不认，而任务文本正是从手机中文输入法来的。
test('URL 前面粘了全角空格照样能取出主机名', () => {
  assert.equal(hostnameOf('\u3000https://Example.COM/x'), 'example.com', '全角空格 U+3000');
  assert.equal(hostnameOf('\u00a0https://feishu.cn/docs'), 'feishu.cn', '不换行空格 U+00A0');
  assert.equal(hostnameOf('  https://feishu.cn/docs  '), 'feishu.cn', '半角空格（本来就该过）');
  assert.equal(hostnameOf('\u3000\u00a0 \t'), null, '全是空白仍然算取不出主机名');
  const route = routeBrowserAction({
    url: '\u3000https://feishu.cn/docs',
    requiresSignedInSession: true,
    config: { browser: { defaultProfile: 'openclaw', managedLoggedInHosts: ['feishu.cn'] } }
  });
  assert.equal(route.signedInHostKnown, true, '一个全角空格不该把已登记的域名打回未知');
  assert.ok(route.warnings.some((text) => text.includes('feishu.cn 已登记')));
});

test('使用真实登录态的 profile 不需要登记表', () => {
  const route = routeBrowserAction({
    url: 'https://mail.example.com/inbox',
    requiresSignedInSession: true,
    config: { browser: { defaultProfile: 'openclaw', signedInProfile: 'chrome', managedLoggedInHosts: [] } }
  });
  assert.equal(route.profile, 'chrome');
  assert.equal(route.signedInHostKnown, null);
  assert.ok(!route.warnings.some((text) => /managedLoggedInHosts/.test(text)));
});
