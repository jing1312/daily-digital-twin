# 运维手册（Windows 11）

这份手册只描述当前的 **Daily Twin + Multica + Codex + Edge** 主链。OpenClaw 只在备份、48 小时切换和回滚步骤中出现。

文中的 `<仓库目录>` 是公开源码目录，`<私有目录>` 是 `DAILY_TWIN_HOME`，两者绝不能相同。

## 0. 先处理凭据

在聊天、截图或旧日志中明文出现过的 API Key、GitHub PAT、Multica PAT 都视为已经泄露：先去对应平台撤销，再生成权限更小的新凭据。不要把新值发到聊天里，也不要写进 Multica `custom_env`、Git 仓库或 PowerShell 历史。

新架构需要的密钥只放在 `<私有目录>\config\`：

```text
feishu-app-secret.secret
capability-hmac.secret
```

能力票 HMAC 由 `runtime init` 自动生成；已存在时不会覆盖。

## 1. 备份旧 OpenClaw

新架构稳定前不删除旧状态。先停掉正在运行的旧网关，再执行只读复制：

```powershell
cd <仓库目录>
.\platform\windows\Backup-DailyTwinState.ps1 -OpenClawHome <旧 OpenClaw 状态目录> -PrivateHome <私有目录>
```

判断成功：输出给出带时间戳的备份目录，配置、SQLite（含 WAL/SHM）和 session JSONL 都有副本，源目录仍在原位。

## 2. 安装依赖并初始化私有目录

```powershell
node --version
pwsh --version
npm ci

.\platform\windows\Set-DailyTwinPaths.ps1 -PrivateHome <私有目录>
npm run runtime -- init --home <私有目录>
```

要求：Node.js `>= 24`，PowerShell 7 可在 PATH 找到。`Set-DailyTwinPaths.ps1` 同时设置当前进程和当前用户的 `DAILY_TWIN_HOME`，创建配额目录；`runtime init` 补齐配置示例、价格表、worker/lock 目录和 HMAC。

初始化应至少得到：

```text
config/runtime.json
config/apps.json
config/pricing.json
config/capability-hmac.secret
data/tasks  data/receipts  data/screenshots  data/cache  data/logs
data/workers  data/locks  backups
```

任何运行数据出现在仓库内都应先停机调查，不能直接提交。

## 3. 配置私有 runtime

以 `config/runtime.example.json` 为字段参考，编辑 `<私有目录>\config\runtime.json`：

- `browser.defaultBrowser` 必须是 `msedge`，`extension` 必须是 `true`。
- `integrations.feishu.appId` 填真实 App ID。
- `integrations.feishu.allowedOpenIds` 建议只放主人账号；留空时仍会使用首次配对绑定。
- `integrations.multica.plannerAgent` 使用 `dt-planner`。
- `workerAgents` 使用 `dt-worker-1` 到 `dt-worker-4`。
- `allowedDirectories` 默认保持 `[]`，确需文件任务时才逐个加入绝对根目录。
- `windows.pwshPath` 填核验过的 PowerShell 7 完整路径；未配置时桌面软件动作失败关闭。

真实 App Secret 写入 `<私有目录>\config\feishu-app-secret.secret`。不要放 JSON 字段、环境变量示例或仓库文件。

检查配置是否能被运行时读取：

```powershell
$env:DAILY_TWIN_HOME = '<私有目录>'
npm run doctor
```

JSON 或阈值错误会以 `invalid_config` 退出，不会静默使用一半默认值。

## 4. 登记网站和软件

编辑私有 `config/apps.json`。公开的 `config/apps.example.json` 只有占位路径和 selector，不能直接用于真实执行。

每个软件至少核验：

```text
id, aliases, path, processName, windowTitlePattern, resource
```

每个网站至少核验：

```text
id, aliases, url, browser=edge, fields, actions,
resultCondition, resultTimeoutMs, resource
```

接入原则是“登记一个、验证一个、再开放一个”。未登记软件必须拒绝，路径不存在必须失败；不能用搜索到的相似程序代替。

## 5. 配置 Multica 和 Codex worker

安装并登录当前官方 Multica CLI，然后按 [Multica agent 配置示例](../config/multica-agents.example.md) 创建：

```text
dt-planner
dt-worker-1
dt-worker-2
dt-worker-3
dt-worker-4
```

关键检查：

- planner 没有 Daily Twin MCP，只输出 1~4 个结构化子任务。
- 四个 worker 都是 Codex runtime，并分别使用自己的 `--binding-slot`。
- worker 为 `workspace-write + approval_policy=never`。
- worker 只能看到八个高层工具；`task_checkpoint` 和 `task_checkpoint_read` 的内容按根任务与 worker slot 隔离。
- `custom_env` 没有 Key、PAT、飞书密钥、HMAC 或 `CODEX_HOME`。
- 运行 Multica daemon 的 Windows 用户能读到 `DAILY_TWIN_HOME`。
- 真机确认每次工作使用独立 `CODEX_HOME` 并加载对应 MCP；本机代码只准备固定 slot binding，不替 Multica 做这一步。

```powershell
$env:DAILY_TWIN_HOME
multica daemon status
```

CLI 未安装时可以用 `-SkipMultica` 先验收固定流程，但复杂任务不会工作，不能宣称整套系统完成。

## 6. 配对日常 Edge

按 Microsoft Playwright Extension 官方说明在 Edge 中安装并完成一次配对：

<https://github.com/microsoft/playwright/tree/main/packages/extension#readme>

Daily Twin 实际启动参数固定包含：

```text
--browser msedge --extension --caps devtools
--snapshot-mode none --image-responses omit --output-mode file
```

保持 `browser.playwrightCommand` 为默认的 `playwright-mcp` 时，运行时优先解析仓库内 `node_modules/@playwright/mcp/cli.js`，不要求把 Playwright MCP 加入系统 PATH。只有改用其他已核验命令时才修改该配置。

验收要求：

1. 在日常 Edge 登录一个测试站点。
2. 让固定流程创建一个 Daily Twin 任务标签。
3. 确认只操作该任务标签，填写后能回读相同文本。
4. 手动把任务标签移出控制范围，下一动作必须进入 `waiting_for_user`。
5. 保持任务未结束，重启控制平面；系统必须按 `window.name` 接回原标签，不能重复新建或重复提交。
6. 重启 Edge 后重新连接，登录态仍存在；恢复的标签索引变化时仍能按 marker 找回。
7. 连接失败时不能打开 Chrome。

私有 `config/apps.json` 只有在核验真实页面后才能填写 `verification.field`、可选的 `verification.submit` 和 `loginRequiredSelector`。登记的验证码 selector 会和通用密码/OTP selector 一起在截图前临时遮罩，截图成功或失败后都恢复页面原样。验证码由飞书直接交给内存 broker：页面进入 `waiting_for_user` 后，单个等待任务可直接回复验证码；填写失败会明确回复并保留等待器。验证码不会经过 Multica、模型、SQLite、日志或回执，等待人工登录或验证码也不会消耗瞬时错误重试次数。手动登录完成后发送 `继续 <任务号>`，任务按本机检查点恢复。

## 7. 先做本机自检

```powershell
npm test
npm run audit:privacy
npm run lint:ps
npm run selftest:ps

