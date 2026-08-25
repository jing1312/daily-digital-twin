#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$PrivateHome,
    [string]$NodePath,
    [string]$MulticaPath,
    [string]$TaskPrefix = 'DailyDigitalTwin',
    [switch]$SkipMultica
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

$resolvedHome = Resolve-DailyTwinHome -PrivateHome $PrivateHome
if ([string]::IsNullOrWhiteSpace($NodePath)) { $NodePath = 'node.exe' }
$resolvedNode = Resolve-DailyTwinExecutable -Preferred $NodePath -AllowedNames @('node', 'node.exe')
if (-not $resolvedNode) { throw "找不到已核验的 Node.js：$NodePath" }

$resolvedMultica = $null
if (-not $SkipMultica) {
    if ([string]::IsNullOrWhiteSpace($MulticaPath)) { $MulticaPath = 'multica.exe' }
    $resolvedMultica = Resolve-DailyTwinExecutable -Preferred $MulticaPath -AllowedNames @('multica', 'multica.exe')
    if (-not $resolvedMultica) { throw "找不到已核验的 Multica CLI：$MulticaPath。尚未安装时可先加 -SkipMultica。" }
}

if ($PSCmdlet.ShouldProcess('当前用户环境变量', '保存 Daily Twin 非敏感启动路径')) {
    $env:DAILY_TWIN_HOME = $resolvedHome
    $env:DAILY_TWIN_NODE = $resolvedNode
    [Environment]::SetEnvironmentVariable('DAILY_TWIN_HOME', $resolvedHome, 'User')
    [Environment]::SetEnvironmentVariable('DAILY_TWIN_NODE', $resolvedNode, 'User')
    if ($resolvedMultica) {
        $env:DAILY_TWIN_MULTICA = $resolvedMultica
        [Environment]::SetEnvironmentVariable('DAILY_TWIN_MULTICA', $resolvedMultica, 'User')
    }
}

$installer = Join-Path $PSScriptRoot 'Install-DailyTwinStartup.ps1'
$taskNames = @("$TaskPrefix-ControlPlane", "$TaskPrefix-Telemetry")
& $installer -RuntimeScript (Join-Path $PSScriptRoot 'Start-DailyTwinControlPlane.ps1') -TaskName "$TaskPrefix-ControlPlane" -RuntimeArguments @('-PrivateHome', $resolvedHome, '-NodePath', $resolvedNode) -Confirm:$false -WhatIf:$WhatIfPreference
& $installer -RuntimeScript (Join-Path $PSScriptRoot 'Start-DailyTwinTelemetry.ps1') -TaskName "$TaskPrefix-Telemetry" -RuntimeArguments @('-PrivateHome', $resolvedHome) -Confirm:$false -WhatIf:$WhatIfPreference
if ($resolvedMultica) {
    & $installer -RuntimeScript (Join-Path $PSScriptRoot 'Start-MulticaDaemon.ps1') -TaskName "$TaskPrefix-Multica" -RuntimeArguments @('-PrivateHome', $resolvedHome, '-MulticaPath', $resolvedMultica) -Confirm:$false -WhatIf:$WhatIfPreference
    $taskNames += "$TaskPrefix-Multica"
}

Write-DailyTwinResult -InputObject ([pscustomobject]@{
    status = if ($WhatIfPreference) { 'preview' } else { 'registered' }
    privateHome = $resolvedHome
    tasks = $taskNames
    openClawChanged = $false
})
