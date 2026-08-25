import { access } from 'node:fs/promises';
import { resolve, sep, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 中文注释：私有执行器加载。公开仓刻意不内置任何真实执行器 ——
// 中文注释：执行器要读本机软件路径、驱动浏览器和桌面，属于私有配置（runtime.mjs 里原来的注释）。
// 中文注释：这里提供的是"从私有目录把执行器请进来"的装载机制：
// 中文注释：  默认位置 <home>/executor/index.mjs，可用 config.execution.module 覆盖（相对私有目录）。
// 中文注释：  路径必须落在私有目录内（防 ../ 越界）；模块必须导出函数（default 或命名导出 executor）。
// 中文注释：  文件不存在时返回空（调用方退回占位执行器），加载失败则抛错 —— 宁可拒绝启动，不悄悄降级。

export class ExecutorLoadError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ExecutorLoadError';
    this.code = code;
  }
}

// 中文注释：占位执行器。没有私有执行器时如实报 partial，绝不谎报 completed。
export async function placeholderExecutor({ task } = {}) {
  return {
    outcome: 'partial',
    reason: '未配置执行器：请在私有目录提供 executor，本次不谎报成功',
    summary: `任务 ${task?.id ?? '?'} 已被调度，但没有可用执行器`
  };
}

// 中文注释：解析执行器模块的绝对路径。越界（逃出私有目录）直接拒绝，不做任何猜测。
export function resolveExecutorPath(home, config) {
  const configured = config?.execution?.module;
  const relative = configured ?? join('executor', 'index.mjs');
  if (typeof relative !== 'string' || relative.trim().length === 0) {
    throw new ExecutorLoadError('execution.module 必须是非空路径字符串', 'invalid_executor_path');
  }
  const homeResolved = resolve(home);
  const candidate = resolve(homeResolved, relative);
  if (candidate !== homeResolved && !candidate.startsWith(homeResolved + sep)) {
    throw new ExecutorLoadError(
      `执行器路径必须位于私有目录内：${relative}`,
      'executor_path_outside_home'
    );
  }
  return candidate;
}

// 中文注释：加载执行器。返回 { executor, source, path }：
// 中文注释：  source = 'private'   私有模块加载成功；
// 中文注释：  source = 'none'      未找到执行器文件（调用方退回占位执行器）。
// 中文注释：模块存在但加载失败/导出不对时抛 ExecutorLoadError，不做静默降级。
export async function loadExecutor(home, config) {
  const path = resolveExecutorPath(home, config);
  try {
    await access(path);
  } catch {
    return { executor: null, source: 'none', path };
  }

  let mod;
  try {
    mod = await import(pathToFileURL(path).href);
  } catch (error) {
    throw new ExecutorLoadError(`执行器加载失败：${error.message}`, 'executor_import_failed');
  }

  const fn = typeof mod.default === 'function'
    ? mod.default
    : (typeof mod.executor === 'function' ? mod.executor : null);
  if (!fn) {
    throw new ExecutorLoadError(
      '执行器模块必须导出函数（default 导出或命名导出 executor）',
      'executor_bad_export'
    );
  }
  return { executor: fn, source: 'private', path };
}

// 中文注释：只读描述当前执行器状态，供 doctor 输出。加载失败不抛错，如实报告。
export async function describeExecutor(home, config) {
  try {
    const loaded = await loadExecutor(home, config);
    if (loaded.source === 'none') {
      return { source: 'placeholder', path: loaded.path, reason: '未找到私有执行器，调度时将如实报 partial' };
    }
    return { source: 'private', path: loaded.path };
  } catch (error) {
    return { source: 'load_error', message: error.message, code: error.code };
  }
}
