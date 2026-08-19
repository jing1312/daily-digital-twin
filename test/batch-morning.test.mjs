import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRuntimeCommand, RuntimeCommandError } from '../src/core/runtime-command.mjs';

describe('runtime-command — batch 命令', () => {
  test('batch 带文件路径解析正确', () => {
    const cmd = parseRuntimeCommand(['batch', '/path/to/tasks.txt']);
    assert.equal(cmd.command, 'batch');
    assert.equal(cmd.filePath, '/path/to/tasks.txt');
  });

  test('batch 带 --home 参数', () => {
    const cmd = parseRuntimeCommand(['batch', '/path/to/tasks.txt', '--home', '/home']);
    assert.equal(cmd.command, 'batch');
    assert.equal(cmd.filePath, '/path/to/tasks.txt');
    assert.equal(cmd.home, '/home');
  });

  test('batch 不带文件路径抛异常', () => {
    assert.throws(() => parseRuntimeCommand(['batch']), RuntimeCommandError);
  });
});

describe('runtime-command — morning 命令', () => {
  test('morning 带文件路径解析正确', () => {
    const cmd = parseRuntimeCommand(['morning', '/path/to/morning.txt']);
    assert.equal(cmd.command, 'morning');
    assert.equal(cmd.filePath, '/path/to/morning.txt');
    assert.equal(cmd.enableScheduler, false);
  });

  test('morning 带 --enable 标志', () => {
    const cmd = parseRuntimeCommand(['morning', '/path/to/morning.txt', '--enable']);
    assert.equal(cmd.command, 'morning');
    assert.equal(cmd.filePath, '/path/to/morning.txt');
    assert.equal(cmd.enableScheduler, true);
  });

  test('morning 带 --home 和 --enable', () => {
    const cmd = parseRuntimeCommand(['morning', '/path/to/morning.txt', '--enable', '--home', '/home']);
    assert.equal(cmd.command, 'morning');
    assert.equal(cmd.filePath, '/path/to/morning.txt');
    assert.equal(cmd.enableScheduler, true);
    assert.equal(cmd.home, '/home');
  });

  test('morning 不带文件路径抛异常', () => {
    assert.throws(() => parseRuntimeCommand(['morning']), RuntimeCommandError);
  });
});

describe('runtime-command — USAGE 包含新命令', () => {
  test('USAGE 包含 batch', () => {
    const { USAGE } = require_or_import_usage();
    assert.ok(USAGE.includes('batch'));
  });

  test('USAGE 包含 morning', () => {
    const { USAGE } = require_or_import_usage();
    assert.ok(USAGE.includes('morning'));
  });
});

// 中文注释：动态导入 USAGE（因为它是 export 的）。
function require_or_import_usage() {
  // 在 ESM 中没法同步 require，直接从 parseRuntimeCommand 的错误信息里拿。
  try {
    parseRuntimeCommand(['unknown_cmd']);
  } catch (error) {
    return { USAGE: error.message };
  }
  return { USAGE: '' };
}
