[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$CatalogPath,
    [Parameter(Mandatory = $true)]
    [string]$Alias
)

$ErrorActionPreference = 'Stop'

# 中文注释：只从用户登记的应用目录启动，禁止模型临时拼接任意命令。
function Get-AppEntry {
    param([object]$Catalog, [string]$Name)
    $matches = @($Catalog.apps | Where-Object {
        $_.id -eq $Name -or $_.aliases -contains $Name
    })
    if ($matches.Count -eq 0) { throw "未登记应用：$Name" }
    if ($matches.Count -gt 1) { throw "应用存在多个候选：$Name" }
    return $matches[0]
}

# 中文注释：确认真实文件、进程和窗口状态后才返回成功回执。
function Start-VerifiedApp {
    param([object]$Entry)
    if (-not (Test-Path -LiteralPath $Entry.path -PathType Leaf)) {
        throw "应用路径不存在：$($Entry.id)"
    }

    $process = Start-Process -FilePath $Entry.path -PassThru
    $process.WaitForInputIdle(10000) | Out-Null
    Start-Sleep -Milliseconds 500
    $process.Refresh()

    if ($process.HasExited) { throw "应用启动后立即退出：$($Entry.id)" }
    $window = $process.MainWindowTitle
    if ($Entry.windowTitlePattern -and $window -notmatch $Entry.windowTitlePattern) {
        throw "应用进程已启动，但窗口标题未通过验证：$window"
    }

    [pscustomobject]@{
        status = 'started'
        appId = $Entry.id
        processId = $process.Id
        processName = $process.ProcessName
        windowTitle = $window
        verifiedAt = [DateTime]::UtcNow.ToString('o')
    }
}

$catalog = Get-Content -Raw -LiteralPath $CatalogPath | ConvertFrom-Json
$entry = Get-AppEntry -Catalog $catalog -Name $Alias
Start-VerifiedApp -Entry $entry | ConvertTo-Json -Compress
