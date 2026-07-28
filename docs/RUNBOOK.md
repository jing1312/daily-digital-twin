# 运维手册（Windows 11 本机）

面向"每天真的要用它"的场景。命令按顺序抄即可，每一步都写了**怎么判断成功**和**出错怎么退回**。

约定：

- `<私有目录>` 指存放运行数据的目录，**必须在公开仓之外**，建议放 D 盘，例如 `D:\DailyTwin`。
- `<仓库目录>` 指这个 Git 仓库所在目录。
- 所有 PowerShell 脚本都在 `platform/windows\`，都要求 PowerShell 5.1 或 7.x。
- 脚本一律输出 JSON（`Write-DailyTwinResult`），方便你直接看字段而不是读散文。

---

## 0. 一次性前置检查

```powershell
node --version          # 需要 >= 24
pwsh --version          # 建议 7.x；5.1 也能跑，但功能更少
```

Node 低于 24 的话 `node:sqlite` 不存在，整个运行时起不来。

---

## 1. 定路径与配额（先做这一步）

历史上 `DAILY_TWIN_HOME` **根本没有设置**，于是旧代码把运行数据写到了公开仓旁边的
`runtime\` 目录里。现在的代码在没有这个变量时会**直接报错退出**（`home_not_configured`），
不会再偷偷写进仓库。所以第一步必须是定路径。

```powershell
cd <仓库目录>
.\platform\windows\Set-DailyTwinPaths.ps1 -PrivateHome D:\DailyTwin
```

这个脚本做四件事：

1. 写**用户级**环境变量 `DAILY_TWIN_HOME`（不是机器级，不需要管理员）。
2. 在 `<私有目录>\config\runtime.json` 里写入 `storage` 配额块。
3. 报告 C 盘和 D 盘可用空间。
4. **默认只报告超配额的目录，不删任何文件。**

参数（都有默认值，按需覆盖）：

| 参数 | 默认 | 含义 |
|---|---|---|
| `-MaxCacheMb` | 2048 | 缓存目录上限 |
| `-MaxScreenshotsMb` | 2048 | 截图目录上限 |
| `-MaxLogsMb` | 512 | 日志目录上限 |
| `-KeepFreeDiskGb` | 20 | 至少给盘留多少空闲 |
| `-Enforce` | 关 | **加上才会真的删文件** |
| `-SkipEnvironmentVariable` | 关 | 只建目录写配置，不动环境变量（用于试跑） |

> 环境变量写入后，**当前这个 PowerShell 窗口读不到**。关掉重开一个，或者手动
> `$env:DAILY_TWIN_HOME = 'D:\DailyTwin'`。

判断成功：新开窗口里 `$env:DAILY_TWIN_HOME` 有值。

---

## 2. 建目录结构

```powershell
.\platform\windows\Initialize-DailyTwinHome.ps1
```

会创建 7 个目录，与 `src/core/home.mjs` 的 `HOME_DIRECTORIES` 一一对应：

```
data\tasks  data\receipts  data\screenshots  data\cache  data\logs  config  backups
```

等价的 Node 侧命令（两者建的是同一批目录，用哪个都行）：

```powershell
npm run runtime -- init
```

判断成功：`init` 的输出里 `configWritten: true`，且上面 7 个目录都存在。

---

## 3. 备份 OpenClaw 现有数据（改配置之前必做）

你机器上的 OpenClaw 已经有真实数据：任务记录若干条，会话 JSONL 文件约 7 MB。
**这些不能丢。** 改 `openclaw.json` 之前先跑：

```powershell
.\platform\windows\Backup-DailyTwinState.ps1 -OpenClawHome <OpenClaw 目录>
```

行为：

- **只复制，从不移动。** 原文件一个字节都不动。
- `openclaw.json` 会同时留两份：原地的 `openclaw.<时间戳>.bak`，以及备份目录里的副本。
- sqlite 会连 `-wal` 和 `-shm` 一起复制（只拿主库文件，恢复时可能丢最后一批未落盘的写入）。
- 会话 `*.jsonl` 从 `sessions`、`data\sessions`、`state\sessions` 三个位置收集。
- **检测到 `openclaw` 或 `node` 进程在运行时会拒绝执行**，除非你加 `-Force` 自己承担
  一致性风险。
- 结束时打印**一行回滚命令**，直接复制粘贴就能还原。

可选参数：`-BackupRoot`（默认落在 `<私有目录>\backups`）、`-PrivateHome`。

判断成功：备份目录里能看到 `openclaw.json`、`*.sqlite`、以及 7 个左右的 `*.jsonl`，
且总大小和源目录相当。

---

## 4. 遥测：让替身知道机器忙不忙

`os.cpus()` 在部分环境下返回全零时间片，导致 CPU 占用取不到值。资源策略是
**取不到就拒绝新动作**（fail-closed），所以如果不喂遥测，替身会永远处于"不接活"状态。
这是刻意的：宁可不干活，也不要在你打游戏或开会时把机器拖死。

前台跑一次（写一份快照就退出）：

```powershell
.\platform\windows\Write-DailyTwinTelemetry.ps1
```

常驻循环（默认 60 秒一次）：

```powershell
.\platform\windows\Write-DailyTwinTelemetry.ps1 -Loop -IntervalSeconds 60
```

数据落在 `<私有目录>\data\telemetry.json`，**无 BOM**，Node 侧只接受 **300 秒内**的样本，
过期视为不可用。

取值来源（都刻意避开 `Get-Counter`——性能计数器名在中文 Windows 上是本地化的，
`\Processor(_Total)\% Processor Time` 这种路径在中文系统上根本匹配不到）：

- CPU：`Win32_PerfFormattedData_PerfOS_Processor` 的 `_Total`，失败退回
  `Win32_Processor.LoadPercentage`。
- 供电：`Win32_Battery.BatteryStatus`（AC 状态码 `2,6,7,8,9`）。没有电池对象视为台式机
  → 认为一直接电。读不到 → 返回 `$null`，**绝不猜"已接电"**。
- 内存：`Win32_OperatingSystem.FreePhysicalMemory`。

临时应急（不写文件，直接用环境变量顶一下）：

```powershell
$env:DAILY_TWIN_CPU_PERCENT = '20'
$env:DAILY_TWIN_ON_AC_POWER = '1'
```

环境变量优先级高于文件，适合调试，不适合长期使用。

---

## 5. 自检

两个自检，一个查环境，一个查脚本层自身。

```powershell
# 环境自检：Node 版本、pwsh、私有目录、仓库里有没有残留 runtime\、磁盘、数据库、
# 遥测新鲜度、网关端口、浏览器 profile 是否被误配成 chrome
.\platform\windows\Invoke-DailyTwinDoctor.ps1

