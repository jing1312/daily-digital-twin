import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function createControlPlaneHealth({ home, now = () => new Date(), pid = process.pid } = {}) {
  if (!home) throw new Error('健康记录器缺少 DAILY_TWIN_HOME');
  const path = join(home, 'data', 'control-plane-health.json');
  let state = null;

  async function persist() {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
    return structuredClone(state);
  }

  return {
    path,
    async start() {
      const timestamp = now().toISOString();
      state = { status: 'running', pid, startedAt: timestamp, lastHeartbeatAt: timestamp, stoppedAt: null };
      return persist();
    },
    async heartbeat() {
      if (!state || state.status !== 'running') throw new Error('控制平面尚未启动，不能写心跳');
      state.lastHeartbeatAt = now().toISOString();
      return persist();
    },
    async stop() {
      if (!state) return null;
      const timestamp = now().toISOString();
      state.status = 'stopped';
      state.lastHeartbeatAt = timestamp;
      state.stoppedAt = timestamp;
      return persist();
    }
  };
}
