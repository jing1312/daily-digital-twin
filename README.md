# Daily Digital Twin

<<<<<<< codex/multica-control-plane
一个运行在 Windows 本机上的个人工作替身：手机通过飞书发任务，简单动作由本机直接执行，复杂任务交给 Multica 拆分并由最多四个隔离的 Codex worker 处理。

当前主链是 **飞书 + Daily Twin + Multica + Codex + Microsoft Playwright MCP**。OpenClaw 不参与新任务，只保留为迁移期间的回滚备份；新架构连续稳定运行 48 小时后才能停用旧自启动。

## 它怎样工作

```text
飞书消息
   |
   v
Daily Twin 本机控制平面 ---- 状态 / 暂停 / 继续 / 取消 / 看证据
   |
   +---- 固定流程：Biomni / Omicos ------------------ 0 Token
   |
   +---- 复杂任务 -> Multica planner -> 1~4 个 Codex worker
                                      |
                                      v
                         Daily Twin 高层 MCP 工具
                         Edge / 已登记软件 / 检查点
```

- 每条普通任务立即获得 `DT-日期-序号`，最终只发送一条终态回执。
- `状态` 等控制命令、本机软件启动和固定网站流程不调用模型。
- planner 只输出最多四个结构化子任务，退出后才启动 worker，不和 worker 抢槽。
- worker 只能调用 `browser_open/fill/submit/wait/capture`、`app_launch`、`task_checkpoint` 和 `task_checkpoint_read`，不能获得 Shell 或整机控制。
- Edge 未连接、登录过期、验证码或任务标签失去归属时进入 `waiting_for_user`，绝不静默改用 Chrome。
- 任务标签标记和检查点保存在本机 SQLite；控制平面重启会把中断的固定流程重新排队，再按完全相等的 `window.name` 定位原 Edge 标签，不重复提交已有检查点记录的动作。
- 没有真实页面、进程、窗口或文件证据时，任务不能报告 `completed`。

## 本机安全边界

- 能力票绑定 `task_id`、Multica issue、worker、允许的网站/软件/目录/动作、过期时间和一次性 nonce，并由本机 HMAC 签名。
- 能力票在 MCP 启动时消费，篡改、过期、重放或越权调用都会失败。
- 验证码只进入内存 broker，不进入 Multica、模型、SQLite、日志、缓存或回执；截图会临时遮罩私有应用目录登记的验证码输入框，并在截图成功或失败后恢复页面样式。
- 飞书 App Secret、能力票密钥、模型 Key、Multica PAT、真实软件路径、截图和 Token 账本只放在 `DAILY_TWIN_HOME`。
- Codex worker 固定为 `workspace-write + approval_policy=never`：授权范围内自动执行，范围外直接拒绝，不弹出远程审批。
- 控制平面与遥测都有单实例锁，避免重复计划任务同时运行。
- 所有终态文字回执在发送前统一脱敏；人工登录和验证码等待不消耗三次瞬时错误重试额度。

## 资源和 Token

重型 worker 数量按本机压力动态收缩：

| 条件 | 重型 worker 上限 |
|---|---:|
| 可用内存 `>= 10 GB` 且 CPU `< 55%` | 4 |
| 可用内存 `6~10 GB` | 2 |
| 可用内存 `4~6 GB` | 1 |
| 可用内存 `< 4 GB`、D 盘不足 20 GB 或遥测缺失 | 0 |
| 电池模式 | 最多 1 |

网页等待、软件计算和任务排队不要求模型进程持续占用资源。超过 90 分钟的 worker 只有保存了本轮新检查点才会重签能力票并续跑；否则停止并如实失败。Token 账本按任务和 worker 记录输入、缓存输入、输出、延迟和本地估价；缓存 Token 视为输入 Token 的子集，只按缓存费率计一次。Multica 聚合用量按 issue 更新快照，未知模型价格保持为空，不猜中转站费用。
=======
[中文说明](README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Operations runbook](docs/RUNBOOK.md) · [Browser profiles](docs/BROWSER-PROFILES.md)

A privacy-first local task runtime for Windows, Feishu, browser automation, and controlled desktop execution. A phone can submit a task through Feishu; a remote model may propose a plan; the local runtime reviews policy, executes through configured adapters, and requires observable evidence before reporting completion.

The source code is public. Runtime state, credentials, browser sessions, screenshots, logs, personal files, and machine-specific application paths remain in a required private directory outside the repository.

## Engineering evidence

- **132 Node unit tests** covering task state, scheduling, identity binding, resource locks, redaction, evidence verification, and related invariants
- **CI on Linux and Windows** with Node 24, privacy auditing, CLI smoke tests, PowerShell parsing, encoding checks, and platform self-tests
- **Zero third-party runtime dependencies**; the runtime uses Node standard-library components, including `node:sqlite` and `node:test`
- **Fail-closed resource policy**: missing or invalid telemetry produces zero execution slots rather than permissive defaults
- **Evidence-gated completion**: a task without valid process, window, page, or file evidence is downgraded to `partial`
- **Human confirmation boundaries** for deletion, overwrite, upload, payment, messaging, and public posting

