// 中文注释：浏览器路由。docs/superpowers/specs/2026-07-27-browser-routing-design.md 之前只有设计文档，src/ 里没有实现（修 B15）。
// 中文注释：这里同时把一个必须澄清的事实编码进代码：内置 chrome profile 驱动的是 Chrome，不是 Edge。
// 中文注释：完整说明见 docs/BROWSER-PROFILES.md。

export const BROWSER_PROFILES = {
  // 中文注释：受管隔离浏览器，自带持久化用户数据目录，无人值守可用；代价是站点要单独登录一次。
  openclaw: {
    driver: 'managed',
    browser: 'openclaw-managed-chromium',
    usesExistingLogin: false,
    unattended: true,
    documented: true,
    note: '受管隔离浏览器。不接触日常浏览器登录态，适合 7×24 无人值守。'
  },
  // 中文注释：挂接真实登录的 Chrome，但会弹出阻塞式"允许远程调试？"，必须有人在电脑前点。
  user: {
    driver: 'cdp-attach',
    browser: 'chrome',
    usesExistingLogin: true,
    unattended: false,
    documented: true,
    note: '挂接真实 Chrome，会弹出远程调试授权提示，需要有人在电脑前确认。'
  },
  // 中文注释：Chrome 扩展模式。官方文档中唯一"无人值守 + 已登录浏览器"的组合，但驱动的是 Chrome。
  chrome: {
    driver: 'extension',
    browser: 'chrome',
    usesExistingLogin: true,
    unattended: true,
    documented: true,
    note: 'Chrome 扩展模式（chrome.debugger）。名字就是 Chrome —— 它不会打开 Edge。'
  },
  // 中文注释：把扩展装进 Edge，理论可行（Edge 是 Chromium 内核），但官方文档只写 Chrome，本项目尚未验证。
  'edge-extension': {
    driver: 'extension',
    browser: 'edge',
    usesExistingLogin: true,
    unattended: true,
    documented: false,
    note: '未验证：官方文档只覆盖 Chrome。使用前必须按 docs/BROWSER-PROFILES.md 的步骤实测。'
  },
  // 中文注释：直接挂 Edge 的用户数据目录，需要有人在 edge://inspect 授权。
  'edge-existing-session': {
    driver: 'existing-session',
    browser: 'edge',
    usesExistingLogin: true,
    unattended: false,
    documented: true,
    requiresUserDataDir: true,
    note: '挂接现有 Edge 会话，需要有人在 edge://inspect/#remote-debugging 授权。'
  }
};

export function describeProfile(name) {
  return BROWSER_PROFILES[name] ?? null;
}

