import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareSuccessorWatcher,
  stopOldWatcherAfterAcceptance,
} from "../../scripts/adapters/ci-watcher.mjs";

const NOW = "2026-07-23T00:00:00.000Z";

function oldWatcherFixture(timeline = []) {
  return {
    running: true,
    target: {
      provider: "synthetic",
      immutableId: "run-1",
      commitSha: "abcdef",
    },
    async stop() {
      this.running = false;
      timeline.push({ event: "old_stopped" });
    },
  };
}

test("successor watches the identical immutable target and acknowledges first observation", async () => {
  const timeline = [];
  const oldWatcher = oldWatcherFixture(timeline);
  const successorWatcher = { running: false };
  const transfer = await prepareSuccessorWatcher({
    oldWatcher,
    successorWatcherProvider: {
      async start({ target, targetHash }) {
        assert.strictEqual(target, oldWatcher.target);
        assert.equal(oldWatcher.running, true);
        successorWatcher.running = true;
        timeline.push({ event: "successor_started" });
        return {
          watcher: successorWatcher,
          acknowledgement: {
            targetHash,
            firstObservation: { status: "success", observedAt: NOW },
          },
        };
      },
    },
  });
  assert.equal(transfer.status, "accepted");
  assert.equal(oldWatcher.running, true);
  assert.equal(transfer.acknowledgement.firstObservation.status, "success");

  await stopOldWatcherAfterAcceptance({
    oldWatcher,
    acceptedTransfer: transfer,
  });
  assert.equal(oldWatcher.running, false);
  assert.equal(successorWatcher.running, true);
  assert.deepEqual(
    timeline.map((entry) => entry.event),
    ["successor_started", "old_stopped"],
  );
});

test("failure, timeout-shaped acknowledgement, and target mismatch keep old watcher running", async () => {
  for (const acknowledgement of [
    null,
    {
      targetHash: "wrong",
      firstObservation: { status: "success", observedAt: NOW },
    },
    {
      targetHash: "placeholder",
      firstObservation: { status: "timeout", observedAt: NOW },
    },
  ]) {
    const oldWatcher = oldWatcherFixture();
    const transfer = await prepareSuccessorWatcher({
      oldWatcher,
      successorWatcherProvider: {
        async start({ targetHash }) {
          const adjusted =
            acknowledgement?.targetHash === "placeholder"
              ? { ...acknowledgement, targetHash }
              : acknowledgement;
          return { watcher: { running: false }, acknowledgement: adjusted };
        },
      },
    });
    assert.equal(transfer.status, "not_accepted");
    assert.equal(oldWatcher.running, true);
  }
});

test("bounded acknowledgement timeout aborts the successor attempt and keeps the old watcher", async () => {
  const oldWatcher = oldWatcherFixture();
  let aborted = false;
  const transfer = await prepareSuccessorWatcher({
    oldWatcher,
    timeoutMs: 5,
    cancellationTimeoutMs: 20,
    successorWatcherProvider: {
      async start({ signal }) {
        return await new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ cancelled: true, watcher: { running: false } });
          });
        });
      },
    },
  });
  assert.equal(transfer.status, "not_accepted");
  assert.equal(
    transfer.reason,
    "successor_watcher_acknowledgement_timeout",
  );
  assert.equal(aborted, true);
  assert.equal(oldWatcher.running, true);
});

test("unconfirmed timeout cancellation becomes indeterminate and keeps the old watcher", async () => {
  const oldWatcher = oldWatcherFixture();
  const transfer = await prepareSuccessorWatcher({
    oldWatcher,
    timeoutMs: 5,
    cancellationTimeoutMs: 5,
    successorWatcherProvider: {
      async start() {
        return await new Promise(() => {});
      },
    },
  });
  assert.equal(transfer.status, "indeterminate");
  assert.equal(
    transfer.reason,
    "successor_watcher_cancellation_unconfirmed",
  );
  assert.equal(oldWatcher.running, true);
});

test("a live watcher with invalid acknowledgement must be cleaned up or marked indeterminate", async () => {
  const oldWatcher = oldWatcherFixture();
  const liveWithoutCleanup = { running: true };
  const indeterminate = await prepareSuccessorWatcher({
    oldWatcher,
    successorWatcherProvider: {
      async start() {
        return { watcher: liveWithoutCleanup, acknowledgement: null };
      },
    },
  });
  assert.equal(indeterminate.status, "indeterminate");
  assert.equal(oldWatcher.running, true);

  const cleanable = {
    running: true,
    async stop() {
      this.running = false;
    },
  };
  const cleaned = await prepareSuccessorWatcher({
    oldWatcher,
    successorWatcherProvider: {
      async start() {
        return { watcher: cleanable, acknowledgement: null };
      },
    },
  });
  assert.equal(cleaned.status, "not_accepted");
  assert.equal(cleanable.running, false);
  assert.equal(oldWatcher.running, true);
});

test("watcher ownership timeline never reaches zero", async () => {
  const owners = [];
  const successorWatcher = { running: false };
  const oldWatcher = oldWatcherFixture();
  const capture = () =>
    owners.push(Number(oldWatcher.running) + Number(successorWatcher.running));
  capture();
  const transfer = await prepareSuccessorWatcher({
    oldWatcher,
    successorWatcherProvider: {
      async start({ targetHash }) {
        successorWatcher.running = true;
        capture();
        return {
          watcher: successorWatcher,
          acknowledgement: {
            targetHash,
            firstObservation: { status: "success", observedAt: NOW },
          },
        };
      },
    },
  });
  await stopOldWatcherAfterAcceptance({ oldWatcher, acceptedTransfer: transfer });
  capture();
  assert.deepEqual(owners, [1, 2, 1]);
});
