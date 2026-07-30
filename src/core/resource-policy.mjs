// 中文注释：基于电源和实时资源决定新动作是否可以启动。
// 中文注释：遥测缺失时必须失败关闭 —— 与 undefined 比较恒为 false，旧实现等于所有闸门全开（修 B6）。

export const DEFAULT_RESOURCE_LIMITS = {
  cpuLimitPercent: 55,
  minAvailableMemoryGb: 4,
  fourSlotMemoryGb: 10,
  twoSlotMemoryGb: 6,
  oneSlotMemoryGb: 4,
  minDiskFreeGb: 20,
  batterySlotLimit: 1,
  maxSlots: 4
};

const REQUIRED_NUMERIC_FIELDS = ['cpuPercent', 'availableMemoryGb', 'diskFreeGb'];

export function decideResourcePolicy(telemetry = {}, limits = DEFAULT_RESOURCE_LIMITS) {
  const reading = telemetry ?? {};
  const missing = REQUIRED_NUMERIC_FIELDS.filter((field) => !Number.isFinite(reading[field]));
  if (typeof reading.onAcPower !== 'boolean') missing.push('onAcPower');
  if (missing.length > 0) {
    return { slotLimit: 0, acceptsNewActions: false, reason: '遥测缺失', missing };
  }

  const effective = { ...DEFAULT_RESOURCE_LIMITS, ...(limits ?? {}) };
  if (
    reading.cpuPercent >= effective.cpuLimitPercent ||
    reading.availableMemoryGb < effective.minAvailableMemoryGb ||
    reading.diskFreeGb < effective.minDiskFreeGb
  ) {
    return { slotLimit: 0, acceptsNewActions: false, reason: '资源不足' };
  }

  let memorySlots = 1;
  if (reading.availableMemoryGb >= effective.fourSlotMemoryGb) memorySlots = 4;
  else if (reading.availableMemoryGb >= effective.twoSlotMemoryGb) memorySlots = 2;
  else if (reading.availableMemoryGb >= effective.oneSlotMemoryGb) memorySlots = 1;

  memorySlots = Math.min(memorySlots, effective.maxSlots);
  if (!reading.onAcPower) {
    return { slotLimit: Math.min(memorySlots, effective.batterySlotLimit), acceptsNewActions: true, reason: '电池模式' };
  }
  return {
    slotLimit: memorySlots,
    acceptsNewActions: true,
    reason: memorySlots === effective.maxSlots ? null : `内存档位：${memorySlots} 个重型槽`
  };
}
