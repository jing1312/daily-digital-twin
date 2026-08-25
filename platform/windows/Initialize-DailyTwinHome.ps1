#Requires -Version 5.1
<#
.SYNOPSIS
    建立私有运行目录的目录分层。

.DESCRIPTION
    目录列表必须与 src/core/home.mjs 里的 HOME_DIRECTORIES 保持一致，
    否则 Node 端 init 和 PowerShell 端初始化会各建一套目录。

.EXAMPLE
    .\Initialize-DailyTwinHome.ps1 -PrivateHome 'D:\DailyTwin\home'
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$PrivateHome
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

$resolvedHome = Resolve-DailyTwinHome -PrivateHome $PrivateHome

# 中文注释：与 src/core/home.mjs 的 HOME_DIRECTORIES 一一对应，多出的 backups 用于状态备份。
$relativeDirectories = @(
    'data\tasks',
    'data\receipts',
    'data\screenshots',
    'data\cache',
    'data\logs',
    'data\workers',
    'data\locks',
    'config',
    'backups'
)

$created = @()
foreach ($relative in $relativeDirectories) {
    $directory = Join-Path $resolvedHome $relative
    if (-not (Test-Path -LiteralPath $directory)) {
        if ($PSCmdlet.ShouldProcess($directory, '创建目录')) {
            New-Item -ItemType Directory -Force -Path $directory | Out-Null
            $created += $directory
        }
    }
}

Write-DailyTwinResult -InputObject ([pscustomobject]@{
    status        = 'ok'
    privateHome   = $resolvedHome
    directories   = ($relativeDirectories | ForEach-Object { Join-Path $resolvedHome $_ })
    createdNow    = $created
    freeSpaceGb   = (Get-DailyTwinFreeSpaceGb -Path $resolvedHome)
    initializedAt = [DateTime]::UtcNow.ToString('o')
})
