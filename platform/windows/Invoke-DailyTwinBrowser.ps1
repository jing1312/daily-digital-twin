#Requires -Version 5.1
<#
.SYNOPSIS
    通过 OpenClaw 执行单个浏览器动作，并返回结构化回执。

.DESCRIPTION
    本脚本不再硬编码 --browser-profile chrome。

    OpenClaw 内置的 chrome profile 按定义就是 Chrome 扩展（driver: extension），
    本地启动的自动探测顺序是 Chrome → Brave → Edge → Chromium → Chrome Canary，
    所以过去写 chrome 其实命中的是 Chrome，而不是 Edge。
    profile 现在由调用方（src/core/browser-router.mjs）决定，见 docs/BROWSER-PROFILES.md。

.EXAMPLE
    .\Invoke-DailyTwinBrowser.ps1 -Action open -Url 'https://example.invalid' -BrowserProfileName openclaw
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('open', 'snapshot', 'type', 'screenshot', 'status')]
    [string]$Action,

    [string]$Url,
    [string]$TargetId,
    [int]$Ref = -1,
    [string]$Text,

    # 中文注释：默认走托管 profile。要用别的路线必须显式传，避免"以为在用 Edge"这种误解再发生。
    # 中文注释：参数名不叫 Profile —— $PROFILE 是 PowerShell 自动变量，占用它就是 B18 那类错误。
    [ValidateSet('openclaw', 'user', 'chrome', 'edge-extension', 'edge-existing-session')]
    [string]$BrowserProfileName = 'openclaw',

    [ValidateSet('efficient', 'full')]
    [string]$SnapshotMode = 'efficient',

    [string]$OpenClawPath = 'openclaw.cmd'
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

# 中文注释：$args 是 PowerShell 的自动变量，原版把参数数组赋给 $args（B18），
# 中文注释：在函数里会和真正的自动参数打架。这里全部改用具名局部变量。
function Invoke-OpenClawBrowser {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string[]]$BrowserArguments,
        [Parameter(Mandatory = $true)][string]$ProfileName,
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$ActionName
    )

    $output = & $Executable browser --browser-profile $ProfileName --json @BrowserArguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "浏览器动作失败（profile=$ProfileName, action=$ActionName, exit=$LASTEXITCODE）：$output"
    }
    return $output
}

# 中文注释：用普通 switch 语句而不是 switch 表达式，避免数组被管道展开这种隐蔽行为。
$browserArguments = @()
switch ($Action) {
    'open' {
        if ([string]::IsNullOrWhiteSpace($Url)) { throw 'open 需要 -Url' }
        $browserArguments = @('open', $Url)
    }
    'snapshot' {
        $browserArguments = @('snapshot', '--format', 'aria')
        if ($SnapshotMode -eq 'efficient') { $browserArguments += @('--mode', 'efficient') }
        if (-not [string]::IsNullOrWhiteSpace($TargetId)) { $browserArguments += @('--target-id', $TargetId) }
    }
    'type' {
        if ($Ref -lt 0) { throw 'type 需要 -Ref（页面元素编号）' }
        if ([string]::IsNullOrEmpty($Text)) { throw 'type 需要 -Text' }
        $browserArguments = @('type', "$Ref", $Text)
    }
    'screenshot' {
        $browserArguments = @('screenshot')
        if (-not [string]::IsNullOrWhiteSpace($TargetId)) { $browserArguments += @('--target-id', $TargetId) }
    }
    'status' {
        $browserArguments = @('status')
    }
}

$result = Invoke-OpenClawBrowser -BrowserArguments $browserArguments -ProfileName $BrowserProfileName `
    -Executable $OpenClawPath -ActionName $Action

# 中文注释：回执里带上真正用了哪个 profile，方便事后核对"到底开的是哪个浏览器"。
Write-DailyTwinResult -InputObject ([pscustomobject]@{
    status         = 'ok'
    action         = $Action
    browserProfile = $BrowserProfileName
    snapshotMode   = $SnapshotMode
    targetId       = $TargetId
    output         = ($result | Out-String).Trim()
    completedAt    = [DateTime]::UtcNow.ToString('o')
})
