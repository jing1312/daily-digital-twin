// 中文注释：本地私有配置编辑器。起一个只监听 127.0.0.1 的小网页，
// 中文注释：改 planner / executor / scheduler / execution 配置，保存前先走
// 中文注释：validateConfig 校验，坏配置根本写不进盘；顺带提供"测试 API 连通"
// 中文注释：按钮，填完 key 一键验证服务商通不通。
// 中文注释：零依赖（只用 node:http），密钥只落私有目录的 config/runtime.json。

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { HOME_ENV, HomeResolutionError, resolveHome } from '../src/core/home.mjs';
import {
  DEFAULT_CONFIG,
  CONFIG_FILE,
  ConfigError,
  loadConfig,
  mergeConfig,
  storeOptionsFromConfig,
  validateConfig
} from '../src/core/config.mjs';
import { TaskStore } from '../src/core/task-store.mjs';

const DEFAULT_PORT = 18791;

// 中文注释：仓库根目录（scripts/..）。daemon 启动要用仓库里的 src/runtime.mjs。
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// 中文注释：推理力度档位。null/空 = 不给 API 传 reasoning_effort 参数。
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

// 中文注释：部分中转站按客户端特征放行（实测 ps.air-outer.com 只认 codex/claude CLI 的
// 中文注释：User-Agent，其余一律 401 "unauthorized client detected"）。这里统一带上，
// 中文注释：runtime 侧的 ai-executor / planner 也使用同一常量。
export const CLIENT_USER_AGENT = 'codex_cli_rs/0.21.0';

// 中文注释：网址补全。用户习惯只填到 /v1，甚至只填域名——这里统一补成
// 中文注释：完整的 chat/completions 接口地址；已经写全的保持原样。
// 中文注释：返回 null 表示输入为空。
export function normalizeEndpoint(input) {
  let text = String(input ?? '').trim();
  if (!text) return null;
  text = text.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(text)) return text;
  return `${text}/chat/completions`;
}

