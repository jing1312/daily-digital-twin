#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$PrivateHome,
    [string]$MulticaPath,
    [int]$PollSeconds = 60
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

$resolvedHome = Resolve-DailyTwinHome -PrivateHome $PrivateHome
$env:DAILY_TWIN_HOME = $resolvedHome
if ([string]::IsNullOrWhiteSpace($MulticaPath)) { $MulticaPath = $env:DAILY_TWIN_MULTICA }
if ([string]::IsNullOrWhiteSpace($MulticaPath)) { $MulticaPath = 'multica.exe' }
$resolvedMultica = Resolve-DailyTwinExecutable -Preferred $MulticaPath -AllowedNames @('multica', 'multica.exe')
if (-not $resolvedMultica) { throw "找不到已核验的 Multica CLI：$MulticaPath" }
if ($PollSeconds -lt 15) { throw '-PollSeconds 不得小于 15 秒' }

& $resolvedMultica daemon start
if ($LASTEXITCODE -ne 0) { throw "Multica daemon start 失败，exit code $LASTEXITCODE" }

while ($true) {
    Start-Sleep -Seconds $PollSeconds
    & $resolvedMultica daemon status
    if ($LASTEXITCODE -eq 0) { continue }
    & $resolvedMultica daemon start
    if ($LASTEXITCODE -ne 0) { throw "Multica daemon 重启失败，exit code $LASTEXITCODE" }
}
