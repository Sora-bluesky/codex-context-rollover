import { descriptorHash } from "../lib/crypto.mjs";
import { RolloverError } from "../lib/errors.mjs";

function isSuccessfulAcknowledgement(acknowledgement, targetHash) {
  return (
    acknowledgement !== null &&
    typeof acknowledgement === "object" &&
    acknowledgement.targetHash === targetHash &&
    acknowledgement.firstObservation?.status === "success" &&
    typeof acknowledgement.firstObservation.observedAt === "string" &&
    Number.isFinite(Date.parse(acknowledgement.firstObservation.observedAt))
  );
}

export async function prepareSuccessorWatcher({
  oldWatcher,
  successorWatcherProvider,
  timeoutMs = 30_000,
  cancellationTimeoutMs = 1_000,
}) {
  if (
    oldWatcher === null ||
    typeof oldWatcher !== "object" ||
    oldWatcher.running !== true ||
    oldWatcher.target === null ||
    typeof oldWatcher.target !== "object"
  ) {
    throw new RolloverError("old_watcher_invalid");
  }
  if (typeof successorWatcherProvider?.start !== "function") {
    throw new RolloverError("successor_watcher_provider_invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RolloverError("watcher_timeout_invalid");
  }
  if (
    !Number.isSafeInteger(cancellationTimeoutMs) ||
    cancellationTimeoutMs <= 0
  ) {
    throw new RolloverError("watcher_cancellation_timeout_invalid");
  }

  const targetHash = descriptorHash(oldWatcher.target);
  const abortController = new AbortController();
  const timedOut = Symbol("watcher-timeout");
  let didTimeout = false;
  let timer;
  const startPromise = Promise.resolve().then(() =>
    successorWatcherProvider.start({
      target: oldWatcher.target,
      targetHash,
      signal: abortController.signal,
    }),
  );
  let result;
  try {
    result = await Promise.race([
      startPromise,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          didTimeout = true;
          abortController.abort();
          resolve(timedOut);
        }, timeoutMs);
      }),
    ]);
  } catch {
    clearTimeout(timer);
    return {
      status: "not_accepted",
      reason: "successor_watcher_start_failed",
      targetHash,
    };
  }
  clearTimeout(timer);
  if (didTimeout) {
    const cancellationResult =
      result === timedOut
        ? await Promise.race([
            startPromise.then(
              (value) => ({ settled: true, value }),
              (error) => ({ settled: true, error }),
            ),
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ settled: false }),
                cancellationTimeoutMs,
              ),
            ),
          ])
        : { settled: true, value: result };
    const cancellationConfirmed =
      cancellationResult.settled === true &&
      (cancellationResult.value?.cancelled === true ||
        cancellationResult.error?.name === "AbortError");
    return {
      status: cancellationConfirmed ? "not_accepted" : "indeterminate",
      reason: cancellationConfirmed
        ? "successor_watcher_acknowledgement_timeout"
        : "successor_watcher_cancellation_unconfirmed",
      targetHash,
      successorWatcher: cancellationResult.value?.watcher,
    };
  }

  if (!isSuccessfulAcknowledgement(result?.acknowledgement, targetHash)) {
    if (result?.watcher?.running === true) {
      if (typeof result.watcher.stop !== "function") {
        return {
          status: "indeterminate",
          reason: "successor_watcher_acknowledgement_invalid_live",
          targetHash,
          successorWatcher: result.watcher,
        };
      }
      try {
        await result.watcher.stop();
      } catch {
        return {
          status: "indeterminate",
          reason: "successor_watcher_cleanup_failed",
          targetHash,
          successorWatcher: result.watcher,
        };
      }
      if (result.watcher.running !== false) {
        return {
          status: "indeterminate",
          reason: "successor_watcher_cleanup_unconfirmed",
          targetHash,
          successorWatcher: result.watcher,
        };
      }
    }
    return {
      status: "not_accepted",
      reason: "successor_watcher_acknowledgement_invalid",
      targetHash,
      successorWatcher: result?.watcher,
    };
  }

  return {
    status: "accepted",
    targetHash,
    acknowledgement: result.acknowledgement,
    successorWatcher: result.watcher,
  };
}

export async function stopOldWatcherAfterAcceptance({
  oldWatcher,
  acceptedTransfer,
}) {
  if (acceptedTransfer?.status !== "accepted") {
    throw new RolloverError("watcher_not_accepted");
  }
  if (acceptedTransfer.successorWatcher?.running !== true) {
    throw new RolloverError("successor_watcher_not_running");
  }
  if (typeof oldWatcher?.stop !== "function") {
    throw new RolloverError("old_watcher_stop_unavailable");
  }
  await oldWatcher.stop();
  return { stopped: oldWatcher.running === false };
}
