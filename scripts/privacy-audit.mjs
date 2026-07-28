import { readFile, readdir } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { cwd, argv } from 'node:process';
import { findLeaks } from '../src/core/redact.mjs';

// 中文注释：公开仓隐私审计。目标是"提交前挡住密钥、真实本机路径、运行数据和中转地址"。
// 中文注释：与 src/core/redact.mjs 共用同一套值形态规则，避免两处规则漂移。

const root = cwd();

// 中文注释：跳过 .git 与私有运行数据目录；runtime/ 是历史回退目录，也一并排除。
const IGNORED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'data', 'state', 'logs', 'tasks', 'runtime', 'backups', '.venv'
]);

// 中文注释：二进制与图片不做文本匹配，避免误报和无意义的读取。
const SKIPPED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz',
  '.sqlite', '.sqlite3', '.db', '.woff', '.woff2', '.ttf'
]);

// 中文注释：占位值白名单。示例配置必须能通过审计，否则大家会习惯性 --force 跳过检查。
const PLACEHOLDER_VALUE = /^(YOUR_|REPLACE_|EXAMPLE|PLACEHOLDER|CHANGE_?ME|<.*>|\.\.\.|xxx+|C:\\Path\\To\\)/i;

const RULES = [
  {
    id: 'api-key',
    description: 'API 密钥形态',
    pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{19,}/g
  },
  {
    id: 'github-token',
    description: 'GitHub 访问令牌',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g
  },
  {
    id: 'jwt',
    description: 'JWT / 会话令牌',
    pattern: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
  },
  {
    id: 'windows-user-path',
    description: '真实 Windows 用户目录',
    // 中文注释：源码里反斜杠常被转义成 \\，匹配前会先归一化，这里只需匹配单反斜杠形态。
    pattern: /[A-Za-z]:\\Users\\[^\\/\r\n"'`,;)]+/g
  },
  {
    id: 'personal-path',
    description: '个人资料目录',
    pattern: /[A-Za-z]:\\(?:文档|学业资料|桌面|下载)[\\/][^\r\n"'`,;)]*/g
  },
  {
    id: 'secret-assignment',
    description: '密钥类键值对',
    pattern: /(?:api[_-]?key|app[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|gateway[_-]?token|auth[_-]?token|password|passwd)\s*[:=]\s*["']([^"']{8,})["']/gi,
    valueGroup: 1
  },
  {
    id: 'relay-endpoint',
    description: '模型中转地址（不应出现在公开仓）',
    // 中文注释：只按形态匹配"非官方域名 + /v1"或带端口的 http 地址，不把真实地址写进本脚本。
    pattern: /\bhttps?:\/\/(?!(?:api\.openai\.com|api\.anthropic\.com|localhost|127\.0\.0\.1|example\.(?:com|invalid))\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::\d{2,5})?\/v\d\b/g
  },
  {
    id: 'http-host-port',
    description: '带端口的明文主机地址',
    pattern: /\bhttp:\/\/(?!localhost|127\.0\.0\.1)[A-Za-z0-9.-]+\.[A-Za-z]{2,}:\d{2,5}\b/g
  }
];

function isPlaceholder(value) {
  return PLACEHOLDER_VALUE.test(String(value).trim());
}

// 中文注释：JS 源码把单个反斜杠写成两个，所以盘符+用户目录的真实路径在文件字节里是双反斜杠。
// 中文注释：不先归一化就直接匹配，测试文件里的真实用户名会整整绕过审计 —— 这正是本轮发现的审计漏洞。
// 中文注释：本文件自身不写任何示例路径，避免审计脚本自己触发规则。
function normalize(text) {
  return text.replaceAll('\\\\', '\\');
}

function scanText(text) {
  const findings = [];
  const normalized = normalize(text);
  const lines = normalized.split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const rule of RULES) {
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match = pattern.exec(line);
      while (match !== null) {
        const value = rule.valueGroup ? match[rule.valueGroup] : match[0];
        if (!isPlaceholder(value)) {
          findings.push({ rule: rule.id, description: rule.description, line: index + 1, sample: value.slice(0, 24) });
        }
        if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
        match = pattern.exec(line);
      }
    }
    // 中文注释：再用运行时脱敏模块复查一遍，两套规则互为兜底。
    for (const leak of findLeaks(line)) {
      if (isPlaceholder(leak)) continue;
      if (findings.some((item) => item.line === index + 1)) continue;
      findings.push({ rule: 'redact-module', description: '脱敏模块判定为敏感形态', line: index + 1, sample: leak.slice(0, 24) });
    }
  });

  return findings;
}

// 中文注释：统计真正读过的文件。如果哪天遍历逻辑写坏了，扫描 0 个文件也会"通过"，
// 中文注释：那就是最危险的假绿灯，所以下面用一个下限硬卡住。
const scanned = { files: 0, bytes: 0 };
const MINIMUM_SCANNED_FILES = 20;

async function walk(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walk(path));
      continue;
    }
    if (SKIPPED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    let text = null;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    scanned.files += 1;
    scanned.bytes += text.length;
    const findings = scanText(text);
    if (findings.length > 0) results.push({ file: relative(root, path), findings });
  }
  return results;
}

const results = await walk(root);
const verbose = argv.includes('--verbose');

if (scanned.files < MINIMUM_SCANNED_FILES) {
  console.error(
    `隐私审计只扫到 ${scanned.files} 个文件（下限 ${MINIMUM_SCANNED_FILES}）。\n` +
      '这说明遍历或过滤逻辑出了问题，"通过"不可信，按失败处理。'
  );
  process.exit(1);
}

if (results.length > 0) {
  const lines = ['隐私审计发现问题（提交前必须处理）：'];
  for (const { file, findings } of results) {
    lines.push(`\n${file}`);
    for (const finding of findings) {
      lines.push(`  第 ${finding.line} 行 [${finding.rule}] ${finding.description}：${finding.sample}…`);
    }
  }
  lines.push('\n处理方式：改用占位值（YOUR_ / EXAMPLE / PLACEHOLDER），或把真实值移到私有目录 config/ 下。');
  console.error(lines.join('\n'));
  process.exitCode = 1;
} else {
  const message = '隐私审计通过：未发现密钥、真实本机路径、中转地址或运行数据。';
  console.log(
    verbose
      ? `${message}\n共检查 ${scanned.files} 个文件、${(scanned.bytes / 1024).toFixed(1)} KB，规则 ${RULES.length} 条。`
      : `${message}（${scanned.files} 个文件 / ${RULES.length} 条规则）`
  );
}
