#Requires -Version 5.1
<#
.SYNOPSIS
    把 openclaw.json 切到路线 C（受管隔离浏览器），并解开挡住 browser 工具的两道闸。

.DESCRIPTION
    本机实测到的现象是"让替身用 Edge 一直没成功"。根因有三条，见 docs/BROWSER-PROFILES.md：

      1. tools.profile = "coding" 把 browser 工具过滤掉了（它属于 group:ui）。
         解法是补 tools.alsoAllow = ["browser"]。注意 allow 与 alsoAllow 在同一作用域内
         不能共存：allow 是替换，alsoAllow 是追加，而 profile 过滤发生在更早一步。
      2. plugins.allow 在工具策略之前就决定了插件加载。留空等同默认（当前没问题），
         但一旦写了白名单就必须把 browser 列进去。
      3. 内置 chrome profile 按定义驱动的就是 Chrome，不是 Edge —— 这才是真正的根因。
         所以本脚本不去折腾 Edge，直接采用受管隔离浏览器。

    默认只做诊断和预览（不落盘）。要真正改写 openclaw.json 必须显式加 -Apply，
    而且 -Apply 一定会先生成时间戳 .bak，并在结束时打印一行回滚命令。

    这个脚本只改 openclaw.json，不碰 openclaw.sqlite，也不碰 sessions 下的会话文件。
    如果要连数据一起备份，先跑 Backup-DailyTwinState.ps1。

.EXAMPLE
    .\Set-OpenClawBrowserProfile.ps1 -ConfigPath 'D:\Path\To\openclaw.json'
.EXAMPLE
    .\Set-OpenClawBrowserProfile.ps1 -ConfigPath 'D:\Path\To\openclaw.json' -Apply
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # 中文注释：openclaw.json 的完整路径。
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    # 中文注释：全局默认快照模式，写进 browser.snapshotDefaults.mode。
    # 中文注释：这个键只接受 'efficient' —— 真机 CLI 的 --mode 也只有 <efficient> 这一个值。
    # 中文注释：full / aria 不是"模式"，是调用时的格式选择（--format ai / --format aria），
    # 中文注释：属于每次调用的决定，不该写进全局默认里。曾经这里允许过 full，
    # 中文注释：那会把一个 OpenClaw 不认的值写进她真实的 openclaw.json。
    [ValidateSet('efficient')]
    [string]$SnapshotMode = 'efficient',

    # 中文注释：默认只预览。没有这个开关就绝不写文件。
    [switch]$Apply
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "找不到 openclaw.json：$ConfigPath"
}

# 中文注释：ConvertFrom-DailyTwinJson 会先剥掉 BOM，并且不使用 -Depth（5.1 的 ConvertFrom-Json 没有这个参数）。
$config = ConvertFrom-DailyTwinJson -Path $ConfigPath
if ($null -eq $config) {
    throw "openclaw.json 解析结果为空，可能不是合法 JSON：$ConfigPath"
}

$changes = @()
$blockers = @()

function Add-DailyTwinChange {
    param([string]$Path, [string]$From, [string]$To, [string]$Why)
    $script:changes += [pscustomobject]@{ path = $Path; from = $From; to = $To; why = $Why }
}

# ---- 1. tools.alsoAllow 必须包含 browser ----
$tools = Get-DailyTwinProperty -InputObject $config -Name 'tools'
if ($null -eq $tools) {
    $tools = [pscustomobject]@{}
    Add-Member -InputObject $config -NotePropertyName 'tools' -NotePropertyValue $tools -Force
    Add-DailyTwinChange -Path 'tools' -From '(不存在)' -To '{}' -Why '需要承载 alsoAllow'
}

