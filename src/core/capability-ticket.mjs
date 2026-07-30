import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

export class CapabilityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
  }
}

function requireSecret(secret) {
  const value = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret ?? ''), 'utf8');
  if (value.length < 32) throw new CapabilityError('能力票密钥至少需要 32 字节', 'weak_secret');
  return value;
}

function normalizePayload(payload) {
  const normalized = {
    version: 1,
    taskId: String(payload?.taskId ?? '').trim(),
    multicaIssueId: String(payload?.multicaIssueId ?? '').trim(),
    workerId: String(payload?.workerId ?? '').trim(),
    websites: [...new Set((payload?.websites ?? []).map(String))].sort(),
    apps: [...new Set((payload?.apps ?? []).map(String))].sort(),
    directories: [...new Set((payload?.directories ?? []).map(String))].sort(),
    actions: [...new Set((payload?.actions ?? []).map(String))].sort(),
    expiresAt: String(payload?.expiresAt ?? '').trim(),
    nonce: String(payload?.nonce ?? '').trim()
  };
  const missing = ['taskId', 'multicaIssueId', 'workerId', 'expiresAt', 'nonce'].filter((key) => !normalized[key]);
  if (missing.length) throw new CapabilityError(`能力票缺少字段：${missing.join(', ')}`, 'invalid_payload');
  if (!Number.isFinite(Date.parse(normalized.expiresAt))) {
    throw new CapabilityError('能力票过期时间无效', 'invalid_payload');
  }
  if (!normalized.actions.length) throw new CapabilityError('能力票至少需要一个动作', 'invalid_payload');
  return normalized;
}

function sign(encodedBody, secret) {
  return createHmac('sha256', requireSecret(secret)).update(encodedBody).digest('base64url');
}

function denied(condition, message, code) {
  if (condition) throw new CapabilityError(message, code);
}

function directoryAllowed(allowedRoots, requestedPath) {
  if (!requestedPath || !isAbsolute(requestedPath)) return false;
  const requested = resolve(requestedPath);
  return allowedRoots.some((root) => {
    if (!isAbsolute(root)) return false;
    const delta = relative(resolve(root), requested);
    return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta));
  });
}

export function issueCapabilityTicket({ secret, payload }) {
  const encodedBody = Buffer.from(JSON.stringify(normalizePayload(payload)), 'utf8').toString('base64url');
  return `${encodedBody}.${sign(encodedBody, secret)}`;
}

export function assertCapabilityRequest(payload, request = {}) {
  denied(request.taskId && request.taskId !== payload.taskId, '任务不匹配', 'task_mismatch');
  denied(request.multicaIssueId && request.multicaIssueId !== payload.multicaIssueId, 'Multica issue 不匹配', 'issue_mismatch');
  denied(request.workerId && request.workerId !== payload.workerId, 'worker 不匹配', 'worker_mismatch');
  denied(request.action && !payload.actions.includes(request.action), '动作未授权', 'action_denied');
  denied(request.website && !payload.websites.includes(request.website), '网站未授权', 'website_denied');
  denied(request.app && !payload.apps.includes(request.app), '软件未授权', 'app_denied');
  denied(request.directory && !directoryAllowed(payload.directories, request.directory), '目录未授权', 'directory_denied');
  return payload;
}

export function verifyCapabilityTicket(ticket, {
  secret,
  store = null,
  consume = false,
  now = new Date(),
  request = {}
} = {}) {
  const [encodedBody, encodedSignature, extra] = String(ticket ?? '').split('.');
  denied(!encodedBody || !encodedSignature || extra !== undefined, '能力票格式无效', 'invalid_ticket');

  const expected = Buffer.from(sign(encodedBody, secret), 'utf8');
  const actual = Buffer.from(encodedSignature, 'utf8');
  denied(expected.length !== actual.length || !timingSafeEqual(expected, actual), '能力票签名无效', 'invalid_signature');

  let payload;
  try {
    payload = normalizePayload(JSON.parse(Buffer.from(encodedBody, 'base64url').toString('utf8')));
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError('能力票正文无效', 'invalid_payload');
  }

  denied(Date.parse(payload.expiresAt) <= now.getTime(), '能力票已过期', 'expired');
  assertCapabilityRequest(payload, request);

  if (consume) {
    denied(!store, '消费能力票需要本机 nonce 存储', 'nonce_store_required');
    const nonceHash = createHash('sha256').update(payload.nonce, 'utf8').digest('hex');
    const consumed = store.consumeCapabilityNonce({
      nonceHash,
      taskPublicId: payload.taskId,
      expiresAt: payload.expiresAt
    });
    denied(!consumed, '能力票已使用，拒绝重放', 'replayed');
  }

  return payload;
}
