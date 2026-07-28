// 中文注释：一个很小的 PowerShell 词法扫描器，只做一件事：
// 中文注释：把注释和字符串字面量“抹白”成空格，同时保留换行，让行号不变。
//
// 为什么需要它：
//   本仓库的 .ps1 脚本刻意在注释和提示文案里写出错误示范，例如
//   “5.1 上 ConvertFrom-Json 没有 -Depth 参数”“InteractiveToken 不是合法值”。
//   如果卫生检查直接对原始文本做正则匹配，这些解释性文字会被误判成真实缺陷。
//   所以先把注释和字符串抹掉，再对剩下的可执行代码做检查。
//
// 覆盖的词法结构：
//   - 块注释 <# ... #>
//   - 行注释 #...（只有出现在 token 开头才算注释）
//   - 单引号字符串 '...'，其中 '' 表示一个引号
//   - 双引号字符串 "..."，其中 "" 表示一个引号，反引号 ` 转义下一个字符
//   - here-string @'...'@ 与 @"..."@（终止符必须顶行）

const AUTOMATIC_VARIABLES = Object.freeze([
  '_',
  'args',
  'error',
  'false',
  'foreach',
  'home',
  'host',
  'input',
  'lastexitcode',
  'matches',
  'myinvocation',
  'null',
  'pid',
  'profile',
  'pscommandpath',
  'psitem',
  'psscriptroot',
  'pwd',
  'stacktrace',
  'switch',
  'this',
  'true'
]);

// 中文注释：'#' 只有位于 token 开头时才开始注释；abc#def 在 PowerShell 里是一个整词。
function startsComment(text, index) {
  if (index === 0) return true;
  return /[\s(){}[\];,|=&<>+*/]/.test(text[index - 1]);
}

// 中文注释：@' 或 @" 只有紧跟换行时才是 here-string，否则只是普通字符。
function startsHereString(text, index) {
  return /^[ \t]*\r?\n/.test(text.slice(index + 2));
}

function blankChar(character) {
  return character === '\n' || character === '\r' ? character : ' ';
}

/**
 * 把 PowerShell 源码里的注释（可选：字符串）替换成等长空格。
 * 返回值与输入等长、行号一一对应，可以直接按行切开报告位置。
 */
export function stripPowerShellSource(text, options = {}) {
  const blankStrings = options.blankStrings === true;
  const out = [];
  const total = text.length;
  let index = 0;
  let state = 'code';
  let hereQuote = null;

  while (index < total) {
    const character = text[index];
    const nextCharacter = index + 1 < total ? text[index + 1] : '';

    if (state === 'code') {
      if (character === '<' && nextCharacter === '#') {
        state = 'block';
        out.push('  ');
        index += 2;
        continue;
      }
      if (character === '#' && startsComment(text, index)) {
        state = 'line';
        out.push(' ');
        index += 1;
        continue;
      }
      if (
        character === '@' &&
        (nextCharacter === "'" || nextCharacter === '"') &&
        startsHereString(text, index)
      ) {
        hereQuote = nextCharacter;
        state = 'here';
        out.push('  ');
        index += 2;
        continue;
      }
      if (character === "'") {
        state = 'single';
        out.push(blankStrings ? ' ' : character);
        index += 1;
        continue;
      }
      if (character === '"') {
        state = 'double';
        out.push(blankStrings ? ' ' : character);
        index += 1;
        continue;
      }
      out.push(character);
      index += 1;
      continue;
    }

    if (state === 'block') {
      if (character === '#' && nextCharacter === '>') {
        state = 'code';
        out.push('  ');
        index += 2;
        continue;
      }
      out.push(blankChar(character));
      index += 1;
      continue;
    }

    if (state === 'line') {
      if (character === '\n' || character === '\r') {
        state = 'code';
        out.push(character);
        index += 1;
        continue;
      }
      out.push(' ');
      index += 1;
      continue;
    }

    if (state === 'single') {
      if (character === "'" && nextCharacter === "'") {
        out.push(blankStrings ? '  ' : "''");
        index += 2;
        continue;
      }
      if (character === "'") {
        state = 'code';
        out.push(blankStrings ? ' ' : character);
        index += 1;
        continue;
      }
      out.push(blankStrings ? blankChar(character) : character);
      index += 1;
      continue;
    }

    if (state === 'double') {
      if (character === '`' && nextCharacter !== '') {
        out.push(blankStrings ? ' ' + blankChar(nextCharacter) : character + nextCharacter);
        index += 2;
        continue;
      }
      if (character === '"' && nextCharacter === '"') {
        out.push(blankStrings ? '  ' : '""');
        index += 2;
        continue;
      }
      if (character === '"') {
        state = 'code';
        out.push(blankStrings ? ' ' : character);
        index += 1;
        continue;
      }
      out.push(blankStrings ? blankChar(character) : character);
      index += 1;
      continue;
    }

    // state === 'here'
    if (character === '\n' && text.slice(index + 1, index + 3) === `${hereQuote}@`) {
      state = 'code';
      hereQuote = null;
      out.push('\n  ');
      index += 3;
      continue;
    }
    out.push(blankChar(character));
    index += 1;
  }

  return out.join('');
}

/** 只抹注释，保留字符串（用于需要看提示文案的检查）。 */
export function stripPowerShellComments(text) {
  return stripPowerShellSource(text, { blankStrings: false });
}

/** 抹掉注释和字符串，只留可执行语法（卫生检查默认用这个）。 */
export function powerShellCodeOnly(text) {
  return stripPowerShellSource(text, { blankStrings: true });
}

/** 把源码按行拆开，返回 { number, raw, code } 便于报告精确行号。 */
export function powerShellCodeLines(text) {
  const raw = text.split(/\r?\n/);
  const code = powerShellCodeOnly(text).split(/\r?\n/);
  return raw.map((line, position) => ({
    number: position + 1,
    raw: line,
    code: code[position] ?? ''
  }));
}

// 中文注释：`$null = 某个命令` 是 PowerShell 官方推荐的丢弃输出写法，
// 中文注释：比 `| Out-Null` 快得多，属于惯例而不是缺陷，所以从"禁止赋值"名单里排除。
const ASSIGNABLE_BY_CONVENTION = Object.freeze(['null']);

const ASSIGNMENT_FORBIDDEN_VARIABLES = Object.freeze(
  AUTOMATIC_VARIABLES.filter((name) => !ASSIGNABLE_BY_CONVENTION.includes(name))
);

export { AUTOMATIC_VARIABLES, ASSIGNMENT_FORBIDDEN_VARIABLES };
