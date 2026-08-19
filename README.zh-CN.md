# Daily Digital Twin

一个运行在 Windows 本机上的个人工作替身框架：手机通过飞书派发任务，本机在**已登录的浏览器会话**里执行网页操作，并用受限的应用目录启动桌面软件。源码公开，运行数据私有。

## 设计边界

- 本地不运行大模型；模型推理仍走你配置的兼容接口。云端只做计划，本机复核后才执行。
- 最多四个任务槽；同一软件、文件或网页标签页互斥；桌面自动化同时只允许一个（前台独占）。
- 验证码、登录弹窗和人工判断会暂停任务，验证码只在内存中传给当前页面，不落盘、不进回执。
- 删除、覆盖、上传、付款、发送和公开发布仍需人工确认。
- **执行必须留证。** 没有进程 / 窗口 / 页面 / 文件四类证据之一，任务只会被判为 `partial`，绝不谎报 `completed`。
- 飞书身份采用**首次配对即绑定**：第一个发消息的人成为主人，之后其他人一律拒绝。

## 浏览器：先读这一节

README 的旧版本写着"Edge 浏览器动作通过 OpenClaw 已配对的 `chrome` profile 执行"，**这句话是错的**。

OpenClaw 内置的 `chrome` profile 按定义就是 Chrome 扩展（`driver: "extension"`），本地启动的自动探测顺序是
Chrome → Brave → Edge → Chromium → Chrome Canary。也就是说 `--browser-profile chrome` 命中的是 Chrome，不是 Edge。

三条可用路线的完整对比、各自的前置条件，以及"没人在电脑前"时哪一条真的成立，见
[`docs/BROWSER-PROFILES.md`](docs/BROWSER-PROFILES.md)。默认配置走 `openclaw` 托管 profile（可无人值守，代价是首次要在替身专用浏览器里单独登录一次）。

## 目录

```text
src/core/            公开任务内核、策略与路由
src/runtime.mjs      命令行入口
platform/windows/    Windows 启动、遥测、备份与修复脚本
config/*.example.*   脱敏示例配置
docs/                运行手册、浏览器路线、架构、缺陷修复记录
test/                Node 内置测试
scripts/             隐私审计
```

私有实例放在本机的 `DAILY_TWIN_HOME` 目录，其中的 `data/`、`config/runtime.json`、截图、日志、浏览器会话和真实应用路径都不进入本仓库。

## 私有目录是必填项

`DAILY_TWIN_HOME` **没有仓库内的兜底路径**。没配置时命令行会直接以退出码 1 失败并给出设置方法，而不是偷偷把运行数据写在公开仓库旁边（这是本轮修掉的 B13b/B14）。

```powershell
# 建议放在 D 盘，避免占满系统盘
# 注意参数名是 -PrivateHome 而不是 -Home：$Home 是 PowerShell 自动变量，占用它就是 B18 那类缺陷
.\platform\windows\Set-DailyTwinPaths.ps1 -PrivateHome 'D:\DailyTwin\home'
```

完整的开机到日常运维步骤见 [`docs/RUNBOOK.md`](docs/RUNBOOK.md)。

## 开发

需要 Node.js 24 或更高版本（用到 `node:sqlite`）。零运行时依赖，不需要 `npm install`。

```powershell
npm test              # 132 条单元测试
npm run audit:privacy # 隐私审计：密钥、真实本机路径、中转地址
npm run smoke         # CLI 冒烟：端到端行为，含"不该产生的副作用"
npm run check         # 上面三条一起跑，提交前必须绿
```

Windows 侧另有两条（需要 pwsh）：

```powershell
npm run lint:ps       # 语法解析 + BOM 检查 + PSScriptAnalyzer
npm run selftest:ps   # 脚本层运行时自检
```

改造过程中确认并修掉的 24 个缺陷，逐条对应到代码位置和守它的测试，见
[`docs/BUGFIX-LOG.md`](docs/BUGFIX-LOG.md)。整体设计与取舍见
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)（英文）。

