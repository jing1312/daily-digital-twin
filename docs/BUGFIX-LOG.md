# 缺陷修复记录

本轮改造前，代码里存在 26 处可疑点，逐个写探针实测后 **24 处确认为真实缺陷**。
下表是"缺陷 → 修复位置 → 守住它的测试"的完整映射。编号 `B*` 同时出现在提交信息、
代码注释和测试名里，方便日后顺着任一处反查。

测试总数：**132**，全部通过（`npm test`）。

---

## P0：会造成数据错误或隐私泄漏

### B1 暂停会摧毁"等待验证码"状态

`pause()` 无条件把任务状态改写为 `queued`。一个正在等验证码的任务被暂停后，
等待原因随之丢失，验证码流程直接断掉，且无法恢复。

- 修复：`src/core/task-store.mjs` —— `pause()` 只在状态为 `running` 时降回 `queued`，
  其余状态原样保留，并把原状态记进新增列 `paused_from`。操作幂等。
- 测试：`test/task-control.test.mjs`（B1 / B1b）
- 冒烟：`.github/scripts/cli-smoke.sh` 第 3 段

### B2 暂停的任务仍然占用并发槽位

槽位统计把 `paused` 的任务算作活跃，于是"只有一个任务在跑"却报槽位已满。

- 修复：`src/core/task-store.mjs` —— 拆开三个概念：`countRunnableTasks`（可跑的）、
  `countOpenTasks`（未结束的）、`countActiveTasks`（占槽的）。暂停任务只进第二类。
- 测试：`test/task-control.test.mjs`（B2 / B2b）
- 冒烟：`pause 1` 之后断言 `runnable: 0` 且 `open: 1`

### B11 数据库没开 WAL，`busy_timeout` 为 0

`journal_mode=delete` + `busy_timeout=0`：只要有第二个连接同时写，立刻 `database is locked`。
一个 7×24 常驻、还要并发两个 worker 的系统，这是必然踩到的。

- 修复：`src/core/schema.mjs` 的 `applyPragmas({ busyTimeoutMs = 5000 })` 打开 WAL 并设置
  忙等超时；`task-store.mjs` 再叠一层重试（`busyRetries: 5`，间隔 120 ms，
  通过 `Atomics.wait` 同步睡眠）。
- 测试：`test/concurrency.test.mjs`（B11 / B11b）
- 注意：内存库的 `journal_mode` 报告为 `memory`，这不是失败，B11b 专门守住这一点。

### B12 资源锁是"先查后插"，存在竞态窗口

`acquireLock` 先 `SELECT` 再 `INSERT`，两条语句之间另一个 worker 可以插进来，
两个任务同时拿到同一个资源。

- 修复：`src/core/task-store.mjs` —— 改成单条原子语句（`INSERT ... WHERE NOT EXISTS`），
  并新增 `exclusive_class` 列 + 部分唯一索引
  `resource_locks_one_per_class ... WHERE exclusive_class IS NOT NULL`，
  用于"同一时刻只允许一个前台桌面任务"。`tryAcquireLock` 返回
  `{ ok, code: 'resource_busy' | 'exclusive_class_busy', holderTaskId }`。
- 测试：`test/concurrency.test.mjs`（B12 / B12b）

### B5 脱敏规则把正常文本打成筛子

敏感值列表里混进了空字符串。以空串做替换意味着"在每个字符之间都插一次掩码"，
于是 `Biomni 已运行` 这种正常摘要被打成 `***B***i***o***m***n***i***…`。

- 修复：新增 `src/core/redact.mjs`。`normalizeSecrets()` 丢弃非字符串、丢弃修剪后不足 3 字符的
  值、去重，并**按长度倒序**替换（否则短值会先把长值切碎）。
- 测试：`test/redaction.test.mjs`（B5）

### B5b 未登记的密钥、真实路径、Cookie 原样落盘

只按"已登记的敏感值"做字符串替换，没有形态识别。于是 `sk-proj-…` 开头的密钥、
真实 Windows 用户目录、`cookie: session=eyJhbGciOi` 这类内容全部原样写进回执。