## Safety boundaries

This project is intentionally conservative because it can interact with signed-in browser sessions and local applications.
>>>>>>> main

- The remote model is a planning component, not a trusted executor.
- The scheduler is disabled by default and must be enabled explicitly.
- CAPTCHA prompts, login dialogs, and tasks requiring human judgement pause for intervention.
- Verification codes are passed only to the active page; they are not stored in receipts.
- The first Feishu sender becomes the bound owner; later senders are rejected until a local reset.
- Desktop automation is foreground-exclusive, and resources such as applications, files, and tabs are locked against conflicting tasks.
- Secrets and personal paths are rejected by a repository privacy audit that also runs in CI.

These controls reduce risk; they do not make unattended browser or desktop automation universally safe. Review the configuration and threat model before connecting real accounts.

## Architecture

```text
<<<<<<< codex/multica-control-plane
src/core/             状态、资源、能力票、Token、单实例锁
src/gateway/          飞书 WebSocket、验证码、回执和证据发送
src/execution/        固定网页流程与 Windows 软件执行
src/integrations/     Multica、Codex worker、Playwright Edge
src/mcp/              只暴露高层本机工具的 stdio MCP
platform/windows/     遥测、计划任务、切换和回滚脚本
config/*.example.*    不含真实路径或密钥的示例
test/                 Node 和跨语言契约测试
```

公开仓与私有实例必须分开。私有实例由 `DAILY_TWIN_HOME` 指定；没有配置时运行时直接失败，不回退到仓库目录。

## 开始部署

需要 Windows 11、Node.js 24、PowerShell 7、Multica CLI，以及已安装 Playwright Extension 的日常 Edge。

```powershell
npm ci
$env:DAILY_TWIN_HOME = 'D:\DailyTwin'
npm run runtime -- init
```

然后在私有目录中完成：

1. 把 `config/runtime.example.json` 合并到 `config/runtime.json`，填写飞书 App ID、允许的 open ID 和已核验的本机命令路径。
2. 把真实飞书 App Secret 写入 `config/feishu-app-secret.secret`。
3. 把 `config/apps.example.json` 复制为私有 `config/apps.json`，逐个核验软件路径、进程名、窗口条件和网页选择器。
4. 按 [Multica agent 示例](config/multica-agents.example.md) 建一个 planner 和四个固定 worker slot。
5. 在 Edge 安装并配对 Microsoft Playwright Extension。
6. 先预览、再注册三个当前用户计划任务：

```powershell
.\platform\windows\Install-DailyTwinServices.ps1 -PrivateHome $env:DAILY_TWIN_HOME -WhatIf
.\platform\windows\Install-DailyTwinServices.ps1 -PrivateHome $env:DAILY_TWIN_HOME
npm run runtime -- scheduler enable
```

完整步骤、验收和回滚见 [运行手册](docs/RUNBOOK.md)，模块边界见 [架构说明](docs/ARCHITECTURE.md)。

## 开发与验证

```powershell
npm ci
npm test
npm run audit:privacy
npm run lint:ps
npm run selftest:ps
```

CLI 冒烟测试在 Git Bash 中运行：

```bash
bash .github/scripts/cli-smoke.sh
```

这些测试能证明代码契约、迁移、权限和脚本行为；它们不能代替真实飞书账号、Multica 账号、Edge 扩展和已安装桌面软件的本机端到端验收。

## 永远不要提交

API Key、PAT、飞书 App Secret、Cookie、验证码、真实 Windows 用户目录、真实软件路径、任务文字、截图、下载文件、浏览器资料、运行数据库、日志和 Token 账本。提交前和 CI 都会运行 `npm run audit:privacy`。

许可证：[MIT](LICENSE)

## 浏览器迁移与 48 小时切换

- 任务只允许在已配对的 Microsoft Edge 任务标签组内执行；Edge 未连接或标签归属丢失时立即进入 waiting_for_user，不会静默切换到 Chrome。
- 迁移旧的 OpenClaw 运行目录前，先用 platform/windows/Backup-DailyTwinState.ps1 备份 SQLite 和会话文件，再按 docs/RUNBOOK.md 验证新控制平面。
- 新架构必须连续稳定运行 48 小时，并完成真实飞书、Edge、Multica 和已登记桌面软件验收后，才可以停用旧的 OpenClaw 自启动；失败时保留检查点并按手册回滚。

## 验收标准

