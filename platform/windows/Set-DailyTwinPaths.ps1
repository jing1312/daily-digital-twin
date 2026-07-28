#Requires -Version 5.1
<#
.SYNOPSIS
    把替身的全部运行数据固定到 D 盘，设置容量上限，并在需要时清理超额文件。

.DESCRIPTION
    为什么必须这么做：系统盘只剩 35 GB 左右，而 D 盘有 100 GB 以上。
    截图、页面快照、缓存和日志会持续增长，放在 C 盘迟早把系统盘写满。
    另外 DAILY_TWIN_HOME 之前根本没设置，老代码于是把运行数据写在公开仓库旁边的 runtime\ 里。

    本脚本做四件事：
      1. 把 DAILY_TWIN_HOME 写成用户级环境变量（不需要管理员权限）。
      2. 建好目录分层，并把上限写进 <home>\config\runtime.json 的 storage 段。
      3. 报告 C / D 两个卷的剩余空间，C 盘低于阈值时明确告警。
      4. 加 -Enforce 时按上限清理最旧的缓存、截图和日志。

.EXAMPLE
    .\Set-DailyTwinPaths.ps1 -PrivateHome 'D:\DailyTwin\home'
.EXAMPLE
    .\Set-DailyTwinPaths.ps1 -PrivateHome 'D:\DailyTwin\home' -Enforce
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$PrivateHome,

    [int]$MaxCacheMb = 2048,
    [int]$MaxScreenshotsMb = 2048,
    [int]$MaxLogsMb = 512,
    [int]$KeepFreeDiskGb = 20,

    # 中文注释：加上才会真的删文件；默认只报告。
    [switch]$Enforce,

    # 中文注释：不写环境变量，只做目录和配置（便于在 CI 或测试目录里试跑）。
    [switch]$SkipEnvironmentVariable
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

$systemDrive = $env:SystemDrive
$homeQualifier = Split-Path -Path ([System.IO.Path]::GetFullPath($PrivateHome)) -Qualifier

if ($homeQualifier -ieq $systemDrive) {
    Write-Warning "私有目录在系统盘（$homeQualifier）。系统盘空间紧张，强烈建议改到 D 盘。"
}

# ---- 1. 建目录 ----
$relativeDirectories = @('data\tasks', 'data\receipts', 'data\screenshots', 'data\cache', 'data\logs', 'config', 'backups')
foreach ($relative in $relativeDirectories) {
    $directory = Join-Path $PrivateHome $relative
    if (-not (Test-Path -LiteralPath $directory)) {
        if ($PSCmdlet.ShouldProcess($directory, '创建目录')) {
            New-Item -ItemType Directory -Force -Path $directory | Out-Null
        }
    }
}

# ---- 2. 环境变量 ----
$environmentVariableSet = $false
if (-not $SkipEnvironmentVariable) {
    if ($PSCmdlet.ShouldProcess('DAILY_TWIN_HOME', "设为 $PrivateHome（用户级）")) {
        [Environment]::SetEnvironmentVariable('DAILY_TWIN_HOME', $PrivateHome, 'User')
        $env:DAILY_TWIN_HOME = $PrivateHome
        $environmentVariableSet = $true
    }
}

# ---- 3. 写入 storage 上限 ----
$configPath = Join-Path $PrivateHome 'config\runtime.json'
$configuration = $null
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $configuration = ConvertFrom-DailyTwinJson -Path $configPath
} else {
    $configuration = [pscustomobject]@{}
}

$storage = [pscustomobject]@{
    maxCacheMb       = $MaxCacheMb
    maxScreenshotsMb = $MaxScreenshotsMb
    maxLogsMb        = $MaxLogsMb
    keepFreeDiskGb   = $KeepFreeDiskGb
    logRotateMb      = 32
    logKeepFiles     = 7
}

if ($configuration.PSObject.Properties['storage']) {
    $configuration.PSObject.Properties.Remove('storage')
}
$configuration | Add-Member -MemberType NoteProperty -Name 'storage' -Value $storage -Force

