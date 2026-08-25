function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function calculateUsageCost(usage = {}, priceTable = {}) {
  const price = priceTable?.models?.[String(usage.model ?? '')];
  if (!price) return null;
  const inputRate = nonNegative(price.inputPerMillion);
  const outputRate = nonNegative(price.outputPerMillion);
  const cachedRate = nonNegative(price.cachedInputPerMillion ?? price.inputPerMillion);
  if (inputRate === null || outputRate === null || cachedRate === null) return null;
  const input = nonNegative(usage.inputTokens) ?? 0;
  const cached = nonNegative(usage.cachedTokens) ?? 0;
  const output = nonNegative(usage.outputTokens) ?? 0;
  const uncachedInput = Math.max(0, input - cached);
  const cost = (uncachedInput * inputRate + cached * cachedRate + output * outputRate) / 1_000_000;
  return Number(cost.toFixed(8));
}
