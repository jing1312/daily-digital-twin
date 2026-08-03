#Requires -Version 5.1
<#
.SYNOPSIS
    Daily Digital Twin 的 Windows 脚本公共库。用点号引入：. "$PSScriptRoot\DailyTwin.Common.ps1"

.DESCRIPTION
    集中处理三件在 Windows PowerShell 5.1 上反复出错的事情：
      1. 中文输出乱码（控制台编码不是 UTF-8 时会出现 "璇峰湪娴忚鍣" 这类字符）。
      2. 可选属性访问在 StrictMode 下直接抛异常。
      3. ConvertFrom-Json 在 5.1 上没有 -Depth 参数，照 7.x 的写法会报"找不到与参数名称 Depth 匹配的参数"。
#>

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# 中文注释：把控制台和管道都切到不带 BOM 的 UTF-8，否则中文回执在飞书里会变成乱码
# 中文注释：（本机实测过 "璇峰湪娴忚鍣ㄥ畬鎴" 这种典型的 UTF-8 被按 GBK 解读的结果）。
function Set-DailyTwinConsoleEncoding {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()

    if (-not $PSCmdlet.ShouldProcess('当前进程的控制台编码', '切换为 UTF-8')) { return }

    $utf8 = New-Object System.Text.UTF8Encoding($false)
    try { [Console]::OutputEncoding = $utf8 } catch { Write-Verbose "无法设置控制台输出编码：$($_.Exception.Message)" }
    try { $global:OutputEncoding = $utf8 } catch { Write-Verbose "无法设置管道编码：$($_.Exception.Message)" }
}

# 中文注释：StrictMode 下访问不存在的属性会抛异常，所有可选字段都必须走这里。
function Get-DailyTwinProperty {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowNull()][AllowEmptyString()]$InputObject,
        [Parameter(Mandatory = $true)][string]$Name,
        $Default = $null
    )

    if ($null -eq $InputObject) { return $Default }

    if ($InputObject -is [System.Collections.IDictionary]) {
        if ($InputObject.Contains($Name)) {
            $value = $InputObject[$Name]
            if ($null -eq $value) { return $Default }
            return $value
        }
        return $Default
    }

    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    if ($null -eq $property.Value) { return $Default }
    return $property.Value
}

# 中文注释：5.1 的 ConvertFrom-Json 没有 -Depth；这里统一入口，避免各脚本各写一套。
function ConvertFrom-DailyTwinJson {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "找不到 JSON 文件：$Path"
    }

    $raw = [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
    if ($raw.Length -gt 0 -and [int]$raw[0] -eq 0xFEFF) { $raw = $raw.Substring(1) }
    if ([string]::IsNullOrWhiteSpace($raw)) { throw "JSON 文件是空的：$Path" }

    try {
        return $raw | ConvertFrom-Json
    } catch {
        throw "JSON 解析失败（$Path）：$($_.Exception.Message)"
    }
}

# 中文注释：Node 的 JSON.parse 遇到 BOM 会直接抛错，所以写文件必须显式用无 BOM 的 UTF-8。
# 中文注释：Out-File -Encoding utf8 在 5.1 上会写 BOM，一律不要用。
function Write-DailyTwinJsonFile {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$InputObject,
        [int]$Depth = 6
    )

    $json = $InputObject | ConvertTo-Json -Depth $Depth
    $directory = Split-Path -Parent $Path
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        if ($PSCmdlet.ShouldProcess($directory, '创建目录')) {
            New-Item -ItemType Directory -Force -Path $directory | Out-Null
        }
    }

    if ($PSCmdlet.ShouldProcess($Path, '写入 JSON')) {
        # 中文注释：先写临时文件再原子替换，避免 Node 端读到写了一半的内容。
        $temporary = "$Path.tmp"
        [System.IO.File]::WriteAllText($temporary, $json, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
}

# 中文注释：给命令行回执用。-Compress 保证单行，便于 Node 端按行读取。
function Write-DailyTwinResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$InputObject,
        [int]$Depth = 6
    )

    $InputObject | ConvertTo-Json -Depth $Depth -Compress
}

