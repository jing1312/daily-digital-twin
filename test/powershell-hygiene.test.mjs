import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSIGNMENT_FORBIDDEN_VARIABLES,
  AUTOMATIC_VARIABLES,
  powerShellCodeLines,
  powerShellCodeOnly,
  stripPowerShellComments
} from '../scripts/lib/powershell-source.mjs';

// 中文注释：沙箱和 CI 里不一定装了 PowerShell，所以这些约束用 Node 侧的词法检查兜住，
// 中文注释：更深的静态检查交给 CI 里的 PSScriptAnalyzer。
//
// 关键设计：所有“禁止出现”的规则都跑在 powerShellCodeOnly() 的结果上，
// 也就是注释和字符串都已经被抹成空格之后的可执行代码。
// 因为本仓库的脚本刻意在文档注释里写出错误示范（例如 “InteractiveToken 不是合法值”），
// 直接对原文匹配会把解释文字当成缺陷。

const SCRIPT_DIRECTORY = 'platform/windows';
const BOM = '\uFEFF';

// 中文注释：每条规则都要能被下面的“负向对照”触发，否则规则等于没生效。
const FORBIDDEN_PATTERNS = [
  {
    id: 'null-coalescing',
    pattern: /\?\?/,
    reason: '?? 空合并运算符是 PowerShell 7 才有的',
    bait: '$value = $a ?? $b'
  },
  {
    id: 'null-conditional',
    pattern: /\$\w+\?\./,
    reason: '?. 空条件访问是 PowerShell 7 才有的',
    bait: '$name = $item?.Name'
  },
  // 中文注释：这里刻意不加 “(if ...) / $x = if (...)” 这类规则。
  // 中文注释：沙箱里只有 PowerShell 7，无法证明 5.1 的语法边界；PSScriptAnalyzer 的
  // 中文注释：PSUseCompatibleSyntax 也没有把它们标成版本相关。真正的 5.1 语法判定
  // 中文注释：交给 CI 里 windows-latest 上的 Windows PowerShell 5.1 解析器（见 .github/workflows/ci.yml）。
  {
    id: 'convertfrom-json-depth',
    pattern: /ConvertFrom-Json[^|\r\n]*-Depth/,
    reason: 'Windows PowerShell 5.1 的 ConvertFrom-Json 没有 -Depth 参数',
    bait: '$data = Get-Content x.json -Raw | ConvertFrom-Json -Depth 12'
  },
  {
    id: 'hardcoded-chrome-profile',
    pattern: /--browser-profile\s+chrome\b/,
    reason: '内置 chrome profile 按定义就是 Chrome 扩展，profile 必须由 browser-router.mjs 决定（B15）',
    bait: "& openclaw browser open --browser-profile chrome 'https://example.invalid'"
  },
  {
    id: 'invalid-logontype',
    pattern: /-LogonType\s+InteractiveToken/,
    reason: 'InteractiveToken 不是 New-ScheduledTaskPrincipal 的合法枚举值（B19）',
    bait: 'New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType InteractiveToken'
  },
  {
    id: 'finite-execution-time-limit',
    pattern: /ExecutionTimeLimit\s+\(New-TimeSpan/,
    reason: '7x24 常驻任务不能设有限运行时长，否则会被计划任务杀掉（B19）',
    bait: 'New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 24)'
  },
  {
    id: 'out-file-utf8-bom',
    pattern: /Out-File\s+[^|\r\n]*-Encoding\s+utf8\b/i,
    reason: '5.1 的 Out-File -Encoding utf8 会写 BOM，Node 的 JSON.parse 会直接抛错',
    bait: '$json | Out-File -FilePath $target -Encoding utf8'
  },
  {
    id: 'get-counter',
    pattern: /\bGet-Counter\b/,
    reason: 'Get-Counter 的计数器路径在中文 Windows 上是本地化的，取 CPU 必须走 CIM',
    bait: "Get-Counter '\\Processor(_Total)\\% Processor Time'"
  }
];

function listScripts() {
  return readdirSync(SCRIPT_DIRECTORY)
    .filter((name) => name.endsWith('.ps1'))
    .sort();
}

function readScript(name) {
  return readFileSync(join(SCRIPT_DIRECTORY, name), 'utf8');
}

// 中文注释：把 param( ... ) 里真正声明的参数名抽出来。
// 中文注释：只认区域开头、逗号后、或属性/类型 ] 后面紧跟的 $Name，
// 中文注释：这样 [string]$Root = $PSScriptRoot 里的默认值不会被误当成参数名。
function declaredParameterNames(code) {
  const names = [];
  const opener = /\bparam\s*\(/gi;
  let match = opener.exec(code);
  while (match) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    while (cursor < code.length && depth > 0) {
      if (code[cursor] === '(') depth += 1;
      else if (code[cursor] === ')') depth -= 1;
      cursor += 1;
    }
    const region = code.slice(match.index + match[0].length, cursor - 1);
    const declaration = /(?:^|[,\]])\s*\$([A-Za-z_]\w*)/g;
    let parameter = declaration.exec(region);
    while (parameter) {
      names.push(parameter[1]);
      parameter = declaration.exec(region);
    }
    match = opener.exec(code);
  }
  return names;
}

