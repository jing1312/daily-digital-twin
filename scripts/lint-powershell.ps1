#Requires -Version 5.1
<#
.SYNOPSIS
    对 platform/windows 下的 .ps1 做静态检查：先解析，再跑 PSScriptAnalyzer。

.DESCRIPTION
    两段检查的分工不同，缺一不可：
      1. 解析（Parser::ParseFile）——用当前宿主的语法规则判定脚本能不能被读懂。
         在 Windows PowerShell 5.1 上跑这一段，才是 5.1 语法的权威判定。
      2. PSScriptAnalyzer——查自动变量赋值、缺少 ShouldProcess、编码、
         以及 PSUseCompatibleSyntax 报出的 5.1/7.0 语法差异。
         这一段建议在 PowerShell 7 上跑，模块安装更稳。

.PARAMETER Path
    要检查的目录，默认是仓库里的 platform\windows。

.PARAMETER SkipAnalyzer
    只解析，不跑 PSScriptAnalyzer（模块装不上时用）。

.EXAMPLE
    powershell.exe -NoProfile -File scripts\lint-powershell.ps1 -SkipAnalyzer
    pwsh -NoProfile -File scripts/lint-powershell.ps1
#>
[CmdletBinding()]
param(
    [string]$Path,
    [switch]$SkipAnalyzer
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if (-not $Path -or $Path.Trim().Length -eq 0) {
    # 中文注释：分两次 Join-Path，避免把 'platform\windows' 当成字面量在非 Windows 上解析失败。
    $repositoryRoot = Split-Path -Parent $PSScriptRoot
    $Path = Join-Path (Join-Path $repositoryRoot 'platform') 'windows'
}
if (-not (Test-Path -LiteralPath $Path)) {
    throw "找不到脚本目录：$Path"
}

$files = Get-ChildItem -LiteralPath $Path -Filter '*.ps1' -File | Sort-Object Name
if ($files.Count -eq 0) {
    throw "$Path 下没有 .ps1，检查等于空跑"
}

$hadProblem = $false

Write-Output "宿主：PowerShell $($PSVersionTable.PSVersion)"
Write-Output ''
Write-Output '=== 1. 语法解析 ==='
foreach ($file in $files) {
    $parseErrors = $null
    $tokens = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors -and $parseErrors.Count -gt 0) {
        $hadProblem = $true
        Write-Output "解析失败  $($file.Name)"
        foreach ($parseError in $parseErrors) {
            Write-Output ("    第 {0} 行：{1}" -f $parseError.Extent.StartLineNumber, $parseError.Message)
        }
    } else {
        Write-Output "解析通过  $($file.Name)"
    }
}

Write-Output ''
Write-Output '=== 2. 编码检查（5.1 读无 BOM 的 UTF-8 会乱码）==='
foreach ($file in $files) {
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    if (-not $hasBom) {
        $hadProblem = $true
        Write-Output "缺少 BOM  $($file.Name)"
    }
}
if (-not $hadProblem) { Write-Output '全部为 UTF-8 with BOM' }

Write-Output ''
Write-Output '=== 3. PSScriptAnalyzer ==='
if ($SkipAnalyzer) {
    Write-Output '按要求跳过'
} else {
    $module = Get-Module -ListAvailable -Name PSScriptAnalyzer
    if (-not $module) {
        # 中文注释：没装就算失败。静默跳过等于让这层检查在 CI 里悄悄消失。
        # 中文注释：确实不想跑的时候请显式传 -SkipAnalyzer。
        $hadProblem = $true
        Write-Output '未安装 PSScriptAnalyzer。安装方式：Install-Module PSScriptAnalyzer -Scope CurrentUser'
        Write-Output '如果本机确实不打算装，请显式使用 -SkipAnalyzer。'
    } else {
        Import-Module PSScriptAnalyzer -ErrorAction Stop
        $settings = @{
            IncludeRules = @('*')
            Rules        = @{
                PSUseCompatibleSyntax = @{
                    Enable         = $true
                    TargetVersions = @('5.1', '7.0')
                }
            }
        }
        $findings = Invoke-ScriptAnalyzer -Path $Path -Settings $settings -Severity Error, Warning
        if (-not $findings) {
            Write-Output '没有 Error/Warning 级别的问题'
        } else {
            $hadProblem = $true
            $findings | Sort-Object ScriptName, Line | ForEach-Object {
                Write-Output ("{0}:{1} [{2}] {3}" -f $_.ScriptName, $_.Line, $_.RuleName, $_.Message)
            }
        }
    }
}

Write-Output ''
if ($hadProblem) {
    Write-Output '=== 汇总：有问题 ==='
    exit 1
}
Write-Output '=== 汇总：全部通过 ==='
