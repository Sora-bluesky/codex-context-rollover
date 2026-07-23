import { calculateRemainingContext } from "./remaining-context.mjs";

const SOURCES = new Set(["app-server", "hook-transcript"]);

function requireOpaqueId(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new TypeError(`${name} must be a non-empty opaque id`);
  }
  return value;
}

function requireTokenCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function requireTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("observedAt must be an ISO-compatible timestamp");
  }
  return value;
}

export function createContextSnapshot({
  threadId,
  turnId,
  activeContextTokens,
  accumulatedSessionTokens,
  modelContextWindow,
  observedAt,
  source,
}) {
  if (!SOURCES.has(source)) {
    throw new TypeError("source is not supported");
  }
  const active = requireTokenCount(activeContextTokens, "activeContextTokens");
  const accumulated = requireTokenCount(
    accumulatedSessionTokens,
    "accumulatedSessionTokens",
  );
  const remaining = calculateRemainingContext({
    activeContextTokens: active,
    modelContextWindow,
  });

  return Object.freeze({
    threadId: requireOpaqueId(threadId, "threadId"),
    turnId: requireOpaqueId(turnId, "turnId"),
    activeContextTokens: active,
    accumulatedSessionTokens: accumulated,
    modelContextWindow: remaining.modelContextWindow,
    rawRemainingTokens: remaining.rawRemainingTokens,
    effectiveRemainingPercent: remaining.effectiveRemainingPercent,
    observedAt: requireTimestamp(observedAt),
    source,
  });
}