// 中文注释：由接口地址倒推出模型列表地址（同源的 /models）。
export function modelsUrlFor(endpoint) {
  return String(endpoint ?? '').replace(/\/chat\/completions$/i, '/models');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 中文注释：把表单补丁深合并进现有配置。普通对象递归合并，其余类型整体替换；
// 中文注释：undefined 表示"这一项不动"。
function deepMergePatch(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isPlainObject(value)) {
      const base = isPlainObject(target[key]) ? target[key] : {};
      target[key] = deepMergePatch({ ...base }, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

// 中文注释：核心写入逻辑（纯函数，方便单测）：
// 中文注释：现有内容 + 表单补丁 → 深合并 → 用默认值补全后整体验校验。
// 中文注释：校验不过就一个字节都不写，杜绝把坏配置存进盘。
export function applyConfigPatch(rawText, patch) {
  let existing = {};
  if (rawText && rawText.trim()) {
    try {
      existing = JSON.parse(rawText);
    } catch (error) {
      return { ok: false, fatal: `现有 ${CONFIG_FILE} 不是合法 JSON：${error.message}。请先手工修好它再保存。` };
    }
    if (!isPlainObject(existing)) return { ok: false, fatal: `现有 ${CONFIG_FILE} 顶层必须是 JSON 对象。` };
  }
  const candidate = deepMergePatch(structuredClone(existing), patch);
  try {
    validateConfig(mergeConfig(DEFAULT_CONFIG, candidate));
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, problems: error.problems };
    throw error;
  }
  return { ok: true, text: `${JSON.stringify(candidate, null, 2)}\n` };
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// 中文注释：用表单里现填的值直接打一次 chat/completions。12 秒超时，
// 中文注释：返回结构化的 ok / error，前端只管展示。地址会先做 /v1 补全；
// 中文注释：reasoningEffort 非空时带上 reasoning_effort 参数（服务商不支持时会报错，能直接看到）。
export async function testChatEndpoint({ apiEndpoint, apiKey, model, reasoningEffort = null }) {
  const endpoint = normalizeEndpoint(apiEndpoint);
  if (!endpoint || !apiKey) return { ok: false, code: 'missing_config', error: 'API 地址和 Key 都要填' };
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const payload = {
      model: model || 'gpt-4o-mini',
      max_tokens: 1024,
      messages: [{ role: 'user', content: '只回复两个字：连通' }]
    };
    if (reasoningEffort) payload.reasoning_effort = reasoningEffort;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'User-Agent': CLIENT_USER_AGENT },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    const raw = await response.text().catch(() => '');
    if (!response.ok) {
      return { ok: false, code: `http_${response.status}`, error: `HTTP ${response.status}：${raw.slice(0, 200)}`, latencyMs };
    }
    let data = null;
    try { data = JSON.parse(raw); } catch { return { ok: false, code: 'bad_json', error: '返回的不是 JSON，请确认 apiEndpoint 指向 chat/completions 接口', latencyMs }; }
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) return { ok: false, code: 'empty_reply', error: '通了但响应里没有 content，检查 model 名是否正确', latencyMs };
    return { ok: true, reply: String(reply).trim().slice(0, 80), latencyMs, model: data?.model ?? null };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error.name === 'AbortError') return { ok: false, code: 'timeout', error: '12 秒没等到响应（网络不通或地址不对）', latencyMs };
    return { ok: false, code: 'fetch_error', error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

// 中文注释：拉取服务商的模型列表（OpenAI 兼容的 GET /models）。
// 中文注释：地址同样支持只填到 /v1。兼容三种返回形态：{data:[{id}]}、纯数组、{models:[...]}。
export async function fetchModelList({ apiEndpoint, apiKey }) {
  const endpoint = normalizeEndpoint(apiEndpoint);
  if (!endpoint || !apiKey) return { ok: false, code: 'missing_config', error: 'API 地址和 Key 都要填' };
  const modelsUrl = modelsUrlFor(endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': CLIENT_USER_AGENT },
      signal: controller.signal
    });
    const raw = await response.text().catch(() => '');
    if (!response.ok) return { ok: false, code: `http_${response.status}`, error: `HTTP ${response.status}：${raw.slice(0, 200)}` };
    let data;
    try { data = JSON.parse(raw); } catch { return { ok: false, code: 'bad_json', error: '模型列表不是 JSON，确认服务商是否支持 /models 接口' }; }
    const rows = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []));
    const ids = rows
      .map((row) => (typeof row === 'string' ? row : (row?.id ?? row?.name ?? row?.model ?? null)))
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim())
      .sort((a, b) => a.localeCompare(b));
    if (ids.length === 0) return { ok: false, code: 'empty_models', error: '接口通了但没解析出任何模型 ID' };
    return { ok: true, models: [...new Set(ids)], url: modelsUrl };
  } catch (error) {
    if (error.name === 'AbortError') return { ok: false, code: 'timeout', error: '12 秒没等到模型列表（网络不通或地址不对）' };
    return { ok: false, code: 'fetch_error', error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

// 中文注释：保存前的补丁规整：网址补全、推理力度空串转 null。
export function normalizePatch(patch) {
  const cleaned = structuredClone(isPlainObject(patch) ? patch : {});
  for (const section of ['planner', 'executor']) {
    const part = cleaned[section];
    if (!isPlainObject(part)) continue;
    if (typeof part.apiEndpoint === 'string') part.apiEndpoint = normalizeEndpoint(part.apiEndpoint);
    if (part.reasoningEffort === '') part.reasoningEffort = null;
  }
  return cleaned;
}

// ---------- 仪表盘（任务列表 / 历史 / 成本 / daemon 启停） ----------

const DAEMON_PID_FILE = 'data/daemon.pid';

export function daemonPidPath(home) {
  return join(home, DAEMON_PID_FILE.replaceAll('\\', '/'));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function readDaemonPid(home) {
  try {
    const text = (await readFile(daemonPidPath(home), 'utf8')).trim();
    const pid = Number.parseInt(text, 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function daemonStatus(home) {
  const pid = await readDaemonPid(home);
  if (pid === null || !isProcessAlive(pid)) return { running: false, pid: null };
  return { running: true, pid };
}

export function startDaemon({ home, nodePath = process.execPath }) {
  const runtimePath = join(REPO_ROOT, 'src', 'runtime.mjs');
  const child = spawn(nodePath, [runtimePath, 'daemon'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DAILY_TWIN_HOME: home },
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  return { ok: true, pid: child.pid };
}

export async function stopDaemon(home) {
  const pid = await readDaemonPid(home);
  if (pid === null) return { ok: false, code: 'not_running', error: 'PID 文件不存在，仪表盘启动过的 daemon 才能这样停。' };
  if (process.platform === 'win32') {
    // 中文注释：/T 连带子进程，/F 强制。detached 进程不是当前进程的子节点，必须用 taskkill。
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    if (result.status !== 0 && isProcessAlive(pid)) {
      return { ok: false, code: 'stop_failed', error: `taskkill 退出码 ${result.status}，进程 ${pid} 可能还在` };
    }
  } else {
    try { process.kill(pid); } catch { /* 进程已不存在，视为已停止 */ }
  }
  await rmSilent(daemonPidPath(home));
  return { ok: true, pid };
}

async function rmSilent(path) {
  try { await import('node:fs/promises').then((fs) => fs.rm(path, { force: true })); } catch { /* 忽略 */ }
}

// 中文注释：把任务行裁成仪表盘需要的字段，长文本截断，不向前端泄整段请求内容。
function slimTask(task, maxText = 80) {
  const clip = (text) => {
    const value = String(text ?? '');
    return value.length > maxText ? `${value.slice(0, maxText)}…` : value;
  };
  return {
    id: task.id,
    publicId: task.publicId ?? null,
    state: task.state,
    taskType: task.taskType ?? 'unknown',
    priority: task.priority ?? 0,
    parentTaskId: task.parentTaskId ?? null,
    request: clip(task.request),
    summary: clip(task.summary),
    updatedAt: task.updatedAt
  };
}

// 中文注释：每次请求单独开一个 store 连接再关闭：daemon 可能同时持库，
// 中文注释 WAL + busyTimeout 允许多连接读，谁也不挡谁。
export async function withStore(home, work) {
  const { config } = await loadConfig(home);
  const dbPath = join(home, String(config.database).replaceAll('\\', '/'));
  await mkdir(dirname(dbPath), { recursive: true });
  const store = new TaskStore(dbPath, storeOptionsFromConfig(config));
  try {
    return work(store);
  } finally {
    store.close();
  }
}

export async function dashboardPayload(home) {
  const [{ config }, daemon] = await Promise.all([
    loadConfig(home),
    daemonStatus(home)
  ]);
  return withStore(home, (store) => ({
    daemon: { ...daemon, schedulerEnabled: config.scheduler?.enabled === true },
    openTasks: store.listOpenTasks().map((task) => slimTask(task)),
    history: store.listCompletedTasks(10).map((task) => slimTask(task)),
    cost: store.totalTokenUsage()
  }));
}

// 中文注释：页面模板。值通过 INITIAL 注入，全部用 .value 赋值，不拼 HTML，天然免注入。
export function renderPage(initialConfig, meta) {
  const safeJson = JSON.stringify({ config: initialConfig, meta }).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daily Twin 私有配置</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: "Microsoft YaHei", system-ui, sans-serif; margin: 0; background: #f4f6f8; color: #1c2733; }
  main { max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin: 0 0 10px; }
  section { background: #fff; border: 1px solid #dde4ea; border-radius: 10px; padding: 18px; margin-bottom: 16px; }
  label { display: block; font-size: 12px; color: #5b6b7b; margin: 10px 0 4px; }
  input[type=text], input[type=password], input[type=number], select { width: 100%; padding: 8px 10px; border: 1px solid #c9d3dc; border-radius: 7px; font-size: 14px; background: #fff; color: inherit; }
  .row { display: flex; gap: 10px; } .row > div { flex: 1; }
  button { padding: 9px 18px; border: 0; border-radius: 8px; font-size: 14px; cursor: pointer; margin-right: 8px; margin-top: 14px; }
  .primary { background: #1668dc; color: #fff; } .primary:hover { background: #0e58c2; }
  .ghost { background: #eef2f6; color: #1c2733; } .ghost:hover { background: #e2e9f0; }
  .hint { font-size: 12px; color: #8595a6; margin-top: 4px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip { padding: 4px 10px; border: 1px solid #c9d3dc; border-radius: 999px; font-size: 12px;
          background: #f2f6fa; color: #1c2733; cursor: pointer; margin: 0; }
  .chip:hover { background: #e4edf5; }
  .chip-active { background: #1668dc; border-color: #1668dc; color: #fff; }
  .keyline { display: flex; gap: 8px; align-items: center; }
  .keyline input { flex: 1; }
  .keyline label { margin: 0; white-space: nowrap; display: flex; align-items: center; gap: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #e4eaf0; vertical-align: top; }
  th { color: #5b6b7b; font-weight: 600; white-space: nowrap; }
  td.mono { white-space: nowrap; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; background: #b6c2cd; }
  .dot.on { background: #22a05a; }
  .st { font-size: 12px; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .st-completed { background: #e6f7ec; color: #116a35; }
  .st-running, .st-queued, .st-retrying { background: #e8f1fc; color: #1668dc; }
  .st-partial, .st-failed { background: #fdecec; color: #a12626; }
  .st-cancelled, .st-paused, .st-waiting_for_user { background: #f2f4f7; color: #5b6b7b; }
  .dashbtns button { margin-top: 0; }
  #result { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); max-width: 680px; width: calc(100% - 32px);
            padding: 12px 16px; border-radius: 9px; font-size: 13px; display: none; box-shadow: 0 6px 24px rgba(0,0,0,.18); white-space: pre-wrap; }
  .ok { background: #e6f7ec; border: 1px solid #9fdcb6; color: #116a35; }
  .bad { background: #fdecec; border: 1px solid #f3b6b6; color: #a12626; }
  .meta { font-size: 12px; color: #8595a6; word-break: break-all; }
  @media (prefers-color-scheme: dark) {
    body { background: #12181f; color: #dbe4ee; }
    section { background: #1a232d; border-color: #2c3946; }
    input[type=text], input[type=password], input[type=number], select { background: #12181f; border-color: #37465a; color: #dbe4ee; }
    .ghost { background: #253141; color: #dbe4ee; }
    label, .hint, .meta { color: #8fa1b5; }
    .ok { background: #12301e; border-color: #2c5c3e; color: #9fe0bb; }
    .bad { background: #341a1a; border-color: #6b3434; color: #f2b8b8; }
  }
</style>
</head>
<body>
<main>
  <h1>Daily Twin 私有配置</h1>
  <p class="meta" id="home-meta"></p>
  <div id="home-warning" style="display:none;background:#fff7e0;border:1px solid #e8cf8a;border-radius:9px;padding:10px 14px;font-size:13px;margin-bottom:14px;"></div>
  <div id="file-problems" style="display:none;background:#fdecec;border:1px solid #f3b6b6;border-radius:9px;padding:10px 14px;font-size:13px;margin-bottom:14px;white-space:pre-wrap;"></div>

  <section>
    <h2>仪表盘</h2>
    <div class="dashbtns">
      <p style="margin:4px 0;"><span class="dot" id="d-dot"></span><span id="d-status">daemon 状态未知</span>
        <button class="ghost" onclick="startDaemon()">启动 daemon</button>
        <button class="ghost" onclick="stopDaemon()">停止 daemon</button>
        <button class="ghost" onclick="refreshDashboard(true)">刷新</button>
      </p>
    </div>
    <p class="hint">这里启动/停止的是调度循环（等效命令行 runtime daemon）；配置改完需要重启 daemon 才生效。</p>

    <h2 style="margin-top:14px;">未结束任务</h2>
    <div id="d-open"></div>

    <h2 style="margin-top:14px;">最近已结束任务</h2>
    <div id="d-history"></div>

    <h2 style="margin-top:14px;">Token 用量</h2>
    <div id="d-cost" class="meta">——</div>
  </section>

  <section>
    <h2>AI 规划器（morning 命令的任务分解）</h2>
    <label>API 地址（填到 /v1 就行，保存时自动补全）</label>
    <input type="text" id="p-endpoint" placeholder="https://api.openai.com/v1" oninput="hintEndpoint('p')">
    <div class="hint" id="p-hint"></div>
    <label>API Key</label>
    <div class="keyline">
      <input type="password" id="p-key" autocomplete="off">
      <label><input type="checkbox" onchange="toggleKey('p-key', this)"> 显示</label>
    </div>
    <div class="row">
      <div><label>模型</label><input type="text" id="p-model"></div>
      <div><label>推理力度</label>
        <select id="p-effort">
          <option value="">默认（不传）</option>
          <option value="minimal">minimal</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
        </select>
      </div>
    </div>
    <div class="chips" id="p-model-chips"></div>
    <button class="ghost" onclick="loadModels('planner')">拉取模型列表</button>
    <button class="ghost" onclick="testApi('planner')">测试连通</button>
  </section>

  <section>
    <h2>AI 执行器（ai_call 任务的实际执行）</h2>
    <label>API 地址（同上，自动补全）</label>
    <input type="text" id="e-endpoint" placeholder="https://api.openai.com/v1" oninput="hintEndpoint('e')">
    <div class="hint" id="e-hint"></div>
    <label>API Key</label>
    <div class="keyline">
      <input type="password" id="e-key" autocomplete="off">
      <label><input type="checkbox" onchange="toggleKey('e-key', this)"> 显示</label>
    </div>
    <div class="row">
      <div><label>模型</label><input type="text" id="e-model"></div>
      <div><label>推理力度</label>
        <select id="e-effort">
          <option value="">默认（不传）</option>
          <option value="minimal">minimal</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
        </select>
      </div>
    </div>
    <div class="chips" id="e-model-chips"></div>
    <div class="row">
      <div><label>结果输出目录（相对私有目录）</label><input type="text" id="e-output"></div>
      <div><label>超时（毫秒）</label><input type="number" id="e-timeout"></div>
    </div>
    <button class="ghost" onclick="loadModels('executor')">拉取模型列表</button>
    <button class="ghost" onclick="testApi('executor')">测试连通</button>
  </section>

  <section>
    <h2>调度器与执行行为</h2>
    <div class="row">
      <div><label>调度开关</label>
        <select id="s-enabled"><option value="false">休眠（默认）</option><option value="true">启用</option></select>
      </div>
      <div><label>轮询间隔（秒）</label><input type="number" id="s-poll"></div>
      <div><label>要求执行证据</label>
        <select id="x-evidence"><option value="true">开启（推荐）</option><option value="false">关闭</option></select>
      </div>
    </div>
    <div class="row">
      <div><label>worker 单次最长分钟数</label><input type="number" id="x-workermin"></div>
      <div><label>私有执行器路径（可空，相对私有目录）</label><input type="text" id="x-module" placeholder="executor/index.mjs"></div>
    </div>
    <p class="hint">私有执行器：把模块放到 私有目录\\&lt;这里填的路径&gt;，daemon 启动时自动装载；加载失败会拒绝启动而不是静默降级。</p>
  </section>

  <section>
    <h2>任务并发与资源档位</h2>
    <div class="row">
      <div><label>最大并行槽 maxSlots（1~8）</label><input type="number" id="b-slots"></div>
      <div><label>未结束任务上限 openTaskLimit（1~64）</label><input type="number" id="b-open"></div>
      <div><label>数据库忙超时（毫秒）</label><input type="number" id="b-busy"></div>
    </div>
    <div class="row">
      <div><label>最少可用内存 GB</label><input type="number" id="r-min"></div>
      <div><label>1 槽内存 GB</label><input type="number" id="r-one"></div>
      <div><label>2 槽内存 GB</label><input type="number" id="r-two"></div>
      <div><label>4 槽内存 GB</label><input type="number" id="r-four"></div>
    </div>
    <p class="hint">内存档位必须满足：最少可用 &le; 1槽 &le; 2槽 &le; 4槽，否则保存时会被拦下。</p>
  </section>

  <button class="primary" onclick="save()">保存配置</button>
  <span class="hint">保存前会做完整校验，非法配置不会被写入。</span>
</main>
<div id="result"></div>

<script>
const INITIAL = ${safeJson};

document.getElementById('home-meta').textContent =
  '私有目录：' + INITIAL.meta.home + '　·　配置文件：' + INITIAL.meta.configPath +
  (INITIAL.meta.exists ? '' : '　（还没创建，第一次保存时会自动生成）');
if (INITIAL.meta.homeWarning) {
  const box = document.getElementById('home-warning');
  box.textContent = '注意：' + INITIAL.meta.homeWarning;
  box.style.display = 'block';
}
if (INITIAL.meta.fileProblems) {
  const box = document.getElementById('file-problems');
  box.textContent = '当前配置文件有问题（保存时会强制重新校验）：\\n- ' + INITIAL.meta.fileProblems.join('\\n- ');
  box.style.display = 'block';
}

function put(id, v) { document.getElementById(id).value = (v === null || v === undefined) ? '' : String(v); }
function get(id) { return document.getElementById(id).value.trim(); }

(function fill() {
  const c = INITIAL.config;
  put('p-endpoint', c.planner && c.planner.apiEndpoint);
  put('p-key', c.planner && c.planner.apiKey);
  put('p-model', c.planner && c.planner.model);
  put('e-endpoint', c.executor && c.executor.apiEndpoint);
  put('e-key', c.executor && c.executor.apiKey);
  put('e-model', c.executor && c.executor.model);
  put('e-output', c.executor && c.executor.outputDir);
  put('e-timeout', c.executor && c.executor.timeoutMs);
  document.getElementById('s-enabled').value = c.scheduler && c.scheduler.enabled ? 'true' : 'false';
  put('s-poll', c.scheduler && c.scheduler.pollSeconds);
  document.getElementById('x-evidence').value = (c.execution && c.execution.requireEvidence === false) ? 'false' : 'true';
  put('x-workermin', c.execution && c.execution.workerMaxMinutes);
  put('x-module', c.execution && c.execution.module);
  put('b-slots', c.maxSlots);
  put('b-open', c.openTaskLimit);
  put('b-busy', c.busyTimeoutMs);
  put('r-min', c.resource && c.resource.minAvailableMemoryGb);
  put('r-one', c.resource && c.resource.oneSlotMemoryGb);
  put('r-two', c.resource && c.resource.twoSlotMemoryGb);
  put('r-four', c.resource && c.resource.fourSlotMemoryGb);
  put('p-effort', c.planner && c.planner.reasoningEffort);
  put('e-effort', c.executor && c.executor.reasoningEffort);
})();

function toggleKey(id, box) {
  document.getElementById(id).type = box.checked ? 'text' : 'password';
}

// ---------- 仪表盘 ----------

function stClass(state) { return 'st st-' + String(state || 'unknown'); }

function renderTaskTable(containerId, rows, emptyText) {
  const container = document.getElementById(containerId);
  container.textContent = '';
  if (!rows || rows.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = emptyText;
    container.appendChild(p);
    return;
  }
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['#', '状态', '类型', '内容', '更新时间']) {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const task of rows) {
    const tr = document.createElement('tr');
    const tdId = document.createElement('td');
    tdId.className = 'mono';
    tdId.textContent = (task.publicId ? task.publicId + ' / ' : '') + task.id;
    tr.appendChild(tdId);
    const tdState = document.createElement('td');
    const span = document.createElement('span');
    span.className = stClass(task.state);
    span.textContent = task.state;
    tdState.appendChild(span);
    tr.appendChild(tdState);
    const tdType = document.createElement('td');
    tdType.textContent = task.taskType;
    tr.appendChild(tdType);
    const tdText = document.createElement('td');
    tdText.textContent = task.request + (task.summary && task.state !== 'running' && task.state !== 'queued' ? ' → ' + task.summary : '');
    tr.appendChild(tdText);
    const tdTime = document.createElement('td');
    tdTime.className = 'mono';
    tdTime.textContent = task.updatedAt ? new Date(task.updatedAt).toLocaleString() : '';
    tr.appendChild(tdTime);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function renderDashboard(data) {
  const dot = document.getElementById('d-dot');
  const status = document.getElementById('d-status');
  if (data.daemon && data.daemon.running) {
    dot.className = 'dot on';
    status.textContent = 'daemon 运行中（PID ' + data.daemon.pid + '）· 调度器' + (data.daemon.schedulerEnabled ? '已启用' : '休眠');
  } else {
    dot.className = 'dot';
    status.textContent = 'daemon 未运行 · 调度器' + (data.daemon && data.daemon.schedulerEnabled ? '已启用' : '休眠');
  }
  renderTaskTable('d-open', data.openTasks, '没有未结束的任务。');
  renderTaskTable('d-history', data.history, '还没有已结束的任务。');
  const cost = data.cost || {};
  document.getElementById('d-cost').textContent =
    'AI 调用 ' + (cost.calls || 0) + ' 次 · 输入 ' + (cost.inputTokens || 0) +
    '（缓存命中 ' + (cost.cachedTokens || 0) + '）· 输出 ' + (cost.outputTokens || 0) +
    ' tokens' + (cost.estimatedCost === null || cost.estimatedCost === undefined ? '' : ' · 估算成本 ¥' + Number(cost.estimatedCost).toFixed(4));
}

async function refreshDashboard(loud) {
  try {
    const res = await fetch('/api/dashboard');
    const data = await res.json();
    renderDashboard(data);
    if (loud) show(resultBox, true, '仪表盘已刷新。');
  } catch (error) {
    if (loud) show(resultBox, false, '仪表盘加载失败：' + error.message);
  }
}

async function daemonControl(action) {
  try {
    const res = await fetch('/api/daemon/' + action, { method: 'POST' });
    const data = await res.json();
    if (data.ok) show(resultBox, true, action === 'start' ? 'daemon 已启动（PID ' + data.pid + '）。' : 'daemon 已停止。');
    else show(resultBox, false, (action === 'start' ? '启动失败' : '停止失败') + '[' + (data.code || '') + ']：' + (data.error || '未知错误'));
  } catch (error) {
    show(resultBox, false, '请求失败：' + error.message);
  }
  refreshDashboard(false);
}

function startDaemon() { return daemonControl('start'); }
function stopDaemon() { return daemonControl('stop'); }

// 中文注释：每 10 秒静默刷新一次仪表盘；后台失败不打扰用户。
setInterval(() => refreshDashboard(false), 10000);
refreshDashboard(false);

// 中文注释：底部提示条。显式取元素，不依赖"元素 id 变全局变量"的非标准行为。
const resultBox = document.getElementById('result');

// 中文注释：地址补全的即时预览——用户只填 /v1，下面实时显示最终会保存的完整接口。
function hintEndpoint(prefix) {
  const value = get(prefix + '-endpoint');
  const hint = document.getElementById(prefix + '-hint');
  if (!value) { hint.textContent = ''; return; }
  let text = value.trim();
  while (text.endsWith('/')) text = text.slice(0, -1);
  if (!text.toLowerCase().endsWith('/chat/completions')) text += '/chat/completions';
  hint.textContent = '将保存为：' + text;
}

// 中文注释：把选中的模型直接写进配置文件（只动 model 字段，其他表单值不掺和）。
async function persistModel(section, modelId) {
  const patch = section === 'planner' ? { planner: { model: modelId } } : { executor: { model: modelId } };
  try {
    const res = await fetch('/api/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch })
    });
    const data = await res.json();
    if (data.ok) show(resultBox, true, '模型已落库：' + modelId);
    else show(resultBox, false, '模型落库失败：' + (data.problems ? data.problems.join('; ') : (data.fatal || data.error || '未知错误')));
  } catch (error) {
    show(resultBox, false, '模型落库失败：' + error.message);
  }
}

// 中文注释：拉取服务商模型列表，填进下拉候选；点击胶囊直接选用并落库。
// 中文注释：主配置默认模型跟首次拉取走 —— 当前模型为空、或不在服务商列表里时，
// 中文注释自动选第一个并立即写盘，避免默认 gpt-4o-mini 在中转站根本不存在。
async function loadModels(section) {
  const prefix = section === 'planner' ? 'p' : 'e';
  const body = { apiEndpoint: get(prefix + '-endpoint'), apiKey: get(prefix + '-key') };
  show(resultBox, true, '正在拉取模型列表……');
  try {
    const res = await fetch('/api/models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.ok) { show(resultBox, false, '拉取失败[' + data.code + ']：' + data.error); return; }
    const chips = document.getElementById(prefix + '-model-chips');
    chips.innerHTML = '';
    for (const id of data.models) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = id;
      chip.onclick = function () {
        document.getElementById(prefix + '-model').value = id;
        const all = chips.querySelectorAll('.chip');
        for (const other of all) other.classList.remove('chip-active');
        chip.classList.add('chip-active');
        persistModel(section, id);
      };
      chips.appendChild(chip);
    }
    const current = get(prefix + '-model');
    if (!current || data.models.indexOf(current) === -1) {
      const picked = data.models[0];
      document.getElementById(prefix + '-model').value = picked;
      chips.querySelector('.chip').classList.add('chip-active');
      await persistModel(section, picked);
      show(resultBox, true, '拉到 ' + data.models.length + ' 个模型；原模型' +
        (current ? '不在服务商列表，已' : '为空，已') + '自动换成 ' + picked + ' 并落库。点胶囊可换。');
    } else {
      const active = chips.querySelectorAll('.chip');
      for (const chip of active) {
        if (chip.textContent === current) chip.classList.add('chip-active');
      }
      show(resultBox, true, '拉到 ' + data.models.length + ' 个模型，点胶囊直接选用（点击即落库）。');
    }
  } catch (error) {
    show(resultBox, false, '拉取失败：' + error.message);
  }
}

function collectPatch() {
  const moduleValue = get('x-module');
  return {
    maxSlots: Number(get('b-slots')),
    openTaskLimit: Number(get('b-open')),
    busyTimeoutMs: Number(get('b-busy')),
    resource: {
      minAvailableMemoryGb: Number(get('r-min')),
      oneSlotMemoryGb: Number(get('r-one')),
      twoSlotMemoryGb: Number(get('r-two')),
      fourSlotMemoryGb: Number(get('r-four'))
    },
    planner: {
      apiEndpoint: get('p-endpoint'), apiKey: get('p-key'), model: get('p-model'),
      reasoningEffort: get('p-effort') || null
    },
    executor: {
      apiEndpoint: get('e-endpoint'), apiKey: get('e-key'), model: get('e-model'),
      reasoningEffort: get('e-effort') || null,
      outputDir: get('e-output'), timeoutMs: Number(get('e-timeout'))
    },
    scheduler: { enabled: document.getElementById('s-enabled').value === 'true', pollSeconds: Number(get('s-poll')) },
    execution: {
      requireEvidence: document.getElementById('x-evidence').value === 'true',
      workerMaxMinutes: Number(get('x-workermin')),
      module: moduleValue === '' ? null : moduleValue
    }
  };
}

function show(el, ok, text) {
  el.className = ok ? 'ok' : 'bad';
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(show._t);
  show._t = setTimeout(() => { el.style.display = 'none'; }, ok ? 4000 : 12000);
}

async function save() {
  const res = await fetch('/api/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patch: collectPatch() })
  });
  const data = await res.json();
  if (data.ok) {
    show(resultBox, true, '已保存到 ' + data.path + '（' + new Date(data.savedAt).toLocaleTimeString() + '）。daemon 正在跑的话需要重启才生效。');
  } else if (data.problems) {
    show(resultBox, false, '校验未通过，没有写盘：\\n- ' + data.problems.join('\\n- '));
  } else {
    show(resultBox, false, data.fatal || data.error || '保存失败');
  }
}

async function testApi(section) {
  const prefix = section === 'planner' ? 'p' : 'e';
  const body = {
    apiEndpoint: get(prefix + '-endpoint'), apiKey: get(prefix + '-key'), model: get(prefix + '-model'),
    reasoningEffort: get(prefix + '-effort') || null
  };
  show(resultBox, true, '正在测试……');
  const res = await fetch('/api/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.ok) {
    show(resultBox, true, '连通成功（' + data.latencyMs + ' ms）模型回复：' + data.reply);
  } else {
    show(resultBox, false, '连通失败[' + data.code + ']：' + data.error);
  }
}
</script>
</body>
</html>`;
}

// 中文注释：组装路由。单独拆出来是为了测试能起在随机端口上。
export function startServer({ home, port = DEFAULT_PORT, host = '127.0.0.1', homeWarning = null } = {}) {
  const configPath = join(home, CONFIG_FILE);

  async function readRawConfig() {
    try {
      return await readFile(configPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return '';
      throw error;
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 200_000) { reject(new Error('请求体过大')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function send(res, status, payload, contentType = 'application/json; charset=utf-8') {
    const body = contentType.startsWith('text/html') ? payload : JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': contentType });
    res.end(body);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && url.pathname === '/') {
        // 中文注释：现有文件坏了也要能打开页面——否则用户没法在网页里把它修好。
        // 中文注释：此时用"默认值 + 文件原文（不校验）"渲染表单，并在顶部红条列出问题。
        let config;
        let fileProblems = null;
        try {
          ({ config } = await loadConfig(home));
        } catch (error) {
          if (!(error instanceof ConfigError)) throw error;
          fileProblems = error.problems;
          const raw = await readFile(configPath, 'utf8');
          config = deepMergePatch(structuredClone(DEFAULT_CONFIG), JSON.parse(raw));
        }
        send(res, 200, renderPage(config, { home, configPath, exists: await fileExists(configPath), homeWarning, fileProblems }), 'text/html; charset=utf-8');
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/config') {
        const raw = await readRawConfig();
        send(res, 200, { path: configPath, exists: raw.trim().length > 0, raw });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/save') {
        const body = JSON.parse(await readBody(req));
        const raw = await readRawConfig();
        const outcome = applyConfigPatch(raw, normalizePatch(body.patch ?? {}));
        if (!outcome.ok) { send(res, 200, outcome); return; }
        await mkdir(join(home, 'config'), { recursive: true });
        await writeFile(configPath, outcome.text, 'utf8');
        send(res, 200, { ok: true, path: configPath, savedAt: new Date().toISOString() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/models') {
        const body = JSON.parse(await readBody(req));
        send(res, 200, await fetchModelList(body ?? {}));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/test') {
        const body = JSON.parse(await readBody(req));
        send(res, 200, await testChatEndpoint(body ?? {}));
        return;
      }

      // 中文注释：仪表盘：任务列表 / 历史 / 成本 / daemon 状态，一次拉全。
      if (req.method === 'GET' && url.pathname === '/api/dashboard') {
        send(res, 200, await dashboardPayload(home));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/daemon/start') {
        const status = await daemonStatus(home);
        if (status.running) {
          send(res, 200, { ok: false, code: 'already_running', error: `daemon 已在运行（PID ${status.pid}）` });
          return;
        }
        const outcome = startDaemon({ home });
        await mkdir(dirname(daemonPidPath(home)), { recursive: true });
        await writeFile(daemonPidPath(home), `${outcome.pid}\n`, 'utf8');
        send(res, 200, { ok: true, pid: outcome.pid });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/daemon/stop') {
        send(res, 200, await stopDaemon(home));
        return;
      }

      send(res, 404, { error: 'not_found' });
    } catch (error) {
      send(res, 500, { error: error.message });
    }
  });

  server.listen(port, host);
  return server;
}

// 中文注释：命令行入口。--port 换端口；--home 与 DAILY_TWIN_HOME 的优先级和其他命令一致。
async function main(argv) {
  const flags = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--port') { index += 1; flags.port = argv[index]; continue; }
    if (String(token).startsWith('--port=')) { flags.port = token.slice('--port='.length); continue; }
    if (token === '--home') { index += 1; flags.home = argv[index]; continue; }
    if (String(token).startsWith('--home=')) { flags.home = token.slice('--home='.length); }
  }
  const port = Number.parseInt(flags.port ?? DEFAULT_PORT, 10);

  // 中文注释：没设 DAILY_TWIN_HOME 时不退出（这是编辑器，不是运行时），
  // 中文注释：回退到用户目录下的 daily-twin-home，并在页面顶部给出醒目提示。
  let home = null;
  let homeWarning = null;
  try {
    home = resolveHome({ cliHome: flags.home ?? null });
  } catch (error) {
    if (!(error instanceof HomeResolutionError)) throw error;
    home = join(homedir(), 'daily-twin-home');
    homeWarning = `没有设置 ${HOME_ENV}，本次用的是默认位置。想让 runtime 命令读到这里的配置，请执行：[Environment]::SetEnvironmentVariable('${HOME_ENV}', '${home.replaceAll("'", "''")}', 'User')`;
  }

  const server = startServer({ home, port: Number.isSafeInteger(port) && port > 0 ? port : DEFAULT_PORT, homeWarning });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  console.log(JSON.stringify({
    started: true,
    url: address,
    home,
    note: '仅监听本机回环地址。Ctrl+C 停止。'
  }, null, 2));

  // 中文注释：Windows 上顺手把浏览器打开，失败不影响服务本身。
  if (process.platform === 'win32') {
    try { const { spawn } = await import('node:child_process'); spawn('cmd', ['/c', 'start', '', address], { detached: true, stdio: 'ignore' }).unref(); } catch {}
  }
}

if (process.argv[1] && process.argv[1].endsWith('config-ui.mjs')) {
  try {
    await main(process.argv);
  } catch (error) {
    console.error(JSON.stringify({ error: { code: error?.code ?? 'config_ui_error', message: error?.message } }, null, 2));
    process.exitCode = 1;
  }
}