.\platform\windows\Write-DailyTwinTelemetry.ps1 -PrivateHome <私有目录>
npm run doctor
```

`npm run doctor` 重点看：schema 版本、WAL、遥测来源、`resourcePolicy.acceptsNewActions` 和槽位数。

完整服务安装后再运行：

```powershell
.\platform\windows\Invoke-DailyTwinDoctor.ps1 -PrivateHome <私有目录> -RefreshTelemetry
```

PowerShell doctor 会检查控制平面 PID/心跳、两个必要计划任务、Multica CLI 和 Edge 静态配置。它只能确认 Edge 配置，不能代替第 7 步的真实配对。

## 8. 注册后台服务

先预览：

```powershell
.\platform\windows\Install-DailyTwinServices.ps1 `
  -PrivateHome <私有目录> `
  -NodePath <node.exe 的已核验路径> `
  -MulticaPath <multica.exe 的已核验路径> `
  -WhatIf
```

预览不会调用 Windows 计划任务 API；内容正确后去掉 `-WhatIf`。脚本注册当前用户登录触发的：

```text
DailyDigitalTwin-ControlPlane
DailyDigitalTwin-Telemetry
DailyDigitalTwin-Multica
```

它不需要管理员权限，不修改 OpenClaw。三个任务都使用无限执行时长、崩溃重试、`Interactive`、`Limited` 和 `IgnoreNew`。任务动作会显式保存 `PrivateHome`、Node 和 Multica 路径，不依赖新的登录会话读取用户环境变量；任何注册 cmdlet 失败都会终止脚本，不能在错误后返回“已注册”。控制平面和遥测自身还有第二层单实例锁。

手动启动一次并检查：

```powershell
Start-ScheduledTask -TaskName 'DailyDigitalTwin-Telemetry'
Start-ScheduledTask -TaskName 'DailyDigitalTwin-Multica'
Start-ScheduledTask -TaskName 'DailyDigitalTwin-ControlPlane'
Start-Sleep -Seconds 10

