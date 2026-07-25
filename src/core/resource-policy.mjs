// 中文注释：基于电源和实时资源决定新动作是否可以启动。
export function decideResourcePolicy({ onAcPower, cpuPercent, availableMemoryGb, diskFreeGb }) {
  if (cpuPercent >= 55 || availableMemoryGb < 8 || diskFreeGb < 20) return { slotLimit: 0, acceptsNewActions: false, reason: '资源不足' };
  if (!onAcPower) return { slotLimit: 1, acceptsNewActions: true, reason: '电池模式' };
  return { slotLimit: 4, acceptsNewActions: true, reason: null };
}
