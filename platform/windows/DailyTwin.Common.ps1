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

# 中文注释：ConvertTo-Json 的 -Depth 默认只有 2，超出的层级会被静默写成 "@{a=1}" 这种字符串。
# 中文注释：写别人的真实配置时这等于把文件写坏，所以先把对象的实际嵌套量出来，再按量给深度。
function Get-DailyTwinJsonDepth {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowNull()]$InputObject,
        [int]$Remaining = 100
    )

    if ($Remaining -le 0) { return 0 }
    if ($null -eq $InputObject) { return 0 }
    if ($InputObject -is [string]) { return 0 }
    if ($InputObject -is [System.ValueType]) { return 0 }

    # 中文注释：数组自己也有 Length/Rank 这些属性，所以必须先判 IEnumerable 再判普通属性袋。
    # 中文注释：只能用 ArrayList.Add 逐个装 —— 走管道的话数组会被展开，"数组也占一层"就量不出来了。
    $children = New-Object System.Collections.ArrayList
    if ($InputObject -is [System.Collections.IDictionary]) {
        foreach ($key in @($InputObject.Keys)) { $null = $children.Add($InputObject[$key]) }
    } elseif ($InputObject -is [System.Collections.IEnumerable]) {
        foreach ($item in $InputObject) { $null = $children.Add($item) }
    } elseif ($null -ne $InputObject.PSObject -and @($InputObject.PSObject.Properties).Count -gt 0) {
        foreach ($property in $InputObject.PSObject.Properties) { $null = $children.Add($property.Value) }
    } else {
        return 0
    }

    $deepest = 0
    foreach ($child in $children) {
        $childDepth = Get-DailyTwinJsonDepth -InputObject $child -Remaining ($Remaining - 1)
        if ($childDepth -gt $deepest) { $deepest = $childDepth }
    }
    return $deepest + 1
}

# 中文注释：万一深度还是不够，序列化结果里会留下这些特征串；宁可报错也不能把半截 JSON 落盘。
function Test-DailyTwinJsonTruncated {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)

    if ([string]::IsNullOrEmpty($Text)) { return $false }
    foreach ($marker in @('"@{', '"System.Collections.Hashtable"', '"System.Object[]"', '"System.Management.Automation.PSCustomObject"')) {
        if ($Text.Contains($marker)) { return $true }
    }
    return $false
}

# 中文注释：量出实际深度后再留两层余量，并且不低于调用方要求的 $Depth，上限 100（ConvertTo-Json 的上限）。
function Resolve-DailyTwinJsonDepth {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowNull()]$InputObject,
        [int]$Minimum = 6
    )

    $effective = (Get-DailyTwinJsonDepth -InputObject $InputObject) + 2
    if ($effective -lt $Minimum) { $effective = $Minimum }
    if ($effective -lt 1) { $effective = 1 }
    if ($effective -gt 100) { $effective = 100 }
    return $effective
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

    $effectiveDepth = Resolve-DailyTwinJsonDepth -InputObject $InputObject -Minimum $Depth
    $json = $InputObject | ConvertTo-Json -Depth $effectiveDepth
    if (Test-DailyTwinJsonTruncated -Text $json) {
        throw "JSON 序列化被截断（已用深度 $effectiveDepth）：$Path。嵌套超过 100 层，或对象里含有不能序列化的类型，已放弃写入。"
    }
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

    # 中文注释：回执一般很浅，但 changes/blockers 这类数组套对象也能到 4~5 层，同样按实测深度来。
    $InputObject | ConvertTo-Json -Depth (Resolve-DailyTwinJsonDepth -InputObject $InputObject -Minimum $Depth) -Compress
}

# 中文注释：pwsh.exe 缺失是本机最常见的开机失败原因之一，注册计划任务前必须先确认。
function Resolve-DailyTwinPwsh {
    [CmdletBinding()]
    param([string]$Preferred = 'pwsh.exe')

    # 中文注释：这个函数只认两种输入，分开处理，两条路绝不互相兜底：
    # 中文注释：  1) 裸名 pwsh / pwsh.exe —— 等于「没有偏好」，可以查 PATH、可以走下面的兜底目录；
    # 中文注释：  2) 带目录的路径 —— 等于「我就要这一个」，只在这个位置找，找不到就返回 $null，
    # 中文注释：     绝不退回去猜另一份 pwsh。函数注释从一开始就是这么承诺的，之前没做到。
    # 中文注释：其余一切（cmd.exe、notepad.exe……）一律 $null，带不带完整路径都一样 ——
    # 中文注释：曾经这里还有一个 -not IsPathRooted 条件，导致 C:\Windows\System32\cmd.exe 被原样放行。
    if (-not [string]::IsNullOrWhiteSpace($Preferred)) {
        $leaf = [System.IO.Path]::GetFileName($Preferred)
        if ($leaf -notin @('pwsh', 'pwsh.exe')) { return $null }

        # 中文注释：叶子名和原串不相等，说明前面还挂着目录，属于第 2 种输入。
        if ($leaf -ne $Preferred) {
            $explicit = Get-Command -Name $Preferred -CommandType Application -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($explicit) { return $explicit.Source }
            return $null
        }
    }

    $command = Get-Command -Name $Preferred -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
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

# 中文注释：私有目录必须显式给出，绝不回落到仓库目录（对应内核里的 B13b/B14）。
# 中文注释：参数名刻意用 PrivateHome 而不是 Home —— $HOME 是 PowerShell 的自动变量，占用它就是 B18 那类错误。
function Resolve-DailyTwinHome {
    [CmdletBinding()]
    param([string]$PrivateHome)

    if (-not [string]::IsNullOrWhiteSpace($PrivateHome)) { return $PrivateHome }
    if (-not [string]::IsNullOrWhiteSpace($env:DAILY_TWIN_HOME)) { return $env:DAILY_TWIN_HOME }

    throw '未配置私有目录。请先运行 Set-DailyTwinPaths.ps1，或设置环境变量 DAILY_TWIN_HOME。'
}

# 中文注释：磁盘剩余空间按卷返回 GB，取不到时返回 $null 而不是 0，避免被当成"磁盘满了"。
# 中文注释：允许空路径 —— 这个函数被遥测采集调用，遥测采集绝不能因为一个取不到的环境变量整体崩掉。
function Get-DailyTwinFreeSpaceGb {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][AllowEmptyString()][AllowNull()][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }

    try {
        $qualifier = Split-Path -Path ([System.IO.Path]::GetFullPath($Path)) -Qualifier
        if ([string]::IsNullOrWhiteSpace($qualifier)) { return $null }
        $disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$qualifier'" -ErrorAction Stop
        if ($null -eq $disk) { return $null }
        $free = Get-DailyTwinProperty -InputObject $disk -Name 'FreeSpace'
        if ($null -eq $free) { return $null }
        return [math]::Round([double]$free / 1GB, 2)
    } catch {
        Write-Verbose "读取磁盘剩余空间失败（$Path）：$($_.Exception.Message)"
        return $null
    }
}
