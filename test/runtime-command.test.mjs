import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRuntimeCommand } from '../src/core/runtime-command.mjs';

test('控制平面命令解析保持任务正文原样', () => {
  assert.deepEqual(parseRuntimeCommand(['create', '打开 Biomni 输入 TEST_TEXT']), {
    command: 'create',
    request: '打开 Biomni 输入 TEST_TEXT'
  });
  assert.deepEqual(parseRuntimeCommand(['pause', '12']), { command: 'pause', taskId: 12 });
  assert.deepEqual(parseRuntimeCommand(['status']), { command: 'status' });
});
