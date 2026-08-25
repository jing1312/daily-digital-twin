#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$PrivateHome,
    [string]$NodePath,
    [string]$RepositoryRoot
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

$resolvedHome = Resolve-DailyTwinHome -PrivateHome $PrivateHome
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
}
if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $NodePath = $env:DAILY_TWIN_NODE
}
if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $NodePath = 'node.exe'
}
$resolvedNode = Resolve-DailyTwinExecutable -Preferred $NodePath -AllowedNames @('node', 'node.exe')
if (-not $resolvedNode) { throw "找不到已核验的 Node.js：$NodePath" }

$versionText = (& $resolvedNode --version 2>&1 | Select-Object -First 1)
if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v(\d+)\.') {
    throw "无法读取 Node.js 版本：$versionText"
}
if ([int]$Matches[1] -lt 24) { throw "Daily Twin 需要 Node.js 24 或更高版本，当前是 $versionText" }

$runtimePath = Join-Path $RepositoryRoot 'src\runtime.mjs'
if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
    throw "找不到 Daily Twin runtime：$runtimePath"
}

$env:DAILY_TWIN_HOME = $resolvedHome
& $resolvedNode $runtimePath 'serve' '--home' $resolvedHome
$nativeExitCode = $LASTEXITCODE
if ($nativeExitCode -ne 0) { throw "Daily Twin 控制平面退出，exit code $nativeExitCode" }
