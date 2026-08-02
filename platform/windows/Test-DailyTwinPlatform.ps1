#Requires -Version 5.1
<#
.SYNOPSIS
    Windows 脚本层的运行时自检。可以在 Windows PowerShell 5.1 和 PowerShell 7 上跑同一份。

.DESCRIPTION
    Node 侧的 test/powershell-hygiene.test.mjs 只做词法检查，证明不了这些脚本
    在真正的 Windows PowerShell 5.1 上跑得起来。这个脚本补上那一段：
      - 控制台编码切到不带 BOM 的 UTF-8（中文回执不再变成 "璇峰湪娴忚鍣"）
      - StrictMode 下的可选属性访问不抛异常
      - 写出的 JSON 一定没有 BOM，否则 Node 的 JSON.parse 会直接失败
      - ConvertFrom-DailyTwinJson 能吃下带 BOM 的输入，且不使用 5.1 没有的 -Depth
      - 私有目录必须显式配置，不存在“退回仓库旁边”的兜底
      - 应用别名匹配大小写不敏感（VS Code 幻觉事件的直接教训）

.EXAMPLE
    powershell.exe -NoProfile -File platform\windows\Test-DailyTwinPlatform.ps1
    pwsh -NoProfile -File platform/windows/Test-DailyTwinPlatform.ps1

.NOTES
    退出码 0 表示全部通过，1 表示有失败项。CI 依赖这个退出码。
#>
[CmdletBinding()]
param()

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

$script:failures = 0
$script:skips = 0

function Write-DailyTwinCheck {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][bool]$Condition,
        [string]$Detail = ''
    )
    if ($Condition) {
        Write-Output "  ok   $Name"
    } else {
        Write-Output "  FAIL $Name  $Detail"
        $script:failures = $script:failures + 1
    }
}

function Write-DailyTwinSkip {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Name, [string]$Reason = '')
    Write-Output "  skip $Name  $Reason"
    $script:skips = $script:skips + 1
}