$existingAllow = Get-DailyTwinProperty -InputObject $tools -Name 'allow'
if ($null -ne $existingAllow) {
    # 中文注释：allow 是"替换"语义，与 alsoAllow 的"追加"语义在同一作用域内互斥。
    # 中文注释：这种情况不能自动改 —— 删掉 allow 可能顺手关掉别的工具，只能由人决定。
    $blockers += [pscustomobject]@{
        code       = 'allow_and_alsoallow_conflict'
        detail     = "tools.allow 已存在（$(($existingAllow | ForEach-Object { $_ }) -join ', ')），它与 tools.alsoAllow 不能共存。"
        suggestion = '要么把 browser 直接加进 tools.allow，要么删掉 allow 改用 alsoAllow。这一步必须你自己决定，脚本不代劳。'
    }
} else {
    $alsoAllow = @(Get-DailyTwinProperty -InputObject $tools -Name 'alsoAllow' -Default @())
    if ($alsoAllow -contains 'browser') {
        Write-Output 'tools.alsoAllow 已包含 browser，无需改动。'
    } else {
        $updatedAlsoAllow = @($alsoAllow) + 'browser'
        Add-Member -InputObject $tools -NotePropertyName 'alsoAllow' -NotePropertyValue $updatedAlsoAllow -Force
        Add-DailyTwinChange -Path 'tools.alsoAllow' -From (($alsoAllow -join ', '), '(空)' | Where-Object { $_ } | Select-Object -First 1) `
            -To ($updatedAlsoAllow -join ', ') `
            -Why 'tools.profile = coding 会过滤掉 group:ui 里的 browser 工具'
    }
}

# ---- 2. plugins.allow 若已是白名单，必须含 browser ----
$plugins = Get-DailyTwinProperty -InputObject $config -Name 'plugins'
if ($null -ne $plugins) {
    $pluginAllow = Get-DailyTwinProperty -InputObject $plugins -Name 'allow'
    if ($null -ne $pluginAllow -and @($pluginAllow).Count -gt 0 -and @($pluginAllow) -notcontains 'browser') {
        $blockers += [pscustomobject]@{
            code       = 'plugin_allowlist_excludes_browser'
            detail     = "plugins.allow 是一份非空白名单，但不含 browser：$(@($pluginAllow) -join ', ')"
            suggestion = 'plugins.allow 在工具策略之前就决定插件加不加载。请把 browser 加进这份白名单，或整体删掉它退回默认。'
        }
    }
}

# ---- 3. 根级 browser 配置块（同时也会激活自带的 browser 插件）----
$browser = Get-DailyTwinProperty -InputObject $config -Name 'browser'
if ($null -eq $browser) {
    $browser = [pscustomobject]@{}
    Add-Member -InputObject $config -NotePropertyName 'browser' -NotePropertyValue $browser -Force
    Add-DailyTwinChange -Path 'browser' -From '(不存在)' -To '{}' -Why '显式的根级 browser 配置块会激活自带的 browser 插件'
}

$currentProfile = Get-DailyTwinProperty -InputObject $browser -Name 'defaultProfile' -Default '(未设置)'
if ($currentProfile -ne 'openclaw') {
    Add-Member -InputObject $browser -NotePropertyName 'defaultProfile' -NotePropertyValue 'openclaw' -Force
    Add-DailyTwinChange -Path 'browser.defaultProfile' -From $currentProfile -To 'openclaw' `
        -Why '路线 C：受管隔离浏览器，文档完整覆盖且真正支持无人值守'
}

$snapshotDefaults = Get-DailyTwinProperty -InputObject $browser -Name 'snapshotDefaults'
if ($null -eq $snapshotDefaults) {
    $snapshotDefaults = [pscustomobject]@{}
    Add-Member -InputObject $browser -NotePropertyName 'snapshotDefaults' -NotePropertyValue $snapshotDefaults -Force
}
$currentSnapshot = Get-DailyTwinProperty -InputObject $snapshotDefaults -Name 'mode' -Default '(未设置)'
if ($currentSnapshot -ne $SnapshotMode) {
    Add-Member -InputObject $snapshotDefaults -NotePropertyName 'mode' -NotePropertyValue $SnapshotMode -Force
    Add-DailyTwinChange -Path 'browser.snapshotDefaults.mode' -From $currentSnapshot -To $SnapshotMode `
        -Why '精简快照能明显压低每次页面操作的 token 消耗'
}

