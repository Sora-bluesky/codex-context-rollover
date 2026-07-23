import { randomUUID } from "node:crypto";
import {
  initialRolloverState,
  PHASES,
  transitionRollover,
} from "../domain/rollover-machine.mjs";
import { shouldRequestRollover } from "../domain/remaining-context.mjs";
import {
  resolveConfiguredHandoff,
  updateAndVerifyHandoff,
} from "../adapters/handoff-file.mjs";
import {
  prepareSuccessorWatcher,
  stopOldWatcherAfterAcceptance,
} from "../adapters/ci-watcher.mjs";
import {
  buildOldThreadGuidance,
  createThreadOnce,
  reconcileThreadCandidates,
} from "../adapters/codex-thread-client.mjs";
import { asErrorCategory, RolloverError } from "../lib/errors.mjs";
import { createSafeLogger } from "../lib/safe-logger.mjs";
import { sha256 } from "../lib/crypto.mjs";

function defaultNow() {
  return new Date().toISOString();
}

function requireProvider(provider, method, code) {
  if (typeof provider?.[method] !== "function") {
    throw new RolloverError(code);
  }
}

export class RolloverController {
  constructor({
    store,
    configuration,
    clock = defaultNow,
    createId = randomUUID,
    logger = createSafeLogger(),
  }) {
    this.store = store;
    this.configuration = configuration;
    this.clock = clock;
    this.createId = createId;
    this.logger = logger;
  }

  async requestRollover(snapshot, { stopHookActive = false } = {}) {
    if (stopHookActive) {
      return { status: "ignored_stop_hook_active", hookOutput: null };
    }
    if (!shouldRequestRollover(snapshot, this.configuration.thresholds)) {
      return { status: "below_threshold", hookOutput: null };
    }

    const lease = await this.store.acquireLease(snapshot.threadId, {
      ownerId: this.createId(),
      acquiredAt: this.clock(),
    });
    if (!lease.acquired) {
      return { status: "lease_held", hookOutput: null };
    }

    try {
      const existing = await this.store.read(snapshot.threadId);
      if (existing !== null) {
        return { status: "already_requested", state: existing, hookOutput: null };
      }

      const observed = initialRolloverState({
        threadId: snapshot.threadId,
        turnId: snapshot.turnId,
        projectRootHash: sha256(this.configuration.projectRoot),
        snapshot,
        now: this.clock(),
      });
      const requested = transitionRollover(
        observed,
        "threshold_reached",
        {},
        this.clock(),
      );
      await this.store.write(snapshot.threadId, requested);
      this.logger.write({
        event: "rollover_requested",
        phase: requested.phase,
        threadId: requested.threadId,
        turnId: requested.turnId,
        observedAt: requested.updatedAt,
      });
      return {
        status: "requested",
        state: requested,
        hookOutput: {
          decision: "block",
          reason:
            "A durable rollover request now exists for this task. Invoke the rollover-continue skill with this exact thread id. If an explicit provider is unavailable, report needs decision and keep the old task and watcher authoritative.",
        },
      };
    } finally {
      await lease.release();
    }
  }

