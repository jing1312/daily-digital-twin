import { posix, win32 } from 'node:path';

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;

function pathFlavor(value) {
  const raw = String(value ?? '');
  if (WINDOWS_ABSOLUTE.test(raw)) return { api: win32, name: 'win32' };
  if (posix.isAbsolute(raw)) return { api: posix, name: 'posix' };
  return null;
}

export function resolveContainedPath(rootPath, candidatePath, { candidateMustBeAbsolute = false } = {}) {
  const root = String(rootPath ?? '');
  const candidate = String(candidatePath ?? '');
  const rootFlavor = pathFlavor(root);
  const candidateFlavor = pathFlavor(candidate);
  if (!rootFlavor || !candidate || (candidateMustBeAbsolute && !candidateFlavor)) return null;
  if (candidateFlavor && candidateFlavor.name !== rootFlavor.name) return null;
  // 中文注释：posix 下反斜杠是普通字符 —— '..\..\secret.png' 会被 resolve 误判成
  // 中文注释：home 内的一个普通文件名，越界路径摇身一变成为"内部路径"（CI B32 实测）。
  // 中文注释：正常 Linux 路径不会出现反斜杠，凡 root 为 posix 而候选带反斜杠一律拒绝。
  if (rootFlavor.name === 'posix' && candidate.includes('\\')) return null;

  const { api } = rootFlavor;
  const resolvedRoot = api.resolve(root);
  const resolvedCandidate = api.resolve(resolvedRoot, candidate);
  const delta = api.relative(resolvedRoot, resolvedCandidate);
  const isInside = delta === '' || (
    delta !== '..' &&
    !delta.startsWith(`..${api.sep}`) &&
    !api.isAbsolute(delta)
  );
  return isInside ? resolvedCandidate : null;
}
