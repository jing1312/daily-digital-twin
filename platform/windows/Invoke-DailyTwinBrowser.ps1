[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('open', 'snapshot', 'type', 'screenshot')]
    [string]$Action,
    [string]$Url,
    [string]$TargetId,
    [int]$Ref,
    [string]$Text,
    [string]$OpenClawPath = 'openclaw.cmd'
)

$ErrorActionPreference = 'Stop'

# 中文注释：所有浏览器动作固定使用 Edge 扩展 profile，避免碰未授权标签页。
function Invoke-Browser {
    param([string[]]$Arguments)
    & $OpenClawPath browser --browser-profile chrome --json @Arguments
    if ($LASTEXITCODE -ne 0) { throw "浏览器动作失败：$Action" }
}

switch ($Action) {
    'open' {
        if ([string]::IsNullOrWhiteSpace($Url)) { throw 'open 需要 Url' }
        Invoke-Browser @('open', $Url)
    }
    'snapshot' {
        $args = @('snapshot', '--format', 'aria')
        if ($TargetId) { $args += @('--target-id', $TargetId) }
        Invoke-Browser $args
    }
    'type' {
        if (-not $Ref -or $null -eq $Text) { throw 'type 需要 Ref 和 Text' }
        Invoke-Browser @('type', "$Ref", $Text)
    }
    'screenshot' {
        $args = @('screenshot')
        if ($TargetId) { $args += @('--target-id', $TargetId) }
        Invoke-Browser $args
    }
}
