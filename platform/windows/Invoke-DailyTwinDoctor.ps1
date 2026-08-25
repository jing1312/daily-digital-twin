#Requires -Version 5.1
<#
.SYNOPSIS
    一次跑完本机体检：Node、私有目录、数据库、遥测、控制平面、Multica 和 Edge。

.DESCRIPTION
    出问题时先跑这个。它只读不写（除了可选的遥测采样），
    每一项都给出"现状 + 该怎么办"，不做任何猜测式的乐观判断。

.EXAMPLE
    .\Invoke-DailyTwinDoctor.ps1
.EXAMPLE
    .\Invoke-DailyTwinDoctor.ps1 -PrivateHome 'D:\DailyTwin\home' -RefreshTelemetry
#>
[CmdletBinding()]
param(
    [string]$PrivateHome,
    [string]$RepositoryRoot,
    [switch]$RefreshTelemetry
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

$checks = @()

function Add-Check {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][ValidateSet('ok', 'warn', 'fail', 'info')][string]$State,
        [Parameter(Mandatory = $true)][string]$Detail,
        [string]$Fix = ''
    )
    $script:checks += [pscustomobject]@{ name = $Name; state = $State; detail = $Detail; fix = $Fix }
}

# ---- Node ----
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCommand) {
    Add-Check -Name 'node' -State 'fail' -Detail '找不到 node。' -Fix 'winget install --id OpenJS.NodeJS.LTS'
} else {
    $nodeVersion = (& $nodeCommand.Source --version) 2>&1
    $majorText = ([string]$nodeVersion).TrimStart('v').Split('.')[0]
    $major = 0
    [void][int]::TryParse($majorText, [ref]$major)
    if ($major -lt 24) {
        Add-Check -Name 'node' -State 'fail' -Detail "node $nodeVersion 版本过低，node:sqlite 需要 24 以上。" -Fix '升级到 Node 24 或更高版本。'
    } else {
        Add-Check -Name 'node' -State 'ok' -Detail "node $nodeVersion" 
    }
}

# ---- pwsh ----
$pwshPath = Resolve-DailyTwinPwsh
if ($pwshPath) {
    Add-Check -Name 'pwsh' -State 'ok' -Detail $pwshPath
} else {
    Add-Check -Name 'pwsh' -State 'warn' -Detail '找不到 pwsh.exe（PowerShell 7）。开机计划任务会静默失败。' `
        -Fix 'winget install --id Microsoft.PowerShell --source winget'
}

# ---- 私有目录 ----
$resolvedHome = $null
try {
    $resolvedHome = Resolve-DailyTwinHome -PrivateHome $PrivateHome
    if (Test-Path -LiteralPath $resolvedHome -PathType Container) {
        Add-Check -Name 'private-home' -State 'ok' -Detail $resolvedHome
    } else {
        Add-Check -Name 'private-home' -State 'fail' -Detail "DAILY_TWIN_HOME 指向的目录不存在：$resolvedHome" `
            -Fix ".\Set-DailyTwinPaths.ps1 -PrivateHome '$resolvedHome'"
    }
} catch {
    Add-Check -Name 'private-home' -State 'fail' -Detail $_.Exception.Message `
        -Fix ".\Set-DailyTwinPaths.ps1 -PrivateHome 'D:\DailyTwin\home'"
}

# ---- 老版本遗留的仓库内运行目录 ----
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
}
$strayRuntime = Join-Path $RepositoryRoot 'runtime'
if (Test-Path -LiteralPath $strayRuntime -PathType Container) {
    Add-Check -Name 'stray-runtime' -State 'warn' `
        -Detail "仓库里存在老版本写下的 runtime\ 目录：$strayRuntime" `
        -Fix "确认里面没有需要保留的数据后删除：Remove-Item -LiteralPath '$strayRuntime' -Recurse"
} else {
    Add-Check -Name 'stray-runtime' -State 'ok' -Detail '仓库里没有遗留的 runtime\ 目录。'
}

# ---- 磁盘 ----
$systemFreeGb = Get-DailyTwinFreeSpaceGb -Path $env:SystemDrive
if ($null -eq $systemFreeGb) {
    Add-Check -Name 'disk-system' -State 'warn' -Detail '读不到系统盘剩余空间。'
} elseif ($systemFreeGb -lt 20) {
    Add-Check -Name 'disk-system' -State 'warn' -Detail "系统盘 $env:SystemDrive 仅剩 $systemFreeGb GB。" `
        -Fix '清理系统盘，并确认 DAILY_TWIN_HOME、截图和日志都在空间充足的数据盘。'
} else {
    Add-Check -Name 'disk-system' -State 'ok' -Detail "系统盘剩余 $systemFreeGb GB"
}

