# Architecture

Daily Digital Twin 是一个单用户 Windows 控制平面。它把手机入口、云端任务协调、模型执行和本机能力拆成四个边界，目标不是让模型控制整台电脑，而是让模型只能调用本机预先授权、可验证的高层动作。

## 1. 组件边界

```text
Feishu
  | task text / control / verification code
  v
Daily Twin control plane (local Node 24)
  |-- deterministic executor --------> Edge / registered Windows apps
  |-- Multica bridge ----------------> Multica Cloud
  |                                      | planner issue
  |                                      | worker issues
  |                                      v
  |                                  local Codex workers
  |                                      |
  +<---------- stdio Daily Twin MCP <----+
```

| 组件 | 负责 | 不负责 |
|---|---|---|
| 飞书 | 手机消息、验证码、控制命令、结果回执 | 本机执行和模型规划 |
| Daily Twin | 身份、状态、资源、能力票、证据、回执、固定流程 | 通用自然语言推理 |
| Multica Cloud | issue 看板、planner/worker 编排、运行与 Token 元数据 | 保存本机密钥或直接控制电脑 |
| Codex worker | 在独立上下文中完成一个结构化子任务 | 任意 Shell、原始浏览器控制、扩大权限 |
| Playwright MCP | 连接已配对的日常 Edge 并执行浏览器动作 | 选择任务权限或生成最终回执 |
| PowerShell/.NET | 遥测、计划任务、已登记软件启动和窗口验证 | 猜测软件路径或模型规划 |

OpenClaw 不在新主链内。它的配置和状态只在迁移期间保留，用于 48 小时稳定观察期内回滚。

## 2. 两条任务路径

### 2.1 固定流程

已知动作不调用 planner：

- `状态 / 暂停 / 继续 / 取消 / 看证据`
- `打开 Biomni，输入 X 并运行`
- `打开 Omicos`

控制命令完全本地处理。Biomni 依次执行 `open -> fill -> 回读复核 -> submit -> wait -> capture`；Omicos 只从私有应用目录读取已核验路径，启动后必须得到进程或窗口证据。

### 2.2 复杂任务

1. 飞书事件先在 SQLite 创建根任务并回复 `DT-YYYYMMDD-NNNN`。
2. Multica parent issue 只分配给 planner。
3. planner 结束后，控制平面读取 run messages，提取一个包含 1~4 个子任务的 JSON。
4. 本机验证每个子任务 ID、标题、指令和 capability，不允许计划扩大权限。
5. 子任务写入 `task_workers`，再按资源档位分配到固定的 `dt-worker-1..4`。
6. 每个 worker issue 有独立状态、摘要、失败原因、Multica issue 和本机 capability binding。
7. 所有 worker 进入终态后，根任务才变为 `completed / partial / failed`。planner 自己的 `done` 绝不等于根任务完成。

planner 和 worker 不同时占重型槽。软件长计算和网页等待交给本机 watcher，不保持模型调用常驻。

## 3. 能力票和 MCP

能力票正文包含：

```text
version, taskId, multicaIssueId, workerId,
websites[], apps[], directories[], actions[],
expiresAt, nonce
```

正文由本机 HMAC-SHA256 签名。验证顺序是签名、有效期、任务/issue/worker 绑定、动作和资源范围，最后把 nonce 哈希写入 SQLite。nonce 只能消费一次。

每个固定 worker slot 有一个私有 binding 文件：

```text
data/workers/slots/<worker>/capability.binding.json
```

MCP 进程启动时读取并消费能力票，随后立即删除 binding。Codex 只看到已经绑定的八个工具：

```text
browser_open  browser_fill  browser_submit  browser_wait
browser_capture  app_launch  task_checkpoint  task_checkpoint_read
```

模型看不到 ticket、HMAC 密钥、`workerId` 参数、原始 Playwright 或通用 Shell。Codex 配置固定为 `sandbox_mode = "workspace-write"` 和 `approval_policy = "never"`，所以越权动作直接失败，不转化成远程审批。

## 4. 浏览器所有权

浏览器进程由 Microsoft Playwright MCP 以这些关键参数连接：

```text
--browser msedge --extension --caps devtools
--snapshot-mode none --image-responses omit --output-mode file
```

默认命令 `playwright-mcp` 会先解析仓库内安装的 `@playwright/mcp/cli.js`，并由当前 Node 进程直接启动；只有显式配置其他命令或已核验路径时才使用该值，因此不依赖系统 PATH 中碰巧存在的同名程序。

没有 Chrome fallback。首次网页动作才惰性连接 Edge，机器人空闲时不会仅为“保持在线”启动浏览器。

新标签页写入 `window.name = DT:<taskId>`，后续每次动作前重新检查标签索引，并要求 marker 与预期值完全相等。标签不存在或 marker 不匹配时停止任务并进入 `waiting_for_user`。填写操作使用登记过的 selector，填写后读取 `inputValue()` 做逐字复核。截图前临时隐藏密码、OTP、通用 verification 输入框以及私有应用目录登记的验证码 selector，截图成功或失败都会在 `finally` 路径恢复原样；只把 `E-<id>` 发到远端，原始路径留在本机证据表。