- 修复：`src/core/redact.mjs` 双轨制 —— **按键名**（`SECRET_KEY_PATTERN`，命中
  `api_key`/`token`/`cookie`/`authorization`/`code`/`otp`/`password` 等一律掩码，不看值长什么样）
  加**按形态**（`VALUE_PATTERNS`：`sk-` 前缀、JWT 三段式、Windows 用户目录、
  GitHub 令牌五种前缀、`Bearer` 头）。`redactValue()` 递归处理对象，用 WeakSet 防循环引用。
  另导出 `findLeaks()` 主动报告"仍然泄漏了什么"。
- 测试：`test/redaction.test.mjs`（B5b / B5b2）
- 同源加固：`scripts/privacy-audit.mjs` 直接复用 `findLeaks`，两处规则不会漂移。

### B17 飞书消息没有发送者校验，且验证码原样回传

任何人只要能把消息投到那个会话，就能驱动你的电脑；返回结构里还带着原始 `code` 字段。

- 修复：`src/core/feishu-adapter.mjs` 强制要求发送者身份，配合 `task-store.mjs` 的
  `claimOwner()` —— **首个发送者自动成为归属账号**，之后其它账号一律拒绝。
  `owner_open_id` 落库持久化，可用 `runtime owner reset` 重新配对。
  验证码不出现在任何可序列化输出里。
- 测试：`test/feishu-identity.test.mjs`（B17 / B17b / B17c / B17d）
- CLI：`runtime owner show` 显示时掩码成 `xxxx***`

### B13b / B14 `init <目录>` 与 `create` / `status` 各写一个 home