$onWindows = [System.Environment]::OSVersion.Platform -eq 'Win32NT'
$workRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("daily-twin-selftest-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
$originalHome = $env:DAILY_TWIN_HOME

try {
    Write-Output "宿主：PowerShell $($PSVersionTable.PSVersion)  Windows：$onWindows"
    Write-Output ''

    Write-Output '--- Set-DailyTwinConsoleEncoding ---'
    Write-DailyTwinCheck -Name '控制台输出编码是 utf-8' -Condition ([Console]::OutputEncoding.WebName -eq 'utf-8') -Detail ([Console]::OutputEncoding.WebName)
    Write-DailyTwinCheck -Name 'utf-8 编码不带 BOM 前导字节' -Condition ([Console]::OutputEncoding.GetPreamble().Length -eq 0)

    Write-Output '--- Get-DailyTwinProperty（StrictMode 下的可选属性访问）---'
    $sample = [pscustomobject]@{ id = 'vscode'; aliases = @('VS Code'); empty = $null }
    Write-DailyTwinCheck -Name '存在的属性' -Condition ((Get-DailyTwinProperty -InputObject $sample -Name 'id') -eq 'vscode')
    Write-DailyTwinCheck -Name '缺失的属性返回默认值而不抛异常' -Condition ((Get-DailyTwinProperty -InputObject $sample -Name 'nope' -Default 'fallback') -eq 'fallback')
    Write-DailyTwinCheck -Name '值为 null 的属性返回默认值' -Condition ((Get-DailyTwinProperty -InputObject $sample -Name 'empty' -Default 'fallback') -eq 'fallback')
    Write-DailyTwinCheck -Name '输入本身是 null 时返回默认值' -Condition ((Get-DailyTwinProperty -InputObject $null -Name 'id' -Default 'fallback') -eq 'fallback')
    $hash = @{ id = 'omicos' }
    Write-DailyTwinCheck -Name '哈希表也能取值' -Condition ((Get-DailyTwinProperty -InputObject $hash -Name 'id') -eq 'omicos')
    Write-DailyTwinCheck -Name '哈希表缺键返回默认值' -Condition ((Get-DailyTwinProperty -InputObject $hash -Name 'zzz' -Default 'd') -eq 'd')

    Write-Output '--- Write-DailyTwinJsonFile（Node 的 JSON.parse 不接受 BOM）---'
    $jsonPath = Join-Path $workRoot 'telemetry.json'
    Write-DailyTwinJsonFile -Path $jsonPath -InputObject ([pscustomobject]@{
        writtenAt  = [DateTime]::UtcNow.ToString('o')
        cpuPercent = 12.5
        onAcPower  = $true
        note       = '中文内容'
    })
    $bytes = [System.IO.File]::ReadAllBytes($jsonPath)
    Write-DailyTwinCheck -Name '文件已写出' -Condition ($bytes.Length -gt 0)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    Write-DailyTwinCheck -Name '没有 BOM（关键：有 BOM 时 Node 会抛错）' -Condition (-not $hasBom) -Detail ("前三个字节：" + ($bytes[0..2] -join ','))
    Write-DailyTwinCheck -Name '临时文件已清理（写入是原子替换）' -Condition (-not (Test-Path -LiteralPath "$jsonPath.tmp"))

    Write-Output '--- ConvertFrom-DailyTwinJson（5.1 上没有 -Depth 参数）---'
    $roundTrip = ConvertFrom-DailyTwinJson -Path $jsonPath
    Write-DailyTwinCheck -Name '数值往返一致' -Condition ($roundTrip.cpuPercent -eq 12.5)
    Write-DailyTwinCheck -Name '中文往返一致（编码没有走本地代码页）' -Condition ($roundTrip.note -eq '中文内容')
    Write-DailyTwinCheck -Name '布尔往返一致' -Condition ($roundTrip.onAcPower -eq $true)

    $bomPath = Join-Path $workRoot 'with-bom.json'
    [System.IO.File]::WriteAllText($bomPath, '{"a":1}', (New-Object System.Text.UTF8Encoding($true)))
    Write-DailyTwinCheck -Name '读取侧容忍带 BOM 的输入' -Condition ((ConvertFrom-DailyTwinJson -Path $bomPath).a -eq 1)

    $badPath = Join-Path $workRoot 'bad.json'
    [System.IO.File]::WriteAllText($badPath, '{not json', (New-Object System.Text.UTF8Encoding($false)))
    $threw = $false
    try { ConvertFrom-DailyTwinJson -Path $badPath | Out-Null } catch { $threw = $true }
    Write-DailyTwinCheck -Name '坏 JSON 抛出明确错误' -Condition $threw

    $threw = $false
    try { ConvertFrom-DailyTwinJson -Path (Join-Path $workRoot 'missing.json') | Out-Null } catch { $threw = $true }
    Write-DailyTwinCheck -Name '文件不存在时抛错' -Condition $threw

    Write-Output '--- JSON 深度（ConvertTo-Json 的 -Depth 默认只有 2，写别人的真实配置时会静默截断）---'
    Write-DailyTwinCheck -Name '标量深度是 0' -Condition ((Get-DailyTwinJsonDepth -InputObject 'text') -eq 0)
    Write-DailyTwinCheck -Name 'null 深度是 0' -Condition ((Get-DailyTwinJsonDepth -InputObject $null) -eq 0)
    Write-DailyTwinCheck -Name '平铺对象深度是 1' -Condition ((Get-DailyTwinJsonDepth -InputObject ([pscustomobject]@{ a = 1 })) -eq 1)
    Write-DailyTwinCheck -Name '数组本身算一层' -Condition ((Get-DailyTwinJsonDepth -InputObject ([pscustomobject]@{ a = @(@{ b = 1 }) })) -eq 3)
    Write-DailyTwinCheck -Name '日期是标量不是属性袋' -Condition ((Get-DailyTwinJsonDepth -InputObject ([DateTime]::UtcNow)) -eq 0)

    $deepText = '{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":"keep"}}}}}}}}'
    $deepObject = $deepText | ConvertFrom-Json
    Write-DailyTwinCheck -Name '八层嵌套量出来就是 8' -Condition ((Get-DailyTwinJsonDepth -InputObject $deepObject) -eq 8) -Detail "得到：$(Get-DailyTwinJsonDepth -InputObject $deepObject)"

    # 中文注释：反向对照 —— 用旧的固定 -Depth 6 序列化同一个对象，必须能被截断检测抓到。
    $truncatedText = $deepObject | ConvertTo-Json -Depth 6 -Compress -WarningAction SilentlyContinue
    Write-DailyTwinCheck -Name '固定深度 6 确实会截断（反向对照）' -Condition (Test-DailyTwinJsonTruncated -Text $truncatedText) -Detail $truncatedText
    Write-DailyTwinCheck -Name '正常 JSON 文本不误报截断' -Condition (-not (Test-DailyTwinJsonTruncated -Text '{"p":"D:\\DailyTwin\\workspace","n":[1,2]}'))
    Write-DailyTwinCheck -Name '空文本不误报截断' -Condition (-not (Test-DailyTwinJsonTruncated -Text ''))

    $deepPath = Join-Path $workRoot 'deep.json'
    Write-DailyTwinJsonFile -Path $deepPath -InputObject $deepObject
    $deepBack = ConvertFrom-DailyTwinJson -Path $deepPath
    Write-DailyTwinCheck -Name '八层嵌套写盘再读回来一字不差' -Condition ($deepBack.a.b.c.d.e.f.g.h -eq 'keep') -Detail (Get-Content -Raw -LiteralPath $deepPath)
    Write-DailyTwinCheck -Name '写出的文件里没有截断特征串' -Condition (-not (Test-DailyTwinJsonTruncated -Text (Get-Content -Raw -LiteralPath $deepPath)))
    Write-DailyTwinCheck -Name '调用方要求更大深度时不会被压小' -Condition ((Resolve-DailyTwinJsonDepth -InputObject ([pscustomobject]@{ a = 1 }) -Minimum 20) -eq 20)
    Write-DailyTwinCheck -Name '深度上限是 100' -Condition ((Resolve-DailyTwinJsonDepth -InputObject ([pscustomobject]@{ a = 1 }) -Minimum 500) -eq 100)

    Write-Output '--- Resolve-DailyTwinHome（不允许退回仓库目录）---'
    $homeA = Join-Path $workRoot 'home-a'
    $homeB = Join-Path $workRoot 'home-b'
    $env:DAILY_TWIN_HOME = ''
    $threw = $false
    try { Resolve-DailyTwinHome | Out-Null } catch { $threw = $true }
    Write-DailyTwinCheck -Name '未配置私有目录时抛错而不是兜底' -Condition $threw
    Write-DailyTwinCheck -Name '显式参数优先' -Condition ((Resolve-DailyTwinHome -PrivateHome $homeA) -eq $homeA)
    $env:DAILY_TWIN_HOME = $homeB
    Write-DailyTwinCheck -Name '没有参数时读环境变量' -Condition ((Resolve-DailyTwinHome) -eq $homeB)
    Write-DailyTwinCheck -Name '参数覆盖环境变量' -Condition ((Resolve-DailyTwinHome -PrivateHome $homeA) -eq $homeA)
    $env:DAILY_TWIN_HOME = ''

    Write-Output '--- Get-DailyTwinFreeSpaceGb（拿不到时必须是 null，不能是 0）---'
    $freeSpace = Get-DailyTwinFreeSpaceGb -Path $workRoot
    if ($onWindows) {
        Write-DailyTwinCheck -Name 'Windows 上返回正数' -Condition ($null -ne $freeSpace -and $freeSpace -gt 0) -Detail "得到：$freeSpace"
    } else {
        Write-DailyTwinCheck -Name '非 Windows 上返回 null（不能谎报 0，否则会被当成磁盘已满）' -Condition ($null -eq $freeSpace) -Detail "得到：$freeSpace"
    }
    # 中文注释：Write-DailyTwinTelemetry 会把可能为空的 $env:SystemDrive 传进来，所以空路径不能炸。
    $emptyPathSurvived = $true
    try { $null = Get-DailyTwinFreeSpaceGb -Path '' } catch { $emptyPathSurvived = $false }
    Write-DailyTwinCheck -Name '空路径不抛异常（遥测脚本会传空的 SystemDrive）' -Condition $emptyPathSurvived

    Write-Output '--- Resolve-DailyTwinPwsh ---'
    Write-DailyTwinCheck -Name '不存在的可执行文件返回 null' -Condition ($null -eq (Resolve-DailyTwinPwsh -Preferred 'definitely-not-a-real-exe'))
    $foundPwsh = Resolve-DailyTwinPwsh -Preferred 'pwsh'
    if ($null -ne $foundPwsh) {
        Write-DailyTwinCheck -Name '能在 PATH 上找到 pwsh' -Condition ($true) -Detail $foundPwsh
    } else {
        Write-DailyTwinSkip -Name '能在 PATH 上找到 pwsh' -Reason '本机没装 PowerShell 7，属于环境问题而非脚本缺陷'
    }

    Write-Output '--- 应用目录别名匹配（B8 / B8b，VS Code 幻觉事件的直接教训）---'
    $catalogPath = Join-Path $workRoot 'apps.json'
    $probeExecutable = if ($onWindows) { "$env:SystemRoot\System32\cmd.exe" } else { '/bin/true' }
    Write-DailyTwinJsonFile -Path $catalogPath -InputObject ([pscustomobject]@{
        apps = @(
            [pscustomobject]@{ id = 'vscode'; aliases = @('VS Code', 'Visual Studio Code'); path = $probeExecutable; processName = 'probe' },
            [pscustomobject]@{ id = 'omicos'; path = $probeExecutable }
        )
    })

    # 中文注释：把 Get-DailyTwinAppEntry 从脚本里按 AST 抽出来单独验证，避免真的去启动进程。
    $scriptText = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Start-DailyTwinApp.ps1')
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($scriptText, [ref]$null, [ref]$null)
    $matchedFunctions = $ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-DailyTwinAppEntry'
    }, $true)
    Write-DailyTwinCheck -Name '能在 Start-DailyTwinApp.ps1 里找到 Get-DailyTwinAppEntry' -Condition ($matchedFunctions.Count -eq 1) -Detail "找到 $($matchedFunctions.Count) 个"

    if ($matchedFunctions.Count -eq 1) {
        . ([scriptblock]::Create($matchedFunctions[0].Extent.Text))
        $catalog = ConvertFrom-DailyTwinJson -Path $catalogPath
        Write-DailyTwinCheck -Name 'id 精确匹配' -Condition ((Get-DailyTwinAppEntry -Catalog $catalog -Name 'vscode' -Source $catalogPath).id -eq 'vscode')
        Write-DailyTwinCheck -Name '别名匹配忽略大小写（"vs code" 对上 "VS Code"）' -Condition ((Get-DailyTwinAppEntry -Catalog $catalog -Name 'vs code').id -eq 'vscode')
        Write-DailyTwinCheck -Name '别名匹配忽略首尾空格' -Condition ((Get-DailyTwinAppEntry -Catalog $catalog -Name '  VS Code  ').id -eq 'vscode')
        Write-DailyTwinCheck -Name '没有 aliases 字段的条目仍可按 id 命中' -Condition ((Get-DailyTwinAppEntry -Catalog $catalog -Name 'omicos').id -eq 'omicos')

        $threw = $false
        try { Get-DailyTwinAppEntry -Catalog $catalog -Name 'chrome' | Out-Null } catch { $threw = $true }
        Write-DailyTwinCheck -Name '未登记的应用直接拒绝（不许瞎猜路径）' -Condition $threw

        $threw = $false
        try { Get-DailyTwinAppEntry -Catalog ([pscustomobject]@{ notApps = @() }) -Name 'vscode' -Source $catalogPath | Out-Null } catch { $threw = $true }
        Write-DailyTwinCheck -Name '目录缺少 apps 字段时报明确错误' -Condition $threw

        $duplicateCatalog = [pscustomobject]@{
            apps = @(
                [pscustomobject]@{ id = 'a'; aliases = @('shared') },
                [pscustomobject]@{ id = 'b'; aliases = @('shared') }
            )
        }
        $threw = $false
        try { Get-DailyTwinAppEntry -Catalog $duplicateCatalog -Name 'shared' | Out-Null } catch { $threw = $true }
        Write-DailyTwinCheck -Name '别名重复时抛错而不是随便选一个' -Condition $threw
    }
} finally {
    $env:DAILY_TWIN_HOME = $originalHome
    Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output ''
if ($script:skips -gt 0) { Write-Output "跳过 $($script:skips) 项（环境原因）" }
if ($script:failures -gt 0) {
    Write-Output "失败 $($script:failures) 项"
    exit 1
}
Write-Output 'Windows 脚本层自检全部通过'
