import { RolloverError } from "../lib/errors.mjs";

function validOpaqueId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

export async function createThreadOnce({ threadClient, request }) {
  if (typeof threadClient?.start !== "function") {
    throw new RolloverError("thread_client_invalid");
  }
  let response;
  try {
    response = await threadClient.start(request);
  } catch {
    return { status: "ambiguous", reason: "thread_start_response_lost" };
  }

  const successorThreadId =
    response?.threadId ?? response?.thread?.id ?? response?.result?.threadId;
  if (!validOpaqueId(successorThreadId)) {
    return { status: "ambiguous", reason: "thread_start_response_malformed" };
  }
  return { status: "created", successorThreadId };
}

export function reconcileThreadCandidates({ expected, candidates }) {
  if (!Array.isArray(candidates)) {
    throw new RolloverError("reconciliation_candidates_invalid");
  }
  const lowerBound = Date.parse(expected.notBefore);
  const upperBound = Date.parse(expected.notAfter);
  if (!Number.isFinite(lowerBound) || !Number.isFinite(upperBound)) {
    throw new RolloverError("reconciliation_window_invalid");
  }

  const matches = candidates.filter((candidate) => {
    const startedAt = Date.parse(candidate.startedAt);
    return (
      validOpaqueId(candidate.threadId) &&
      candidate.projectRoot === expected.projectRoot &&
      candidate.source === expected.source &&
      candidate.rolloverId === expected.rolloverId &&
      Number.isFinite(startedAt) &&
      startedAt >= lowerBound &&
      startedAt <= upperBound
    );
  });

  if (matches.length !== 1) {
    return {
      status: "needs_decision",
      reason:
        matches.length === 0
          ? "reconciliation_zero_candidates"
          : "reconciliation_multiple_candidates",
    };
  }
  return { status: "reconciled", successorThreadId: matches[0].threadId };
}

export function buildOldThreadGuidance({ successorThreadId, handoffPath }) {
  if (!validOpaqueId(successorThreadId)) {
    throw new RolloverError("successor_thread_id_invalid");
  }
  if (typeof handoffPath !== "string" || handoffPath.length === 0) {
    throw new RolloverError("handoff_path_missing");
  }
  return [
    "Rollover successor is ready.",
    `Successor thread: ${successorThreadId}`,
    `Verified handoff: ${handoffPath}`,
    "Keep this thread recoverable; do not archive or delete it automatically.",
  ].join("\n");
}