`init` 走一套路径解析，其它命令走另一套。结果 `init` 建好的库和 `create` 写入的库
不是同一个文件。更糟的是 `DAILY_TWIN_HOME` 未设置时会**回退到公开仓旁边的 `runtime\`**，
而这个目录当时不在 `.gitignore` 里——运行数据随时可能被提交上去。

- 修复：新增 `src/core/home.mjs`。所有命令共用 `resolveHome()`，优先级
  `--home` > 环境变量 > **抛错**（`HomeResolutionError`，code `home_not_configured`）。
  **没有仓库内回退路径。** `.gitignore` 补上 `runtime/`、`backups/`、`receipts/`、
  `screenshots/`、`credentials/`、`*.sqlite-wal`、`*.sqlite-shm`、`*.bak*`。
- 测试：`test/home.test.mjs`（B13b / B13b2 / B14 / B14b）
- 冒烟：第 1 段断言未配置 home 时非零退出，且**仓库里不会新建 `runtime/` 或
  `data/runtime.sqlite`**；第 6 段结束时再确认仓库仍然干净。

---

## P1：会让替身行为出错或在关键时刻拒绝服务

### B3 零等待者时纯数字消息被当成新任务

用户发一串数字本意是验证码，但没有任务在等待时，这串数字被静默创建成了一个新任务。

- 修复：`src/core/message-router.mjs` + `task-store.mjs` 的 `listVerificationWaiters()`
  （JOIN 时带 `expires_at > now`，TTL 默认 600 秒）。没有有效等待者就明确拒绝，不猜。
- 测试：`test/router.test.mjs`（B3 / B3b）

### B4 不带编号的 `暂停` 返回 `任务 null 不存在`

- 修复：`src/core/feishu-adapter.mjs` —— 只有一个候选任务时直接生效；多个候选时列出候选
  并要求补编号；统计候选时只算未暂停的任务。
- 测试：`test/router.test.mjs`（B4 / B4b / B4c / B4d）

### B6 / B6b 遥测缺失时"失败开放"

`decideResourcePolicy({ onAcPower: true })` 返回 `{ slotLimit: 4, acceptsNewActions: true }`；
连 `decideResourcePolicy({})` 都返回 `acceptsNewActions: true`。也就是说什么都不知道的时候，
它选择满负荷开工。

- 修复：`src/core/resource-policy.mjs` 改为**失败关闭**：任何一项
  （`cpuPercent` / `availableMemoryGb` / `diskFreeGb` / `onAcPower`）缺失或非法，
  返回 `{ slotLimit: 0, acceptsNewActions: false, reason: '遥测缺失', missing: [...] }`。
  `Number(null) === 0` 这个陷阱由 `telemetry.mjs` 导出的 `toFiniteNumber()` 挡住——
  否则"没有值"会被当成"0%"，反而更容易通过阈值。
- 测试：`test/resource-and-receipt.test.mjs`（B6 / B6b / B6c / B6d）
- 配套：因为改成失败关闭，必须有办法真的拿到遥测，于是新增
  `src/core/telemetry.mjs` 与 `platform/windows/Write-DailyTwinTelemetry.ps1`（见"偏离清单"第 3 条）。

### B7 `pause abc` 变成 `taskId: NaN`

`Number('abc')` 得到 `NaN`，然后 `NaN` 被原样传进 SQL。

- 修复：`src/core/runtime-command.mjs` 的 `parseTaskId()` 要求 `/^\d+$/` 且为安全正整数，
  错误码 `missing_task_id` / `invalid_task_id`。
- 测试：`test/runtime-command.test.mjs`（B7 / B7b / B7c）

### B8 应用目录缺 `apps` 键直接崩栈

`Cannot read properties of undefined (reading 'filter')`。

- 修复：`src/core/app-catalog.mjs` 校验结构，缺失时给出带文件路径的可读错误。
- 测试：`test/app-catalog.test.mjs`（B8 / B8a）

### B8b 别名大小写敏感

`vs code` 匹配不上目录里登记的 `VS Code`。

- 修复：比较前统一小写并修剪首尾空格；**别名冲突时拒绝执行**而不是随便挑一个。
- 测试：`test/app-catalog.test.mjs`（B8b，以及别名冲突、站点与应用不串台等 5 条）
- PowerShell 侧同一逻辑：`platform/windows/Start-DailyTwinApp.ps1`，
  由 `Test-DailyTwinPlatform.ps1` 用 AST 抽出该函数单独验证。

### B9 进入终态时抹掉了原因字段

任务失败后 `reason` 被清空，事后无法知道为什么失败。

- 修复：`src/core/task-store.mjs` 用 `'reason' in options` 区分"没传"和"显式传 null"；
  新增 **一次性写入**列 `failure_reason`（`UPDATE ... WHERE failure_reason IS NULL`），
  保证第一次记录的失败原因永远不被后续状态流转覆盖。
- 测试：`test/task-control.test.mjs`（B9 / B9b）

### B10 没有持久化的重试计数

重启后重试次数归零，退避策略等于失效。

- 修复：新增 `tasks.attempt` 列 + `bumpAttempt()`（返回**数字**，不是对象）。
  另加 `resume_state` 列与 `saveResumeState()` / `getResumeState()`（读取时自动解析 JSON）。
- 测试：`test/task-control.test.mjs`（B10 / B10b）、`test/concurrency.test.mjs`
  中"数据库文件重开后任务与尝试次数仍然存在"

### B13c 未知命令打印裸堆栈

用户敲错一个字，得到一屏 Node 堆栈。

- 修复：`src/runtime.mjs` 的 `reportError()` 输出结构化 JSON，
  **只在 `DAILY_TWIN_DEBUG=1` 时附堆栈**；未知命令返回 `unknown_command` + 用法。
- 测试：`test/runtime-command.test.mjs`（B13c）
- 冒烟：第 5 段直接 `grep` 输出里有没有 `    at ` 这种堆栈行，有就判失败

### B20 配置文件里的键在源码里根本不存在

`config/runtime.example.json` 写着一堆阈值，但 `src/` 和 `test/` 里搜不到这些键名——
真正生效的是硬编码：CPU 55%、内存 8 GB、磁盘 20 GB、4 个槽位、退避 `[30, 120, 300]`。
改配置文件没有任何效果。

- 修复：新增 `src/core/config.mjs`，`DEFAULT_CONFIG` 与
  `config/runtime.example.json` 逐字对应（示例文件由默认值生成并做过往返校验）。
  `loadConfig(home)` 返回 `{ config, source, path }`；文件不存在返回默认值而不报错；
  格式错误抛 `ConfigError` 并逐条列出问题。`resource-policy.mjs`、`retry-policy.mjs`、
  `scheduler.mjs` 全部改为读配置。
- 测试：`test/config.test.mjs`（B20 / B20b / B20c，共 9 条）

---

## P2：死代码与"设计写了但没实现"

### B15 浏览器路由只有 126 行设计文档，`src/` 里没有实现

而且那份设计文档的策略本身是错的（"Edge is the default for every browser task"），
脚本里则硬编码了 `--browser-profile chrome`——**那个 profile 按定义就是 Chrome，不是 Edge**。

- 修复：新增 `src/core/browser-router.mjs`（五个 profile + `routeBrowserAction()`）。
  完整说明与更正见 `docs/BROWSER-PROFILES.md`。
- 测试：`test/browser-router.test.mjs`（B15 / B15b / B15c，共 9 条）；
  `test/powershell-hygiene.test.mjs` 里另有一条规则禁止再出现硬编码的
  `--browser-profile chrome`。

### B16 `canSchedule` 只被它自己和它的测试引用

- 修复：新增 `src/core/scheduler-loop.mjs`，把调度判断真正接进循环。
  执行器契约：`{ task, store, config }` → `{ outcome, summary?, reason?, evidence?[] }`。
  **`start()` 在调度器关闭时返回 `{ started: false, reason: 'scheduler_disabled' }`**——
  默认休眠是刻意的。

### B16b `recordTokenUsage` 从未被调用

- 修复：`token_ledger` 表落地（含 `cached_tokens` 列），`recordTokenUsage` /
  `summarizeTokenUsage` 接进 `token-ledger.mjs` 与回执流程。
- 测试：`test/resource-and-receipt.test.mjs` 中"回执可携带执行证据与 token 用量"
- **注意**：这一轮只把账本接通。完整的 token / 上下文平面（上下文编译器、
  提示缓存分级、按 worker 隔离命名空间）**明确留到下一轮**。

### `app-catalog.mjs` 没有任何地方 import

- 修复：接进 CLI 与 PowerShell 侧应用启动流程，并补上 8 条测试。

---

## PowerShell 层

### B18 覆盖 PowerShell 自动变量

`Invoke-DailyTwinBrowser.ps1` 拿 `$args` 当普通数组用；`Start-DailyTwinApp.ps1` 直接给
`$matches` 赋值。`$matches` 是 `-match` 的捕获结果，**后面任何一次 `-match` 都会把它冲掉**，
属于"今天能跑、明天随机出错"的那类问题。

- 修复：`$args` → `$browserArguments`，`$matches` → `$matchedApps`。
  参数名同理避开自动变量：浏览器 profile 参数叫 **`-BrowserProfileName`**（不是 `-Profile`，
  `$PROFILE` 是自动变量），私有目录参数叫 **`-PrivateHome`**（不是 `-Home`）。
- 测试：`test/powershell-hygiene.test.mjs` —— 检查自动变量赋值与参数声明两种形态，
  各带一条负向对照测试。
- 例外：`$null = SomeCommand` 是官方的"丢弃输出"惯用写法，不在禁止范围内。

### B19 计划任务配置会在 24 小时后自杀

`ExecutionTimeLimit (New-TimeSpan -Hours 24)`：一个号称 7×24 常驻的服务，
到 24 小时会被计划任务直接终止。同时没有 `RestartCount`（崩了不重起）、
没有 `-Principal`（登录类型不明确），也没检查 `pwsh.exe` 是否存在。

- 修复：`platform/windows/Install-DailyTwinStartup.ps1` ——
  `ExecutionTimeLimit = [TimeSpan]::Zero`（不限时）、`RestartCount` / `RestartInterval`、
  `New-ScheduledTaskPrincipal -LogonType Interactive -RunLevel Limited`
  （`InteractiveToken` **不是合法值**）、`MultipleInstances IgnoreNew`、
  注册前检查 `pwsh.exe` 并给出 winget 提示、`-Unregister` 开关。
- 测试：`test/powershell-hygiene.test.mjs` 禁止再出现有限的 `ExecutionTimeLimit`。

---

## 两处"我自己造出来的洞"，也记在这里

写测试的过程中发现两个**我这轮新加的检查本身**是假绿灯，一并修掉：

1. **隐私审计能在扫描 0 个文件的情况下判通过。** 遍历逻辑一旦写坏，输出仍然是"通过"。
   已加 `MINIMUM_SCANNED_FILES = 20` 下限，并让成功输出**始终打印扫描到的文件数与字节数**。
2. **PowerShell 卫生检查在给自己的文档报警。** 这些脚本刻意在注释和字符串里写反面例子
   （"`InteractiveToken` 不是合法值"、"5.1 上 `ConvertFrom-Json` 没有 `-Depth` 参数"），
   而检查规则是拿裸文本做正则，于是把文档当成了缺陷——5 条初始失败里有 3 条是这个原因。
   已新增 `scripts/lib/powershell-source.mjs`：一个小型词法扫描器，先把注释和字符串
   （含 `<# #>`、`@'...'@`、`@"..."@` here-string）替换成等长空格再匹配，**保留行号与总长度**。
   规则表里每条都带一个 `bait` 字符串，配两条负向对照测试：
   每条规则必须能在 bait 上触发，且 bait 出现在注释或字符串里时必须**不**触发。

