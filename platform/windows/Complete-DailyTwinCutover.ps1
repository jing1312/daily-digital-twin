#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$PrivateHome,
    [ValidateRange(1, 8760)][double]$StableHours = 48,
    [string]$OpenClawTaskName = 'OpenClaw Gateway'
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

$resolvedHome = Resolve-DailyTwinHome -PrivateHome $PrivateHome
$healthPath = Join-Path $resolvedHome 'data\control-plane-health.json'
$health = ConvertFrom-DailyTwinJson -Path $healthPath
if (-not (Test-DailyTwinCutoverHealth -Health $health -StableHours $StableHours)) {
    $healthStatus = Get-DailyTwinProperty -InputObject $health -Name 'status' -Default 'unknown'
    $healthPid = Get-DailyTwinProperty -InputObject $health -Name 'pid' -Default 'unknown'
    throw "新控制平面未满足连续健康切换条件（status=$healthStatus，pid=$healthPid，要求 $StableHours 小时且心跳不超过 5 分钟）。"
}
$startedAt = [DateTime]::Parse((Get-DailyTwinProperty -InputObject $health -Name 'startedAt')).ToUniversalTime()
$heartbeatAt = [DateTime]::Parse((Get-DailyTwinProperty -InputObject $health -Name 'lastHeartbeatAt')).ToUniversalTime()
$now = [DateTime]::UtcNow
$ageHours = ($now - $startedAt).TotalHours
$heartbeatAgeMinutes = ($now - $heartbeatAt).TotalMinutes

$task = Get-ScheduledTask -TaskName $OpenClawTaskName -ErrorAction Stop
if ($PSCmdlet.ShouldProcess($OpenClawTaskName, '停止并禁用旧 OpenClaw 计划任务')) {
    Stop-ScheduledTask -TaskName $OpenClawTaskName -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName $OpenClawTaskName -ErrorAction Stop | Out-Null
}
Write-DailyTwinResult -InputObject ([pscustomobject]@{
    status = if ($WhatIfPreference) { 'preview' } else { 'disabled' }
    taskName = $task.TaskName
    stableHours = [math]::Round($ageHours, 2)
    heartbeatAgeMinutes = [math]::Round($heartbeatAgeMinutes, 2)
    dataDeleted = $false
})
