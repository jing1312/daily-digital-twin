import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRuntimeCommand, RuntimeCommandError, USAGE } from '../src/core/runtime-command.mjs';

test('控制平面命令解析保持任务正文原样', () => {
  assert.deepEqual(parseRuntimeCommand(['create', '打开 Biomni 输入 TEST_TEXT']), {
    command: 'create',
    request: '打开 Biomni 输入 TEST_TEXT'
  });
  assert.deepEqual(parseRuntimeCommand(['pause', '12']), { command: 'pause', taskId: 12 });
  assert.deepEqual(parseRuntimeCommand(['status']), { command: 'status' });
});

test('B7：非数字任务编号必须被拒绝，不得变成 NaN 传进数据库', () => {
  // 修复前：parseRuntimeCommand(['pause', 'abc']) 返回 { taskId: NaN }，
  // 修复前：一路传到 SQL 才炸，用户看到的是莫名其妙的报错。
  for (const bad of ['abc', '1.5', '-3', '1e3', ' ', '']) {
    assert.throws(() => parseRuntimeCommand(['pause', bad]), (error) => {
      assert.ok(error instanceof RuntimeCommandError);
      assert.ok(['invalid_task_id', 'missing_task_id'].includes(error.code), `意外的错误码 ${error.code}`);
      return true;
    }, `编号 ${JSON.stringify(bad)} 应被拒绝`);
  }
});

test('B7b：缺少任务编号时给出明确提示', () => {
  for (const command of ['pause', 'resume', 'cancel']) {
    assert.throws(() => parseRuntimeCommand([command]), (error) => {
      assert.equal(error.code, 'missing_task_id');
      assert.match(error.message, new RegExp(`${command} 需要任务编号`));
      return true;
    });
  }
});

test('B7c：超大编号被拒绝而不是静默丢失精度', () => {
  assert.throws(() => parseRuntimeCommand(['pause', '99999999999999999999']), /超出范围/);
});

test('B13c：未知命令给出可读用法而不是抛裸栈', () => {
  assert.throws(() => parseRuntimeCommand(['frobnicate']), (error) => {
    assert.equal(error.code, 'unknown_command');
    assert.match(error.message, /未知控制命令：frobnicate/);
    assert.match(error.message, /runtime init/, '错误信息应带上用法');
    return true;
  });
  assert.throws(() => parseRuntimeCommand([]), /unknown_command|未知控制命令|需要/);
  assert.ok(USAGE.includes('runtime doctor'));
});

test('--home 可用空格或等号写法，且不会污染任务正文', () => {
  assert.deepEqual(parseRuntimeCommand(['create', '打开 Biomni', '--home', 'D:\\DailyTwin\\home']), {
    command: 'create',
    request: '打开 Biomni',
    home: 'D:\\DailyTwin\\home'
  });
  assert.deepEqual(parseRuntimeCommand(['--home=D:\\DailyTwin\\home', 'status']), {
    command: 'status',
    home: 'D:\\DailyTwin\\home'
  });
  assert.throws(() => parseRuntimeCommand(['status', '--home']), /--home 需要一个目录参数/);
});

test('create 缺少任务正文时被拒绝', () => {
  assert.throws(() => parseRuntimeCommand(['create']), (error) => {
    assert.equal(error.code, 'missing_request');
    return true;
  });
  assert.throws(() => parseRuntimeCommand(['create', '   ']), /missing_request|不能为空|需要/);
});

test('调度器与归属账号子命令解析', () => {
  assert.deepEqual(parseRuntimeCommand(['scheduler', 'enable']), { command: 'scheduler', action: 'enable' });
  assert.deepEqual(parseRuntimeCommand(['scheduler']), { command: 'scheduler', action: 'status' });
  assert.deepEqual(parseRuntimeCommand(['owner', 'reset']), { command: 'owner', action: 'reset' });
  assert.deepEqual(parseRuntimeCommand(['owner']), { command: 'owner', action: 'show' });
  assert.throws(() => parseRuntimeCommand(['scheduler', 'turbo']), RuntimeCommandError);
});

test('init 同时兼容位置参数目录与 --home', () => {
  assert.deepEqual(parseRuntimeCommand(['init', 'D:\\DailyTwin\\home']), {
    command: 'init',
    home: 'D:\\DailyTwin\\home'
  });
  assert.deepEqual(parseRuntimeCommand(['init', '--home', 'D:\\DailyTwin\\home']), {
    command: 'init',
    home: 'D:\\DailyTwin\\home'
  });
  assert.deepEqual(parseRuntimeCommand(['init']), { command: 'init' });
});

test('daemon 与 doctor 命令可解析', () => {
  assert.deepEqual(parseRuntimeCommand(['daemon']), { command: 'daemon' });
  assert.deepEqual(parseRuntimeCommand(['doctor']), { command: 'doctor' });
});

test('MCP 支持固定 Multica worker slot，且不能同时传任意 binding 路径', () => {
  assert.deepEqual(parseRuntimeCommand(['mcp', '--binding-slot', 'dt-worker-1']), {
    command: 'mcp', bindingSlot: 'dt-worker-1'
  });
  assert.throws(
    () => parseRuntimeCommand(['mcp', '--binding', 'data/a.json', '--binding-slot', 'dt-worker-1']),
    (error) => error.code === 'conflicting_binding_source'
  );
  assert.throws(
    () => parseRuntimeCommand(['mcp', '--binding-slot', '..\\escape']),
    (error) => error.code === 'invalid_binding_slot'
  );
});