另外还有一类只有写测试才会暴露的问题：**非 `async` 的临时目录辅助函数**会让
`finally` 里的 `rmSync` 在异步读取之前就删掉目录。凡是这类 helper 都必须
`async` + `return await work(home)`。

---

## B25 `Write-DailyTwinJsonFile` 会静默截断嵌套较深的 JSON

**来源：** PR #1（`feat/browser-route-c`）。这条是从那个分支里**单独摘出来**的：
它是 PR #1 里唯一一个与浏览器路线无关、却会弄坏用户真实数据的公共层缺陷，
所以先单独进主线，不必等整条浏览器路线的结论。
洞是在写 `Set-OpenClawBrowserProfile.ps1`（那个脚本要改写用户真实的 `openclaw.json`）时暴露的。

`ConvertTo-Json` 的 `-Depth` 默认只有 2，超出的层级不会报错，而是被写成
`"@{a=1}"` 这样的字符串。`DailyTwin.Common.ps1` 里的 `Write-DailyTwinJsonFile`
原本固定给 `-Depth 6`——比默认好，但仍然是一个**猜出来的常数**。
一旦被写的对象比这个常数深，写盘过程一声不吭，
用户拿到的是一个能解析、但语义已经坏掉的配置。

**严重程度是实测的，不是估的。** 用新加的 `Get-DailyTwinJsonDepth` 量过仓库现有的配置样例：
`config/runtime.example.json` 实测**深度 3**，用旧的固定 `-Depth 6` 序列化**不会**被截断。
所以对目前随仓库发布的配置来说，这是一个**尚未触发的潜在缺陷**，不是正在冒烟的故障。
真正的残余风险在 `Write-DailyTwinTelemetry.ps1`：它序列化的是 CIM 查询回来的对象，
深度由 Windows 决定、不由我们控制，那才是这个固定常数最可能先崩的地方。

