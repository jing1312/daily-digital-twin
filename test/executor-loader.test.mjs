import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  resolveExecutorPath,
  loadExecutor,
  describeExecutor,
  placeholderExecutor,
  ExecutorLoadError
} from '../src/core/executor-loader.mjs';

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'ddt-executor-'));
}

function cleanup(home) {
  rmSync(home, { recursive: true, force: true });
}

function writeExecutor(home, relativePath, source) {
  const fullPath = join(home, relativePath);
  mkdirSync(resolve(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, source, 'utf8');
}

test('默认执行器位置是 <home>/executor/index.mjs', () => {
  const home = makeHome();
  try {
    assert.equal(resolveExecutorPath(home, {}), resolve(home, 'executor', 'index.mjs'));
    assert.equal(resolveExecutorPath(home, null), resolve(home, 'executor', 'index.mjs'));
  } finally {
    cleanup(home);
  }
});

test('execution.module 可以覆盖默认位置（相对私有目录解析）', () => {
  const home = makeHome();
  try {
    const config = { execution: { module: 'custom/exec.mjs' } };
    assert.equal(resolveExecutorPath(home, config), resolve(home, 'custom', 'exec.mjs'));
  } finally {
    cleanup(home);
  }
});

test('执行器路径越出私有目录必须被拒绝，不做猜测', () => {
  const home = makeHome();
  try {
    for (const evil of ['../evil.mjs', 'executor/../../evil.mjs']) {
      const config = { execution: { module: evil } };
      assert.throws(() => resolveExecutorPath(home, config), (error) => {
        assert.ok(error instanceof ExecutorLoadError);
        assert.equal(error.code, 'executor_path_outside_home');
        return true;
      }, `越界路径必须被拒绝：${evil}`);
    }
  } finally {
    cleanup(home);
  }
});

test('execution.module 为空白字符串必须被拒绝', () => {
  const home = makeHome();
  try {
    assert.throws(() => resolveExecutorPath(home, { execution: { module: '   ' } }), (error) => {
      assert.equal(error.code, 'invalid_executor_path');
      return true;
    });
  } finally {
    cleanup(home);
  }
});

test('执行器文件不存在时返回空，由调用方退回占位执行器', async () => {
  const home = makeHome();
  try {
    const loaded = await loadExecutor(home, {});
    assert.equal(loaded.executor, null);
    assert.equal(loaded.source, 'none');
    assert.equal(loaded.path, resolve(home, 'executor', 'index.mjs'));
  } finally {
    cleanup(home);
  }
});

test('default 导出的函数执行器能被装载并调用', async () => {
  const home = makeHome();
  try {
    writeExecutor(home, join('executor', 'index.mjs'),
      'export default async ({ task }) => ({ outcome: "completed", summary: `done ${task.id}` });\n');
    const loaded = await loadExecutor(home, {});
    assert.equal(loaded.source, 'private');
    assert.equal(typeof loaded.executor, 'function');
    const result = await loaded.executor({ task: { id: 7 }, store: null, config: {} });
    assert.equal(result.outcome, 'completed');
    assert.equal(result.summary, 'done 7');
  } finally {
    cleanup(home);
  }
});

test('命名导出 executor 也能被装载', async () => {
  const home = makeHome();
  try {
    writeExecutor(home, join('executor', 'index.mjs'),
      'export async function executor() { return { outcome: "partial" }; }\n');
    const loaded = await loadExecutor(home, {});
    assert.equal(loaded.source, 'private');
    const result = await loaded.executor({ task: { id: 1 } });
    assert.equal(result.outcome, 'partial');
  } finally {
    cleanup(home);
  }
});

test('导出不是函数时必须报 executor_bad_export，不许静默降级', async () => {
  const home = makeHome();
  try {
    writeExecutor(home, join('executor', 'index.mjs'), 'export default { not: "a function" };\n');
    await assert.rejects(() => loadExecutor(home, {}), (error) => {
      assert.ok(error instanceof ExecutorLoadError);
      assert.equal(error.code, 'executor_bad_export');
      return true;
    });
  } finally {
    cleanup(home);
  }
});

test('模块加载抛错时必须报 executor_import_failed', async () => {
  const home = makeHome();
  try {
    writeExecutor(home, join('executor', 'index.mjs'), 'throw new Error("boom");\n');
    await assert.rejects(() => loadExecutor(home, {}), (error) => {
      assert.ok(error instanceof ExecutorLoadError);
      assert.equal(error.code, 'executor_import_failed');
      assert.match(error.message, /boom/);
      return true;
    });
  } finally {
    cleanup(home);
  }
});

test('占位执行器如实报 partial，绝不谎报 completed', async () => {
  const result = await placeholderExecutor({ task: { id: 3 } });
  assert.equal(result.outcome, 'partial');
  assert.match(result.reason, /未配置执行器/);
  assert.match(result.summary, /3/);
});

test('describeExecutor：无私有执行器时报 placeholder 并给出位置', async () => {
  const home = makeHome();
  try {
    const info = await describeExecutor(home, {});
    assert.equal(info.source, 'placeholder');
    assert.equal(info.path, resolve(home, 'executor', 'index.mjs'));
  } finally {
    cleanup(home);
  }
});

test('describeExecutor：私有执行器就位时报 private 与路径', async () => {
  const home = makeHome();
  try {
    writeExecutor(home, join('executor', 'index.mjs'), 'export default async () => ({ outcome: "partial" });\n');
    const info = await describeExecutor(home, {});
    assert.equal(info.source, 'private');
    assert.equal(info.path, resolve(home, 'executor', 'index.mjs'));
  } finally {
    cleanup(home);
  }
});

test('describeExecutor：加载失败不抛错，如实报 load_error', async () => {
  const home = makeHome();
  try {
    writeExecutor(home, join('executor', 'index.mjs'), 'export default 42;\n');
    const info = await describeExecutor(home, {});
    assert.equal(info.source, 'load_error');
    assert.equal(info.code, 'executor_bad_export');
  } finally {
    cleanup(home);
  }
});
