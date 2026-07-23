export const DISPLAY_BASELINE_TOKENS = 12_000;

export function normalizeContextWindow(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

export function calculateRemainingContext({
  activeContextTokens,
  modelContextWindow,
  baselineTokens = DISPLAY_BASELINE_TOKENS,
}) {
  if (!Number.isSafeInteger(activeContextTokens) || activeContextTokens < 0) {
    throw new TypeError("activeContextTokens must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(baselineTokens) || baselineTokens < 0) {
    throw new TypeError("baselineTokens must be a non-negative safe integer");
  }

  const normalizedWindow = normalizeContextWindow(modelContextWindow);
  if (normalizedWindow === null) {
    return {
      modelContextWindow: null,
      rawRemainingTokens: null,
      effectiveRemainingPercent: null,
    };
  }

  const rawRemainingTokens = Math.max(0, normalizedWindow - activeContextTokens);
  const effectiveWindow = normalizedWindow - baselineTokens;
  if (effectiveWindow <= 0) {
    return {
      modelContextWindow: normalizedWindow,
      rawRemainingTokens,
      effectiveRemainingPercent: 0,
    };
  }

  const effectiveUsed = Math.max(activeContextTokens - baselineTokens, 0);
  const effectiveRemaining = Math.max(effectiveWindow - effectiveUsed, 0);
  const unroundedPercent = (effectiveRemaining / effectiveWindow) * 100;
  const effectiveRemainingPercent = Math.round(
    Math.min(100, Math.max(0, unroundedPercent)),
  );

  return {
    modelContextWindow: normalizedWindow,
    rawRemainingTokens,
    effectiveRemainingPercent,
  };
}

export function validateThresholds(thresholds) {
  if (
    thresholds === null ||
    typeof thresholds !== "object" ||
    !Number.isSafeInteger(thresholds.remainingPercent) ||
    thresholds.remainingPercent < 0 ||
    thresholds.remainingPercent > 100 ||
    !Number.isSafeInteger(thresholds.rawRemainingTokens) ||
    thresholds.rawRemainingTokens < 0
  ) {
    throw new TypeError("Explicit valid rollover thresholds are required");
  }
  return Object.freeze({
    remainingPercent: thresholds.remainingPercent,
    rawRemainingTokens: thresholds.rawRemainingTokens,
  });
}

export function shouldRequestRollover(snapshot, thresholds) {
  const checkedThresholds = validateThresholds(thresholds);
  const percentageReached =
    snapshot.effectiveRemainingPercent !== null &&
    snapshot.effectiveRemainingPercent <= checkedThresholds.remainingPercent;
  const rawTokensReached =
    snapshot.rawRemainingTokens !== null &&
    snapshot.rawRemainingTokens <= checkedThresholds.rawRemainingTokens;
  return percentageReached || rawTokensReached;
}
