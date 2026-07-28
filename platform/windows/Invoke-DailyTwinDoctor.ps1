#Requires -Version 5.1
<#
.SYNOPSIS
    一次跑完本机体检：Node、私有目录、数据库、遥测、磁盘、OpenClaw 网关、浏览器 profile。

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
    [int]$GatewayPort = 18789,
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
        -Fix "OpenClaw 的临时日志在 $env:SystemDrive\WINDOWS\TEMP\openclaw，可以定期清理或改到 D 盘。"
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

# ---- OpenClaw 网关 ----
$listening = @()
try { $listening = @(Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction Stop) } catch { $listening = @() }
if ($listening.Count -gt 0) {
    Add-Check -Name 'gateway' -State 'ok' -Detail "端口 $GatewayPort 正在监听。"
} else {
    Add-Check -Name 'gateway' -State 'warn' -Detail "端口 $GatewayPort 没有监听者，WebSocket 会以 1006 断开。" `
        -Fix ".\Repair-OpenClawGatewayTask.ps1  然后按提示加 -Apply"
}

# ---- 浏览器 profile 提醒 ----
Add-Check -Name 'browser-profile' -State 'info' `
    -Detail 'OpenClaw 内置的 chrome profile 是 Chrome 扩展，不是 Edge。本地探测顺序 Chrome→Brave→Edge→Chromium→Canary。' `
    -Fix '要用哪条路线见 docs/BROWSER-PROFILES.md；默认走 openclaw 托管 profile。'

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
