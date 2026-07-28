#Requires -Version 5.1
<#
.SYNOPSIS
    在改动配置之前备份 OpenClaw 与替身的状态，并打印一行回滚命令。

.DESCRIPTION
    这个脚本的存在前提是一条硬约束：OpenClaw 的既有数据不能丢。
    因此对数据库和会话文件一律"复制"而不是"移动"，源文件保持原样。

    备份内容：
      1. openclaw.json            -> 时间戳 .bak（同目录，便于就地回滚）
      2. openclaw.sqlite (+ -wal / -shm) -> 备份目录
      3. sessions 下的 *.jsonl    -> 备份目录
      4. 替身私有目录的 config\   -> 备份目录（如果存在）

.EXAMPLE
    .\Backup-DailyTwinState.ps1 -OpenClawHome 'D:\Path\To\_personal_agent' -BackupRoot 'D:\DailyTwin\backups'
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # 中文注释：OpenClaw 的配置与数据所在目录（含 openclaw.json / openclaw.sqlite）。
    [Parameter(Mandatory = $true)]
    [string]$OpenClawHome,

    [string]$BackupRoot,

    [string]$PrivateHome,

    # 中文注释：默认不动运行中的进程。若确实要在网关运行时备份，加 -Force 自行承担一致性风险。
    [switch]$Force
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

if (-not (Test-Path -LiteralPath $OpenClawHome -PathType Container)) {
    throw "找不到 OpenClaw 目录：$OpenClawHome"
}

if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
    $BackupRoot = Join-Path $OpenClawHome 'backups'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDirectory = Join-Path $BackupRoot "state-$stamp"

# 中文注释：备份前先确认网关没在跑，否则 sqlite 可能被复制成不一致的中间状态。
$runningGateway = @(Get-Process -Name 'openclaw', 'node' -ErrorAction SilentlyContinue)
if ($runningGateway.Count -gt 0 -and -not $Force) {
    Write-Warning "检测到可能在运行的进程：$(($runningGateway | Select-Object -ExpandProperty ProcessName -Unique) -join ', ')"
    Write-Warning '建议先停掉网关再备份。确认要继续请加 -Force。'
    throw '为保证备份一致性已中止。'
}

if ($PSCmdlet.ShouldProcess($backupDirectory, '创建备份目录')) {
    New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
}

$copied = @()
$skipped = @()
$rollbackCommands = @()

# 中文注释：配置文件就地留一份带时间戳的 .bak，回滚时不用去翻备份目录。
$configPath = Join-Path $OpenClawHome 'openclaw.json'
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $configBackup = "$configPath.$stamp.bak"
    if ($PSCmdlet.ShouldProcess($configPath, '备份配置')) {
        Copy-Item -LiteralPath $configPath -Destination $configBackup -Force
        Copy-Item -LiteralPath $configPath -Destination (Join-Path $backupDirectory 'openclaw.json') -Force
    }
    $copied += $configBackup
    $rollbackCommands += "Copy-Item -LiteralPath '$configBackup' -Destination '$configPath' -Force"
} else {
    $skipped += $configPath
}

# 中文注释：数据库连同 WAL / SHM 一起复制，只复制不移动。
$databaseNames = @('openclaw.sqlite', 'openclaw.sqlite-wal', 'openclaw.sqlite-shm')
foreach ($name in $databaseNames) {
    $source = Join-Path $OpenClawHome $name
    if (Test-Path -LiteralPath $source -PathType Leaf) {
        if ($PSCmdlet.ShouldProcess($source, '复制数据库文件')) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $backupDirectory $name) -Force
        }
        $copied += $source
    } else {
        $skipped += $source
    }
}

# 中文注释：会话记录（约 7 MB 的 JSONL），按原目录结构复制。
$sessionCandidates = @('sessions', 'data\sessions', 'state\sessions')
$sessionFileCount = 0
foreach ($candidate in $sessionCandidates) {
    $sessionDirectory = Join-Path $OpenClawHome $candidate
    if (-not (Test-Path -LiteralPath $sessionDirectory -PathType Container)) { continue }

    $sessionFiles = @(Get-ChildItem -LiteralPath $sessionDirectory -Filter '*.jsonl' -File -Recurse -ErrorAction SilentlyContinue)
    if ($sessionFiles.Count -eq 0) { continue }

    $destination = Join-Path $backupDirectory $candidate
    if ($PSCmdlet.ShouldProcess($sessionDirectory, "复制 $($sessionFiles.Count) 个会话文件")) {
        New-Item -ItemType Directory -Force -Path $destination | Out-Null
        foreach ($file in $sessionFiles) {
            Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $destination $file.Name) -Force
        }
    }
    $sessionFileCount += $sessionFiles.Count
    $copied += $sessionDirectory
}

# 中文注释：替身自己的配置也一起备份（不含 data\，那里是可再生的运行数据）。
if (-not [string]::IsNullOrWhiteSpace($PrivateHome)) {
    $privateConfig = Join-Path $PrivateHome 'config'
    if (Test-Path -LiteralPath $privateConfig -PathType Container) {
        $destination = Join-Path $backupDirectory 'twin-config'
        if ($PSCmdlet.ShouldProcess($privateConfig, '复制替身配置')) {
            Copy-Item -LiteralPath $privateConfig -Destination $destination -Recurse -Force
        }
        $copied += $privateConfig
    }
}

$totalBytes = 0
if (Test-Path -LiteralPath $backupDirectory -PathType Container) {
    $measured = Get-ChildItem -LiteralPath $backupDirectory -File -Recurse -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum
    if ($null -ne $measured -and $null -ne $measured.Sum) { $totalBytes = [long]$measured.Sum }
}

Write-Output ''
Write-Output '备份完成。回滚只需要这一行：'
if ($rollbackCommands.Count -gt 0) {
    foreach ($command in $rollbackCommands) { Write-Output "  $command" }
} else {
    Write-Output "  Copy-Item -LiteralPath '$backupDirectory\*' -Destination '$OpenClawHome' -Recurse -Force"
}
Write-Output ''

Write-DailyTwinResult -InputObject ([pscustomobject]@{
    status           = 'ok'
    backupDirectory  = $backupDirectory
    copied           = $copied
    skipped          = $skipped
    sessionFileCount = $sessionFileCount
    totalMb          = [math]::Round($totalBytes / 1MB, 2)
    rollback         = $rollbackCommands
    backedUpAt       = [DateTime]::UtcNow.ToString('o')
})
