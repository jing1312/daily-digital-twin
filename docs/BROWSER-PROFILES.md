# 浏览器路线选择（为什么"用 Edge"一直没成功）

> 这份文档取代 `docs/superpowers/specs/2026-07-27-browser-routing-design.md` 里
> "Edge is the default for every browser task" 这条策略。那句话是错的，见下文"更正记录"。

## 先给结论

1. **内置的 `chrome` profile 按定义就是 Chrome。** 它不是"浏览器"的通用叫法，而是一个具体
   实现：Chrome 扩展驱动（`driver: "extension"`）。把 `--browser-profile chrome` 写进脚本，
   永远不会打开 Edge。
2. **`tools.profile: "coding"` 根本不含 `browser` 工具**，所以在配好 profile 之前，浏览器
   动作连"被拒绝"都不会发生——工具不存在。
3. **在"无人值守 + 复用已登录浏览器"这两个要求同时成立时，官方文档只覆盖一条路线：Chrome 扩展模式。**
   Edge 能不能装同一个扩展，官方没写，本项目也没验证过。

本项目当前默认走 **受管隔离浏览器（`openclaw` profile）**，代价是常用网站要在替身专用浏览器里
单独登录一次。这是唯一"文档覆盖 + 无人值守 + 不需要你坐在电脑前"的组合。

> **2026-07-28 决定：正式采用路线 C（受管隔离浏览器）。**
> 配套落地物：`platform/windows/Set-OpenClawBrowserProfile.ps1`（改 `openclaw.json`，默认只预览）、
> `browser.managedLoggedInHosts`（登记哪些站点已经在受管浏览器里登录过）。
> 路线 B 和路线 A 的说明保留，作为将来切换时的依据，但**当前不是默认**。

## 三个原因，按发生顺序

### 原因一：工具被 profile 过滤掉了

`browser` 工具属于 `group:ui`。`tools.profile: "coding"` 这个预设不包含 `group:ui`，
因此浏览器工具在 coding profile 下是不可见的。

正确的开启方式是 `tools.alsoAllow`（追加），而不是 `tools.allow`（替换）：

```jsonc
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["browser"]
  }
}
```

两个关键细节：

- `tools.allow` 与 `tools.alsoAllow` **不能在同一作用域同时出现**。`allow` 是"整份替换"，
  `alsoAllow` 是"在 profile 结果上追加"，语义冲突。
- **profile 过滤先执行，再应用 allow/alsoAllow**。所以只写 `allow: ["browser"]` 会把其它
  工具全部关掉，通常不是你想要的结果。

参考：<https://docs.openclaw.ai/tools>、<https://docs.openclaw.ai/tools/browser>、
<https://docs.openclaw.ai/gateway/config-tools>、
<https://docs.openclaw.ai/tools/multi-agent-sandbox-tools#configuration-precedence>

### 原因二：插件加载在工具策略之前

`plugins.allow` 控制的是"插件要不要被加载"，这一步比工具策略更早。日志里出现的
`plugins.allow is empty` 表示"用默认值"，此时是 **正常的**（默认加载内置插件）。
但一旦你以后往 `plugins.allow` 里写了任何一项，就必须把 `browser` 一起写进去，
否则浏览器插件会在工具策略生效之前就被拦下。

另一种触发方式：在配置根层写一个显式的 `browser` 配置块，也会激活内置浏览器插件。

### 原因三：`chrome` profile 就是 Chrome（真正的根因）

内置 profile 只有三个，各自绑定了具体实现：

| profile | 驱动 | 实际浏览器 | 需要人在电脑前 | 复用日常登录态 |
|---|---|---|---|---|
| `openclaw` | 受管隔离浏览器 | 自带 Chromium | 否 | 否 |
| `user` | Chrome DevTools MCP 挂接 | Chrome | **是**（弹"允许远程调试？"） | 是 |
| `chrome` | Chrome **扩展**（`driver: "extension"`） | Chrome | 否 | 是 |