function Test-DailyTwinCutoverHealth {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Health,
        [ValidateRange(1, 8760)][double]$StableHours = 48,
        [ValidateRange(1, 60)][double]$MaxHeartbeatAgeMinutes = 5,
        [DateTime]$Now = [DateTime]::UtcNow,
        [scriptblock]$IsProcessAlive
    )

    if ((Get-DailyTwinProperty -InputObject $Health -Name 'status') -ne 'running') { return $false }
    try {
        $healthPid = [int](Get-DailyTwinProperty -InputObject $Health -Name 'pid')
        $startedAt = [DateTime]::Parse((Get-DailyTwinProperty -InputObject $Health -Name 'startedAt')).ToUniversalTime()
        $heartbeatAt = [DateTime]::Parse((Get-DailyTwinProperty -InputObject $Health -Name 'lastHeartbeatAt')).ToUniversalTime()
    } catch {
        return $false
    }
    if ($healthPid -le 0) { return $false }

    $nowUtc = $Now.ToUniversalTime()
    $ageHours = ($nowUtc - $startedAt).TotalHours
    $heartbeatAgeMinutes = ($nowUtc - $heartbeatAt).TotalMinutes
    if ($ageHours -lt $StableHours -or $heartbeatAgeMinutes -lt 0 -or $heartbeatAgeMinutes -gt $MaxHeartbeatAgeMinutes) {
        return $false
    }

    if ($null -eq $IsProcessAlive) {
        $IsProcessAlive = { param($candidatePid) $null -ne (Get-Process -Id $candidatePid -ErrorAction SilentlyContinue) }
    }
    try {
        return [bool](& $IsProcessAlive $healthPid)
    } catch {
        return $false
    }
}

# 中文注释：pwsh.exe 缺失是本机最常见的开机失败原因之一，注册计划任务前必须先确认。
function Resolve-DailyTwinPwsh {
    [CmdletBinding()]
    param([string]$Preferred = 'pwsh.exe')

    if ([string]::IsNullOrWhiteSpace($Preferred)) { return $null }
    if ([System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters($Preferred)) { return $null }

    $fileName = [System.IO.Path]::GetFileName($Preferred)
    if ($fileName -notin @('pwsh', 'pwsh.exe')) { return $null }

    $directoryName = [System.IO.Path]::GetDirectoryName($Preferred)
    if (-not [string]::IsNullOrWhiteSpace($directoryName)) {
        if (-not (Test-Path -LiteralPath $Preferred -PathType Leaf)) { return $null }
        return (Resolve-Path -LiteralPath $Preferred).Path
    }

    # 中文注释：只有裸名 pwsh/pwsh.exe 才允许查 PATH 或标准安装位置。
    $command = Get-Command -Name $Preferred -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }

    # 中文注释：这些环境变量在服务账号或非标准架构下可能为空，Join-Path 收到 $null 会直接抛异常。
    # 中文注释：所以先逐个判空再拼接 —— 一个"找不到 pwsh"的辅助函数本身绝不该抛错。
    $roots = @(
        @{ Base = $env:ProgramFiles;        Relative = 'PowerShell\7\pwsh.exe' },
        @{ Base = ${env:ProgramFiles(x86)}; Relative = 'PowerShell\7\pwsh.exe' },
        @{ Base = $env:LOCALAPPDATA;        Relative = 'Microsoft\WindowsApps\pwsh.exe' }
    )
    foreach ($root in $roots) {
        if ([string]::IsNullOrWhiteSpace($root.Base)) { continue }
        $candidate = Join-Path $root.Base $root.Relative
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }

    return $null
}

