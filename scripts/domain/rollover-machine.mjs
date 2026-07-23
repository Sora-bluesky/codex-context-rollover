import { RolloverError } from "../lib/errors.mjs";

export const PHASES = Object.freeze({
  OBSERVING: "Observing",
  REQUESTED: "Requested",
  HANDOFF_VERIFIED: "HandoffVerified",
  MONITOR_PREPARING: "MonitorPreparing",
  MONITOR_ACCEPTED: "MonitorAccepted",
  CREATING_THREAD: "CreatingThread",
  RECONCILE: "Reconcile",
  SUCCESSOR_CREATED: "SuccessorCreated",
  OLD_THREAD_LINKED: "OldThreadLinked",
  COMPLETE: "Complete",
  NEEDS_DECISION: "NeedsDecision",
});

const TRANSITIONS = new Map([
  [`${PHASES.OBSERVING}:threshold_reached`, PHASES.REQUESTED],
  [`${PHASES.REQUESTED}:handoff_verified`, PHASES.HANDOFF_VERIFIED],
  [`${PHASES.HANDOFF_VERIFIED}:watcher_requested`, PHASES.MONITOR_PREPARING],
  [`${PHASES.MONITOR_PREPARING}:watcher_accepted`, PHASES.MONITOR_ACCEPTED],
  [`${PHASES.MONITOR_ACCEPTED}:thread_creation_started`, PHASES.CREATING_THREAD],
  [`${PHASES.CREATING_THREAD}:thread_created`, PHASES.SUCCESSOR_CREATED],
  [`${PHASES.CREATING_THREAD}:creation_ambiguous`, PHASES.RECONCILE],
  [`${PHASES.RECONCILE}:thread_reconciled`, PHASES.SUCCESSOR_CREATED],
  [`${PHASES.SUCCESSOR_CREATED}:old_thread_linked`, PHASES.OLD_THREAD_LINKED],
  [`${PHASES.OLD_THREAD_LINKED}:completed`, PHASES.COMPLETE],
]);

const NEEDS_DECISION_FROM = new Set([
  PHASES.REQUESTED,
  PHASES.HANDOFF_VERIFIED,
  PHASES.MONITOR_PREPARING,
  PHASES.MONITOR_ACCEPTED,
  PHASES.CREATING_THREAD,
  PHASES.RECONCILE,
  PHASES.SUCCESSOR_CREATED,
  PHASES.OLD_THREAD_LINKED,
]);

export function initialRolloverState({
  threadId,
  turnId,
  projectRootHash,
  snapshot,
  now,
}) {
  return {
    schemaVersion: 1,
    phase: PHASES.OBSERVING,
    threadId,
    turnId,
    projectRootHash,
    activeContextTokens: snapshot.activeContextTokens,
    accumulatedSessionTokens: snapshot.accumulatedSessionTokens,
    modelContextWindow: snapshot.modelContextWindow,
    rawRemainingTokens: snapshot.rawRemainingTokens,
    createdAt: now,
    updatedAt: now,
  };
}

export function transitionRollover(state, event, details = {}, now) {
  if (event === "needs_decision") {
    if (!NEEDS_DECISION_FROM.has(state.phase)) {
      throw new RolloverError("invalid_state_transition");
    }
    return {
      ...state,
      ...details,
      phase: PHASES.NEEDS_DECISION,
      updatedAt: now,
    };
  }

  const nextPhase = TRANSITIONS.get(`${state.phase}:${event}`);
  if (nextPhase === undefined) {
    throw new RolloverError("invalid_state_transition");
  }
  return {
    ...state,
    ...details,
    phase: nextPhase,
    updatedAt: now,
  };
}
