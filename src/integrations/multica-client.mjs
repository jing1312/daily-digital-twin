import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redactText } from '../core/redact.mjs';

const execFileAsync = promisify(execFile);

export class MulticaError extends Error {
  constructor(message, code = 'multica_error') {
    super(message);
    this.name = 'MulticaError';
    this.code = code;
  }
}

function parseJsonOrText(stdout) {
  const text = String(stdout ?? '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const key = text.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/)?.[0] ?? null;
    return { key, text };
  }
}

async function defaultRunner(command, args, options) {
  return execFileAsync(command, args, {
    ...options,
    windowsHide: true,
    timeout: options.timeout ?? 30_000,
    maxBuffer: 2 * 1024 * 1024,
    encoding: 'utf8'
  });
}

export class MulticaClient {
  constructor({ command = 'multica', plannerAgent = 'dt-planner', runner = defaultRunner, cwd = undefined, env = process.env } = {}) {
    this.command = command;
    this.plannerAgent = plannerAgent;
    this.runner = runner;
    this.cwd = cwd;
    this.env = env;
  }

  async run(args, { timeout = 30_000 } = {}) {
    try {
      const result = await this.runner(this.command, args, {
        cwd: this.cwd,
        env: this.env,
        shell: false,
        timeout
      });
      return parseJsonOrText(result.stdout);
    } catch (error) {
      const detail = redactText(String(error?.stderr ?? error?.message ?? 'Multica CLI 调用失败')).trim().slice(0, 500);
      throw new MulticaError(`Multica CLI 调用失败：${detail}`, 'multica_cli_failed');
    }
  }

  async dispatch(task, { mode = 'complex' } = {}) {
    const request = String(task.request ?? '').trim();
    const title = `${task.publicId} ${request.replaceAll(/\s+/g, ' ')}`.slice(0, 180);
    const args = ['issue', 'create', '--title', title, '--description', request];
    if (mode === 'complex') args.push('--assignee', this.plannerAgent);
    args.push('--output', 'json');
    const issue = await this.run(args);
    const issueId = issue.key ?? issue.issue_key ?? issue.issueKey ?? issue.id ?? null;
    if (!issueId) throw new MulticaError('Multica 创建 issue 后没有返回可识别的 ID', 'multica_invalid_response');
    return { issueId: String(issueId), mode };
  }

  async getIssue(issueId) {
    return this.run(['issue', 'get', String(issueId), '--output', 'json']);
  }

  async getIssueRuns(issueId) {
    return this.run(['issue', 'runs', String(issueId), '--full-id', '--output', 'json']);
  }

  async getRunMessages(runId) {
    return this.run(['issue', 'run-messages', String(runId), '--output', 'json']);
  }

  async createWorkerIssue({ parentIssueId, marker, title, description, agent } = {}) {
    const safeMarker = String(marker ?? '').trim();
    const safeTitle = String(title ?? '').replaceAll(/\s+/g, ' ').trim();
    if (!parentIssueId || !safeMarker || !safeTitle || !description || !agent) {
      throw new MulticaError('创建 worker issue 缺少 parent/marker/title/description/agent', 'multica_invalid_worker_issue');
    }
    const created = await this.run([
      'issue', 'create', '--title', `[${safeMarker}] ${safeTitle}`.slice(0, 180),
      '--description', String(description), '--parent', String(parentIssueId),
      '--assignee', String(agent), '--output', 'json'
    ]);
    const issueId = created.key ?? created.issue_key ?? created.issueKey ?? created.id ?? null;
    if (!issueId) throw new MulticaError('Multica 创建 worker issue 后没有返回可识别的 ID', 'multica_invalid_response');
    return { issueId: String(issueId) };
  }

  async getIssueUsage(issueId) {
    return this.run(['issue', 'usage', String(issueId), '--output', 'json']);
  }

  async cancelTask(taskId) {
    return this.run(['issue', 'cancel-task', String(taskId)]);
  }

  async rerunIssue(issueId) {
    return this.run(['issue', 'rerun', String(issueId)]);
  }

  normalizeUsage(usage, { issueId = null, taskId, workerId }) {
    const aggregate = usage?.total_input_tokens !== undefined || usage?.task_count !== undefined;
    const cachedTokens = Number(aggregate
      ? usage?.total_cache_read_tokens ?? 0
      : usage?.cache_read_tokens ?? usage?.cached_tokens ?? 0);
    return {
      usageId: aggregate && issueId
        ? `multica:issue:${issueId}:aggregate`
        : usage?.id ?? usage?.run_id ?? usage?.task_id ?? usage?.usage_id ?? null,
      taskId,
      workerId,
      model: String(aggregate ? 'multica-aggregate' : usage?.model ?? 'unknown'),
      inputTokens: Number(aggregate ? usage?.total_input_tokens ?? 0 : usage?.input_tokens ?? 0),
      cachedTokens,
      outputTokens: Number(aggregate ? usage?.total_output_tokens ?? 0 : usage?.output_tokens ?? 0),
      cacheHit: cachedTokens > 0,
      latencyMs: Number(aggregate ? 0 : usage?.duration_ms ?? usage?.latency_ms ?? 0),
      estimatedCost: usage?.estimated_cost ?? null
    };
  }
}
