import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRuntimeCommand, RuntimeCommandError } from '../src/core/runtime-command.mjs';

describe('F3 — tree 命令解析', () => {
  test('tree 基本解析', () => {
    const cmd = parseRuntimeCommand(['tree']);
    assert.equal(cmd.command, 'tree');
  });

  test('tree 带 --home', () => {
    const cmd = parseRuntimeCommand(['tree', '--home', '/data']);
    assert.equal(cmd.command, 'tree');
    assert.equal(cmd.home, '/data');
  });
});

describe('F4 — history 命令解析', () => {
  test('history 基本解析，默认 limit=20', () => {
    const cmd = parseRuntimeCommand(['history']);
    assert.equal(cmd.command, 'history');
    assert.equal(cmd.limit, 20);
  });

  test('history 带 --limit', () => {
    const cmd = parseRuntimeCommand(['history', '--limit', '50']);
    assert.equal(cmd.command, 'history');
    assert.equal(cmd.limit, 50);
  });

  test('history --limit 无效值时用默认', () => {
    const cmd = parseRuntimeCommand(['history', '--limit', 'abc']);
    assert.equal(cmd.limit, 20);
  });

  test('history 带 --home', () => {
    const cmd = parseRuntimeCommand(['history', '--home', '/data', '--limit', '10']);
    assert.equal(cmd.command, 'history');
    assert.equal(cmd.home, '/data');
    assert.equal(cmd.limit, 10);
  });
});

describe('F4 — show 命令解析', () => {
  test('show 带任务编号', () => {
    const cmd = parseRuntimeCommand(['show', '42']);
    assert.equal(cmd.command, 'show');
    assert.equal(cmd.taskId, 42);
  });

  test('show 不带编号抛异常', () => {
    assert.throws(() => parseRuntimeCommand(['show']), RuntimeCommandError);
  });

  test('show 非数字编号抛异常', () => {
    assert.throws(() => parseRuntimeCommand(['show', 'abc']), RuntimeCommandError);
  });
});

describe('F5 — cost 命令解析', () => {
  test('cost 基本解析', () => {
    const cmd = parseRuntimeCommand(['cost']);
    assert.equal(cmd.command, 'cost');
  });

  test('cost 带 --home', () => {
    const cmd = parseRuntimeCommand(['cost', '--home', '/data']);
    assert.equal(cmd.command, 'cost');
    assert.equal(cmd.home, '/data');
  });
});

describe('F6 — morning --dry-run 解析', () => {
  test('morning 带 --dry-run', () => {
    const cmd = parseRuntimeCommand(['morning', '/path/tasks.txt', '--dry-run']);
    assert.equal(cmd.command, 'morning');
    assert.equal(cmd.filePath, '/path/tasks.txt');
    assert.equal(cmd.dryRun, true);
    assert.equal(cmd.enableScheduler, false);
  });

  test('morning 同时带 --dry-run 和 --enable', () => {
    const cmd = parseRuntimeCommand(['morning', '/path/tasks.txt', '--dry-run', '--enable']);
    assert.equal(cmd.dryRun, true);
    assert.equal(cmd.enableScheduler, true);
  });

  test('morning 不带 --dry-run 时 dryRun 为 false', () => {
    const cmd = parseRuntimeCommand(['morning', '/path/tasks.txt']);
    assert.equal(cmd.dryRun, false);
  });
});

describe('USAGE 包含新命令', () => {
  function getUsage() {
    try { parseRuntimeCommand(['unknown_cmd']); } catch (e) { return e.message; }
    return '';
  }

  test('USAGE 包含 tree', () => assert.ok(getUsage().includes('tree')));
  test('USAGE 包含 history', () => assert.ok(getUsage().includes('history')));
  test('USAGE 包含 show', () => assert.ok(getUsage().includes('show <编号>')));
  test('USAGE 包含 cost', () => assert.ok(getUsage().includes('cost')));
  test('USAGE 包含 --dry-run', () => assert.ok(getUsage().includes('--dry-run')));
});
