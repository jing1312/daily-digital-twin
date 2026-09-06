// 中文注释：path-boundary 回归测试 —— resolveContainedPath 的 flavor 判定与平台无关，
// 中文注释：本地 Windows 也能直接验证 Linux 语义（B32：posix 下反斜杠被当普通文件名）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveContainedPath } from '../src/core/path-boundary.mjs';

describe('resolveContainedPath — posix root（Linux 语义）', () => {
  const posixHome = '/tmp/daily-twin-home';

  test('posix 下候选带反斜杠一律拒绝，哪怕 resolve 会把它判成内部文件名', () => {
    // 中文注释：B32 回归：'..\..\secret.png' 与 'system32\evil.png' 在 Linux 上
    // 中文注释：会被 posix.resolve 拼成 home 内的普通文件名，反斜杠不是分隔符。
    assert.equal(resolveContainedPath(posixHome, '..\\..\\secret.png'), null);
    assert.equal(resolveContainedPath(posixHome, 'system32\\evil.png'), null);
    assert.equal(resolveContainedPath(posixHome, 'C:\\Windows\\evil.png'), null);
  });

  test('posix 下正常的内部与越界路径判定不受影响', () => {
    assert.equal(resolveContainedPath(posixHome, 'data/shots/a.png'), '/tmp/daily-twin-home/data/shots/a.png');
    assert.equal(resolveContainedPath(posixHome, '../escape.png'), null);
    assert.equal(resolveContainedPath(posixHome, '/etc/passwd'), null);
  });
});

describe('resolveContainedPath — win32 root（Windows 语义）', () => {
  const winHome = 'D:\\DailyTwin\\home';

  test('盘符绝对路径越界拒绝、内部相对路径接受', () => {
    assert.equal(resolveContainedPath(winHome, 'C:\\Windows\\evil.png'), null);
    // 中文注释：win32 API 在任何平台都用反斜杠拼接，期望值直接写字面量，不依赖 node:path 的平台行为。
    assert.equal(resolveContainedPath(winHome, 'data\\shots\\a.png'), 'D:\\DailyTwin\\home\\data\\shots\\a.png');
    assert.equal(resolveContainedPath(winHome, '..\\escape.png'), null);
  });
});