if ($resolvedHome) {
    $homeFreeGb = Get-DailyTwinFreeSpaceGb -Path $resolvedHome
    # 中文注释：不用 (if ...) 这种内联表达式 —— Windows PowerShell 5.1 对括号里放语句很挑，先算好再传。
    $homeDiskState = 'ok'
    if ($null -ne $homeFreeGb -and $homeFreeGb -lt 20) { $homeDiskState = 'warn' }
    Add-Check -Name 'disk-home' -State $homeDiskState -Detail "私有目录所在卷剩余 $homeFreeGb GB"
}

# ---- 数据库与遥测 ----
if ($resolvedHome) {
    $databasePath = Join-Path $resolvedHome 'data\runtime.sqlite'
    if (Test-Path -LiteralPath $databasePath -PathType Leaf) {
        $sizeMb = [math]::Round((Get-Item -LiteralPath $databasePath).Length / 1MB, 2)
        Add-Check -Name 'database' -State 'ok' -Detail "$databasePath（$sizeMb MB）"
    } else {
        Add-Check -Name 'database' -State 'info' -Detail '任务库还不存在（第一次 init 或 create 时会自动建立）。' `
            -Fix 'npm run runtime -- init'
    }

    if ($RefreshTelemetry) {
        try {
            & (Join-Path $PSScriptRoot 'Write-DailyTwinTelemetry.ps1') -PrivateHome $resolvedHome | Out-Null
        } catch {
            Add-Check -Name 'telemetry-write' -State 'warn' -Detail "刷新遥测失败：$($_.Exception.Message)"
        }
    }

    $telemetryPath = Join-Path $resolvedHome 'data\telemetry.json'
    if (-not (Test-Path -LiteralPath $telemetryPath -PathType Leaf)) {
        Add-Check -Name 'telemetry' -State 'fail' `
            -Detail '没有遥测文件。资源策略是 fail-closed 的，槽位会归零，替身永远不会开始工作。' `
            -Fix ".\Write-DailyTwinTelemetry.ps1 -PrivateHome '$resolvedHome'"
    } else {
        try {
            $telemetry = ConvertFrom-DailyTwinJson -Path $telemetryPath
            $writtenAt = Get-DailyTwinProperty -InputObject $telemetry -Name 'writtenAt'
            $ageSeconds = $null
            if ($writtenAt) {
                $ageSeconds = [int]([DateTime]::UtcNow - [DateTime]::Parse($writtenAt).ToUniversalTime()).TotalSeconds
            }
            $cpuPercent = Get-DailyTwinProperty -InputObject $telemetry -Name 'cpuPercent'
            $onAcPower = Get-DailyTwinProperty -InputObject $telemetry -Name 'onAcPower'

            if ($null -eq $ageSeconds -or $ageSeconds -gt 300) {
                Add-Check -Name 'telemetry' -State 'warn' -Detail "遥测已过期（$ageSeconds 秒前写入，上限 300 秒）。" `
                    -Fix '让 Write-DailyTwinTelemetry.ps1 -Loop 常驻，或加进计划任务每分钟跑一次。'
            } else {
                Add-Check -Name 'telemetry' -State 'ok' -Detail "$ageSeconds 秒前写入，cpu=$cpuPercent%，接电=$onAcPower"
            }
        } catch {
            Add-Check -Name 'telemetry' -State 'fail' -Detail "遥测文件解析失败：$($_.Exception.Message)" `
                -Fix '删掉该文件后重新采样。注意必须是无 BOM 的 UTF-8。'
        }
    }
}

# ---- 新控制平面健康与计划任务 ----
if ($resolvedHome) {
    $healthPath = Join-Path $resolvedHome 'data\control-plane-health.json'
    if (-not (Test-Path -LiteralPath $healthPath -PathType Leaf)) {
        Add-Check -Name 'control-plane' -State 'fail' -Detail '没有控制平面健康文件，飞书新网关尚未成功启动。' `
            -Fix '.\Install-DailyTwinServices.ps1 -WhatIf，确认后去掉 -WhatIf，再启动 DailyDigitalTwin-ControlPlane。'
    } else {
        try {
            $health = ConvertFrom-DailyTwinJson -Path $healthPath
            $healthStatus = Get-DailyTwinProperty -InputObject $health -Name 'status'
            $healthPid = Get-DailyTwinProperty -InputObject $health -Name 'pid'
            $heartbeatText = Get-DailyTwinProperty -InputObject $health -Name 'lastHeartbeatAt'
            $heartbeatAgeMinutes = $null
            if ($heartbeatText) {
                $heartbeatAgeMinutes = ([DateTime]::UtcNow - [DateTime]::Parse($heartbeatText).ToUniversalTime()).TotalMinutes
            }
            $processAlive = $false
            if ($null -ne $healthPid) {
                $processAlive = $null -ne (Get-Process -Id ([int]$healthPid) -ErrorAction SilentlyContinue)
            }
            if ($healthStatus -eq 'running' -and $processAlive -and $null -ne $heartbeatAgeMinutes -and $heartbeatAgeMinutes -le 5) {
                Add-Check -Name 'control-plane' -State 'ok' -Detail "PID $healthPid，心跳 $([math]::Round($heartbeatAgeMinutes, 2)) 分钟前。"
            } else {
                Add-Check -Name 'control-plane' -State 'fail' `
                    -Detail "健康状态=$healthStatus，PID=$healthPid，进程存活=$processAlive，心跳年龄=$heartbeatAgeMinutes 分钟。" `
                    -Fix '查看 DailyDigitalTwin-ControlPlane 计划任务的 LastTaskResult 和控制平面日志。'
            }
        } catch {
            Add-Check -Name 'control-plane' -State 'fail' -Detail "健康文件无效：$($_.Exception.Message)"
        }
    }
}