function Resolve-DailyTwinExecutable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Preferred,
        [Parameter(Mandatory = $true)][string[]]$AllowedNames
    )

    if ([string]::IsNullOrWhiteSpace($Preferred)) { return $null }
    if ([System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters($Preferred)) { return $null }
    $fileName = [System.IO.Path]::GetFileName($Preferred)
    if ($AllowedNames -notcontains $fileName) { return $null }

    $directoryName = [System.IO.Path]::GetDirectoryName($Preferred)
    if (-not [string]::IsNullOrWhiteSpace($directoryName)) {
        if (-not (Test-Path -LiteralPath $Preferred -PathType Leaf)) { return $null }
        return (Resolve-Path -LiteralPath $Preferred).Path
    }

    $command = Get-Command -Name $Preferred -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

# 中文注释：私有目录必须显式给出，绝不回落到仓库目录（对应内核里的 B13b/B14）。
# 中文注释：参数名刻意用 PrivateHome 而不是 Home —— $HOME 是 PowerShell 的自动变量，占用它就是 B18 那类错误。
function Resolve-DailyTwinHome {
    [CmdletBinding()]
    param([string]$PrivateHome)

    if (-not [string]::IsNullOrWhiteSpace($PrivateHome)) { return $PrivateHome }
    if (-not [string]::IsNullOrWhiteSpace($env:DAILY_TWIN_HOME)) { return $env:DAILY_TWIN_HOME }

    throw '未配置私有目录。请先运行 Set-DailyTwinPaths.ps1，或设置环境变量 DAILY_TWIN_HOME。'
}

function Enter-DailyTwinProcessLock {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$HomeDirectory,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ([string]::IsNullOrWhiteSpace($HomeDirectory)) { throw '进程锁缺少私有目录' }
    if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { throw "进程锁名称非法：$Name" }

    $lockDirectory = Join-Path $HomeDirectory 'data\locks'
    if (-not (Test-Path -LiteralPath $lockDirectory -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $lockDirectory | Out-Null
    }
    $lockPath = Join-Path $lockDirectory "$Name.lock"
    try {
        $stream = New-Object System.IO.FileStream(
            $lockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    } catch [System.IO.IOException] {
        throw "Daily Twin $Name 已在运行，不能启动第二个实例。锁文件：$lockPath"
    }

    try {
        $owner = [pscustomobject]@{
            pid = $PID
            startedAt = [DateTime]::UtcNow.ToString('o')
        } | ConvertTo-Json -Compress
        $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($owner)
        $stream.SetLength(0)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
        return $stream
    } catch {
        $stream.Dispose()
        throw
    }
}

# 中文注释：磁盘剩余空间按卷返回 GB，取不到时返回 $null 而不是 0，避免被当成"磁盘满了"。
# 中文注释：允许空路径 —— 这个函数被遥测采集调用，遥测采集绝不能因为一个取不到的环境变量整体崩掉。
# 中文注释：只接受可验证的磁盘容量；未知、负数或超过卷总容量时一律返回 $null。
function ConvertTo-DailyTwinFreeSpaceGb {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowNull()]$AvailableBytes,
        [Parameter(Mandatory = $true)][AllowNull()]$TotalBytes
    )

    try {
        if ($null -eq $AvailableBytes -or $null -eq $TotalBytes) { return $null }
        $available = [double]$AvailableBytes
        $total = [double]$TotalBytes
        if ([double]::IsNaN($available) -or [double]::IsInfinity($available)) { return $null }
        if ([double]::IsNaN($total) -or [double]::IsInfinity($total)) { return $null }
        if ($total -le 0 -or $available -lt 0 -or $available -gt $total) { return $null }
        return [math]::Round($available / 1GB, 2)
    } catch {
        return $null
    }
}

# 中文注释：DriveInfo 只在 Windows 本地盘符上使用；非 Windows、UNC、无效路径或
# 中文注释：容量异常时返回 $null，不能用虚构的巨大空间替代缺失遥测。
function Get-DailyTwinFreeSpaceGb {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][AllowEmptyString()][AllowNull()][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    if ([System.Environment]::OSVersion.Platform -ne 'Win32NT') { return $null }

    try {
        $fullPath = [System.IO.Path]::GetFullPath($Path)
        $rootPath = [System.IO.Path]::GetPathRoot($fullPath)
        # 只允许类似 C:\ 的本地 Windows 盘符；UNC 根路径必须失败关闭。
        if ([string]::IsNullOrWhiteSpace($rootPath) -or $rootPath -notmatch '^[A-Za-z]:\\$') { return $null }
    } catch {
        return $null
    }

    try {
        $driveInfo = New-Object System.IO.DriveInfo($rootPath)
        if ($driveInfo.IsReady) {
            $driveFree = ConvertTo-DailyTwinFreeSpaceGb -AvailableBytes $driveInfo.AvailableFreeSpace -TotalBytes $driveInfo.TotalSize
            if ($null -ne $driveFree) { return $driveFree }
        }
    } catch {
        Write-Verbose "DriveInfo 读取磁盘剩余空间失败（$Path）：$([string]$_.Exception.Message)"
    }

    try {
        $qualifier = $rootPath.Substring(0, 2)
        $disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$qualifier'" -ErrorAction Stop
        if ($null -eq $disk) { return $null }
        $free = Get-DailyTwinProperty -InputObject $disk -Name 'FreeSpace'
        $total = Get-DailyTwinProperty -InputObject $disk -Name 'Size'
        return (ConvertTo-DailyTwinFreeSpaceGb -AvailableBytes $free -TotalBytes $total)
    } catch {
        Write-Verbose "读取磁盘剩余空间失败（$Path）：$([string]$_.Exception.Message)"
        return $null
    }
}
