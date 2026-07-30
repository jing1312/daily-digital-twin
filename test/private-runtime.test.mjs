import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readPrivateSecret, resolvePrivatePath } from '../src/core/private-config.mjs';
import { parseRuntimeCommand } from '../src/core/runtime-command.mjs';

test('私有配置路径只能留在 DAILY_TWIN_HOME 内', () => {
  const home = join('D:\\', 'private', 'daily-twin');
  assert.match(resolvePrivatePath(home, 'config/apps.json'), /config[\\/]apps\.json$/);
  assert.throws(
    () => resolvePrivatePath(home, '..\\openclaw.json'),
    (error) => error.code === 'private_path_escape'
  );
  assert.throws(
    () => resolvePrivatePath(home, 'C:\\Windows\\win.ini'),
    (error) => error.code === 'private_path_escape'
  );
});

test('密钥文件去掉 BOM/换行，但短 HMAC 密钥失败关闭', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ddt-private-'));
  try {
    mkdirSync(join(home, 'config'));
    writeFileSync(join(home, 'config', 'secret.txt'), '\uFEFF0123456789abcdef0123456789abcdef\r\n', 'utf8');
    assert.equal(await readPrivateSecret(home, 'config/secret.txt', { minLength: 32 }), '0123456789abcdef0123456789abcdef');
    writeFileSync(join(home, 'config', 'short.txt'), 'short', 'utf8');
    await assert.rejects(
      () => readPrivateSecret(home, 'config/short.txt', { minLength: 32 }),
      (error) => error.code === 'secret_too_short'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runtime CLI 提供 serve 和 mcp 两个生产入口', () => {
  assert.deepEqual(parseRuntimeCommand(['serve', '--home', 'D:\\private']), { command: 'serve', home: 'D:\\private' });
  assert.deepEqual(parseRuntimeCommand(['mcp', '--home', 'D:\\private']), { command: 'mcp', home: 'D:\\private' });
  assert.deepEqual(
    parseRuntimeCommand(['mcp', '--home', 'D:\\private', '--binding', 'data/workers/binding.json']),
    { command: 'mcp', home: 'D:\\private', binding: 'data/workers/binding.json' }
  );
});

test('runtime mcp 进入 MCP 装配，不再误落入任务控制分支', () => {
  const home = mkdtempSync(join(tmpdir(), 'ddt-mcp-cli-'));
  try {
    mkdirSync(join(home, 'data'), { recursive: true });
    const result = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning',
      fileURLToPath(new URL('../src/runtime.mjs', import.meta.url)),
      'mcp', '--home', home
    ], { encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /无法读取应用目录/);
    assert.doesNotMatch(result.stderr, /任务 undefined 不存在/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runtime init 一次生成可启动骨架和本机 HMAC，重复 init 不覆盖已有文件', () => {
  const home = mkdtempSync(join(tmpdir(), 'ddt-init-private-'));
  try {
    const runtimePath = fileURLToPath(new URL('../src/runtime.mjs', import.meta.url));
    const first = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', runtimePath, 'init', '--home', home], {
      encoding: 'utf8', timeout: 10_000
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(existsSync(join(home, 'config', 'runtime.json')), true);
    assert.equal(existsSync(join(home, 'config', 'apps.json')), true);
    assert.equal(existsSync(join(home, 'config', 'pricing.json')), true);
    assert.equal(existsSync(join(home, 'data', 'workers')), true);
    const secretPath = join(home, 'config', 'capability-hmac.secret');
    const secret = readFileSync(secretPath, 'utf8').trim();
    assert.match(secret, /^[a-f0-9]{64}$/);

    const second = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', runtimePath, 'init', '--home', home], {
      encoding: 'utf8', timeout: 10_000
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(secretPath, 'utf8').trim(), secret);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
