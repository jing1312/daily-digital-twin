#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskPrefix = 'DailyDigitalTwin',
    [string]$OpenClawTaskName = 'OpenClaw Gateway'
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

$removed = @()
foreach ($taskName in @("$TaskPrefix-ControlPlane", "$TaskPrefix-Telemetry", "$TaskPrefix-Multica")) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) { continue }
    if ($PSCmdlet.ShouldProcess($taskName, '停止并注销 Daily Twin 计划任务')) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    }
    $removed += $taskName
}

$openClaw = Get-ScheduledTask -TaskName $OpenClawTaskName -ErrorAction SilentlyContinue
if ($openClaw -and $PSCmdlet.ShouldProcess($OpenClawTaskName, '恢复并启动旧 OpenClaw 计划任务')) {
    Enable-ScheduledTask -TaskName $OpenClawTaskName -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $OpenClawTaskName -ErrorAction Stop
}

Write-DailyTwinResult -InputObject ([pscustomobject]@{
    status = if ($WhatIfPreference) { 'preview' } else { 'rolled_back' }
    removedTasks = $removed
    openClawRestored = [bool]$openClaw
    dataDeleted = $false
})
