#Requires -Version 5.1
<#
.SYNOPSIS
    只从用户登记的应用目录启动桌面软件，并返回可核验的执行证据。

.DESCRIPTION
    这个脚本存在的理由是一次真实的谎报事故：模型曾经声称"VS Code 已直接打开，进程已确认在运行"，
    而交叉核查证明那台机器上根本没有安装 VS Code。
    因此本脚本只做三件事：查登记表、验证文件真实存在、启动后回读进程与窗口证据。
    拿不到证据就抛异常，绝不返回 started。

.EXAMPLE
    .\Start-DailyTwinApp.ps1 -CatalogPath 'D:\DailyTwin\home\config\apps.json' -Alias 'vs code'
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$CatalogPath,

    [Parameter(Mandatory = $true)]
    [string]$Alias,

    [int]$InputIdleTimeoutMs = 10000,
    [int]$WindowSettleMs = 800
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

# 中文注释：$matches 是 PowerShell 的自动变量（-match 的捕获结果），原版直接赋值（B18），
# 中文注释：后面任何一次 -match 都会把它冲掉。这里改名为 $matchedApps。
function Get-DailyTwinAppEntry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Catalog,
        [Parameter(Mandatory = $true)][string]$Name,
        # 中文注释：只用于错误信息。刻意不去读脚本作用域的 $CatalogPath，
        # 中文注释：这样这个函数能被单独抽出来测试，不依赖调用方的变量。
        [string]$Source = '(未提供目录路径)'
    )

    $apps = Get-DailyTwinProperty -InputObject $Catalog -Name 'apps'
    if ($null -eq $apps) {
        throw "应用目录缺少 apps 字段：$Source"
    }

    # 中文注释：别名比较必须忽略大小写和首尾空格，否则 'vs code' 匹配不上登记的 'VS Code'（B8b）。
    $needle = $Name.Trim()
    $matchedApps = @($apps | Where-Object {
        $id = [string](Get-DailyTwinProperty -InputObject $_ -Name 'id' -Default '')
        $aliases = @(Get-DailyTwinProperty -InputObject $_ -Name 'aliases' -Default @())
        if ($id -and $id.Trim() -ieq $needle) { return $true }
        foreach ($alias in $aliases) {
            if ([string]$alias -and ([string]$alias).Trim() -ieq $needle) { return $true }
        }
        return $false
    })

    if ($matchedApps.Count -eq 0) { throw "未登记应用：$needle" }
    if ($matchedApps.Count -gt 1) {
        $ids = ($matchedApps | ForEach-Object { Get-DailyTwinProperty -InputObject $_ -Name 'id' -Default '?' }) -join ', '
        throw "应用别名存在多个候选（$ids），请修正应用目录：$needle"
    }
    return $matchedApps[0]
}

# 中文注释：确认真实文件、进程和窗口状态后才返回成功回执。
function Start-DailyTwinVerifiedApp {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)]$Entry,
        [int]$IdleTimeoutMs = 10000,
        [int]$SettleMs = 800
    )

    $appId = [string](Get-DailyTwinProperty -InputObject $Entry -Name 'id' -Default '未命名应用')
    $path = [string](Get-DailyTwinProperty -InputObject $Entry -Name 'path' -Default '')
    $expectedProcess = Get-DailyTwinProperty -InputObject $Entry -Name 'processName'
    $windowPattern = Get-DailyTwinProperty -InputObject $Entry -Name 'windowTitlePattern'

    if ([string]::IsNullOrWhiteSpace($path)) { throw "应用未登记可执行文件路径：$appId" }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        # 中文注释：这一句就是防谎报的第一道闸 —— 文件不存在就不可能"已经打开"。
        throw "应用路径不存在，无法启动：$appId -> $path"
    }

    if (-not $PSCmdlet.ShouldProcess($appId, '启动应用')) {
        return [pscustomobject]@{ status = 'skipped'; appId = $appId; reason = 'WhatIf' }
    }

    $process = Start-Process -FilePath $path -PassThru
    try { $process.WaitForInputIdle($IdleTimeoutMs) | Out-Null }
    catch { Write-Verbose "WaitForInputIdle 不适用于该进程：$($_.Exception.Message)" }
    Start-Sleep -Milliseconds $SettleMs
    $process.Refresh()

    if ($process.HasExited) { throw "应用启动后立即退出：$appId（退出码 $($process.ExitCode)）" }

    if ($expectedProcess -and $process.ProcessName -ine [string]$expectedProcess) {
        throw "进程名与登记不符：期望 $expectedProcess，实际 $($process.ProcessName)"
    }

    $windowTitle = $process.MainWindowTitle
    if ($windowPattern -and $windowTitle -notmatch [string]$windowPattern) {
        throw "应用进程已启动，但窗口标题未通过验证：$windowTitle"
    }

    [pscustomobject]@{
        status      = 'started'
        appId       = $appId
        kind        = 'process'
        processId   = $process.Id
        processName = $process.ProcessName
        windowTitle = $windowTitle
        target      = $path
        verifiedAt  = [DateTime]::UtcNow.ToString('o')
    }
}

$catalog = ConvertFrom-DailyTwinJson -Path $CatalogPath
$entry = Get-DailyTwinAppEntry -Catalog $catalog -Name $Alias -Source $CatalogPath
$receipt = Start-DailyTwinVerifiedApp -Entry $entry -IdleTimeoutMs $InputIdleTimeoutMs -SettleMs $WindowSettleMs
Write-DailyTwinResult -InputObject $receipt
