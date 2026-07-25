import { decideResourcePolicy } from './resource-policy.mjs';

// 中文注释：根据资源策略决定任务是否能领取执行槽。
export function canSchedule({ activeCount, foregroundBusy, requiresForeground, resource }) {
  const policy = decideResourcePolicy(resource);
  if (!policy.acceptsNewActions) return { allowed: false, reason: policy.reason, policy };
  if (activeCount >= policy.slotLimit) return { allowed: false, reason: '执行槽已满', policy };
  if (requiresForeground && foregroundBusy) return { allowed: false, reason: '前台操作正在被其他任务占用', policy };
  return { allowed: true, reason: null, policy };
}