if (-not $configuration.PSObject.Properties['database']) {
    $configuration | Add-Member -MemberType NoteProperty -Name 'database' -Value 'data/runtime.sqlite' -Force
}

Write-DailyTwinJsonFile -Path $configPath -InputObject $configuration -Depth 8

# ---- 4. 容量报告与可选清理 ----
function Get-DirectorySizeMb {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return 0 }
    $measured = Get-ChildItem -LiteralPath $Path -File -Recurse -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum
    if ($null -eq $measured -or $null -eq $measured.Sum) { return 0 }
    return [math]::Round([double]$measured.Sum / 1MB, 2)
}

function Limit-DirectorySize {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][int]$LimitMb
    )

    $report = [pscustomobject]@{ path = $Path; sizeMb = (Get-DirectorySizeMb -Path $Path); limitMb = $LimitMb; removed = 0; freedMb = 0 }
    if ($report.sizeMb -le $LimitMb) { return $report }
    if (-not $Enforce) { return $report }

    $files = @(Get-ChildItem -LiteralPath $Path -File -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
    $currentBytes = [double]$report.sizeMb * 1MB
    $limitBytes = [double]$LimitMb * 1MB
    $removed = 0
    $freed = 0.0

    foreach ($file in $files) {
        if ($currentBytes -le $limitBytes) { break }
        if ($PSCmdlet.ShouldProcess($file.FullName, '删除超额文件')) {
            $size = [double]$file.Length
            Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
            $currentBytes -= $size
            $freed += $size
            $removed += 1
        }
    }

    $report.removed = $removed
    $report.freedMb = [math]::Round($freed / 1MB, 2)
    $report.sizeMb = [math]::Round($currentBytes / 1MB, 2)
    return $report
}

$quotaReports = @(
    (Limit-DirectorySize -Path (Join-Path $PrivateHome 'data\cache') -LimitMb $MaxCacheMb),
    (Limit-DirectorySize -Path (Join-Path $PrivateHome 'data\screenshots') -LimitMb $MaxScreenshotsMb),
    (Limit-DirectorySize -Path (Join-Path $PrivateHome 'data\logs') -LimitMb $MaxLogsMb)
)

$systemFreeGb = Get-DailyTwinFreeSpaceGb -Path $systemDrive
$homeFreeGb = Get-DailyTwinFreeSpaceGb -Path $PrivateHome

if ($null -ne $systemFreeGb -and $systemFreeGb -lt $KeepFreeDiskGb) {
    Write-Warning "系统盘 $systemDrive 剩余 $systemFreeGb GB，低于阈值 $KeepFreeDiskGb GB。请清理，或把 OpenClaw 的临时日志目录也迁到 D 盘。"
}

Write-Output ''
Write-Output "私有目录：$PrivateHome"
if ($environmentVariableSet) {
    Write-Output 'DAILY_TWIN_HOME 已写入用户环境变量。新开的终端才会生效，当前终端已临时设置。'
}
Write-Output "系统盘剩余：$systemFreeGb GB    私有目录所在卷剩余：$homeFreeGb GB"
foreach ($report in $quotaReports) {
    Write-Output ("  {0}  {1} MB / 上限 {2} MB  已删 {3} 个文件" -f $report.path, $report.sizeMb, $report.limitMb, $report.removed)
}
if (-not $Enforce) { Write-Output '（当前只报告不删除。要按上限清理请加 -Enforce）' }
Write-Output ''

Write-DailyTwinResult -InputObject ([pscustomobject]@{
    status                 = 'ok'
    privateHome            = $PrivateHome
    configPath             = $configPath
    environmentVariableSet = $environmentVariableSet
    systemDriveFreeGb      = $systemFreeGb
    homeVolumeFreeGb       = $homeFreeGb
    quotas                 = $quotaReports
    enforced               = [bool]$Enforce
    configuredAt           = [DateTime]::UtcNow.ToString('o')
})
