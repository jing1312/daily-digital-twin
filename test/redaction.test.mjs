import assert from 'node:assert/strict';
import test from 'node:test';
import { redactText, redactValue, findLeaks, normalizeSecrets, REDACTED } from '../src/core/redact.mjs';
import { createReceipt } from '../src/core/receipt.mjs';

// 中文注释：这些"敏感样本"一律在运行时拼装，源码里不出现任何完整的密钥形态或真实用户名。
// 中文注释：否则公开仓自己就成了泄露源，隐私审计也会（正确地）把测试文件标红。
const SAMPLE = {
  apiKey: ['sk', 'proj', 'AbCdEf0123456789AbCdEf0123456789'].join('-'),
  githubToken: ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'].join('_'),
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', 'QWxhZGRpbjpvcGVuc2VzYW1l'].join('.'),
  // 中文注释：占位用户名，不使用任何真实姓名。
  userPath: ['C:', 'Users', 'PlaceholderUser', 'twin', 'shot.png'].join('\\'),
  bearer: `Bearer ${['abcdef0123456789', 'ABCDEF'].join('')}`
};

test('B5：空字符串或过短的敏感值不得把正常文本打成筛子', () => {
  // 修复前：sensitiveValues 里出现 '' 时 replaceAll('') 会在每个字符间插入掩码，
  // 修复前：'Biomni 已运行' 变成 '***B***i***o***m***n***i*** ***已***运***行***'。
  const text = redactText('Biomni 已运行', ['', '  ', null, undefined, 1, 'ab']);
  assert.equal(text, 'Biomni 已运行', '无效敏感值必须被忽略');
});

test('B5b：未登记的密钥、真实用户路径与 Cookie 依然会被结构化脱敏', () => {
  const source = [
    `key=${SAMPLE.apiKey}`,
    `shot=${SAMPLE.userPath}`,
    `cookie: session=${SAMPLE.jwt}`,
    `gh=${SAMPLE.githubToken}`,
    `Authorization: ${SAMPLE.bearer}`
  ].join('\n');

  // 修复前：这些值不在 sensitiveValues 名单里，就原样写进回执和日志。
  const redacted = redactText(source);
  assert.equal(redacted.includes(SAMPLE.apiKey), false, 'API 密钥必须被掩码');
  assert.equal(redacted.includes('PlaceholderUser'), false, 'Windows 用户名必须被掩码');
  assert.equal(redacted.includes(SAMPLE.githubToken), false, 'GitHub token 必须被掩码');
  assert.equal(redacted.includes(SAMPLE.jwt), false, 'JWT 必须被掩码');
  assert.match(redacted, /\[REDACTED\]/);
});

test('B5b2：findLeaks 能主动报出仍然泄漏的内容', () => {
  assert.equal(findLeaks('普通文本，没有敏感值').length, 0);
  assert.ok(findLeaks(`token=${SAMPLE.apiKey}`).length > 0);
  assert.ok(findLeaks(`路径 ${SAMPLE.userPath}`).length > 0, '真实用户路径也应被视为泄漏');
});

test('按键名脱敏：结构里凡是密钥类字段一律掩码，不看值长什么样', () => {
  const value = redactValue({
    appSecret: 'PLACEHOLDER_VALUE',
    access_token: 'PLACEHOLDER_VALUE',
    verification_code: '123456',
    pageTitle: 'Biomni',
    nested: { cookies: 'a=b', note: '正常内容' }
  });

  assert.equal(value.appSecret, REDACTED);
  assert.equal(value.access_token, REDACTED);
  assert.equal(value.verification_code, REDACTED);
  assert.equal(value.pageTitle, 'Biomni', '非敏感字段不能被误伤');
  assert.equal(value.nested.cookies, REDACTED);
  assert.equal(value.nested.note, '正常内容');
});

test('循环引用不会让脱敏函数栈溢出', () => {
  const cyclic = { name: '任务' };
  cyclic.self = cyclic;
  const result = redactValue(cyclic);
  assert.equal(result.name, '任务');
  assert.equal(result.self, '[CIRCULAR]');
});

test('normalizeSecrets 只保留可用于替换的字符串', () => {
  assert.deepEqual(normalizeSecrets(['abcd', '', null, 7, ' xy ', 'efgh']), ['abcd', 'efgh']);
});

test('回执即使传入畸形敏感值也不会损坏摘要', () => {
  const receipt = createReceipt({
    taskId: 7,
    state: 'partial',
    summary: 'Biomni 已运行',
    evidence: { pageTitle: 'Biomni', cookie: 'session=abc' },
    sensitiveValues: ['', '123456']
  });

  assert.equal(receipt.summary, 'Biomni 已运行');
  assert.equal(receipt.evidence.cookie, REDACTED);
  assert.equal(JSON.stringify(receipt).includes('123456'), false);
});