test('platform/windows 下确实有脚本，避免这组测试变成空跑', () => {
  const scripts = listScripts();
  assert.ok(scripts.length >= 8, `期望至少 8 个脚本，实际 ${scripts.length}`);
  assert.ok(scripts.includes('DailyTwin.Common.ps1'), '公共库必须存在，其他脚本都点号引入它');
  assert.ok(scripts.includes('Write-DailyTwinTelemetry.ps1'), 'src/core/telemetry.mjs 依赖这个脚本存在');
});

test('每个 .ps1 都必须是 UTF-8 with BOM', () => {
  // 中文注释：Windows PowerShell 5.1 读没有 BOM 的 UTF-8 文件时按本地代码页解码，
  // 中文注释：中文提示会变成 "璇峰湪娴忚鍣" 这种乱码，然后原样发到飞书。
  for (const name of listScripts()) {
    assert.equal(readScript(name)[0], BOM, `${name} 缺少 UTF-8 BOM`);
  }
});

test('每个 .ps1 都使用 CRLF 换行', () => {
  for (const name of listScripts()) {
    const lonelyLineFeeds = (readScript(name).match(/(?<!\r)\n/g) ?? []).length;
    assert.equal(lonelyLineFeeds, 0, `${name} 含 ${lonelyLineFeeds} 处裸 LF 换行`);
  }
});

test('词法扫描器会抹掉注释和字符串，但保留代码和行号', () => {
  const source = [
    '#Requires -Version 5.1',
    '<#',
    '  这里故意写错误示范：ConvertFrom-Json -Depth 5',
    '#>',
    "$message = 'InteractiveToken 不是合法值'",
    '$real = 1  # 行尾注释里也写 ?? 空合并',
    '@"',
    'here-string 里的 ?? 也不算',
    '"@'
  ].join('\n');
  const code = powerShellCodeOnly(source);
  const lines = code.split('\n');

  assert.equal(lines.length, 9, '行数必须与原文一致');
  assert.equal(code.length, source.length, '抹白后长度必须与原文一致，行号才可信');
  assert.ok(!/ConvertFrom-Json/.test(code), '块注释里的内容应被抹掉');
  assert.ok(!/InteractiveToken/.test(code), '字符串里的内容应被抹掉');
  assert.ok(!/\?\?/.test(code), '行尾注释和 here-string 里的内容应被抹掉');
  assert.match(lines[4], /^\$message = /, '赋值语句本身必须保留');
  assert.match(lines[5], /^\$real = 1/, '代码部分必须保留');

  // 中文注释：只抹注释的模式要保留字符串，供需要读提示文案的检查使用。
  const withStrings = stripPowerShellComments(source);
  assert.ok(withStrings.includes('InteractiveToken'), '只抹注释时字符串应保留');
  assert.ok(!withStrings.includes('ConvertFrom-Json'), '只抹注释时注释仍要抹掉');
});

test('负向对照：每条禁止规则都能在合成的坏脚本上触发', () => {
  // 中文注释：如果抹白逻辑写错，所有规则都会静默失效。这条测试保证规则真的还在工作。
  for (const rule of FORBIDDEN_PATTERNS) {
    const bad = powerShellCodeOnly(`#Requires -Version 5.1\r\n${rule.bait}\r\n`);
    assert.ok(rule.pattern.test(bad), `规则 ${rule.id} 已失效：诱饵没有被匹配到`);
  }
});

test('负向对照：把违规写法放进注释或字符串时不得报警', () => {
  for (const rule of FORBIDDEN_PATTERNS) {
    const escapedForSingleQuotes = rule.bait.replaceAll("'", "''");
    const documented = powerShellCodeOnly(
      ['#Requires -Version 5.1', `# 反例：${rule.bait}`, `$hint = '${escapedForSingleQuotes}'`, ''].join('\r\n')
    );
    assert.ok(!rule.pattern.test(documented), `规则 ${rule.id} 误伤了注释或字符串里的文档说明`);
  }
});