本地启动时的浏览器自动探测顺序是 **Chrome → Brave → Edge → Chromium → Chrome Canary**。
也就是说，只要机器上装了 Chrome，Edge 永远排在后面，不会被选中。

另外，`browser.defaultProfile` 的默认值在官方文档两处写得不一致（一处写 `"openclaw"`，
一处写 `"chrome"`）。**不要依赖默认值**，本项目一律显式传 `--browser-profile`。

参考：<https://docs.openclaw.ai/tools/browser>、<https://docs.openclaw.ai/tools/chrome-extension>

## 五个 profile 与本项目的路由

`src/core/browser-router.mjs` 把上表连同两条 Edge 变体一起编码成 `BROWSER_PROFILES`，
并由 `routeBrowserAction()` 在运行前做判断，把已知风险以 `warnings` 显式返回：

| profile | driver | browser | unattended | documented |
|---|---|---|---|---|
| `openclaw` | `managed` | `openclaw-managed-chromium` | 是 | 是 |
| `user` | `cdp-attach` | `chrome` | 否 | 是 |
| `chrome` | `extension` | `chrome` | 是 | 是 |
| `edge-extension` | `extension` | `edge` | 是 | **否（未验证）** |
| `edge-existing-session` | `existing-session` | `edge` | 否 | 是 |

`routeBrowserAction()` 的拒绝条件只有两条，都会明确给出 `reason`：

- `requires_human_at_computer`：任务声明无人值守，但选中的 profile 需要人工授权。
- `unknown_profile`：profile 名字拼错——直接拒绝，不做"猜一个最近似的"。

再叠加四类警告：profile 不带日常登录态、实际浏览器与你要求的不一致、profile 未被官方文档覆盖、
缺 `browser.edgeUserDataDir`。**警告不阻止执行，但一定会出现在回执里**，避免"我以为它在用 Edge"
这种误解重复发生。

## 三条可选路线

### 路线 C：受管隔离浏览器（**已采用**）

`browser.defaultProfile: "openclaw"`。替身用自己的一份持久化用户数据目录，与你日常浏览器
完全隔离。

- 优点：文档完整覆盖；真正无人值守；替身的登录态和你的日常浏览器互不污染；出事只需删掉那份
  用户数据目录。
- 代价：常用网站需要**一次性**在这个浏览器里手动登录。之后登录态会持久保存。
- 适用：本项目绝大多数网页任务。

#### 怎么落地

不要手改 `openclaw.json`。用脚本，它默认只预览、不写盘：

```powershell
# 第一步：只看要改什么，一个字节都不会写
.\platform\windows\Set-OpenClawBrowserProfile.ps1 -ConfigPath 'D:\...\openclaw.json'

# 第二步：确认无误后再落盘（会先生成时间戳 .bak，并打印一行回滚命令）
.\platform\windows\Set-OpenClawBrowserProfile.ps1 -ConfigPath 'D:\...\openclaw.json' `
    -ManagedUserDataDir 'D:\DailyTwin\browser-profile' -Apply
