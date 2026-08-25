import { readFile } from 'node:fs/promises';
import { resolveContainedPath } from './path-boundary.mjs';

export function resolvePrivatePath(home, configuredPath) {
  const candidate = resolveContainedPath(home, configuredPath);
  if (!candidate) {
    throw Object.assign(new Error('私有配置路径逃出 DAILY_TWIN_HOME'), { code: 'private_path_escape' });
  }
  return candidate;
}

export async function readPrivateSecret(home, configuredPath, { minLength = 1 } = {}) {
  const path = resolvePrivatePath(home, configuredPath);
  let value;
  try {
    value = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '').trim();
  } catch (error) {
    throw Object.assign(new Error(`无法读取私有密钥文件：${error.message}`), { code: 'secret_unavailable' });
  }
  if (value.length < minLength) {
    throw Object.assign(new Error(`私有密钥长度不足，至少需要 ${minLength} 个字符`), { code: 'secret_too_short' });
  }
  return value;
}

export async function readPrivateJson(home, configuredPath) {
  const path = resolvePrivatePath(home, configuredPath);
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw Object.assign(new Error(`无法读取私有 JSON 配置：${error.message}`), { code: 'private_json_unavailable' });
  }
}