# 脚本层自检：编码、JSON 读写、路径解析、磁盘查询、应用别名匹配
npm run selftest:ps
```

`Invoke-DailyTwinDoctor.ps1` 可选参数：`-PrivateHome`、`-RepositoryRoot`、
`-GatewayPort`（默认 18789）、`-RefreshTelemetry`（顺手刷一次遥测再判断新鲜度）。
**任何一项 fail 都会以退出码 1 结束**，方便挂到计划任务里。

Node 侧的对应命令：

```powershell
npm run doctor
```

输出里最值得看的三个字段：

- `telemetrySources` —— `cpu` / `power` 的实际来源，取值为 `env` / `file` / `local` / `unavailable`。
  优先级是 **环境变量 > 新鲜的遥测文件 > Node 本机采样**（`power` 没有本机采样，只有前两种）。
  如果是 `unavailable`，看 `telemetryReasons` 里的原因码。
  有一个反直觉的情况值得记住：遥测文件**新鲜但 `cpuPercent` 无效**时，原因码是 `missing_cpu_percent`，
  并且**不会**回退到本机采样 —— 这是刻意的失败关闭，宁可停工也不拿另一个来源掩盖坏掉的传感器。
  想恢复只有两条路：修好 `Write-DailyTwinTelemetry.ps1` 的写入，或者删掉 `data/telemetry.json`
  （文件不存在时才会启用本机采样兜底）。临时救急可以设 `DAILY_TWIN_CPU_PERCENT`。
- `resourcePolicy.acceptsNewActions` —— `false` 就是不接新活，`reason` 会说为什么。
- `migration` —— 数据库从哪个 schema 版本升到了哪个版本。

---

## 6. 开机自启

```powershell
.\platform\windows\Install-DailyTwinStartup.ps1 -RuntimeScript <仓库目录>\src\runtime.mjs
```

关键点（这些都是上一版的坑）：

- `ExecutionTimeLimit` 设为 `[TimeSpan]::Zero` = **不限时**。上一版写的是 24 小时，
  到点会被计划任务直接杀掉，对 7×24 常驻是致命的。
- 配了 `RestartCount`（默认 3）和 `RestartIntervalMinutes`（默认 1），崩了会自动重起。
- `New-ScheduledTaskPrincipal -LogonType Interactive -RunLevel Limited`。
  **`InteractiveToken` 不是合法值**——合法枚举是
  `None, Password, S4U, Interactive, Group, ServiceAccount, InteractiveOrPassword`。
  用交互式登录是必要的：桌面自动化需要能看见桌面会话。
- `MultipleInstances IgnoreNew`，避免重复实例互相抢数据库锁。
- 注册前会检查 `pwsh.exe` 存在，找不到时给出 winget 安装提示。

卸载：

```powershell
.\platform\windows\Install-DailyTwinStartup.ps1 -RuntimeScript x -Unregister
```

其它参数：`-TaskName`（默认 `DailyDigitalTwin`）。

---

## 7. 网关起不来时

典型症状：`Get-NetTCPConnection -LocalPort 18789` 返回空；计划任务 `LastTaskResult` 是
`267009`；`ws://127.0.0.1:18789` 报 `gateway closed (1006 abnormal closure)`。

