#Requires -Version 5.1
<#
.SYNOPSIS
    采集 CPU 占用、供电状态、可用内存和磁盘剩余，写入 <home>\data\telemetry.json。

.DESCRIPTION
    src/core/telemetry.mjs 会读这个文件。为什么必须有它：
    Node 的 os.cpus() 在部分环境里返回全零的时间片，拿不到 CPU 占用；
    而资源策略是 fail-closed 的 —— 遥测缺失就把槽位归零、不接新动作。
    没有这个文件，替身可能永远无法开始工作，而且看不出原因。

    实现上刻意避开 Get-Counter 作为首选：性能计数器名在中文 Windows 上是本地化的，
    '\Processor(_Total)\% Processor Time' 会直接找不到。CIM 的类名和属性名不本地化。

.EXAMPLE
    .\Write-DailyTwinTelemetry.ps1 -PrivateHome 'D:\DailyTwin\home'

.EXAMPLE
    # 每分钟写一次，配合计划任务常驻
    .\Write-DailyTwinTelemetry.ps1 -Loop -IntervalSeconds 60
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$PrivateHome,
    [switch]$Loop,
    [int]$IntervalSeconds = 60
)

. "$PSScriptRoot\DailyTwin.Common.ps1"
Set-DailyTwinConsoleEncoding

$resolvedHome = Resolve-DailyTwinHome -PrivateHome $PrivateHome
$telemetryPath = Join-Path $resolvedHome 'data\telemetry.json'

# 中文注释：CPU 占用。首选 Win32_PerfFormattedData_PerfOS_Processor（CIM 属性名不本地化），
# 中文注释：失败再退回 Win32_Processor.LoadPercentage。全程不用 Get-Counter：见文件头说明。
function Get-DailyTwinCpuPercent {
    [CmdletBinding()]
    param()

    try {
        $processor = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor `
            -Filter "Name='_Total'" -ErrorAction Stop
        $value = Get-DailyTwinProperty -InputObject $processor -Name 'PercentProcessorTime'
        if ($null -ne $value) {
            return [pscustomobject]@{ cpuPercent = [math]::Round([double]$value, 2); source = 'cim_perf' }
        }
    } catch {
        Write-Verbose "CIM 性能计数器不可用：$($_.Exception.Message)"
    }

    try {
        $load = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop |
            Measure-Object -Property LoadPercentage -Average
        if ($null -ne $load -and $null -ne $load.Average) {
            return [pscustomobject]@{ cpuPercent = [math]::Round([double]$load.Average, 2); source = 'cim_loadpercentage' }
        }
    } catch {
        Write-Verbose "Win32_Processor.LoadPercentage 不可用：$($_.Exception.Message)"
    }

    return [pscustomobject]@{ cpuPercent = $null; source = 'unavailable' }
}

# 中文注释：供电状态。取不到时返回 $null，绝不猜"已接电" —— 猜错会让替身在电池上满负荷跑。
function Get-DailyTwinPowerState {
    [CmdletBinding()]
    param()

    try {
        $batteries = @(Get-CimInstance -ClassName Win32_Battery -ErrorAction Stop)
        if ($batteries.Count -eq 0) {
            # 中文注释：没有电池对象通常是台式机，可以安全地认为一直接电。
            return [pscustomobject]@{ onAcPower = $true; source = 'no_battery'; batteryPercent = $null }
        }

        $battery = $batteries[0]
        $status = Get-DailyTwinProperty -InputObject $battery -Name 'BatteryStatus'
        $percent = Get-DailyTwinProperty -InputObject $battery -Name 'EstimatedChargeRemaining'

        if ($null -eq $status) {
            return [pscustomobject]@{ onAcPower = $null; source = 'missing_battery_status'; batteryPercent = $percent }
        }

        # 中文注释：BatteryStatus 取值：1 = 放电（未接电），2 = 交流电，6/7/8/9 = 充电中（也算接电）。
        $acCodes = @(2, 6, 7, 8, 9)
        return [pscustomobject]@{
            onAcPower      = ($acCodes -contains [int]$status)
            source         = 'win32_battery'
            batteryStatus  = [int]$status
            batteryPercent = $percent
        }
    } catch {
        Write-Verbose "Win32_Battery 读取失败：$($_.Exception.Message)"
        return [pscustomobject]@{ onAcPower = $null; source = 'unavailable'; batteryPercent = $null }
    }
}

function Get-DailyTwinAvailableMemoryGb {
    [CmdletBinding()]
    param()

    try {
        $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        $freeKb = Get-DailyTwinProperty -InputObject $operatingSystem -Name 'FreePhysicalMemory'
        if ($null -eq $freeKb) { return $null }
        return [math]::Round([double]$freeKb / 1MB, 2)
    } catch {
        Write-Verbose "Win32_OperatingSystem 读取失败：$($_.Exception.Message)"
        return $null
    }
}

function Write-DailyTwinTelemetrySample {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$HomeDirectory
    )

    if (-not $PSCmdlet.ShouldProcess($Path, '采样并写入遥测')) { return $null }

    $cpu = Get-DailyTwinCpuPercent
    $power = Get-DailyTwinPowerState

    $reading = [pscustomobject]@{
        writtenAt           = [DateTime]::UtcNow.ToString('o')
        cpuPercent          = $cpu.cpuPercent
        onAcPower           = $power.onAcPower
        availableMemoryGb   = (Get-DailyTwinAvailableMemoryGb)
        homeVolumeFreeGb    = (Get-DailyTwinFreeSpaceGb -Path $HomeDirectory)
        systemVolumeFreeGb  = (Get-DailyTwinFreeSpaceGb -Path $env:SystemDrive)
        sources             = [pscustomobject]@{ cpu = $cpu.source; power = $power.source }
        batteryPercent      = (Get-DailyTwinProperty -InputObject $power -Name 'batteryPercent')
        writerVersion       = 1
    }

    # 中文注释：必须写无 BOM 的 UTF-8。Node 的 JSON.parse 遇到 BOM 会整体抛错，
    # 中文注释：那会让遥测永久失效，进而让调度器永久停摆 —— 一个不可见字符停掉整台替身。
    Write-DailyTwinJsonFile -Path $Path -InputObject $reading -Depth 4
    return $reading
}

if ($Loop) {
    if ($IntervalSeconds -lt 5) { throw '-IntervalSeconds 不得小于 5 秒' }
    Write-Output "开始持续写入遥测：$telemetryPath（每 $IntervalSeconds 秒，Ctrl+C 停止）"
    while ($true) {
        try {
            $sample = Write-DailyTwinTelemetrySample -Path $telemetryPath -HomeDirectory $resolvedHome
            Write-Verbose "cpu=$($sample.cpuPercent) ac=$($sample.onAcPower)"
        } catch {
            Write-Warning "本轮遥测写入失败，将在下一轮重试：$($_.Exception.Message)"
        }
        Start-Sleep -Seconds $IntervalSeconds
    }
}

$result = Write-DailyTwinTelemetrySample -Path $telemetryPath -HomeDirectory $resolvedHome
Write-DailyTwinResult -InputObject ([pscustomobject]@{
    status        = 'ok'
    telemetryFile = $telemetryPath
    reading       = $result
})
