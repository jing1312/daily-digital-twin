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