test('可执行代码里不得出现任何禁止写法', () => {
  const offenders = [];
  for (const name of listScripts()) {
    for (const line of powerShellCodeLines(readScript(name))) {
      for (const rule of FORBIDDEN_PATTERNS) {
        if (rule.pattern.test(line.code)) {
          offenders.push(`${name}:${line.number} [${rule.id}] ${rule.reason}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `发现禁止写法：\n${offenders.join('\n')}`);
});

test('不得给 PowerShell 自动变量赋值（B18）', () => {
  // 中文注释：$args 会和函数真正的参数数组打架，$matches 会被下一次 -match 直接冲掉。
  const offenders = [];
  for (const name of listScripts()) {
    for (const line of powerShellCodeLines(readScript(name))) {
      for (const variable of ASSIGNMENT_FORBIDDEN_VARIABLES) {
        const assignment = new RegExp(`\\$${variable}\\b\\s*(?:\\+|-|\\*|/)?=(?!=)`, 'i');
        if (assignment.test(line.code)) {
          offenders.push(`${name}:${line.number} -> $${variable}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `发现对自动变量赋值：\n${offenders.join('\n')}`);
});

test('负向对照：自动变量赋值检查确实能抓到 $args 和 $matches', () => {
  const bait = powerShellCodeOnly('$args = @()\r\n$matches = $null\r\n');
  const hits = ASSIGNMENT_FORBIDDEN_VARIABLES.filter((variable) =>
    new RegExp(`\\$${variable}\\b\\s*(?:\\+|-|\\*|/)?=(?!=)`, 'i').test(bait)
  );
  assert.deepEqual(hits.sort(), ['args', 'matches']);
  // 中文注释：$null = ... 是官方推荐的丢弃写法，不能被这条规则误伤。
  const discardIdiom = powerShellCodeOnly('$null = Get-Something\r\n');
  assert.ok(
    !ASSIGNMENT_FORBIDDEN_VARIABLES.some((variable) =>
      new RegExp(`\\$${variable}\\b\\s*(?:\\+|-|\\*|/)?=(?!=)`, 'i').test(discardIdiom)
    ),
    '$null = ... 被误判为缺陷'
  );
});

test('不得声明与自动变量同名的参数（B18 的另一种形态）', () => {
  const offenders = [];
  for (const name of listScripts()) {
    const code = powerShellCodeOnly(readScript(name));
    for (const parameter of declaredParameterNames(code)) {
      if (AUTOMATIC_VARIABLES.includes(parameter.toLowerCase())) {
        offenders.push(`${name} -> -${parameter}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `参数名占用了自动变量：\n${offenders.join('\n')}`);
});

test('负向对照：参数名检查能抓到 -Profile 和 -Home，且不误伤默认值', () => {
  const good = 'param(\r\n  [string]$Root = $PSScriptRoot,\r\n  [switch]$Force\r\n)\r\n';
  assert.deepEqual(declaredParameterNames(good), ['Root', 'Force']);

  const bad = 'param(\r\n  [string]$Profile,\r\n  [string]$Home\r\n)\r\n';
  const flagged = declaredParameterNames(bad).filter((parameter) =>
    AUTOMATIC_VARIABLES.includes(parameter.toLowerCase())
  );
  assert.deepEqual(flagged, ['Profile', 'Home']);
});

test('每个脚本都声明最低版本并统一 UTF-8 输出', () => {
  for (const name of listScripts()) {
    const text = readScript(name);
    assert.match(text, /#Requires -Version 5\.1/, `${name} 缺少 #Requires -Version 5.1`);
    if (name === 'DailyTwin.Common.ps1') continue;
    assert.match(text, /DailyTwin\.Common\.ps1/, `${name} 未点号引入公共库`);
    assert.match(text, /Set-DailyTwinConsoleEncoding/, `${name} 未设置 UTF-8 输出编码`);
  }
});

test('调用到的 DailyTwin 公共函数都必须真的定义过', () => {
  // 中文注释：拼错函数名在 PowerShell 里只会在运行到那一行时才炸，所以在这里静态兜住。
  const defined = new Set();
  const called = new Map();
  for (const name of listScripts()) {
    const code = powerShellCodeOnly(readScript(name));
    for (const match of code.matchAll(/^\s*function\s+([A-Za-z]+-DailyTwin[A-Za-z]*)/gim)) {
      defined.add(match[1].toLowerCase());
    }
    for (const match of code.matchAll(/\b([A-Za-z]+-DailyTwin[A-Za-z]*)\b/g)) {
      if (!called.has(match[1].toLowerCase())) called.set(match[1].toLowerCase(), `${name}`);
    }
  }
  const missing = [...called.entries()]
    .filter(([lowered]) => !defined.has(lowered))
    .map(([lowered, where]) => `${lowered} (首次出现于 ${where})`);
  assert.ok(defined.size >= 8, `公共库应定义至少 8 个函数，实际 ${defined.size}`);
  assert.deepEqual(missing, [], `调用了未定义的函数：\n${missing.join('\n')}`);
});
