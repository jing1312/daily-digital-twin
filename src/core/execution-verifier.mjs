// 中文注释：执行结果校验。这是硬需求，不是加分项 ——
// 中文注释：曾出现模型声称"VS Code 已打开、进程已确认在运行"，实际该软件根本没安装。
// 中文注释：因此没有真实证据的任务不允许标记 completed，只能落 partial 并说明未通过验证。

export const EVIDENCE_KINDS = new Set(['process', 'window', 'page', 'file']);

export class EvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EvidenceError';
    this.code = 'invalid_evidence';
  }
}

// 中文注释：校验证据结构。process 类证据必须带真实 PID 和进程名，否则等于没验证。
export function validateEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') throw new EvidenceError('证据必须是对象');
  const kind = String(evidence.kind ?? '').trim();
  if (!EVIDENCE_KINDS.has(kind)) {
    throw new EvidenceError(`证据类型必须是 ${[...EVIDENCE_KINDS].join(' / ')}，实际为 ${kind || '(空)'}`);
  }
  if (kind === 'process') {
    const processId = Number(evidence.processId);
    if (!Number.isInteger(processId) || processId <= 0) throw new EvidenceError('process 证据需要正整数 processId');
    if (!String(evidence.processName ?? '').trim()) throw new EvidenceError('process 证据需要 processName');
  }
  if ((kind === 'window' || kind === 'page' || kind === 'file') && !String(evidence.target ?? '').trim()) {
    throw new EvidenceError(`${kind} 证据需要 target（窗口标题、页面标识或文件路径）`);
  }
  return {
    kind,
    target: evidence.target ? String(evidence.target) : null,
    processId: kind === 'process' ? Number(evidence.processId) : null,
    processName: kind === 'process' ? String(evidence.processName).trim() : null,
    detail: evidence.detail ? String(evidence.detail) : null
  };
}

// 中文注释：登记一条执行证据。
export function recordExecutionEvidence(store, taskId, evidence) {
  const normalized = validateEvidence(evidence);
  const stored = store.insertExecutionEvidence({ taskId, ...normalized });
  store.recordEvent(taskId, store.getTask(taskId).state, `执行证据：${normalized.kind}`);
  return stored;
}

// 中文注释：判断任务是否已有可接受的证据。
export function verifyExecution(store, taskId, { requiredKinds = null } = {}) {
  const evidence = store.listExecutionEvidence(taskId);
  const matching = requiredKinds
    ? evidence.filter((item) => requiredKinds.includes(item.kind))
    : evidence;
  return {
    verified: matching.length > 0,
    evidenceCount: matching.length,
    evidence: matching
  };
}

// 中文注释：收尾任务。没有证据就不许写 completed —— 宁可报 partial，也不谎报成功。
export function finalizeTask(store, taskId, { summary = null, requireEvidence = true, requiredKinds = null } = {}) {
  const check = verifyExecution(store, taskId, { requiredKinds });
  if (requireEvidence && !check.verified) {
    const task = store.transition(taskId, 'partial', {
      summary,
      reason: '执行结果未通过验证',
      failureReason: '缺少执行验证证据，无法确认动作真的发生'
    });
    return { state: task.state, verified: false, task, check };
  }
  const task = store.transition(taskId, 'completed', { summary });
  return { state: task.state, verified: check.verified, task, check };
}
