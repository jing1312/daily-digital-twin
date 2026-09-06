# Daily Digital Twin

[English](README.md) | **简体中文**

[![CI](https://github.com/jing1312/daily-digital-twin/actions/workflows/ci.yml/badge.svg)](https://github.com/jing1312/daily-digital-twin/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D24-185FA5)
![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-0F6E56)
![license](https://img.shields.io/badge/license-MIT-444441)

一个跑在 Windows 本机上的隐私优先个人自动化运行时。任务从手机、终端或网页仪表盘进来，本地调度器用受控执行器去干，并且**报不出证据就绝不说 completed** —— 拿不出进程 / 窗口 / 页面 / 文件四类证据之一的任务，只会如实判为 `partial`。

三条原则贯穿全部代码：

| 原则 | 怎么落实 |
| --- | --- |
| 诚实 | 无证据 → `partial`，绝不谎报 `completed`。 |
| 失败关闭 | 配置错了拒绝运行；执行器装载失败拒绝启动；遥测缺失就是 0 个调度槽。 |
| 私密外置 | 密钥、数据库、输出、日志全在仓库外的私有 `DAILY_TWIN_HOME`，CI 里的隐私审计把关。 |

![架构](docs/assets/architecture.svg)

## 它能干什么

**命令层** —— `create`、`batch`、`morning`、`status`、`tree`、`history`、`show`、`cost`、`pause`/`resume`/`cancel`、`scheduler`、`daemon`/`serve`、`mcp`、`doctor`、`config`。

- `morning` 接收一份纯文本任务清单，交给 AI planner 分解成父子任务树，类型为 `ai_call`、`desktop` 或 `browser`。父任务只是容器，等所有子任务到终态后由调度器自动收尾。
- `batch` 不走 AI，直接批量导入同一份清单。
- `show` 打印任务的完整事件流、证据和 token 记账。

**执行器**

- `ai_call` —— 走 OpenAI 兼容接口，token 账本按任务记录（输入、缓存输入、输出、延迟、本地估价）。任务描述里引用了 `DAILY_TWIN_HOME` 内的图片文件时，执行器自动路由到视觉模型（`executor.visionModel`）并把图片作为多模态输入带上。
- `desktop` / `browser` —— 从 `DAILY_TWIN_HOME` 里的私有执行器模块装载（例如 `executor/index.mjs`）。自带的私有执行器能打开已登记的应用（进程 + 窗口证据），并用 `playwright-core` 驱动受管 Edge 浏览器打开已登记网站或网址——回读真实 URL 与页面标题，截图落盘作为文件证据。已登记网站还可以定义多步流程（`goto`/`fill`/`click`/`wait`/`verify`/`screenshot`，步骤值支持 `{{参数}}` 占位符，参数在任务文本里以 `参数=值` 提供）；任何一步失败都会如实报失败，带步骤号和现场截图。没有私有执行器时，这些类型如实返回 `partial`。
- `unknown` —— 原样跳过，不瞎猜。

**daemon 看门狗** —— `Start-DailyTwinWatchdog.ps1` 负责调度 daemon 的生死：以 `data/daemon.pid` 为准绳（PID 由 daemon 本体写入，命令行 / 配置页 / 看门狗三种拉起方式状态一致），进程崩了自动拉起，拉不起来按 15s→30s→60s… 指数退避持续重试、绝不弃疗；锁文件防双开；每次崩溃与恢复都追加到 `state\watchdog.log`。配合登录计划任务（`Install-DailyTwinStartup.ps1`）形成三层自愈：看门狗拉 daemon，计划任务拉看门狗，登录拉计划任务。

**飞书控制面**（`serve`）—— WebSocket 网关，首次发消息的人绑定为唯一所有者，之后其他人一律拒绝；支持任务派发与控制命令（`status`、`pause`、`resume`、`cancel`、查证据），回执统一脱敏。

**Multica worker 体系** —— 复杂任务由 planner 拆成最多四个隔离的 Codex worker。worker 持有 HMAC 签名的一次性能力票，绑定任务号、issue、worker、允许的网站 / 软件 / 目录白名单和过期时间。worker 只能调用高层本机 MCP 工具（`browser_open/fill/submit/wait/capture`、`app_launch`、`task_checkpoint`），拿不到 shell。

**配置网页**（`npm run config`）—— 编辑规划器 / 执行器接口、从服务商拉取模型列表直接落库、查看未结束任务 / 历史 / token 花费、一键启停 daemon，全在 `127.0.0.1:18791` 本机完成。

## 安全边界

这个项目能接触已登录的浏览器会话和本机软件，所以刻意保守：

- 远端模型只出计划，不受信任；任何动作都在本机复核后才执行。
- 调度器默认休眠，必须显式启用。
- 验证码、登录弹窗和需要人工判断的场景会暂停进入 `waiting_for_user`，不擅自应付。
- 验证码只传给当前活动页面，不落盘、不进回执、不进数据库 / 日志 / 缓存。
- 桌面自动化前台独占；软件、文件、标签页按任务互斥锁定。
- 删除、覆盖、上传、付款、发送、公开发布仍需人工确认。
- 密钥和私有路径永不进仓库 —— 隐私审计在本地和 CI 都会跑。

这些手段降低风险，但不等于无人值守的浏览器 / 桌面自动化普遍安全。接入真实账号前，先过一遍配置和威胁模型。

## 资源策略

重活按本机实时遥测伸缩：

| 条件 | 槽位 |
| --- | ---:|
| 可用内存 ≥ 10 GB 且 CPU < 55% | 最多 4 |
| 可用内存 6~10 GB | 2 |
| 可用内存 4~6 GB | 1 |
| 不足 4 GB、磁盘紧张或遥测过期 | 0 |
| 电池供电 | ≤ 1 |

遥测缺失不是边缘情况 —— 直接停调度。

## 任务生命周期

![证据门控](docs/assets/evidence-gate.svg)

## 快速上手

环境要求：Windows 11（部署目标）、Node.js ≥ 24、平台脚本需要 PowerShell 7。无需 `npm install` —— 零运行时与开发依赖。

```powershell
# 1. 把 DAILY_TWIN_HOME 指向仓库外的私有目录
.\platform\windows\Set-DailyTwinPaths.ps1 -PrivateHome 'D:\DailyTwin\home'
$env:DAILY_TWIN_HOME = 'D:\DailyTwin\home'

# 2. 初始化并自检
npm run runtime -- init
npm run runtime -- doctor

# 3. 派活
npm run runtime -- create '总结今天的日程'
npm run runtime -- morning .\tasks.txt --enable   # 规划 + 分解 + 启动调度器
npm run runtime -- status
npm run runtime -- show 1

# 4. 按需注册计划任务（先预览）
.\platform\windows\Install-DailyTwinServices.ps1 -PrivateHome $env:DAILY_TWIN_HOME -WhatIf
.\platform\windows\Install-DailyTwinServices.ps1 -PrivateHome $env:DAILY_TWIN_HOME
```

启用 AI 规划器 / 执行器：在私有 `config/runtime.json` 里配 planner 和 executor 接口，用 `npm run config` 最省事。

开始常规运行前，先读 [`docs/RUNBOOK.md`](docs/RUNBOOK.md)。

## 验证

```bash
npm test              # 399 个单元测试
npm run audit:privacy # 密钥 / 私有路径不得进仓库
npm run smoke         # CLI 冒烟
npm run check         # 测试 + 审计 + 冒烟
```

Windows 额外跑 `npm run lint:ps` 和 `npm run selftest:ps`（PowerShell 解析、编码、平台自测）。CI 在 Linux 和 Windows 双平台、Node 24 下执行以上全部。

## 文档

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 信任模型、状态、调度、校验与设计取舍
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) —— 部署、运维、切换与回滚
- [`docs/BROWSER-PROFILES.md`](docs/BROWSER-PROFILES.md) —— 浏览器路线与无人值守边界
- [`docs/BUGFIX-LOG.md`](docs/BUGFIX-LOG.md) —— 缺陷、修复与守住它们的测试

## 路线图

- 按能力选模型：分类用便宜模型，规划用强模型。
- 飞书控制面收尾（应用密钥、worker 绑定），实现手机优先的使用方式。

## 许可证

MIT，见 [`LICENSE`](LICENSE)。