```powershell
# 只诊断，不改任何东西
.\platform\windows\Repair-OpenClawGatewayTask.ps1

# 确认建议无误后再执行修复
.\platform\windows\Repair-OpenClawGatewayTask.ps1 -Apply
```

**`267009` 不是错误。** 它是 `0x00041301` = `SCHED_S_TASK_RUNNING`，意思是"任务正在运行中"。
所以真正要查的是"进程活着但端口没监听"，常见原因是进程起在了另一个用户会话里、
或者启动早期就崩了但计划任务还没判定为结束。

参数：`-TaskName`（默认 `OpenClaw Gateway`）、`-Port`（默认 18789）、
`-RestartCount`、`-RestartIntervalMinutes`。

---

## 8. 日常任务操作

```powershell
npm run runtime -- create "打开 VS Code 并整理今天的实验记录"
npm run runtime -- status
npm run runtime -- pause 1
npm run runtime -- resume 1
npm run runtime -- cancel 1
```

需要注意的语义（上一版在这里出过错）：

- **`pause` 不改任务状态。** 只有 `running` 会降回 `queued`；`waiting_for_user` 保持原样。
  上一版会把等验证码的任务强行改成 `queued`，等待原因随之丢失，验证码流程直接断掉。
- **暂停的任务不占并发槽位。** 上一版占着，导致"明明只有一个任务在跑，却说槽位满了"。
- `resume` 返回结构化结果，失败码只有两个：`not_paused`、`slots_full`。
- 任务编号必须是纯数字。`pause abc` 会返回 `invalid_task_id`，**不再打印一屏堆栈**。

---

## 9. 启用调度器（默认是休眠的）

出厂状态 `scheduler.enabled = false`，替身**不会自己动**。确认前面各项都正常之后再打开：

```powershell
npm run runtime -- scheduler status    # 先看当前状态
npm run runtime -- scheduler enable
npm run runtime -- daemon              # 前台跑循环，Ctrl+C 停
```

开关写在 `<私有目录>\config\runtime.json`，不在公开仓里。

**关于"执行器"**：内置执行器是刻意的占位实现——它会把任务标成 `partial`，
理由写明"未配置执行器：请在私有目录提供 executor，本次不谎报成功"。
这来自一次真实事故：上一版曾报告"VS Code 已直接打开，进程已确认在运行"，
交叉核查发现那台机器上根本没装 VS Code。所以现在的规则是：
**没有执行证据 → 任务判 `partial`，绝不判 `completed`。**

证据类型只认四种：`process`、`window`、`page`、`file`（见 `src/core/execution-verifier.mjs`）。

---

## 10. 出问题了怎么退回

| 想退回什么 | 怎么做 |
|---|---|
| `openclaw.json` 改坏了 | 用第 3 步备份时打印的那行回滚命令 |
| 数据库看起来不对 | 停掉 daemon，把 `backups\` 里的 sqlite 复制回 `data\` |
| 开机自启不想要了 | `Install-DailyTwinStartup.ps1 -RuntimeScript x -Unregister` |
| 环境变量想清掉 | `[Environment]::SetEnvironmentVariable('DAILY_TWIN_HOME', $null, 'User')` |
| 整个代码想退回改动前 | `git reset --hard 774f320`（本轮改造前的最后一次提交） |

---

## 11. 每次改完代码，提交前跑这三条

```powershell
npm run check      # 单元测试 + 隐私审计 + CLI 冒烟
npm run lint:ps    # PowerShell 语法 + BOM + PSScriptAnalyzer
npm run selftest:ps
```

`npm run check` 里的隐私审计会拦住 API 密钥、GitHub 令牌、JWT、真实 Windows 用户目录、
个人资料目录、密钥类键值对、模型中转地址、带端口的明文主机地址这八类内容。
它同时有一个**下限保护**：扫到的文件少于 20 个就直接判失败——否则遍历逻辑写坏时，
"扫描 0 个文件"也会显示通过，那是最危险的假绿灯。

`lint:ps` 在缺少 PSScriptAnalyzer 时**判失败而不是静默跳过**。一个会自己消失的检查等于没有检查。

---

## 12. 沙箱验证不了、只能你在本机确认的部分

下面这些依赖真实 Windows（CIM 类、计划任务、真实浏览器、OpenClaw 网关），
在开发沙箱里无法执行，全部需要你在本机跑一遍：

- [ ] 第 1 步：环境变量真的写进用户级，重开窗口能读到。
- [ ] 第 3 步：备份产物完整（配置 + sqlite + 全部 jsonl），且源目录未被改动。
- [ ] 第 4 步：`telemetry.json` 里 `cpuPercent` 和 `onAcPower` 都不是 `null`。
- [ ] 第 5 步：`Invoke-DailyTwinDoctor.ps1` 全绿；`npm run doctor` 的
      `resourcePolicy.acceptsNewActions` 为 `true`。
- [ ] 第 6 步：计划任务注册成功，`ExecutionTimeLimit` 显示为不限时。
- [ ] 第 7 步：网关端口 18789 能监听。
- [ ] 浏览器路线：见 `docs/BROWSER-PROFILES.md` 末尾的清单。
