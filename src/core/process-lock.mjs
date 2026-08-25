import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class ProcessLockError extends Error {
  constructor(message, code = 'process_lock_error') {
    super(message);
    this.name = 'ProcessLockError';
    this.code = code;
  }
}

function defaultIsProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readOwner(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function acquireProcessLock({
  home,
  name,
  pid = process.pid,
  now = () => new Date(),
  isProcessAlive = defaultIsProcessAlive
} = {}) {
  if (!home) throw new ProcessLockError('进程锁缺少 DAILY_TWIN_HOME', 'process_lock_home_missing');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(name ?? ''))) {
    throw new ProcessLockError('进程锁名称非法', 'process_lock_name_invalid');
  }

  const path = join(home, 'data', 'locks', `${name}.lock`);
  await mkdir(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = randomUUID();
    let handle;
    try {
      handle = await open(path, 'wx');
      await handle.writeFile(`${JSON.stringify({ pid, token, startedAt: now().toISOString() })}\n`, 'utf8');
      let released = false;
      return {
        path,
        pid,
        async release() {
          if (released) return false;
          released = true;
          await handle.close();
          const owner = await readOwner(path);
          if (owner?.token !== token) return false;
          try {
            await unlink(path);
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
          return true;
        }
      };
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch {}
      }
      if (error?.code !== 'EEXIST') throw error;
      const owner = await readOwner(path);
      if (isProcessAlive(Number(owner?.pid))) {
        throw new ProcessLockError(
          `Daily Twin ${name} 已在运行（PID ${owner.pid}）`,
          'instance_already_running'
        );
      }
      try {
        await unlink(path);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
    }
  }

  throw new ProcessLockError(`无法取得 Daily Twin ${name} 单实例锁`, 'process_lock_contended');
}