修法（在公共层修，四个调用方一起受益）：

1. 新增 `Get-DailyTwinJsonDepth` —— 递归量出对象的实际嵌套深度。
   哈希表、数组、普通属性袋各算一层；字符串和值类型算 0 层；递归自带 100 层熔断。
   实现上必须用 `ArrayList.Add` 逐个装子节点：走管道的话数组会被 PowerShell 展开，
   "数组也占一层"就量不出来了（这一条是写完第一版后被自检里的断言抓出来的）。
2. 新增 `Resolve-DailyTwinJsonDepth` —— 实测深度 **+2** 的余量，不低于调用方要求的值，
   上限 100（`ConvertTo-Json` 自己的上限）。
3. 新增 `Test-DailyTwinJsonTruncated` —— 检查序列化结果里有没有 `"@{`、
   `"System.Collections.Hashtable"`、`"System.Object[]"`、
   `"System.Management.Automation.PSCustomObject"` 这四个截断特征串。
   `Write-DailyTwinJsonFile` 序列化完一旦检出就**抛错，不写盘**。
4. `Write-DailyTwinResult` 也改成按实测深度序列化：回执一般很浅，
   但 `changes` / `blockers` 这类"数组套对象"也能到 4~5 层。

回归断言（`Test-DailyTwinPlatform.ps1` 新增 13 条，脚本层自检总数 **33 → 46**）：
量深度的边界（标量 0、`null` 0、平铺对象 1、数组自己算一层、`DateTime` 算标量）、
8 层嵌套量出来必须是 8、8 层写盘再读回来一字不差、
写出的文件里没有特征串、调用方要求的更大深度不被压小、上限确实是 100。
其中最关键的一条是**反向对照**：拿同一个 8 层对象用旧的固定 `-Depth 6` 序列化，
断言截断检测**确实**能抓到它——否则这套守卫可能只是全绿，而没在测任何东西。