foreach ($taskName in @('DailyDigitalTwin-ControlPlane', 'DailyDigitalTwin-Telemetry')) {
    $scheduledTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($scheduledTask) {
        Add-Check -Name "task-$taskName" -State 'ok' -Detail "状态 $($scheduledTask.State)"
    } else {
        Add-Check -Name "task-$taskName" -State 'fail' -Detail '计划任务不存在。' `
            -Fix '.\Install-DailyTwinServices.ps1 -WhatIf，确认后去掉 -WhatIf。'
    }
}

# ---- Multica ----
$multicaPreferred = $env:DAILY_TWIN_MULTICA
if ([string]::IsNullOrWhiteSpace($multicaPreferred)) { $multicaPreferred = 'multica.exe' }
$multicaPath = Resolve-DailyTwinExecutable -Preferred $multicaPreferred -AllowedNames @('multica', 'multica.exe')
if ($multicaPath) {
    Add-Check -Name 'multica' -State 'ok' -Detail $multicaPath
} else {
    Add-Check -Name 'multica' -State 'fail' -Detail '找不到 Multica CLI，复杂任务无法派发。' `
        -Fix '安装并登录 Multica CLI；若只测试固定流程，安装服务时显式使用 -SkipMultica。'
}

# ---- Edge / Playwright Extension 配置 ----
if ($resolvedHome) {
    $runtimeConfigPath = Join-Path $resolvedHome 'config\runtime.json'
    if (Test-Path -LiteralPath $runtimeConfigPath -PathType Leaf) {
        try {
            $runtimeConfig = ConvertFrom-DailyTwinJson -Path $runtimeConfigPath
            $browserConfig = Get-DailyTwinProperty -InputObject $runtimeConfig -Name 'browser'
            $defaultBrowser = Get-DailyTwinProperty -InputObject $browserConfig -Name 'defaultBrowser'
            $extensionEnabled = Get-DailyTwinProperty -InputObject $browserConfig -Name 'extension' -Default $false
            if ($defaultBrowser -eq 'msedge' -and $extensionEnabled -eq $true) {
                Add-Check -Name 'edge' -State 'info' `
                    -Detail '配置要求 msedge + Playwright Extension；静态配置正确，仍需在真实 Edge 中完成配对测试。'
            } else {
                Add-Check -Name 'edge' -State 'fail' -Detail "defaultBrowser=$defaultBrowser，extension=$extensionEnabled。" `
                    -Fix '把私有 runtime.json 设置为 browser.defaultBrowser=msedge、browser.extension=true。'
            }
        } catch {
            Add-Check -Name 'edge' -State 'fail' -Detail "读取浏览器配置失败：$($_.Exception.Message)"
        }
    } else {
        Add-Check -Name 'edge' -State 'fail' -Detail '缺少私有 config\runtime.json。'
    }
}

# ---- 输出 ----
$symbols = @{ ok = '[ok]  '; warn = '[warn]'; fail = '[FAIL]'; info = '[info]' }
Write-Output ''
foreach ($check in $checks) {
    Write-Output "$($symbols[$check.state]) $($check.name)：$($check.detail)"
    if ($check.fix) { Write-Output "        修复：$($check.fix)" }
}

$failCount = @($checks | Where-Object { $_.state -eq 'fail' }).Count
$warnCount = @($checks | Where-Object { $_.state -eq 'warn' }).Count
Write-Output ''
Write-Output "体检完成：$failCount 项必须处理，$warnCount 项建议处理。"
Write-Output ''

$overallStatus = 'ok'
if ($failCount -gt 0) { $overallStatus = 'fail' }

Write-DailyTwinResult -InputObject ([pscustomobject]@{
    status    = $overallStatus
    failCount = $failCount
    warnCount = $warnCount
    checks    = $checks
    checkedAt = [DateTime]::UtcNow.ToString('o')
})

if ($failCount -gt 0) { exit 1 }
