#Requires -Version 5.1
<#
.SYNOPSIS
    把替身网关登记为"当前用户登录即启动"的计划任务。

.DESCRIPTION
    修掉了原版的四个问题（B19）：
      1. ExecutionTimeLimit 写成 24 小时 —— 一个 7x24 常驻网关会被计划任务每天准点杀掉。现在设为无限制。
      2. 没有 RestartCount / RestartInterval —— 进程崩了就再也不起来。现在崩溃后重试 3 次。
      3. 没有 -Principal —— 登录类型不确定。现在显式用 LogonType Interactive（注意：InteractiveToken 不是合法值）。
      4. 不检查 pwsh.exe 是否存在 —— 缺失时任务注册成功但每次开机静默失败。现在提前报错。
    另外加了 MultipleInstances IgnoreNew，避免手动启动和开机启动同时跑出两个守护进程。

.EXAMPLE
    .\Install-DailyTwinStartup.ps1 -RuntimeScript 'D:\DailyTwin\daily-digital-twin\platform\windows\Start-DailyTwinDaemon.ps1'
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$RuntimeScript,

    [string]$TaskName = 'DailyDigitalTwin',

    # 中文注释：崩溃后重启次数。0 表示不重启。
    [int]$RestartCount = 3,
    [int]$RestartIntervalMinutes = 1,

    [switch]$Unregister
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

if ($Unregister) {
    if ($PSCmdlet.ShouldProcess($TaskName, '注销计划任务')) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    }
    Write-DailyTwinResult -InputObject ([pscustomobject]@{ status = 'unregistered'; taskName = $TaskName })
    return
}

# 中文注释：先确认脚本本体存在，再确认 pwsh.exe 存在。两者缺一，任务都会开机静默失败。
if (-not (Test-Path -LiteralPath $RuntimeScript -PathType Leaf)) {
    throw "找不到要开机运行的脚本：$RuntimeScript"
}

$pwshPath = Resolve-DailyTwinPwsh
if (-not $pwshPath) {
    throw @'
找不到 pwsh.exe（PowerShell 7）。计划任务会注册成功但每次开机都静默失败。
请先安装：winget install --id Microsoft.PowerShell --source winget
安装后重新运行本脚本。
'@
}

$resolvedScript = (Resolve-Path -LiteralPath $RuntimeScript).Path
$action = New-ScheduledTaskAction -Execute $pwshPath `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$resolvedScript`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

# 中文注释：ExecutionTimeLimit 设为 TimeSpan::Zero 即"不限制运行时长"，这是 7x24 常驻任务的必要条件。
$settingsParameters = @{
    StartWhenAvailable        = $true
    AllowStartIfOnBatteries   = $true
    DontStopIfGoingOnBatteries = $true
    ExecutionTimeLimit        = [TimeSpan]::Zero
    MultipleInstances         = 'IgnoreNew'
}
if ($RestartCount -gt 0) {
    $settingsParameters['RestartCount'] = $RestartCount
    $settingsParameters['RestartInterval'] = (New-TimeSpan -Minutes $RestartIntervalMinutes)
}
$settings = New-ScheduledTaskSettingsSet @settingsParameters

# 中文注释：LogonType 的合法取值是 None / Password / S4U / Interactive / Group / ServiceAccount /
# 中文注释：InteractiveOrPassword。写 InteractiveToken 会直接报参数校验失败 —— 这是本机踩过的坑。
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

if ($PSCmdlet.ShouldProcess($TaskName, '注册开机启动任务')) {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force | Out-Null
}

Write-DailyTwinResult -InputObject ([pscustomobject]@{
    status             = 'registered'
    taskName           = $TaskName
    executable         = $pwshPath
    script             = $resolvedScript
    logonType          = 'Interactive'
    executionTimeLimit = 'unlimited'
    restartCount       = $RestartCount
    multipleInstances  = 'IgnoreNew'
    registeredAt       = [DateTime]::UtcNow.ToString('o')
})