  async executeRollover({
    threadId,
    handoffUpdater,
    oldWatcher,
    successorWatcherProvider,
    threadClient,
    oldThreadClient,
  }) {
    const lease = await this.store.acquireLease(threadId, {
      ownerId: this.createId(),
      acquiredAt: this.clock(),
    });
    if (!lease.acquired) {
      return { status: "lease_held" };
    }

    try {
      let state = await this.store.read(threadId);
      if (state?.phase !== PHASES.REQUESTED) {
        return { status: "not_ready", state };
      }

      const resolvedHandoff = await resolveConfiguredHandoff({
        projectRoot: this.configuration.projectRoot,
        handoffPaths: this.configuration.handoffPaths,
      });
      if (resolvedHandoff.status !== "resolved") {
        state = transitionRollover(
          state,
          "needs_decision",
          { errorCategory: resolvedHandoff.reason },
          this.clock(),
        );
        await this.store.write(threadId, state);
        return { status: "needs_decision", state };
      }

      const handoff = await updateAndVerifyHandoff({
        resolvedHandoff,
        requiredHeadings: this.configuration.requiredHandoffHeadings,
        updateHandoff: handoffUpdater,
      });
      if (handoff.status !== "verified") {
        return { status: "handoff_not_verified", reason: handoff.reason, state };
      }

      state = transitionRollover(
        state,
        "handoff_verified",
        { handoffHash: handoff.postWriteHash },
        this.clock(),
      );
      await this.store.write(threadId, state);

      state = transitionRollover(
        state,
        "watcher_requested",
        {},
        this.clock(),
      );
      await this.store.write(threadId, state);

      const watcherTransfer = await prepareSuccessorWatcher({
        oldWatcher,
        successorWatcherProvider,
        timeoutMs: this.configuration.watcherAcknowledgementTimeoutMs,
        cancellationTimeoutMs:
          this.configuration.watcherCancellationTimeoutMs,
      });
      if (watcherTransfer.status !== "accepted") {
        state = transitionRollover(
          state,
          "needs_decision",
          {
            watcherDescriptorHash: watcherTransfer.targetHash,
            errorCategory: watcherTransfer.reason,
          },
          this.clock(),
        );
        await this.store.write(threadId, state);
        return { status: "needs_decision", state };
      }

      state = transitionRollover(
        state,
        "watcher_accepted",
        {
          watcherDescriptorHash: watcherTransfer.targetHash,
          watcherFirstObservedAt:
            watcherTransfer.acknowledgement.firstObservation.observedAt,
        },
        this.clock(),
      );
      await this.store.write(threadId, state);

      const rolloverId = this.createId();
      const creationStartedAt = this.clock();
      state = transitionRollover(
        state,
        "thread_creation_started",
        { rolloverId, creationStartedAt },
        creationStartedAt,
      );
      await this.store.write(threadId, state);

      const creation = await createThreadOnce({
        threadClient,
        request: {
          projectRoot: this.configuration.projectRoot,
          source: "codex-context-rollover",
          rolloverId,
          handoffPath: resolvedHandoff.handoffPath,
        },
      });
      if (creation.status !== "created") {
        state = transitionRollover(
          state,
          "creation_ambiguous",
          { errorCategory: creation.reason },
          this.clock(),
        );
        await this.store.write(threadId, state);
        return {
          status: "reconcile",
          state,
          watcherTransfer,
        };
      }

      state = transitionRollover(
        state,
        "thread_created",
        { successorThreadId: creation.successorThreadId },
        this.clock(),
      );
      await this.store.write(threadId, state);

      return await this.#finalize({
        state,
        resolvedHandoff,
        oldWatcher,
        watcherTransfer,
        oldThreadClient,
      });
    } catch (error) {
      this.logger.write({
        event: "rollover_error",
        threadId,
        errorCategory: asErrorCategory(error),
        observedAt: this.clock(),
      });
      throw error;
    } finally {
      await lease.release();
    }
  }

  async reconcileRollover({
    threadId,
    candidates,
    notAfter,
    oldWatcher,
    watcherTransfer,
    oldThreadClient,
  }) {
    const lease = await this.store.acquireLease(threadId, {
      ownerId: this.createId(),
      acquiredAt: this.clock(),
    });
    if (!lease.acquired) {
      return { status: "lease_held" };
    }

    try {
      let state = await this.store.read(threadId);
      if (state?.phase !== PHASES.RECONCILE) {
        return { status: "not_ready", state };
      }
      const result = reconcileThreadCandidates({
        expected: {
          notBefore: state.creationStartedAt,
          notAfter,
          projectRoot: this.configuration.projectRoot,
          source: "codex-context-rollover",
          rolloverId: state.rolloverId,
        },
        candidates,
      });
      if (result.status !== "reconciled") {
        state = transitionRollover(
          state,
          "needs_decision",
          { errorCategory: result.reason },
          this.clock(),
        );
        await this.store.write(threadId, state);
        return { status: "needs_decision", state };
      }

      state = transitionRollover(
        state,
        "thread_reconciled",
        { successorThreadId: result.successorThreadId },
        this.clock(),
      );
      await this.store.write(threadId, state);
      const resolvedHandoff = await resolveConfiguredHandoff({
        projectRoot: this.configuration.projectRoot,
        handoffPaths: this.configuration.handoffPaths,
      });
      if (resolvedHandoff.status !== "resolved") {
        state = transitionRollover(
          state,
          "needs_decision",
          { errorCategory: resolvedHandoff.reason },
          this.clock(),
        );
        await this.store.write(threadId, state);
        return { status: "needs_decision", state };
      }
      return await this.#finalize({
        state,
        resolvedHandoff,
        oldWatcher,
        watcherTransfer,
        oldThreadClient,
      });
    } finally {
      await lease.release();
    }
  }

  async recoverInterruptedRollover(threadId) {
    const lease = await this.store.acquireLease(threadId, {
      ownerId: this.createId(),
      acquiredAt: this.clock(),
    });
    if (!lease.acquired) {
      return { status: "lease_held" };
    }
    try {
      let state = await this.store.read(threadId);
      if (state?.phase === PHASES.CREATING_THREAD) {
        state = transitionRollover(
          state,
          "creation_ambiguous",
          { errorCategory: "thread_creation_interrupted" },
          this.clock(),
        );
        await this.store.write(threadId, state);
        return { status: "reconcile", state };
      }
      if (
        [
          PHASES.HANDOFF_VERIFIED,
          PHASES.MONITOR_PREPARING,
          PHASES.MONITOR_ACCEPTED,
          PHASES.SUCCESSOR_CREATED,
          PHASES.OLD_THREAD_LINKED,
        ].includes(state?.phase)
      ) {
        state = transitionRollover(
          state,
          "needs_decision",
          { errorCategory: "interrupted_rollover_phase" },
          this.clock(),
        );
        await this.store.write(threadId, state);
        return { status: "needs_decision", state };
      }
      return { status: "not_ready", state };
    } finally {
      await lease.release();
    }
  }

  async markNeedsDecision(threadId, errorCategory) {
    const lease = await this.store.acquireLease(threadId, {
      ownerId: this.createId(),
      acquiredAt: this.clock(),
    });
    if (!lease.acquired) {
      return { status: "lease_held" };
    }
    try {
      let state = await this.store.read(threadId);
      if (
        state === null ||
        [PHASES.COMPLETE, PHASES.NEEDS_DECISION].includes(state.phase)
      ) {
        return { status: "not_ready", state };
      }
      state = transitionRollover(
        state,
        "needs_decision",
        { errorCategory },
        this.clock(),
      );
      await this.store.write(threadId, state);
      return { status: "needs_decision", state };
    } finally {
      await lease.release();
    }
  }

  async #finalize({
    state,
    resolvedHandoff,
    oldWatcher,
    watcherTransfer,
    oldThreadClient,
  }) {
    requireProvider(oldThreadClient, "sendGuidance", "old_thread_client_invalid");
    const guidance = buildOldThreadGuidance({
      successorThreadId: state.successorThreadId,
      handoffPath: resolvedHandoff.handoffPath,
    });
    try {
      await oldThreadClient.sendGuidance({
        threadId: state.threadId,
        guidance,
      });
    } catch {
      const needsDecision = transitionRollover(
        state,
        "needs_decision",
        { errorCategory: "old_thread_guidance_failed" },
        this.clock(),
      );
      await this.store.write(state.threadId, needsDecision);
      return { status: "needs_decision", state: needsDecision };
    }

    let linked = transitionRollover(
      state,
      "old_thread_linked",
      {},
      this.clock(),
    );
    await this.store.write(state.threadId, linked);

    try {
      const stopResult = await stopOldWatcherAfterAcceptance({
        oldWatcher,
        acceptedTransfer: watcherTransfer,
      });
      if (!stopResult.stopped) {
        throw new RolloverError("old_watcher_stop_not_confirmed");
      }
    } catch {
      const needsDecision = transitionRollover(
        linked,
        "needs_decision",
        { errorCategory: "old_watcher_stop_failed" },
        this.clock(),
      );
      await this.store.write(state.threadId, needsDecision);
      return { status: "needs_decision", state: needsDecision };
    }

    linked = transitionRollover(linked, "completed", {}, this.clock());
    await this.store.write(state.threadId, linked);
    this.logger.write({
      event: "rollover_completed",
      phase: linked.phase,
      threadId: linked.threadId,
      successorThreadId: linked.successorThreadId,
      handoffHash: linked.handoffHash,
      watcherDescriptorHash: linked.watcherDescriptorHash,
      observedAt: linked.updatedAt,
    });
    return { status: "complete", state: linked };
  }
}
