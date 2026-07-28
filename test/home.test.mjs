import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { resolveHome, databasePath, HomeResolutionError, HOME_ENV, HOME_DIRECTORIES } from '../src/core/home.mjs';

test('B13b：init 与其他命令共用同一套 home 解析，不会各写一个目录', () => {
  // 修复前：init 用位置参数目录，create/status 各自另算，结果 init 建的库谁也读不到。
  const viaCli = resolveHome({ cliHome: '/tmp/ddt-home', env: {} });
  const viaEnv = resolveHome({ cliHome: null, env: { [HOME_ENV]: '/tmp/ddt-home' } });
  assert.equal(viaCli, viaEnv, '同一目录经两种入口解析结果必须一致');
  assert.equal(viaCli, resolve('/tmp/ddt-home'));
});

test('B13b2：--home 优先于环境变量', () => {
  const home = resolveHome({ cliHome: '/tmp/from-cli', env: { [HOME_ENV]: '/tmp/from-env' } });
  assert.equal(home, resolve('/tmp/from-cli'));
});

test('B14：未配置 home 时必须失败关闭，绝不回退到公开源码目录', () => {
  // 修复前：回退到源码目录旁的 runtime/，私有任务数据写在公开仓里，且 .gitignore 没有它。
  assert.throws(() => resolveHome({ cliHome: null, env: {} }), (error) => {
    assert.ok(error instanceof HomeResolutionError);
    assert.equal(error.code, 'home_not_configured');
    assert.match(error.message, /DAILY_TWIN_HOME/);
    assert.match(error.message, /--home/, '错误信息要告诉用户怎么修');
    return true;
  });
});

test('B14b：空白字符串不算已配置', () => {
  assert.throws(() => resolveHome({ cliHome: '   ', env: { [HOME_ENV]: '' } }), HomeResolutionError);
});

test('数据库路径始终落在 home 之下，并接受 Windows 反斜杠写法', () => {
  const home = resolve('/tmp/ddt-home');
  assert.equal(databasePath(home), resolve(home, 'data/runtime.sqlite'));
  assert.equal(databasePath(home, 'data\\runtime.sqlite'), resolve(home, 'data/runtime.sqlite'));
});

test('私有目录清单覆盖任务数据、截图、缓存与日志', () => {
  for (const expected of ['data/tasks', 'data/receipts', 'data/screenshots', 'data/cache', 'data/logs', 'config']) {
    assert.ok(HOME_DIRECTORIES.includes(expected), `缺少目录 ${expected}`);
  }
});
