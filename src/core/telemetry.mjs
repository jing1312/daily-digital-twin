import { readFile } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { join } from 'node:path';
import { cpus, freemem } from 'node:os';

// 中文注释：遥测采集。内存和磁盘 Node 自己能算；CPU 在部分容器/虚拟化环境里 os.cpus() 全为 0，
// 中文注释：电源状态（是否接电）核心 Node 根本拿不到。这两项都允许由外部文件或环境变量提供，
// 中文注释：来源见 platform/windows/Write-DailyTwinTelemetry.ps1。
// 中文注释：任何一项缺失都会让资源策略失败关闭（见 B6）—— 这是刻意的，但必须留下可诊断的出口，
// 中文注释：否则采集不到 CPU 的机器会永久无法调度。

export const TELEMETRY_FILE = 'data/telemetry.json';
const BYTES_PER_GB = 1024 ** 3;

function cpuTotals() {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    for (const [mode, value] of Object.entries(cpu.times)) {
      total += value;
      if (mode === 'idle') idle += value;
    }
  }
  return { idle, total };
}

// 中文注释：两次采样求差，避免用开机以来的累计值算出恒定的 CPU 占用。
// 中文注释：返回 null 表示本机采样器不可用（容器里 times 恒为 0），交给上层用外部数据兜底。
export async function sampleCpuPercent(sampleMs = 200) {
  const first = cpuTotals();
  await new Promise((resolve) => setTimeout(resolve, Math.max(20, sampleMs)));
  const second = cpuTotals();
  const totalDelta = second.total - first.total;
  const idleDelta = second.idle - first.idle;
  if (!Number.isFinite(totalDelta) || totalDelta <= 0) return null;
  const percent = 100 * (1 - idleDelta / totalDelta);
  if (!Number.isFinite(percent)) return null;
  return Number(Math.min(100, Math.max(0, percent)).toFixed(2));
}

export function diskFreeGb(path) {
  try {
    const stats = statfsSync(path);
    const free = (Number(stats.bavail) * Number(stats.bsize)) / BYTES_PER_GB;
    if (!Number.isFinite(free) || free < 0) return null;
    return Number(free.toFixed(2));
  } catch {
    return null;
  }
}

// 中文注释：Windows 上私有目录在 D:，但 OpenClaw 的临时日志写在 C:\WINDOWS\TEMP。
// 中文注释：所以磁盘余量必须取"私有目录所在卷"和"系统卷"的较小值，否则 C: 撑满了也照样接任务。
export function systemDiskFreeGb() {
  const systemDrive = process.env.SystemDrive;
  if (!systemDrive) return null;
  return diskFreeGb(systemDrive.endsWith('\\') ? systemDrive : `${systemDrive}\\`);
}

function parseNumericEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// 中文注释：读取外部写入的遥测文件。过期一律视为未知，绝不猜"已接电"。
export async function readTelemetryFile(home, { maxAgeSeconds = 300 } = {}) {
  try {
    const raw = await readFile(join(home, TELEMETRY_FILE), 'utf8');
    // 中文注释：PowerShell 5.1 的 Out-File -Encoding utf8 和记事本都会写 BOM，JSON.parse 会因此直接抛错。
    // 中文注释：写入侧已改成无 BOM，这里再兜一层，避免遥测因为一个不可见字符整体失效导致调度器永久停摆。
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    // 中文注释：文件内容必须是对象。写成数组、数字或 null 时一律视为无效，而不是继续往下猜。
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'not_an_object' };
    }
    const writtenAt = Date.parse(parsed.writtenAt ?? '');
    if (!Number.isFinite(writtenAt)) return { ok: false, reason: 'missing_written_at' };
    const ageSeconds = Math.round((Date.now() - writtenAt) / 1000);
    if (ageSeconds > maxAgeSeconds) return { ok: false, reason: `stale_${ageSeconds}s`, ageSeconds };
    return { ok: true, ageSeconds, data: parsed };
  } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? 'file_missing' : String(error?.message ?? error) };
  }
}

