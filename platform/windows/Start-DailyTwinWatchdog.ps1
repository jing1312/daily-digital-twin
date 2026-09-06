#Requires -Version 5.1
<#
.SYNOPSIS
    daemon 崩溃自愈守护：探活 data/daemon.pid，进程死了就拉起，拉不起就退避重试，永不放弃。

.DESCRIPTION
    自愈分三层，本脚本是第二层（进程级守护）：
      1. 计划任务层（Install-DailyTwinStartup.ps1）：登录自启 + 进程崩溃重启 3 次。
      2. 本脚本（watchdog 循环）：daemon 死了拉起；拉起失败按 15s→30s→60s→... 指数退避，
         到 -MaxBackoffSeconds 封顶后继续试 —— 绝不 throw 退出，守护者不先倒下。
      3. 计划任务层兜底：watchdog 本身崩了由 RestartCount 再拉 3 次。

    与 Start-MulticaDaemon.ps1（Multica CLI 时代）的区别：那个直接轮询 multica daemon status，
    重启失败一次就 throw 死掉；本脚本面向当前 runtime daemon（node src/runtime.mjs daemon），
    以 data/daemon.pid 为准绳，崩溃与恢复都写日志到 <home>\state\watchdog.log（UTC 时间戳），
    日志超过 2MB 自动截断保留后半，防止无限增长。

    防多开：Enter-DailyTwinProcessLock 独占 <home>\data\locks\watchdog.lock。

.EXAMPLE
    .\Start-DailyTwinWatchdog.ps1
