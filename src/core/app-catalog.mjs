import { readFile } from 'node:fs/promises';

// 中文注释：读取本机私有应用目录，公开仓只保留示例配置。
export async function loadAppCatalog(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// 中文注释：只允许唯一别名命中，避免模型猜错软件。
export function resolveApp(catalog, alias) {
  const matches = catalog.apps.filter((entry) => entry.id === alias || entry.aliases.includes(alias));
  if (matches.length === 0) throw new Error(`未登记应用：${alias}`);
  if (matches.length > 1) throw new Error(`应用存在多个候选：${alias}`);
  return matches[0];
}