# 中文注释：这里曾经写过一个顶层 browser.userDataDir，那是错的 —— OpenClaw 根本不读它。
# 中文注释：文档里 userDataDir 只存在于 browser.profiles.<name>.userDataDir，而且是给
# 中文注释：existing-session 驱动用的（让它去附着一个非默认的 Chromium 用户目录）；
# 中文注释：受管浏览器"仍然使用它自己的用户数据目录"，位置是固定的，配置改不了。
# 中文注释：写一个不被读取的键，等于在回执里承诺一件不会发生的事，所以整段删掉。
# 中文注释：如果旧版脚本已经写入这个键，新版必须迁移掉，不能带着已知污染返回 already_ok。
$legacyUserDataProperty = $browser.PSObject.Properties['userDataDir']
if ($null -ne $legacyUserDataProperty) {
    $browser.PSObject.Properties.Remove('userDataDir')
    Add-DailyTwinChange -Path 'browser.userDataDir' -From '(已设置，值不回显)' -To '(删除)' `
        -Why 'OpenClaw 不读取这个顶层键；清理旧版脚本留下的无效配置'
}
#
# 中文注释：改成如实报告登录态真正落在哪儿 —— 这是备份策略和磁盘策略真正要盯的路径。
$managedUserDataDir = $null
if (-not [string]::IsNullOrWhiteSpace($env:OPENCLAW_HOME)) {
    $managedUserDataDir = Join-Path $env:OPENCLAW_HOME '.openclaw\browser\openclaw\user-data'
}

# ---- 输出与落盘 ----
foreach ($blocker in $blockers) {
    Write-Warning "[$($blocker.code)] $($blocker.detail)"
    Write-Warning "  处理建议：$($blocker.suggestion)"
}

if ($changes.Count -eq 0) {
    Write-Output '配置已经符合路线 C，没有需要改动的地方。'
} else {
    Write-Output '将要做的改动：'
    foreach ($change in $changes) {
        Write-Output "  $($change.path)：$($change.from) -> $($change.to)"
        Write-Output "      理由：$($change.why)"
    }
}

# 中文注释：$backupPath / $applied 只有在真的落了盘之后才会被赋值。
# 中文注释：-WhatIf 或者交互确认时选了「否」，ShouldProcess 返回 $false，这里什么都不会发生，
# 中文注释：回执就必须如实说「什么都没做」——不能给出一个指向不存在文件的 rollbackCommand。
$backupPath = $null
$applied = $false
if ($Apply -and $changes.Count -gt 0) {
    if ($blockers.Count -gt 0) {
        throw '存在需要你自己决定的冲突项（见上面的 Warning），已中止，未改动任何文件。'
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $plannedBackupPath = "$ConfigPath.$stamp.bak"
    if ($PSCmdlet.ShouldProcess($ConfigPath, "备份到 $plannedBackupPath 后写入新配置")) {
        # 中文注释：先备份再写。备份用 Copy-Item，源文件保持原样。
        Copy-Item -LiteralPath $ConfigPath -Destination $plannedBackupPath -ErrorAction Stop
        if (-not (Test-Path -LiteralPath $plannedBackupPath -PathType Leaf)) {
            throw "备份没有生成，已放弃写入：$plannedBackupPath"
        }
        # 中文注释：确认备份实体存在之后才对外承认它，回执里的路径必然是真实存在的文件。
        $backupPath = $plannedBackupPath
        # 中文注释：Write-DailyTwinJsonFile 走 .tmp + Move-Item，写无 BOM 的 UTF-8，
        # 中文注释：并且会按对象实际嵌套深度给 ConvertTo-Json -Depth（默认 6 层不够时会截断成 "@{...}"）。
        # 中文注释：openclaw.json 由 Node 侧读取，带 BOM 会让部分 JSON 解析器报错。
        $topLevelBefore = @($config.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
        Write-DailyTwinJsonFile -Path $ConfigPath -InputObject $config

        # 中文注释：写完立刻读回来逐项确认，任何一项不对就地回滚 —— 绝不留下一个坏掉的配置。
        $verify = $null
        try { $verify = ConvertFrom-DailyTwinJson -Path $ConfigPath } catch { $verify = $null }
        $verifyFailure = $null
        if ($null -eq $verify) {
            $verifyFailure = '写回去的文件已经不是合法 JSON'
        } else {
            $topLevelAfter = @($verify.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
            $lostKeys = @($topLevelBefore | Where-Object { $topLevelAfter -notcontains $_ })
            $verifyTools = Get-DailyTwinProperty -InputObject $verify -Name 'tools'
            $verifyAlsoAllow = @(Get-DailyTwinProperty -InputObject $verifyTools -Name 'alsoAllow' -Default @())
            $verifyBrowser = Get-DailyTwinProperty -InputObject $verify -Name 'browser'
            $verifyProfile = Get-DailyTwinProperty -InputObject $verifyBrowser -Name 'defaultProfile'
            $verifyLegacyUserDataProperty = $verifyBrowser.PSObject.Properties['userDataDir']
            $rawWritten = [System.IO.File]::ReadAllText($ConfigPath, (New-Object System.Text.UTF8Encoding($false)))

            if ($lostKeys.Count -gt 0) {
                $verifyFailure = "顶层键丢了：$($lostKeys -join ', ')"
            } elseif (Test-DailyTwinJsonTruncated -Text $rawWritten) {
                $verifyFailure = '文件里出现了 JSON 截断特征串（嵌套层数被 ConvertTo-Json 截掉了）'
            } elseif ($verifyAlsoAllow -notcontains 'browser') {
                $verifyFailure = 'tools.alsoAllow 里没有 browser'
            } elseif ($verifyProfile -ne 'openclaw') {
                $verifyFailure = "browser.defaultProfile 不是 openclaw（实际是 $verifyProfile）"
            } elseif ($null -ne $legacyUserDataProperty -and $null -ne $verifyLegacyUserDataProperty) {
                $verifyFailure = '旧版顶层 browser.userDataDir 没有被删除'
            }
        }

        if ($null -ne $verifyFailure) {
            Copy-Item -LiteralPath $backupPath -Destination $ConfigPath -Force
            throw "写入后的校验失败（$verifyFailure），已用备份还原原文件。备份仍保留：$backupPath"
        }
        # 中文注释：走到这里才算「写了并且校验过」，applied 这个词才配用。
        $applied = $true
    }
} elseif ($changes.Count -gt 0) {
    Write-Output ''
    Write-Output '以上只是预览，没有写任何文件。确认无误后加 -Apply 真正执行。'
}

Write-DailyTwinResult -InputObject ([pscustomobject]@{
    # 中文注释：applied 只在 $applied 为真时出现。加了 -Apply 但被 -WhatIf / 确认框拦下来的，
    # 中文注释：结果和预览完全一样（没有落盘），所以就如实报 preview。
    status         = if ($blockers.Count -gt 0) { 'blocked' } elseif ($changes.Count -eq 0) { 'already_ok' } elseif ($applied) { 'applied' } else { 'preview' }
    configPath     = $ConfigPath
    route          = 'C: 受管隔离浏览器（browser.defaultProfile = openclaw）'
    changes        = $changes
    blockers       = $blockers
    backupPath     = $backupPath
    rollbackCommand = if ($backupPath) { "Copy-Item -LiteralPath '$backupPath' -Destination '$ConfigPath' -Force" } else { $null }
    # 中文注释：只报告，不设置 —— 这个位置由 OpenClaw 固定，配置改不了。
    # 中文注释：$null 表示没设 OPENCLAW_HOME，此时由 OpenClaw 自行决定，本脚本不猜。
    managedUserDataDir = $managedUserDataDir
    nextSteps      = @(
        '重启 OpenClaw 网关，让新配置生效。',
        'openclaw browser status —— 确认 browser 工具这次真的可用。',
        '在受管浏览器里把常用站点逐个登录一次（这是路线 C 唯一的一次性代价）。',
        '登录态落在 managedUserDataDir 那个目录里，位置固定、改不了；备份和磁盘策略盯这个路径。',
        '把登录过的域名写进替身私有目录 config/runtime.json 的 browser.managedLoggedInHosts。'
    )
})