```

脚本会做三件事，对应上文三个原因：`tools.alsoAllow` 补 `browser`、检查 `plugins.allow`、
建根级 `browser` 配置块（`defaultProfile` / `snapshotDefaults.mode` / `userDataDir`）。

有两种情况它会**拒绝自动改**，只报告让你自己决定：

| 代码 | 情况 | 为什么不能代劳 |
| --- | --- | --- |
| `allow_and_alsoallow_conflict` | `tools.allow` 已存在 | `allow` 是替换语义、`alsoAllow` 是追加语义，同一作用域不能共存。删掉 `allow` 可能顺手关掉别的工具。 |
| `plugin_allowlist_excludes_browser` | `plugins.allow` 是非空白名单但不含 `browser` | 插件加载发生在工具策略之前，改白名单等于改插件加载策略。 |

落盘之后脚本会立刻把文件读回来逐项核对（顶层键没丢、没有 JSON 截断特征串、`alsoAllow` 里有
`browser`、`defaultProfile` 是 `openclaw`），任何一项不对就用备份原地还原并报错。

#### 一次性登录清单

改完配置后需要做一次，而且只做一次：

1. 重启 OpenClaw 网关。
2. `openclaw browser status` —— 确认 `browser` 工具这次真的存在。
3. 让替身打开一个需要登录的站点，在弹出的受管浏览器窗口里手动登录。
4. 逐个站点重复第 3 步（飞书、学校系统、文献库……）。
5. 把登录过的域名写进私有目录 `config/runtime.json` 的 `browser.managedLoggedInHosts`。
6. 重启一次网关，再打开同一个站点，确认**不再要求登录**——这一步才算真的验证了登录态持久化。

### 路线 B：Chrome 扩展模式（值得试，但 Edge 侧未验证）

`browser.defaultProfile: "chrome"`（Chrome）或本项目的 `edge-extension`（Edge，未验证）。

这是官方文档中**唯一**"已登录浏览器 + 电脑前没人"都成立的模式。它不用远程调试端口，
而是走 `chrome.debugger` 扩展 API，所以不会弹出那个阻塞式授权提示。

安装步骤（Chrome 路径已由官方文档覆盖）：

1. `openclaw browser extension path` —— 拿到扩展目录。
2. 打开 `chrome://extensions`，右上角开 **开发者模式**，"加载已解压的扩展程序"，选上一步的目录。
3. `openclaw browser extension pair` —— 生成配对码。
4. 点浏览器工具栏上的扩展图标，把配对码粘进弹窗。
5. 图标徽标变为 ON 即配对成功。

要知道的边界：

- 配对令牌落在 `credentials/browser-extension-relay.secret`，权限 `0600`。**这个文件永远不进仓。**
- 授权边界是"OpenClaw 的那个标签组"，不是整个浏览器。
- 单页内容分享上限约 120,000 字符，超长页面会被截断。
- 诊断命令：`openclaw browser status`、`openclaw browser doctor --browser-profile chrome`。

**Edge 侧的诚实说明**：Edge 是 Chromium 内核，理论上能加载同一个未打包扩展
（`edge://extensions` + 开发者模式）。但官方文档只写 Chrome，本项目也没有在真机上验证过。
所以 `edge-extension` 在 `browser-router.mjs` 里被标记 `documented: false`，每次路由都会
带一条警告。**验证成功之前，不要把它设成默认。**

### 路线 A：挂接现有 Edge 会话（不适合无人值守）

`driver: "existing-session"` + `attachOnly: true` + 指向 Edge 的 `userDataDir`，
确实可以把动作打到 Edge 上。但必须有人在 `edge://inspect/#remote-debugging` 里点授权，
所以它不满足 7×24 无人值守的前提。本项目保留这个 profile
（`edge-existing-session`），仅用于"你确实坐在电脑前"的调试场景。

## 顺手能省 token 的两个开关

- `browser.snapshotDefaults.mode: "efficient"` —— 页面快照走精简模式，token 消耗明显下降。
  本项目 `config/runtime.example.json` 里 `browser.snapshotMode` 默认就是 `efficient`。
- `browser.tabCleanup.enabled`（默认 `true`）—— 只会清理 **OpenClaw 自己用 `action: "open"`
  打开的**标签页，不会碰你手动开的标签。所以它不是"会不会关掉我的页面"的风险项。

## 本项目怎么配

私有目录下的 `config/runtime.json`（不是公开仓里的 example）：

```jsonc
{
  "browser": {
    "defaultProfile": "openclaw",
    "signedInProfile": null,
    "snapshotMode": "efficient",
    "edgeUserDataDir": null,
    "managedLoggedInHosts": [".feishu.cn", "www.ncbi.nlm.nih.gov"]
  }
}
```

