#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$PrivateHome,
    [int]$IntervalSeconds = 60
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

$resolvedHome = Resolve-DailyTwinHome -PrivateHome $PrivateHome
$processLock = Enter-DailyTwinProcessLock -HomeDirectory $resolvedHome -Name 'telemetry'
try {
    & "$PSScriptRoot\Write-DailyTwinTelemetry.ps1" -PrivateHome $resolvedHome -Loop -IntervalSeconds $IntervalSeconds
    if ($LASTEXITCODE -ne 0) { throw "Daily Twin 遥测进程退出，exit code $LASTEXITCODE" }
} finally {
    $processLock.Dispose()
}
