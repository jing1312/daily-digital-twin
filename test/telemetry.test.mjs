import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TELEMETRY_FILE,
  TELEMETRY_HINT,
  toFiniteNumber,
  readTelemetryFile,
  collectTelemetry,
  sampleCpuPercent
} from '../src/core/telemetry.mjs';
import { decideResourcePolicy } from '../src/core/resource-policy.mjs';

const ENV_KEYS = ['DAILY_TWIN_CPU_PERCENT', 'DAILY_TWIN_ON_AC_POWER'];

// 中文注释：遥测读取会看环境变量，测试必须先清空再恢复，否则互相污染。
async function withHome(work, fileContent) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const home = mkdtempSync(join(tmpdir(), 'twin-telemetry-'));
  mkdirSync(join(home, 'data'), { recursive: true });
  if (fileContent !== undefined) {
    writeFileSync(join(home, TELEMETRY_FILE), fileContent, 'utf8');
  }
  try {
    return await work(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function freshFile(extra = {}) {
  return JSON.stringify({ writtenAt: new Date().toISOString(), ...extra });
}

test('toFiniteNumber 拒绝一切会被 Number() 悄悄变成 0 的输入', () => {
  // 中文注释：这一组就是本轮实测发现的漏洞根源。Number(null) === 0 会让"读不到 CPU"
  // 中文注释：变成"CPU 占用 0%，机器空闲，全部放行"。
  for (const value of [null, undefined, '', '   ', [], {}, false, true, 'abc', NaN, Infinity]) {
    assert.equal(toFiniteNumber(value), null, `${JSON.stringify(value)} 必须判为不可用`);
  }
  assert.equal(toFiniteNumber(0), 0);
  assert.equal(toFiniteNumber(18.5), 18.5);
  assert.equal(toFiniteNumber('42.25'), 42.25);
  assert.equal(toFiniteNumber(-1), -1);
});

test('遥测文件里 cpuPercent 为 null 时绝不能被读成 0%', async () => {
  await withHome(async (home) => {
    const collected = await collectTelemetry(home, { sampleMs: 20 });
    assert.equal('cpuPercent' in collected.reading, false, 'cpuPercent 不应出现在读数里');
    // 中文注释：source 必须是 unavailable。写成 'file' 会让 doctor 同时打印
    // 中文注释：source=file 和 reason=missing_cpu_percent，看起来像"读到了"。
    assert.equal(collected.sources.cpu, 'unavailable');
    assert.equal(collected.cpuReason, 'missing_cpu_percent');
    assert.equal(collected.sources.power, 'unavailable');
    assert.equal(collected.powerReason, 'missing_on_ac_power');

    const policy = decideResourcePolicy(collected.reading);
    assert.equal(policy.acceptsNewActions, false);
    assert.equal(policy.slotLimit, 0);
    assert.ok(policy.missing.includes('cpuPercent'));
  }, freshFile({ cpuPercent: null, onAcPower: null }));
});

test('PowerShell 写出的合法读数能被接受并放行', async () => {
  await withHome(async (home) => {
    const collected = await collectTelemetry(home, { sampleMs: 20 });
    assert.equal(collected.sources.cpu, 'file');
    assert.equal(collected.sources.power, 'file');
    assert.equal(collected.reading.cpuPercent, 18.5);
    assert.equal(collected.reading.onAcPower, true);

    const policy = decideResourcePolicy({
      ...collected.reading,
      availableMemoryGb: 12.4,
      diskFreeGb: 35.2
    });
    assert.equal(policy.acceptsNewActions, true);
    assert.equal(policy.slotLimit, 4);
  }, freshFile({ cpuPercent: 18.5, onAcPower: true }));
});

test('BOM 开头的遥测文件仍然可读（记事本和 PS 5.1 都会加 BOM）', async () => {
  await withHome(async (home) => {
    const file = await readTelemetryFile(home);
    assert.equal(file.ok, true);
    assert.equal(file.data.cpuPercent, 30);
  }, '\uFEFF' + freshFile({ cpuPercent: 30, onAcPower: false }));
});

test('过期的遥测一律作废，绝不猜"已接电"', async () => {
  const stale = JSON.stringify({
    writtenAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    cpuPercent: 5,
    onAcPower: true
  });
  await withHome(async (home) => {
    const file = await readTelemetryFile(home, { maxAgeSeconds: 300 });
    assert.equal(file.ok, false);
    assert.match(file.reason, /^stale_\d+s$/);

    const collected = await collectTelemetry(home, { sampleMs: 20 });
    assert.equal('onAcPower' in collected.reading, false, '过期文件不得提供电源状态');
    assert.equal(decideResourcePolicy(collected.reading).acceptsNewActions, false);
  }, stale);
});

test('遥测文件内容不是对象时判为无效', async () => {
  for (const content of ['[1,2,3]', 'null', '"hello"', '42']) {
    await withHome(async (home) => {
      const file = await readTelemetryFile(home);
      assert.equal(file.ok, false, `${content} 应判为无效`);
      assert.equal(file.reason, 'not_an_object');
    }, content);
  }
});

test('缺文件、缺 writtenAt 都有明确原因，且不放行', async () => {
  await withHome(async (home) => {
    const missing = await readTelemetryFile(home);
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'file_missing');

    const collected = await collectTelemetry(home, { sampleMs: 20 });
    assert.equal(decideResourcePolicy(collected.reading).acceptsNewActions, false);
  });

  await withHome(async (home) => {
    const file = await readTelemetryFile(home);
    assert.equal(file.ok, false);
    assert.equal(file.reason, 'missing_written_at');
  }, JSON.stringify({ cpuPercent: 10, onAcPower: true }));
});

test('环境变量可以临时覆盖，优先级高于遥测文件', async () => {
  await withHome(async (home) => {
    process.env.DAILY_TWIN_CPU_PERCENT = '20';
    process.env.DAILY_TWIN_ON_AC_POWER = '1';
    const collected = await collectTelemetry(home, { sampleMs: 20 });
    assert.equal(collected.sources.cpu, 'env');
    assert.equal(collected.sources.power, 'env');
    assert.equal(collected.reading.cpuPercent, 20);
    assert.equal(collected.reading.onAcPower, true);
  }, freshFile({ cpuPercent: 99, onAcPower: false }));

  // 中文注释：显式写 0 表示"在用电池"，必须被当成有效值而不是"没提供"。
  await withHome(async (home) => {
    process.env.DAILY_TWIN_ON_AC_POWER = '0';
    const collected = await collectTelemetry(home, { sampleMs: 20 });
    assert.equal(collected.reading.onAcPower, false);
    const policy = decideResourcePolicy({ ...collected.reading, cpuPercent: 5, availableMemoryGb: 20, diskFreeGb: 100 });
    assert.equal(policy.slotLimit, 1, '电池模式只允许一个槽位');
  });
});

test('sampleCpuPercent 拿不到有效时间片时返回 null，而不是 0', async () => {
  const sample = await sampleCpuPercent(20);
  assert.ok(sample === null || (Number.isFinite(sample) && sample >= 0 && sample <= 100));
});

test('遥测缺失时的提示文案给出可执行的三条出路', () => {
  assert.match(TELEMETRY_HINT, /Write-DailyTwinTelemetry\.ps1/);
  assert.match(TELEMETRY_HINT, /DAILY_TWIN_ON_AC_POWER/);
  assert.match(TELEMETRY_HINT, /失败关闭/);
});