#>
[CmdletBinding()]
param(
    [string]$PrivateHome,
    [string]$RepoPath,
    [string]$NodePath = 'node',
    [int]$PollSeconds = 60,
    [int]$MaxBackoffSeconds = 300
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

$resolvedHome = Resolve-DailyTwinHome -PrivateHome $PrivateHome
$env:DAILY_TWIN_HOME = $resolvedHome
if ([string]::IsNullOrWhiteSpace($RepoPath)) { $RepoPath = Split-Path -Parent $PSScriptRoot | Split-Path -Parent }
$runtimeScript = Join-Path $RepoPath 'src\runtime.mjs'
if (-not (Test-Path -LiteralPath $runtimeScript -PathType Leaf)) { throw "找不到 runtime.mjs：$runtimeScript" }
if ($PollSeconds -lt 15) { throw '-PollSeconds 不得小于 15 秒' }
if ($MaxBackoffSeconds -lt 15) { throw '-MaxBackoffSeconds 不得小于 15 秒' }

$lockStream = Enter-DailyTwinProcessLock -HomeDirectory $resolvedHome -Name 'watchdog'

$stateDir = Join-Path $resolvedHome 'state'
if (-not (Test-Path -LiteralPath $stateDir -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
}
$watchdogLog = Join-Path $stateDir 'watchdog.log'
$daemonLog = Join-Path $stateDir 'daemon-runtime.log'
$pidFile = Join-Path $resolvedHome 'data\daemon.pid'
$logLimitBytes = 2MB

function Write-WatchdogLog {
    param([string]$Event, [string]$Detail = '')
    # 中文注释：日志超过 2MB 时截断保留后半（最后 512KB），时间线仍然连续可读。
    if ((Test-Path -LiteralPath $watchdogLog) -and ((Get-Item -LiteralPath $watchdogLog).Length -gt $logLimitBytes)) {
        $tail = Get-Content -LiteralPath $watchdogLog -Tail 4096 -Encoding UTF8
        $tail | Set-Content -LiteralPath $watchdogLog -Encoding UTF8
    }
    $line = "[{0}] {1}{2}" -f [DateTime]::UtcNow.ToString('o'), $Event, $(if ($Detail) { " | $Detail" } else { '' })
    Add-Content -LiteralPath $watchdogLog -Value $line -Encoding UTF8
}

function Test-DaemonAlive {
    # 中文注释：以 PID 文件为准绳。文件不存在 = 守护范围外（不是本 watchdog / 配置页拉起的才算）。
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { return $null }
    $raw = Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue
    if ($null -eq $raw) { $raw = '' }
    $pidValue = $null
    try { $pidValue = [int]((ConvertFrom-Json $raw).pid) } catch {
        # 中文注释：PID 文件可能是纯数字，兼容两种写法。
        if ([int]::TryParse($raw.Trim(), [ref]$pidValue)) { } else { return $null }
    }
    $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($proc) { return $pidValue }
    return $false   # 有文件但进程死了 = 崩溃，需要自愈
}

function Start-Daemon {
    # 中文注释：detached 拉起 daemon，输出重定向到 daemon-runtime.log（同样限量截断）。
    if ((Test-Path -LiteralPath $daemonLog) -and ((Get-Item -LiteralPath $daemonLog).Length -gt $logLimitBytes)) {
        $tail = Get-Content -LiteralPath $daemonLog -Tail 4096 -Encoding UTF8
        $tail | Set-Content -LiteralPath $daemonLog -Encoding UTF8
    }
    $nodeResolved = (Get-Command $NodePath -ErrorAction Stop).Source
    # 中文注释：仓库要求 node >= 24（node:sqlite）。版本不够时第一时间写日志，别让用户看 daemon 秒退的哑谜。
    $nodeVersion = & $nodeResolved --version
    $nodeMajor = 0
    if ($nodeVersion -match '^v(\d+)') { $nodeMajor = [int]$Matches[1] }
    if ($nodeMajor -lt 24) {
        Write-WatchdogLog 'node-version-warning' "$nodeResolved 是 $nodeVersion，仓库要求 >= 24，daemon 大概率起不来。请用 -NodePath 指定 node 24。"
    }
    # 中文注释：runtime.mjs 用绝对路径，不依赖工作目录解析。
    $process = Start-Process -FilePath $nodeResolved `
        -ArgumentList @('"' + $runtimeScript + '"', 'daemon') `
        -WorkingDirectory $RepoPath `
        -WindowStyle Hidden `
        -RedirectStandardOutput $daemonLog `
        -RedirectStandardError "$daemonLog.err" `
        -PassThru
    # 中文注释：给 daemon 10 秒初始化（开库、装载执行器），之后看 PID 文件是否刷新。
    Start-Sleep -Seconds 10
    return $process
}

Write-WatchdogLog 'watchdog-start' "home=$resolvedHome repo=$RepoPath poll=${PollSeconds}s"

$backoffSeconds = 15
while ($true) {
    $alive = Test-DaemonAlive
    if ($alive -is [int]) {
        # 中文注释：daemon 活着 —— 重置退避，安静轮询。
        if ($backoffSeconds -ne 15) { Write-WatchdogLog 'daemon-recovered' "pid=$alive" }
        $backoffSeconds = 15
        Start-Sleep -Seconds $PollSeconds
        continue
    }

    if ($alive -eq $false) {
        Write-WatchdogLog 'daemon-crashed' "pid 文件存在但进程已死，准备拉起"
    }

    $process = $null
    try { $process = Start-Daemon } catch {
        Write-WatchdogLog 'daemon-start-error' $_.Exception.Message
    }

    if ($process -and -not $process.HasExited) {
        Write-WatchdogLog 'daemon-started' "pid=$($process.Id)"
        $backoffSeconds = 15
        Start-Sleep -Seconds $PollSeconds
    } else {
        # 中文注释：拉起失败或秒退 —— 指数退避后重试，守护循环绝不退出。
        $exitCode = if ($process) { $process.ExitCode } else { $null }
        Write-WatchdogLog 'daemon-start-failed' "exitCode=$exitCode，退避 ${backoffSeconds}s 后重试"
        Start-Sleep -Seconds $backoffSeconds
        $backoffSeconds = [Math]::Min($backoffSeconds * 2, $MaxBackoffSeconds)
    }
}
