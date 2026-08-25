import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

function denied(message, code) {
  throw Object.assign(new Error(message), { code });
}
function isInside(root, candidate) {
  const delta = relative(root, candidate);
  return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta));
}

export function createLocalEvidenceSender({ screenshotRoot, sendImage } = {}) {
  if (!screenshotRoot || typeof sendImage !== 'function') throw new Error('证据发送器缺少截图目录或图片 transport');
  const configuredRoot = resolve(screenshotRoot);
  return async (evidence, context = {}) => {
    if (!['page', 'window'].includes(evidence?.kind)) denied('只允许发送页面或窗口截图证据', 'evidence_kind_denied');
    const configuredTarget = resolve(String(evidence?.target ?? ''));
    if (!isInside(configuredRoot, configuredTarget)) denied('证据路径不在私有截图目录内', 'evidence_path_denied');
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extname(configuredTarget).toLowerCase())) {
      denied('证据文件不是允许的图片格式', 'evidence_format_denied');
    }
    const [realRoot, realTarget] = await Promise.all([realpath(configuredRoot), realpath(configuredTarget)]);
    if (!isInside(realRoot, realTarget)) denied('证据符号链接逃出私有截图目录', 'evidence_path_denied');
    const file = await stat(realTarget);
    if (!file.isFile()) denied('证据目标不是文件', 'evidence_not_file');
    await sendImage(realTarget, context);
    return { sent: true, evidenceId: evidence.id ?? null };
  };
}