Get-ScheduledTask -TaskName 'DailyDigitalTwin-*'
Get-Content -Raw '<私有目录>\data\control-plane-health.json'
.\platform\windows\Invoke-DailyTwinDoctor.ps1 -PrivateHome <私有目录>
```

关闭所有 PowerShell 窗口后再次从飞书发 `状态`。能回复才说明不依赖前台窗口。

如果飞书连接、首次 Multica 同步或健康记录初始化在启动中途失败，控制平面应退出并释放单实例锁，不能留下仅显示为运行中的空进程。查看计划任务退出码和结构化错误，修复原因后再启动。

## 9. 启用调度并做验收

```powershell
npm run runtime -- scheduler enable --home <私有目录>
```

按顺序从飞书测试：

1. `状态`：立即回复，Multica/模型 Token 增量为 0。
2. `打开 Omicos`：只启动已登记程序，并给出真实进程/窗口证据或明确失败。
3. `打开 Biomni，输入 TEST_TEXT 并运行`：先回任务号，完成后只发一条终态回执。
4. `看证据 <任务号>`：才发送脱敏截图；所有终态文字回执发送前统一脱敏，不暴露授权头或本机用户路径。
5. 单个验证码等待任务直接回复验证码；两个等待任务必须带任务号。
6. 同时提交网页、软件和复杂数据任务：最多四个存活，前台动作不冲突；低内存时重型 worker 自动降为 1。
7. 篡改或重放测试能力票、访问未登记软件/目录：全部拒绝。
8. 让一个 worker 失败：根任务必须得到 `partial` 或 `failed` 回执，不能因 planner 已完成而假报成功。
9. 暂停一个正在运行的复杂任务：Multica 对应 run 必须停止；随后发送 `继续 <任务号>`，只能对已记录 issue 发起 rerun。再取消一个任务，远端停止失败必须出现在回复中。
10. 用测试环境把 `execution.workerMaxMinutes` 临时调低：本轮有新检查点时应重签 binding 并续跑；没有新检查点或只有上一轮旧检查点时必须停止并失败。验收后恢复为 `90`。
11. 本机取消任务后再让 Multica 延迟创建 planner/worker run：后台必须补取消一次；远端全部终态后不得在后续同步中重复取消。
12. 价格表设置不同的普通输入和缓存输入费率，确认缓存 Token 只作为输入子集计费一次，而不是普通输入费加缓存费。

任务状态、worker、失败原因、重试次数、证据和 Token 可从 SQLite/CLI 查询；验证码不能查询到，因为它从不落库。

## 10. 观察 48 小时再切换

连续观察：

- Windows 重新登录后机器人自动恢复。
- 控制平面心跳每分钟更新。
- 飞书、Multica 和 Edge 没有重复实例。
- 空闲 5 分钟时控制平面、MCP 和 Multica daemon 合计内存接近目标，CPU 保持低占用。
- 失败和取消均有唯一终态回执。

达到连续 48 小时后，确认健康文件仍是 `running`、PID 存活且心跳不超过 5 分钟，再预览停用旧 OpenClaw；刚停止时写下的新鲜心跳不算健康：

```powershell
.\platform\windows\Complete-DailyTwinCutover.ps1 -PrivateHome <私有目录> -WhatIf
.\platform\windows\Complete-DailyTwinCutover.ps1 -PrivateHome <私有目录>
```

脚本只停止并禁用旧计划任务，不删除旧配置、会话、数据库或浏览器状态。

## 11. 回滚

```powershell
.\platform\windows\Rollback-DailyTwinServices.ps1 -WhatIf
.\platform\windows\Rollback-DailyTwinServices.ps1
```

它注销三个新计划任务并恢复旧 OpenClaw 任务，不删除新旧数据。回滚后保留 `<私有目录>` 供排错，不要直接清空。

## 12. 提交前检查

```powershell
npm test
npm run audit:privacy
npm run lint:ps
npm run selftest:ps
```

Git Bash：

```bash
bash .github/scripts/cli-smoke.sh
```

确认 `git status` 中没有私有 `config/`、`data/`、截图、日志、真实软件目录、Key 或 PAT。CI 会重新执行锁文件安装、Node 测试、隐私审计、CLI 冒烟和 Windows PowerShell 5.1/7 检查。