- `defaultProfile`：默认路线。改成 `chrome` 前先按路线 B 装好扩展。
- `signedInProfile`：只有当任务显式声明"需要已登录会话"时才会用到。留空则退回默认 profile，
  并附一条警告。
- `edgeUserDataDir`：只有 `edge-existing-session` 需要。
- `managedLoggedInHosts`：路线 C 的一次性登录成本记在这里。两种写法：
  - `"example.com"` —— 只匹配这一个主机名（大小写不敏感）。
  - `".example.com"` —— 匹配 `example.com` 本身以及它的任意子域（沿用 Cookie 域的写法）。
    注意 `.feishu.cn` **不会**匹配 `evilfeishu.cn`，不存在跨点位的后缀误伤。

关于 `managedLoggedInHosts` 有一条要说清楚的设计取舍：**它只影响警告，永远不会拦下任务。**

这份列表是"人手工声明的"，不是"程序观测到的"——登录态可能过期，域名可能漏记。
如果让它决定放不放行，一份过期的列表就会把本来能做的事全挡住，而且挡得毫无道理。
所以路由的行为是：

| 情况 | 行为 |
| --- | --- |
| 任务要求已登录会话，域名**在**列表里 | 放行，附一条"登录态可能已过期，撞到登录墙就重登一次"的提醒 |
| 任务要求已登录会话，域名**不在**列表里 | 放行，附一条"受管浏览器大概率没有它的登录态，会停在登录页" |
| 任务要求已登录会话，但 URL 解析不出主机名 | 放行，附原来那条通用提醒 |

真正防"其实没登录却报成功"的那道闸，是 `execution-verifier` 的证据要求，不是这份列表。

命令行侧：`platform/windows/Invoke-DailyTwinBrowser.ps1` 的参数名是 **`-BrowserProfileName`**，
不叫 `-Profile`——`$PROFILE` 是 PowerShell 自动变量，占用它会踩到与 B18 同类的坑。

## 更正记录

`docs/superpowers/specs/2026-07-27-browser-routing-design.md` 是本仓最早的浏览器路由设计稿。
它有两个问题，都在本轮修正：

1. **策略是错的。** 它写"Edge is the default for every browser task"。按上文原因三，内置
   profile 里没有任何一个默认走 Edge；`chrome` profile 驱动的是 Chrome。
2. **它是死代码。** 126 行设计文档在 `src/` 里没有对应实现（缺陷编号 B15）。现在实现落在
   `src/core/browser-router.mjs`，测试在 `test/browser-router.test.mjs`。

旧文件保留不删，作为设计演进记录；**以本文件为准**。

## 还需要在真机上验证的部分

沙箱里没有 Windows、没有 Chrome/Edge、也没有 OpenClaw 网关，所以下面这些只能由你在本机确认：

- [ ] `Set-OpenClawBrowserProfile.ps1` 的预览输出与你真实的 `openclaw.json` 对得上。
- [ ] `-Apply` 之后 `.bak` 确实生成，且新配置能被 OpenClaw 正常读起来。
- [ ] `tools.alsoAllow: ["browser"]` 后，`openclaw browser status` 能正常返回。
- [ ] 受管浏览器（路线 C）里一次性登录后，重启网关登录态仍然保留。
- [ ] 路线 B 的扩展在 Chrome 上配对成功，徽标变 ON。
- [ ] 路线 B 的扩展能否在 Edge 上加载并配对（这一条是本项目目前**唯一**的未知项）。

沙箱里能证明的部分只有：脚本在 PowerShell 7.6.4 上语法通过、PSScriptAnalyzer 无
Error/Warning、预览不写盘、落盘先备份且备份逐字节一致、两条闸门都会拒绝落盘、重复执行幂等、
八层嵌套的原有配置不会被 `ConvertTo-Json` 截断。**Windows PowerShell 5.1 上的行为由 CI 的
`windows-latest` 任务判定，不由沙箱判定。**
