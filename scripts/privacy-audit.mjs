import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { cwd } from 'node:process';

const root = cwd();
const ignored = new Set(['.git', 'node_modules', 'data', 'state', 'logs', 'tasks']);
const secretPatterns = [
  /sk-[A-Za-z0-9]{20,}/,
  /(?:api[_-]?key|app[_-]?secret|token|password)\s*[:=]\s*["'](?!YOUR_|REPLACE_|EXAMPLE)[^"']{8,}["']/i,
  /(?:C:\\Users|D:\\文档\\学业资料)\\[^\r\n"']+/i
];

// 中文注释：递归扫描公开仓中可能泄露的密钥、个人路径和运行数据。
async function walk(directory) {
  const findings = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      findings.push(...await walk(path));
      continue;
    }
    const text = await readFile(path, 'utf8');
    if (secretPatterns.some((pattern) => pattern.test(text))) findings.push(relative(root, path));
  }
  return findings;
}

const findings = await walk(root);
if (findings.length > 0) {
  console.error(`隐私审计发现问题：\n${findings.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('隐私审计通过：未发现密钥、运行数据或真实本机路径。');
}
