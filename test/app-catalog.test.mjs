import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAppCatalog, resolveApp, resolveWebsite } from '../src/core/app-catalog.mjs';

function writeCatalog(value) {
  const directory = mkdtempSync(join(tmpdir(), 'ddt-catalog-'));
  const path = join(directory, 'apps.json');
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return { directory, path };
}

async function withCatalog(value, work) {
  const { directory, path } = writeCatalog(value);
  try {
    return await work(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('B8：缺少 apps 列表时给出可读错误，而不是读取 undefined 属性崩溃', async () => {
  // 修复前：直接抛 "Cannot read properties of undefined (reading 'filter')"，用户完全看不懂。
  await withCatalog({ websites: [] }, async (path) => {
    const catalog = await loadAppCatalog(path);
    assert.throws(() => resolveApp(catalog, 'vscode'), (error) => {
      assert.match(error.message, /缺少 apps 列表/);
      assert.equal(/Cannot read properties/.test(error.message), false, '不得暴露底层 TypeError');
      return true;
    });
  });
});

test('B8a：既没有 apps 也没有 websites 的文件直接拒绝加载', async () => {
  await withCatalog({ note: '空目录' }, async (path) => {
    await assert.rejects(() => loadAppCatalog(path), /缺少 apps 或 websites 列表/);
  });
});

test('B8b：别名匹配忽略大小写与首尾空格', async () => {
  const catalog = {
    apps: [{ id: 'vscode', aliases: ['VS Code', 'Visual Studio Code'], path: 'C:\\X\\Code.exe' }]
  };
  // 修复前：'vs code' 匹配不到别名 'VS Code'，用户按自然写法说话就找不到软件。
  await withCatalog(catalog, async (path) => {
    const loaded = await loadAppCatalog(path);
    for (const alias of ['vs code', 'VS CODE', '  VS Code  ', 'vscode', 'visual studio code']) {
      assert.equal(resolveApp(loaded, alias).id, 'vscode', `别名 ${JSON.stringify(alias)} 应命中`);
    }
  });
});

test('未登记的软件必须明确拒绝，不允许猜测', async () => {
  await withCatalog({ apps: [{ id: 'vscode', aliases: ['VS Code'] }] }, async (path) => {
    const catalog = await loadAppCatalog(path);
    assert.throws(() => resolveApp(catalog, 'Photoshop'), /未登记应用/);
    assert.throws(() => resolveApp(catalog, '   '), /别名不能为空/);
  });
});

test('别名冲突时拒绝执行而不是随便选一个', async () => {
  const catalog = {
    apps: [
      { id: 'editor-a', aliases: ['编辑器'] },
      { id: 'editor-b', aliases: ['编辑器'] }
    ]
  };
  await withCatalog(catalog, async (path) => {
    const loaded = await loadAppCatalog(path);
    assert.throws(() => resolveApp(loaded, '编辑器'), /存在多个候选/);
  });
});

test('站点解析与应用解析互不串台', async () => {
  const catalog = {
    apps: [{ id: 'vscode', aliases: ['VS Code'] }],
    websites: [{ id: 'biomni', aliases: ['Biomni'], url: 'https://example.invalid/biomni' }]
  };
  await withCatalog(catalog, async (path) => {
    const loaded = await loadAppCatalog(path);
    assert.equal(resolveWebsite(loaded, 'biomni').id, 'biomni');
    assert.throws(() => resolveApp(loaded, 'biomni'), /未登记应用/);
    assert.throws(() => resolveWebsite(loaded, 'VS Code'), /未登记站点/);
  });
});

test('文件缺失或 JSON 非法时报出文件路径便于排错', async () => {
  await assert.rejects(() => loadAppCatalog(join(tmpdir(), 'ddt-not-exist-catalog.json')), /无法读取应用目录/);
  await withCatalog('{ 这不是 JSON', async (path) => {
    await assert.rejects(() => loadAppCatalog(path), /不是合法 JSON/);
  });
});

test('仓库内的示例应用目录本身是合法的', async () => {
  const catalog = await loadAppCatalog('config/apps.example.json');
  assert.equal(resolveApp(catalog, 'vs code').id, 'vscode');
  assert.equal(resolveWebsite(catalog, 'biomni').id, 'biomni');
});
