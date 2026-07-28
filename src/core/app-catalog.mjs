import { readFile } from 'node:fs/promises';

// 中文注释：读取本机私有应用目录，公开仓只保留示例配置。

// 中文注释：别名统一小写并去空格后比较，避免"vs code"匹配不到"VS Code"（修 B8b）。
function normalizeKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

function toList(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

export async function loadAppCatalog(path) {
  let raw = null;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`无法读取应用目录 ${path}：${error.message}`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`应用目录不是合法 JSON（${path}）：${error.message}`);
  }
  if (!Array.isArray(parsed?.apps) && !Array.isArray(parsed?.websites)) {
    throw new Error(`应用目录缺少 apps 或 websites 列表（${path}）`);
  }
  return parsed;
}

// 中文注释：通用查找。缺少对应列表时给出可读错误，而不是 Cannot read properties of undefined（修 B8）。
function resolveEntry(catalog, alias, listName, label) {
  const entries = catalog?.[listName];
  if (!Array.isArray(entries)) throw new Error(`应用目录缺少 ${listName} 列表，无法解析${label}：${alias}`);
  const key = normalizeKey(alias);
  if (!key) throw new Error(`${label}别名不能为空`);
  const matches = entries.filter((entry) => {
    if (normalizeKey(entry?.id) === key) return true;
    return toList(entry?.aliases).some((candidate) => normalizeKey(candidate) === key);
  });
  if (matches.length === 0) throw new Error(`未登记${label}：${alias}`);
  if (matches.length > 1) throw new Error(`${label}存在多个候选：${alias}`);
  return matches[0];
}

// 中文注释：只允许唯一别名命中，避免模型猜错软件。
export function resolveApp(catalog, alias) {
  return resolveEntry(catalog, alias, 'apps', '应用');
}

export function resolveWebsite(catalog, alias) {
  return resolveEntry(catalog, alias, 'websites', '站点');
}