// 中文注释：从 URL 里取出主机名。取不到就返回 null —— 宁可不判断，也不要拿半截字符串去匹配。
export function hostnameOf(url) {
  if (typeof url !== 'string') return null;
  // 中文注释：任务文本是人从手机上打过来的，URL 前后粘上空白是常态。
  // 中文注释：WHATWG 的 new URL() 自己会去掉半角空格和 Tab/换行，所以那几种本来就没问题；
  // 中文注释：但它不认全角空格 U+3000 和不换行空格 U+00A0 —— 中文输入法打出来的恰恰是全角空格。
  // 中文注释：'　https://feishu.cn' 会让 new URL() 直接抛错，hostname 退化成 null，
  // 中文注释：登录态提示就从「具体到 feishu.cn」掉回「泛泛而谈」。JS 的 trim() 认这两个，所以用 trim 之后的串去解析。
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  try {
    const hostname = new URL(trimmed).hostname.toLowerCase();
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

// 中文注释：登记表的匹配规则只有两条，刻意保持可预测：
// 中文注释：  'example.com'  只匹配 example.com 本身；
// 中文注释：  '.example.com' 匹配 example.com 及其任意子域名（沿用 cookie 域的写法）。
export function isHostLoggedIn(hostname, entries = []) {
  if (!hostname || !Array.isArray(entries)) return false;
  const target = hostname.toLowerCase();
  return entries.some((raw) => {
    if (typeof raw !== 'string') return false;
    const entry = raw.trim().toLowerCase();
    if (entry.length === 0) return false;
    if (entry.startsWith('.')) {
      const bare = entry.slice(1);
      return bare.length > 0 && (target === bare || target.endsWith(entry));
    }
    return target === entry;
  });
}

// 中文注释：决定一次浏览器动作应该走哪个 profile，并把所有已知风险以 warnings 显式返回。
export function routeBrowserAction({
  url = null,
  requiresSignedInSession = false,
  unattended = true,
  preferredBrowser = null,
  config = {}
} = {}) {
  const browserConfig = config.browser ?? {};
  const defaultProfile = browserConfig.defaultProfile ?? 'openclaw';
  const warnings = [];

  let profileName = defaultProfile;
  if (requiresSignedInSession) {
    if (browserConfig.signedInProfile) {
      profileName = browserConfig.signedInProfile;
    } else {
      warnings.push('任务需要已登录会话，但未配置 browser.signedInProfile，将使用受管浏览器（需在其中单独登录一次）。');
    }
  }

  const profile = BROWSER_PROFILES[profileName];
  if (!profile) {
    return {
      allowed: false,
      reason: 'unknown_profile',
      profile: profileName,
      warnings: [`未知的 browser profile：${profileName}。可选值：${Object.keys(BROWSER_PROFILES).join(' / ')}`]
    };
  }

  // 中文注释：受管浏览器（路线 C）不共享日常浏览器的登录态，每个站点要单独登录一次。
  // 中文注释：这里只发警告、不拒绝执行 —— managedLoggedInHosts 是人手维护的声明，不是观测结果，
  // 中文注释：拿它当拒绝依据的话，一份过期的清单就会挡住本来能跑的任务。
  // 中文注释：真正防"没登录却谎报成功"的是 execution-verifier 的证据要求，不是这张表。
  let signedInHostKnown = null;
  if (requiresSignedInSession && !profile.usesExistingLogin) {
    const hostname = hostnameOf(url);
    signedInHostKnown = hostname === null ? null : isHostLoggedIn(hostname, browserConfig.managedLoggedInHosts ?? []);
    if (signedInHostKnown === true) {
      warnings.push(`${hostname} 已登记为在受管浏览器里登录过；若仍撞上登录墙，说明登录态已过期，需要重新登录一次。`);
    } else if (signedInHostKnown === false) {
      warnings.push(`${hostname} 不在 browser.managedLoggedInHosts 里，受管浏览器大概率没有它的登录态，任务会停在登录页。`);
    } else {
      warnings.push(`profile ${profileName} 不会带上你日常浏览器的登录态，站点需要在受管浏览器里单独登录。`);
    }
  }
  if (preferredBrowser && profile.browser !== preferredBrowser) {
    warnings.push(`你要求使用 ${preferredBrowser}，但 profile ${profileName} 实际驱动 ${profile.browser}。`);
  }
  if (!profile.documented) {
    warnings.push(`profile ${profileName} 尚未在官方文档中覆盖，也未在本项目验证，请先按文档步骤实测。`);
  }
  if (profile.requiresUserDataDir && !browserConfig.edgeUserDataDir) {
    warnings.push(`profile ${profileName} 需要配置 browser.edgeUserDataDir 指向浏览器用户数据目录。`);
  }

  if (unattended && !profile.unattended) {
    return {
      allowed: false,
      reason: 'requires_human_at_computer',
      profile: profileName,
      driver: profile.driver,
      browser: profile.browser,
      warnings: [...warnings, `profile ${profileName} 需要有人在电脑前授权，无法用于无人值守任务。`]
    };
  }

  return {
    allowed: true,
    reason: null,
    profile: profileName,
    driver: profile.driver,
    browser: profile.browser,
    snapshotMode: browserConfig.snapshotMode ?? 'efficient',
    url,
    signedInHostKnown,
    warnings,
    cliArgs: ['--browser-profile', profileName]
  };
}