初始化私有运行目录并创建任务：

```powershell
$env:DAILY_TWIN_HOME = 'D:\DailyTwin\home'
npm run runtime -- init
npm run runtime -- create '打开 Biomni，在输入框输入 TEST_TEXT'
npm run runtime -- status
npm run runtime -- doctor    # 检查库、迁移版本、遥测与磁盘
```

## 调度器默认休眠

`scheduler.enabled` 默认 `false`。装好之后替身**不会**自己开始跑任务，必须显式开启：

```powershell
npm run runtime -- scheduler status
npm run runtime -- scheduler enable
```

资源策略是 fail-closed 的：拿不到 CPU 占用和是否接电源，就判定为"遥测缺失"，槽位归零、不接新动作。
Windows 上由 `platform/windows/Write-DailyTwinTelemetry.ps1` 定期写入 `data/telemetry.json`；
调试时也可以用 `DAILY_TWIN_CPU_PERCENT` 和 `DAILY_TWIN_ON_AC_POWER` 两个环境变量临时覆盖。

## 晨间工作流：批量发任务 → AI 分解 → 调度执行

这是 v3 新增的核心功能：**早晨把所有任务一次性发给 AI，它帮你分解成子任务并自动调度执行。**

### 1. 准备任务文件

创建一个文本文件，每行一个任务，`#` 开头的行是注释：

```text
# 今天的任务
写一篇关于 AI 在教育领域应用的博客文章
整理上周的实验数据并生成图表
查一下最近 Three.js 的更新日志
给团队发一封周报邮件
```

### 2. 配置 AI API

在私有目录的 `config/runtime.json` 中填入你的 OpenAI 兼容 API：

```json
{
  "planner": {
    "apiEndpoint": "https://api.openai.com/v1/chat/completions",
    "apiKey": "你的 API Key",
    "model": "gpt-4o-mini"
  },
  "executor": {
    "apiEndpoint": "https://api.openai.com/v1/chat/completions",
    "apiKey": "你的 API Key",
    "model": "gpt-4o-mini"
  }
}
```

没有配置 API 也能用 —— 任务会以 `unknown` 类型透传，不分解。

### 3. 一键启动晨间工作流

```powershell
# 只规划和创建任务，不自动启动调度器
npm run runtime -- morning C:\path\to\tasks.txt

# 规划 + 创建 + 自动启动调度器
npm run runtime -- morning C:\path\to\tasks.txt --enable
```

AI 会把每个任务分解成 1-4 个子任务，判断每个子任务的类型（`ai_call` / `desktop` / `browser`）和优先级，
然后创建父子任务并打出计划概览。

### 4. 批量导入（不经过 AI 规划）

如果不需要 AI 分解，只想批量创建任务：

```powershell
npm run runtime -- batch C:\path\to\tasks.txt
```

### 任务类型说明

| 类型 | 含义 | 谁来执行 |
|---|---|---|
| `ai_call` | 可由 AI 直接完成（写文案、做分析、查资料等） | AI 执行器 |
| `desktop` | 需要操作桌面软件 | 需配置私有桌面执行器 |
| `browser` | 需要浏览器操作 | 需配置私有浏览器执行器 |
| `unknown` | 未分类 | 尝试用 AI 执行 |

## 不要提交的东西

真实 API Key、飞书 App Secret、网关 token、模型中转地址、Cookie、含真实 Windows 用户名的绝对路径、
任务截图、个人研究材料、`data/` 下的任何运行数据。`npm run audit:privacy` 会在提交前拦一道，CI 里也会再跑一次。

审计规则对"用户目录 + 真实用户名"这种形态是零容忍的，连文档里的示例都不放过 —— 这是故意的：
上一版审计因为没有处理源码里的双反斜杠转义，真的漏掉过一个真实用户名。