任务标签映射同时保存在 SQLite 的 `task_browser_sessions`。控制平面重启或标签索引变化后，驱动扫描 Edge 标签并按 `window.name` 恢复原任务页；找不到 marker 时进入 `waiting_for_user`，不会静默新建替代标签。Biomni 固定流程把 `opened / filled / submitted` 检查点写入任务行，验证码或登录恢复后不会重复提交已经完成的副作用。

## 5. 状态和持久化

SQLite 当前 schema 为 v6，主要表包括：

- `tasks`、`task_events`、`daily_task_counters`
- `task_workers`
- `resource_locks`、`verification_waits`
- `task_browser_sessions`
- `execution_evidence`、`terminal_receipts`
- `token_ledger`
- `capability_nonces`
- `inbound_messages`、`settings`

数据库使用 WAL、`busy_timeout` 和短事务。前台互斥由 `resource_locks.exclusive_class` 的唯一索引保证，不依赖容易竞态的“先查再写”。任务、worker、Multica issue、失败原因、重试计数和检查点都持久化；验证码不持久化。

公开仓不提供私有目录兜底。`DAILY_TWIN_HOME` 缺失时直接失败，配置中的数据库、应用目录、价格表和密钥路径都必须是 home 内的相对路径。

## 6. 资源调度

资源策略是 fail-closed：CPU、供电、内存或磁盘读不到时不接新动作。

| 可用内存 | 槽位 |
|---|---:|
| `>= 10 GB` | 4 |
| `6~10 GB` | 2 |
| `4~6 GB` | 1 |
| `< 4 GB` | 0 |

同时要求 CPU 滚动值 `< 55%`、私有目录所在盘至少剩余 20 GB；电池模式最多一个槽。逻辑任务最多四个存活，前台桌面动作始终单线程，网页、软件和文件分别加资源锁。

PowerShell 每分钟通过 CIM 写 `data/telemetry.json`。Node 只接受 300 秒内的样本，并记录读数来源。遥测和控制平面各有独立单实例锁：Node 使用带 PID/nonce 的原子锁文件并接管死 PID 残留，PowerShell 使用 `FileShare.None`，进程退出后由系统释放句柄。

调度器启动时会把上次控制平面中断留下的 `running + deterministic` 任务恢复为 `queued` 并释放旧锁，使其按 SQLite 检查点续跑；`complex` 任务保持原状态，由 Multica 同步桥恢复，不能被本机固定流程调度器误领。

## 7. Token 和上下文

- 固定流程和控制命令优先 0 Token。
- planner 只存在于拆分阶段，最多输出四个子任务。
- 每个 worker 有独立 workspace、summary 和 checkpoint 目录。
- 只有无副作用结果可以缓存；提交、发送、写文件和启动软件的成功状态不能复用。
- Multica 官方 `issue usage` 返回 issue 聚合量；本机用稳定 issue 快照 ID 原地更新，不把每次轮询重复累加。
- `token_ledger` 按 task、worker、model 和 usage/run ID 去重记录输入、缓存输入、输出、延迟和费用。
- 费用只使用私有 `config/pricing.json`；`cached_tokens` 是输入 Token 的子集，先从输入量扣除，再分别套用普通输入和缓存输入费率，不能重复计费。未知价格返回 `null`。
- worker 的检查点按 `task + worker` 隔离，`task_checkpoint_read` 只能读取当前绑定 worker 的内容。
- 90 分钟预算从当前 worker run 真正开始时计算，轮询不会刷新起点。到期时只有本轮开始后保存的新检查点才有效；控制平面会重签能力票、取消当前 Multica run 并对同一 issue 执行 rerun。没有新检查点或续跑链路不完整时停止远端 run 并把 worker 标为失败，不伪造续跑。

## 8. 远端生命周期

复杂任务的本机状态和 Multica run 必须一起变化：

- `暂停`：本机先标记暂停，再用 `multica issue cancel-task <run-id>` 停止 planner 或 worker 的活动 run，并记住对应 issue。
- 暂停期间：后台同步继续检查，补取消命令时尚未出现的远端 run，防止任务仍在消耗 Token。
- `继续`：仅对暂停时成功停止的 issue 执行 `multica issue rerun <issue-id>`；任何 rerun 失败都会让任务保持暂停并明确回复。
- `取消`：停止所有可见活动 run 后进入本机终态；远端停止失败会在回复中如实列出，不会伪报全部成功。

worker issue 派发失败会从 `dispatching` 回到 `planned` 并在后续轮次重试。planner 输出无效会直接使根任务失败并进入终态回执队列，不会卡在运行态。根任务终态之后才出现的 planner/worker run 也会被后台补取消；确认所有远端 issue 已进入终态后记录一次清理完成，不再每 15 秒重复调用。

