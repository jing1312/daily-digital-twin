[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PrivateHome
)

$ErrorActionPreference = 'Stop'

# 中文注释：建立私有数据分层，避免任务、截图、日志和缓存混入源码仓。
$directories = @(
    $PrivateHome,
    (Join-Path $PrivateHome 'data\tasks'),
    (Join-Path $PrivateHome 'data\receipts'),
    (Join-Path $PrivateHome 'data\screenshots'),
    (Join-Path $PrivateHome 'data\cache'),
    (Join-Path $PrivateHome 'data\logs'),
    (Join-Path $PrivateHome 'config')
)

foreach ($directory in $directories) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

[pscustomobject]@{
    privateHome = $PrivateHome
    directories = $directories
    initializedAt = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json -Compress
