[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RuntimeScript,
    [string]$TaskName = 'DailyDigitalTwin'
)

$ErrorActionPreference = 'Stop'

# 中文注释：使用当前用户登录触发器，不申请管理员权限，也不创建远程入口。
$action = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument "-NoProfile -WindowStyle Hidden -File `"$RuntimeScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 24)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output "已登记当前用户登录启动：$TaskName"