人工登录、验证码和需要人工判断的弹窗属于 `waiting_for_user`，不增加瞬时错误重试计数。只有可重试的执行错误才使用三次退避额度。

## 9. 进程生命周期

`Install-DailyTwinServices.ps1` 为当前用户注册三个登录触发任务：

```text
DailyDigitalTwin-ControlPlane
DailyDigitalTwin-Telemetry
DailyDigitalTwin-Multica
```

任务使用 PowerShell 7、`Interactive`、`Limited`、无限执行时长、崩溃后重试和 `IgnoreNew`。注册动作显式携带私有目录、Node 和 Multica 可执行文件路径，不依赖注销后才刷新的环境变量。`-WhatIf` 只生成预览，不调用计划任务 API；真实注册的所有 cmdlet 都以错误即停止。`-SkipMultica` 只注册前两个，并在回执中只列出实际注册项。

控制平面启动飞书 WebSocket、固定流程调度器、Multica 同步、Token/回执泵和健康心跳。启动任一步失败都会立即走同一清理入口，关闭已经打开的飞书、浏览器、SQLite 和进程锁，不能留下“进程仍在但服务不可用”的假在线状态。每个后台泵单飞，同类上一次调用未结束时不会重入；停止时先停 timer、scheduler 和飞书，再等待活动泵结束，最后关闭浏览器、健康记录、SQLite 和进程锁。终态文字回执在发送前统一脱敏。

旧 OpenClaw 任务只有在 `control-plane-health.json` 显示同一实例连续健康至少 48 小时、状态仍为 `running`、PID 真实存活且心跳新鲜时，才允许由 `Complete-DailyTwinCutover.ps1` 停用。刚停止进程写下的新鲜心跳不能通过闸门。回滚脚本注销新任务并恢复旧任务，不删除任何数据。

## 10. 仍需真实环境证明的部分

自动化测试不能证明以下外部契约：

- Multica CLI 已安装、登录，planner 和四个 Codex agent 配置正确。
- Multica 当前版本会给每项工作创建独立 `CODEX_HOME`，并加载对应 MCP 配置。
- Playwright Extension 已在日常 Edge 中配对，登录态在 Edge 重启后仍可用。
- 飞书事件订阅、WebSocket、allowlist 和图片上传在真实租户可用。
- Omicos、Biomni 的真实路径、selector、窗口标题和完成条件仍匹配当前版本。
- Windows 登录后三个计划任务能持续在线，并在所有 PowerShell 窗口关闭后继续工作。
- 空闲 5 分钟时控制平面、MCP 和 Multica daemon 的总内存低于目标值。

这些项目必须按 [RUNBOOK](RUNBOOK.md) 真机验收。CI 通过只说明源码内部契约成立，不能替代上述事实。

---

> 中文注释：以下章节来自 main 侧 v3（AI planner / executor 与 morning 工作流在合并后的代码中仍然可用）。

## 13. Morning workflow and AI integration (v3)

The v3 extension adds the "morning dump" workflow: the user writes all their tasks
in a text file, and a single command runs the full pipeline.

```
tasks.txt ──▶ planner.mjs ──▶ TaskStore (parent + sub-tasks) ──▶ scheduler-loop ──▶ ai-executor.mjs
                 │                    │                              │
                 │                    │                              │  ai_call → AI API
                 │                    │                              │  desktop → partial (needs private executor)
                 │                    │                              │  browser → partial (needs private executor)
                 │                    │                              ▼
                 │                    │                        evidence-gated completion
                 ▼                    ▼
          OpenAI-compatible       parent_task_id
          API (untrusted)         task_type, priority
```

### Planner (`src/core/planner.mjs`)

Takes a list of raw task descriptions, sends them to an OpenAI-compatible chat API with a
system prompt that asks for decomposition into sub-tasks with type classification
(`ai_call` / `desktop` / `browser`) and priority (1–5). Returns a validated plan.

When no API is configured, it **passes through** — each task becomes a single `unknown`-type
sub-task. This is not an error; it lets the system work without an API key, just without
decomposition.

The planner is **untrusted**: its output is validated structurally (`validatePlan`), and
`parentIndex` bounds are checked against the original task count. A malformed plan is rejected;
the morning workflow falls back to passthrough rather than failing.

### AI executor (`src/core/ai-executor.mjs`)

Implements the scheduler-loop executor contract for `ai_call`-type tasks. Calls the AI API,
saves the output to a file under `data/outputs/`, and returns that file as execution evidence.
Without file evidence, the task is downgraded to `partial` — the same evidence-gated completion
rule from §7 applies.

The **composite executor** routes by `task_type`: `ai_call` → AI executor, `desktop` / `browser`
→ `partial` with a message that the corresponding private executor is needed. This is the
executor wired into `runtime daemon`.

### Schema v3

Adds `parent_task_id`, `task_type`, and `priority` columns to the `tasks` table. Migration is
idempotent and backward-compatible: a v2 database upgrades in place, existing tasks get
`task_type = 'unknown'` and `priority = 0`.
