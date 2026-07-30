# 浏览器路线选择（为什么"用 Edge"一直没成功）

> **历史文档，不再是当前部署方案。** Daily Twin 已移除 OpenClaw 浏览器主链；当前实现固定使用 Microsoft Playwright MCP 的 `--browser msedge --extension`，见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 和 [`RUNBOOK.md`](RUNBOOK.md)。本文件只保留早期故障分析，不能用于新安装。

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

### 路线 C：受管隔离浏览器（推荐，现在就能用）

`browser.defaultProfile: "openclaw"`。替身用自己的一份持久化用户数据目录，与你日常浏览器
完全隔离。

- 优点：文档完整覆盖；真正无人值守；替身的登录态和你的日常浏览器互不污染；出事只需删掉那份
  用户数据目录。
- 代价：常用网站需要**一次性**在这个浏览器里手动登录。之后登录态会持久保存。
- 适用：本项目绝大多数网页任务。

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
    "edgeUserDataDir": null
  }
}
```

- `defaultProfile`：默认路线。改成 `chrome` 前先按路线 B 装好扩展。
- `signedInProfile`：只有当任务显式声明"需要已登录会话"时才会用到。留空则退回默认 profile，
  并附一条警告。
- `edgeUserDataDir`：只有 `edge-existing-session` 需要。

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

- [ ] `tools.alsoAllow: ["browser"]` 后，`openclaw browser status` 能正常返回。
- [ ] 受管浏览器（路线 C）里一次性登录后，重启网关登录态仍然保留。
- [ ] 路线 B 的扩展在 Chrome 上配对成功，徽标变 ON。
- [ ] 路线 B 的扩展能否在 Edge 上加载并配对（这一条是本项目目前**唯一**的未知项）。
