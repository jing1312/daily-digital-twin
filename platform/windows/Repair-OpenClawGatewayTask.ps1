#Requires -Version 5.1
<#
.SYNOPSIS
    诊断并修复 "OpenClaw Gateway" 计划任务，让本机网关真的能在 18789 端口起来。

.DESCRIPTION
    针对本机实测到的四个症状：
      1. Get-NetTCPConnection -LocalPort 18789 返回空 —— 网关根本没在监听。
      2. 计划任务 LastTaskResult = 267009 —— 这不是错误码，而是 SCHED_S_TASK_RUNNING，
         意思是"任务被认为还在运行中"。常见成因是上一次实例卡住 + MultipleInstances 策略挡掉了新实例。
      3. New-ScheduledTaskPrincipal -LogonType InteractiveToken 直接报参数校验失败 ——
         合法取值只有 None / Password / S4U / Interactive / Group / ServiceAccount / InteractiveOrPassword。
      4. ws://127.0.0.1:18789 出现 1006 abnormal closure —— 端口没人监听时客户端就是这个表现。

    默认只诊断（-WhatIf 语义），要真正改动请显式加 -Apply。

.EXAMPLE
    .\Repair-OpenClawGatewayTask.ps1
.EXAMPLE
    .\Repair-OpenClawGatewayTask.ps1 -Apply
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = 'OpenClaw Gateway',
    [int]$Port = 18789,
    [switch]$Apply,
    [int]$RestartCount = 3,
    [int]$RestartIntervalMinutes = 1
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

$findings = @()
$actions = @()

function Add-Finding {
    param([string]$Code, [string]$Detail, [string]$Suggestion)
    $script:findings += [pscustomobject]@{ code = $Code; detail = $Detail; suggestion = $Suggestion }
}

# ---- 1. 端口是否真的在监听 ----
$listening = $null
try {
    $listening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
} catch {
    $listening = @()
}

if ($listening.Count -eq 0) {
    Add-Finding -Code 'port_not_listening' `
        -Detail "端口 $Port 没有任何监听者，所以 ws://127.0.0.1:$Port 会以 1006 abnormal closure 断开。" `
        -Suggestion '这是症状不是原因，继续看计划任务与进程状态。'
} else {
    $owningPids = ($listening | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique) -join ', '
    Add-Finding -Code 'port_listening' -Detail "端口 $Port 正在监听，占用进程 PID：$owningPids" -Suggestion '无需处理。'
}

# ---- 2. 计划任务状态与 LastTaskResult ----
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Add-Finding -Code 'task_missing' -Detail "找不到计划任务：$TaskName" `
        -Suggestion '先用 OpenClaw 自带的安装命令注册网关任务，再运行本脚本。'
} else {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    $lastResult = Get-DailyTwinProperty -InputObject $info -Name 'LastTaskResult'
    $lastRunTime = Get-DailyTwinProperty -InputObject $info -Name 'LastRunTime'

    Add-Finding -Code 'task_state' -Detail "状态 $($task.State)，LastTaskResult $lastResult，上次运行 $lastRunTime" `
        -Suggestion '见下方针对 267009 的说明。'

    if ($null -ne $lastResult -and [int]$lastResult -eq 267009) {
        Add-Finding -Code 'sched_s_task_running' `
            -Detail '267009 = 0x00041301 = SCHED_S_TASK_RUNNING，表示任务被判定为仍在运行，而不是失败。' `
            -Suggestion '停掉卡住的实例（Stop-ScheduledTask），并把 MultipleInstances 改成 IgnoreNew 后重启。'
    }

    # 中文注释：ExecutionTimeLimit 不是无限制时，7x24 网关会被准点杀掉。
    $limit = Get-DailyTwinProperty -InputObject $task.Settings -Name 'ExecutionTimeLimit'
    if ($limit -and [string]$limit -ne 'PT0S') {
        Add-Finding -Code 'execution_time_limit' `
            -Detail "ExecutionTimeLimit = $limit，常驻网关会在到点时被计划任务终止。" `
            -Suggestion '改为 PT0S（不限时长）。'
    }

    $restart = Get-DailyTwinProperty -InputObject $task.Settings -Name 'RestartCount' -Default 0
    if ([int]$restart -le 0) {
        Add-Finding -Code 'no_restart_policy' -Detail 'RestartCount = 0，进程崩溃后不会自动重启。' `
            -Suggestion "设置 RestartCount=$RestartCount、RestartInterval=$RestartIntervalMinutes 分钟。"
    }

    $logonType = Get-DailyTwinProperty -InputObject $task.Principal -Name 'LogonType'
    Add-Finding -Code 'logon_type' -Detail "当前 LogonType = $logonType" `
        -Suggestion '合法值是 None / Password / S4U / Interactive / Group / ServiceAccount / InteractiveOrPassword；InteractiveToken 不是合法值。'
}

# ---- 3. pwsh.exe 是否存在 ----
$pwshPath = Resolve-DailyTwinPwsh
if (-not $pwshPath) {
    Add-Finding -Code 'pwsh_missing' -Detail '找不到 pwsh.exe（PowerShell 7）。' `
        -Suggestion 'winget install --id Microsoft.PowerShell --source winget'
} else {
    Add-Finding -Code 'pwsh_found' -Detail "pwsh.exe: $pwshPath" -Suggestion '无需处理。'
}

# ---- 4. 应用修复 ----
if ($Apply -and $null -ne $task) {
    if ($PSCmdlet.ShouldProcess($TaskName, '停止卡住的实例并重写运行策略')) {
        try {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            $actions += '已请求停止当前实例'
        } catch {
            $actions += "停止实例失败：$($_.Exception.Message)"
        }

        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -MultipleInstances 'IgnoreNew' -RestartCount $RestartCount `
            -RestartInterval (New-TimeSpan -Minutes $RestartIntervalMinutes)

        $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
            -LogonType Interactive -RunLevel Limited

        Set-ScheduledTask -TaskName $TaskName -Settings $settings -Principal $principal | Out-Null
        $actions += '已写入：无限运行时长 / IgnoreNew / 崩溃重启 / LogonType Interactive'

        Start-ScheduledTask -TaskName $TaskName
        $actions += '已重新启动任务'

        Start-Sleep -Seconds 5
        $recheck = @()
        try { $recheck = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop) } catch { $recheck = @() }
        if ($recheck.Count -gt 0) {
            $actions += "端口 $Port 现在已在监听"
        } else {
            $actions += "端口 $Port 仍未监听，请查看 OpenClaw 自身日志"
        }
    }
} elseif ($Apply) {
    $actions += '计划任务不存在，跳过修复'
} else {
    $actions += '仅诊断模式。确认无误后加 -Apply 执行修复。'
}

Write-Output ''
foreach ($finding in $findings) {
    Write-Output "[$($finding.code)] $($finding.detail)"
    Write-Output "    建议：$($finding.suggestion)"
}
Write-Output ''
foreach ($item in $actions) { Write-Output "· $item" }
Write-Output ''

Write-DailyTwinResult -InputObject ([pscustomobject]@{
    status     = 'ok'
    taskName   = $TaskName
    port       = $Port
    applied    = [bool]$Apply
    findings   = $findings
    actions    = $actions
    checkedAt  = [DateTime]::UtcNow.ToString('o')
})