// 中文注释：电源状态优先级：环境变量 > 新鲜的遥测文件 > 未知。
function resolvePower(file) {
  if (process.env.DAILY_TWIN_ON_AC_POWER === '1') return { onAcPower: true, source: 'env' };
  if (process.env.DAILY_TWIN_ON_AC_POWER === '0') return { onAcPower: false, source: 'env' };
  // 中文注释：source 表示"值真的来自哪里"。没取到值就必须是 unavailable，
  // 中文注释：否则 doctor 会同时打印 source=file 和 reason=file_missing，自相矛盾。
  if (!file.ok) return { onAcPower: null, source: 'unavailable', reason: file.reason };
  if (typeof file.data.onAcPower !== 'boolean') {
    return { onAcPower: null, source: 'unavailable', reason: 'missing_on_ac_power' };
  }
  return { onAcPower: file.data.onAcPower, source: 'file', ageSeconds: file.ageSeconds };
}

// 中文注释：严格取数。绝不能用 Number(x) 直接判断 —— Number(null)、Number('')、Number([])、Number(false)
// 中文注释：全都等于 0，而 0 会被当成"CPU 占用 0%，机器完全空闲，放开跑"。
// 中文注释：这是实测踩到的坑：PowerShell 在取不到 CIM 时写出 cpuPercent: null，
// 中文注释：旧写法把它读成 0%，本该失败关闭的场景反而变成完全放行。
export function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// 中文注释：CPU 优先级：显式环境变量 > 新鲜的遥测文件 > 本机采样 > 未知。
// 中文注释：文件存在但字段无效时不回退到本机采样，避免把失败关闭误报成有效读数。
function resolveCpu(localSample, file) {
  const fromEnv = parseNumericEnv('DAILY_TWIN_CPU_PERCENT');
  if (fromEnv !== null) return { cpuPercent: Number(fromEnv.toFixed(2)), source: 'env' };
  if (file.ok) {
    const fromFile = toFiniteNumber(file.data?.cpuPercent);
    if (fromFile !== null) {
      return { cpuPercent: Number(fromFile.toFixed(2)), source: 'file', ageSeconds: file.ageSeconds };
    }
    return { cpuPercent: null, source: 'unavailable', reason: 'missing_cpu_percent' };
  }
  if (Number.isFinite(localSample)) return { cpuPercent: localSample, source: 'local' };
  return { cpuPercent: null, source: 'unavailable', reason: 'os_cpus_times_flat' };
}

// 中文注释：汇总一份遥测读数。缺失字段直接不写入 reading，交给 decideResourcePolicy 判定并失败关闭。
export async function collectTelemetry(home, { sampleMs = 200, maxAgeSeconds = 300 } = {}) {
  const file = await readTelemetryFile(home, { maxAgeSeconds });
  const localSample = await sampleCpuPercent(sampleMs);
  const cpu = resolveCpu(localSample, file);
  const power = resolvePower(file);

  const reading = {};
  if (Number.isFinite(cpu.cpuPercent)) reading.cpuPercent = cpu.cpuPercent;
  const memoryGb = Number((freemem() / BYTES_PER_GB).toFixed(2));
  if (Number.isFinite(memoryGb)) reading.availableMemoryGb = memoryGb;

  const homeDisk = diskFreeGb(home);
  const systemDisk = systemDiskFreeGb();
  const diskCandidates = [homeDisk, systemDisk].filter((value) => Number.isFinite(value));
  if (diskCandidates.length > 0) reading.diskFreeGb = Math.min(...diskCandidates);
  if (typeof power.onAcPower === 'boolean') reading.onAcPower = power.onAcPower;

  return {
    reading,
    sources: { cpu: cpu.source, power: power.source },
    cpuReason: cpu.reason ?? null,
    powerReason: power.reason ?? null,
    disk: { homeVolumeFreeGb: homeDisk, systemVolumeFreeGb: systemDisk },
    telemetryFile: { fresh: file.ok, reason: file.ok ? null : file.reason, ageSeconds: file.ageSeconds ?? null }
  };
}

export const TELEMETRY_HINT = [
  'CPU 占用与电源状态可能需要 Windows 侧提供，请任选其一：',
  '  1) 定期运行 platform/windows/Write-DailyTwinTelemetry.ps1（推荐，写入 data/telemetry.json）',
  '  2) 临时设置环境变量：DAILY_TWIN_ON_AC_POWER=1（接电）或 0（电池）、DAILY_TWIN_CPU_PERCENT=30',
  '注意：遥测缺失时调度器会失败关闭、不接新任务，这是刻意设计，不是故障。'
].join('\n');