一次完整验收应覆盖：飞书发送普通任务并得到任务号；固定网页流程填写后读取值复核、提交并保存页面证据；验证码或登录弹窗进入等待状态并能按任务号继续；软件启动后有进程和窗口证据；资源不足时暂停新动作；最终回执包含真实完成部分、证据路径和失败原因。

公开仓只存代码、示例配置、测试和运维文档；私有运行目录、浏览器资料、任务内容、截图、下载文件、日志、数据库和 Token 账本永不提交。
=======
phone / Feishu          remote model                 Windows machine
      |                      |                              |
      | task text            | untrusted plan               |
      +--------------------->+----------------------------->|
                             |                              | policy review
                             |                              | controlled execution
                             |                              | evidence verification
                             |<-----------------------------+
                                  redacted receipt
```

```text
src/core/            task state, policy, routing, redaction, verification, AI planner, AI executor
src/runtime.mjs      command-line entry point
platform/windows/    setup, telemetry, backup, repair, and self-test scripts
config/*.example.*   sanitised example configuration
scripts/             privacy and source audits
test/                Node test suite
docs/                architecture, operations, browser routing, and bug-fix record
```

Private state lives under `DAILY_TWIN_HOME`. There is no repository-local fallback: the CLI exits with an error when the private home is not configured.

## Requirements

- Windows 11 for the intended deployment environment
- Node.js 24 or newer
- PowerShell for platform setup, telemetry, and Windows self-tests
- A separately configured compatible model endpoint for planning
- Explicitly configured browser and application adapters for real execution

No `npm install` step is required because the project declares no runtime or development dependencies.

## Quick start

Set up the private state directory from PowerShell:

```powershell
.\platform\windows\Set-DailyTwinPaths.ps1 -PrivateHome 'D:\DailyTwin\home'
$env:DAILY_TWIN_HOME = 'D:\DailyTwin\home'
```

Initialise the runtime and inspect its state:

```powershell
npm run runtime -- init
npm run runtime -- create 'Open the configured research workspace and enter TEST_TEXT'
npm run runtime -- status
npm run runtime -- doctor
```

The scheduler remains dormant after installation:

```powershell
npm run runtime -- scheduler status
npm run runtime -- scheduler enable
```

### Morning workflow (v3)

Send all your tasks at once — the AI planner decomposes them into sub-tasks, creates a parent-child task tree, and optionally starts the scheduler:

```powershell
# Create a task file (one task per line, # for comments)
npm run runtime -- morning C:\path\to\tasks.txt --enable
```

Batch import without AI planning:

```powershell
npm run runtime -- batch C:\path\to\tasks.txt
```

Configure the AI API in your private `config/runtime.json` (see `config/runtime.example.json`). Without an API configured, tasks pass through as `unknown` type without decomposition.

Read [`docs/RUNBOOK.md`](docs/RUNBOOK.md) before enabling routine execution. Browser-profile behaviour and unattended-operation constraints are documented in [`docs/BROWSER-PROFILES.md`](docs/BROWSER-PROFILES.md).

## Verification

Run the cross-platform checks before committing:

```bash
npm test
npm run audit:privacy
npm run smoke
npm run check
```

Windows adds PowerShell-specific checks:

```powershell
npm run lint:ps
npm run selftest:ps
```

`npm run check` combines the Node tests, privacy audit, and CLI smoke test. CI also verifies that the project remains dependency-free and that Windows scripts retain the encoding and line-ending properties required by Windows PowerShell 5.1.

## Status and limitations

| Component | Status | Important limitation |
| --- | --- | --- |
| Core task store and policy | Tested | Designed for one owner on one Windows machine |
| Privacy audit and redaction | CI-enforced | Cannot compensate for secrets deliberately committed outside the audited patterns |
| Scheduler | Dormant by default | Requires fresh CPU and power telemetry before accepting work |
| Browser routing | Documented and guarded | Some profiles require a human or a separate initial login |
| Built-in executor | AI executor for `ai_call` tasks | `desktop`/`browser` types return `partial`; real machine-specific execution must be configured privately |
| AI planner | Tested | Decomposes tasks via OpenAI-compatible API; falls back to passthrough when unconfigured |
| Morning workflow | Tested | Batch import → AI planning → sub-task creation → optional scheduler start |
| Destructive or external actions | Confirmation-gated | Human approval remains part of the security model |

The repository is an experimental personal automation framework, not a general-purpose autonomous agent or a security-certified product.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — trust model, state, scheduling, verification, and design trade-offs
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — setup and operations
- [`docs/BROWSER-PROFILES.md`](docs/BROWSER-PROFILES.md) — browser routes, requirements, and unattended-operation limits
- [`docs/BUGFIX-LOG.md`](docs/BUGFIX-LOG.md) — defects, fixes, and the tests that guard them
- [`README.zh-CN.md`](README.zh-CN.md) — the preserved original Chinese landing page

## Licence

MIT. See [`LICENSE`](LICENSE).
>>>>>>> main
