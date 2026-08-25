// 中文注释：本地私有配置编辑器。起一个只监听 127.0.0.1 的小网页，
// 中文注释：改 planner / executor / scheduler / execution 配置，保存前先走
// 中文注释：validateConfig 校验，坏配置根本写不进盘；顺带提供"测试 API 连通"
// 中文注释：按钮，填完 key 一键验证服务商通不通。
// 中文注释：零依赖（只用 node:http），密钥只落私有目录的 config/runtime.json。

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { HOME_ENV, HomeResolutionError, resolveHome } from '../src/core/home.mjs';
import {
  DEFAULT_CONFIG,
  CONFIG_FILE,
  ConfigError,
  loadConfig,
  mergeConfig,
  validateConfig
} from '../src/core/config.mjs';

const DEFAULT_PORT = 18791;

// 中文注释：推理力度档位。null/空 = 不给 API 传 reasoning_effort 参数。
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

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
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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
      headers: { Authorization: `Bearer ${apiKey}` },
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
  .keyline { display: flex; gap: 8px; align-items: center; }
  .keyline input { flex: 1; }
  .keyline label { margin: 0; white-space: nowrap; display: flex; align-items: center; gap: 4px; }
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
      <div><label>模型</label><input type="text" id="p-model" list="p-models"></div>
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
    <datalist id="p-models"></datalist>
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
      <div><label>模型</label><input type="text" id="e-model" list="e-models"></div>
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
    <datalist id="e-models"></datalist>
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
      <div><label>最大并行槽 maxSlots（1~4）</label><input type="number" id="b-slots"></div>
      <div><label>未结束任务上限 openTaskLimit（1~4）</label><input type="number" id="b-open"></div>
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

// 中文注释：拉取服务商模型列表，填进下拉候选；输入框仍可手输。
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
    const list = document.getElementById(prefix + '-models');
    list.innerHTML = '';
    for (const id of data.models) {
      const option = document.createElement('option');
      option.value = id;
      list.appendChild(option);
    }
    show(resultBox, true, '拉到 ' + data.models.length + ' 个模型，模型输入框里可以下拉选了。');
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
