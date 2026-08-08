import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  CONFIG_FILE,
  ConfigError,
  loadConfig,
  mergeConfig,
  validateConfig,
  storeOptionsFromConfig
} from '../src/core/config.mjs';
import { TaskStore } from '../src/core/task-store.mjs';
import { decideResourcePolicy } from '../src/core/resource-policy.mjs';

// 中文注释：必须 await work，否则 finally 会在异步读取配置之前就把临时目录删掉，
// 中文注释：测试会随机通过或失败（loadConfig 拿到 ENOENT 后静默退回默认值）。
async function withHome(work) {
  const home = mkdtempSync(join(tmpdir(), 'ddt-config-'));
  try {
    return await work(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function writeConfig(home, value) {
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(join(home, CONFIG_FILE), JSON.stringify(value), 'utf8');
}

test('B20：配置文件里的槽位数真正生效，不再被代码硬编码覆盖', async () => {
  // 修复前：maxSlots 在 src/ 和 test/ 里根本不出现，示例配置只是装饰品。
  await withHome(async (home) => {
    writeConfig(home, { maxSlots: 2 });
    const { config } = await loadConfig(home);
    assert.equal(config.maxSlots, 2);

    const store = new TaskStore(':memory:', storeOptionsFromConfig(config));
    store.createTask({ request: '任务一' });
    store.createTask({ request: '任务二' });
    assert.throws(() => store.createTask({ request: '任务三' }), /上限 2/);
    store.close();
  });
});

test('B20b：资源阈值来自配置并被资源策略采用', async () => {
  await withHome(async (home) => {
    writeConfig(home, { resource: { cpuLimitPercent: 90, minAvailableMemoryGb: 2, minDiskFreeGb: 5 } });
    const { config } = await loadConfig(home);

    const reading = { onAcPower: true, cpuPercent: 80, availableMemoryGb: 4, diskFreeGb: 10 };
    // 中文注释：这套读数在默认阈值（55% / 8GB / 20GB）下会被拒，放宽后必须被接受。
    assert.equal(decideResourcePolicy(reading, DEFAULT_CONFIG.resource).acceptsNewActions, false);
    assert.equal(decideResourcePolicy(reading, config.resource).acceptsNewActions, true);
  });
});

test('B20c：退避序列与重试上限可由配置覆盖', async () => {
  await withHome(async (home) => {
    writeConfig(home, { retries: { maxAttempts: 5, backoffSeconds: [1, 2] } });
    const { config } = await loadConfig(home);
    assert.equal(config.retries.maxAttempts, 5);
    assert.deepEqual(config.retries.backoffSeconds, [1, 2], '数组必须整体替换而不是与默认值交错');
  });
});

test('缺少配置文件时使用默认值且不报错', async () => {
  await withHome(async (home) => {
    const { config, source } = await loadConfig(home);
    assert.equal(source, null, '应标明配置来自内置默认值');
    assert.equal(config.maxSlots, DEFAULT_CONFIG.maxSlots);
    assert.equal(config.scheduler.enabled, false, '调度器默认必须休眠');
  });
});

test('配置文件格式错误必须报错而不是静默忽略', async () => {
  await withHome(async (home) => {
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(join(home, CONFIG_FILE), '{ 这不是 JSON', 'utf8');
    await assert.rejects(() => loadConfig(home), ConfigError);
  });
});

test('非法阈值会被逐条指出', async () => {
  await withHome(async (home) => {
    writeConfig(home, { maxSlots: '4', resource: { cpuLimitPercent: 500 }, scheduler: { enabled: 'yes' } });
    await assert.rejects(() => loadConfig(home), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, 'invalid_config');
      assert.ok(error.problems.length >= 3, `应报出多条问题，实际 ${error.problems.length}`);
      assert.ok(error.problems.some((item) => item.includes('maxSlots')));
      assert.ok(error.problems.some((item) => item.includes('cpuLimitPercent')));
      assert.ok(error.problems.some((item) => item.includes('scheduler.enabled')));
      return true;
    });
  });
});

test('mergeConfig 深合并对象但整体替换数组', () => {
  const merged = mergeConfig(
    { a: { b: 1, c: 2 }, list: [1, 2, 3] },
    { a: { c: 9 }, list: [7] }
  );
  assert.deepEqual(merged, { a: { b: 1, c: 9 }, list: [7] });
});

test('maxSlots 会同步进 resource，避免两处阈值不一致', () => {
  const config = validateConfig(mergeConfig(DEFAULT_CONFIG, { maxSlots: 3 }));
  assert.equal(config.resource.maxSlots, 3);
  assert.equal(decideResourcePolicy(
    { onAcPower: true, cpuPercent: 10, availableMemoryGb: 16, diskFreeGb: 100 },
    config.resource
  ).slotLimit, 3);
});

test('默认配置包含本轮新增的存储上限与执行验证开关', () => {
  assert.equal(DEFAULT_CONFIG.execution.requireEvidence, true, '默认必须要求执行证据');
  assert.ok(DEFAULT_CONFIG.storage.keepFreeDiskGb >= 20, '需为系统盘保留余量');
  assert.equal(DEFAULT_CONFIG.browser.defaultProfile, 'openclaw', '默认不碰用户日常浏览器');
});

test('snapshotMode 与 managedLoggedInHosts 的非法取值会被配置校验拦下', () => {
  // 中文注释：snapshotMode 会被原样传给 PowerShell 的 ValidateSet，
  // 中文注释：不在这里拦，就会变成一个看不懂的参数校验错误。
  assert.throws(
    () => validateConfig(mergeConfig(DEFAULT_CONFIG, { browser: { snapshotMode: 'efficent' } })),
    (error) => error.code === 'invalid_config' && error.problems.some((p) => p.includes('snapshotMode'))
  );
  // 中文注释：aria 是真机上确实存在的格式（snapshot --format aria），必须放行；
  // 中文注释：ai 则不是本项目的对外取值 —— 对外叫 full，内部才映射成 --format ai，别把内部拼法漏成配置项。
  for (const mode of ['efficient', 'full', 'aria']) {
    assert.doesNotThrow(
      () => validateConfig(mergeConfig(DEFAULT_CONFIG, { browser: { snapshotMode: mode } })),
      `snapshotMode=${mode} 应当被接受`
    );
  }
  assert.throws(
    () => validateConfig(mergeConfig(DEFAULT_CONFIG, { browser: { snapshotMode: 'ai' } })),
    (error) => error.code === 'invalid_config' && error.problems.some((p) => p.includes('snapshotMode'))
  );
  assert.throws(
    () => validateConfig(mergeConfig(DEFAULT_CONFIG, { browser: { managedLoggedInHosts: 'feishu.cn' } })),
    (error) => error.problems.some((p) => p.includes('managedLoggedInHosts'))
  );
  assert.throws(
    () => validateConfig(mergeConfig(DEFAULT_CONFIG, { browser: { managedLoggedInHosts: ['ok.com', '  '] } })),
    (error) => error.problems.some((p) => p.includes('managedLoggedInHosts'))
  );
  const good = validateConfig(mergeConfig(DEFAULT_CONFIG, { browser: { managedLoggedInHosts: ['.feishu.cn'] } }));
  assert.deepEqual(good.browser.managedLoggedInHosts, ['.feishu.cn']);
});

test('execution.module 可选但给了就必须是相对私有目录的非空路径', () => {
  // 中文注释：不给或给 null 都算"用默认位置"，必须放行。
  assert.doesNotThrow(() => validateConfig(mergeConfig(DEFAULT_CONFIG, {})));
  assert.doesNotThrow(() => validateConfig(mergeConfig(DEFAULT_CONFIG, { execution: { module: null } })));
  assert.doesNotThrow(() => validateConfig(mergeConfig(DEFAULT_CONFIG, { execution: { module: 'executor/index.mjs' } })));
  for (const bad of ['', '   ', 42, {}, ['executor/index.mjs']]) {
    assert.throws(
      () => validateConfig(mergeConfig(DEFAULT_CONFIG, { execution: { module: bad } })),
      (error) => error.code === 'invalid_config' && error.problems.some((p) => p.includes('execution.module')),
      `非法 execution.module 必须被拦下：${JSON.stringify(bad)}`
    );
  }
});