**这一次没有一起带过来的部分（仍留在 PR #1 里）：**
`Set-OpenClawBrowserProfile.ps1` 落盘后读回来核对、任何一项不对就用备份原地还原的那一段，
以及跑一遍完整 `-Apply` 再断言 8 层原有配置无损的端到端回归。
那两段依赖 PR #1 的 OpenClaw 配置脚本本身，而这个分支里没有那个脚本；
所以也就不该写进日志——否则这份日志会描述一件仓库树里并不存在的事。

---

## 偏离原计划的地方（7 条，全部有意为之）

| # | 偏离 | 原因 |
|---|---|---|
| 1 | 改动了 `test/scheduler-adapter.test.mjs` | 它原来的 `handleFeishuText(store, '打开 Biomni')` 把 B17 漏洞编码进了测试。现在传 `{ openId: 'ou_owner' }`。这打破了计划里"12 个既有测试逐字不变"的承诺，但断言意图完整保留。 |
| 2 | token 表沿用 `token_ledger` 而非计划里的 `token_usage` | 表已存在，改名会让迁移复杂化且无收益；改为新增 `cached_tokens` 列。 |
| 3 | 新增 `src/core/telemetry.mjs` + `Write-DailyTwinTelemetry.ps1` | 计划正文没有这两个文件。但 B6 改成失败关闭后，如果没有喂遥测的途径，替身会**永久无法运行**。 |
| 4 | 离开 `waiting_for_user` 时**不**自动清空 `reason` | 自动清空会把 B9 重新弄坏。持久性改由一次性写入的 `failure_reason` 列保证。 |
| 5 | `scripts/privacy-audit.mjs` 整体重写，而非计划里的"扩充规则" | 旧版会静默漏掉转义过的 Windows 路径（源码里单反斜杠写成两个），必须先归一化再匹配。 |
| 6 | 新增共享库 `platform/windows/DailyTwin.Common.ps1`，四个原有 `.ps1` 整体重写而非打补丁 | 编码、JSON 读写、路径解析这些逻辑在四个脚本里各写了一遍且各有不同的错。 |
| 7 | 新增 `scripts/lib/powershell-source.mjs`、`scripts/lint-powershell.ps1`、`platform/windows/Test-DailyTwinPlatform.ps1`、`.gitattributes`、`.github/scripts/cli-smoke.sh` | 计划正文没有这些文件；它们分别用于词法扫描、PowerShell 静态检查、脚本层运行时自检、行尾控制和 CLI 冒烟。 |

---

## 沙箱里无法证明、必须真机验证的部分

- **所有 `.ps1` 的运行时行为。** 沙箱没有 Windows，用不了 CIM 类、计划任务、
  真实浏览器。这里能做的只有：语法解析、编码检查、PSScriptAnalyzer、
  以及 `Test-DailyTwinPlatform.ps1` 里那些跨平台可跑的部分。
- **Windows PowerShell 5.1 的语法边界。** 沙箱只有 PowerShell 7.6.4。实测
  `(if ...)`、`$x = if (...)`、`$x = switch (...)`、`@(if ...)`、`"$(if ...)"`、三元、`??`
  在 7.x 上**全部解析通过**，所以沙箱证明不了它们在 5.1 上的行为。
  这些判断已交给 GitHub Actions 的 `windows-latest` 作业——那里用
  `shell: powershell`（即 Windows PowerShell 5.1）跑 `Parser::ParseFile`，
  那才是权威的 5.1 语法检查。
- **Edge 能否加载 Chrome 扩展。** 见 `docs/BROWSER-PROFILES.md` 路线 B。
- **磁盘可用空间的真实数值。** 沙箱的 overlay 文件系统会报出
  `diskFreeGb: 8589934591.22` 这种明显失真的值，属于环境假象，不影响逻辑。
