import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RolloverStore } from "../../scripts/state/rollover-store.mjs";
import {
  initialRolloverState,
  PHASES,
  transitionRollover,
} from "../../scripts/domain/rollover-machine.mjs";

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rollover-store-test-"),
  );
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("state writes replace the prior durable checkpoint", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new RolloverStore(directory);
    await store.write("thread-1", { phase: "Requested", sequence: 1 });
    await store.write("thread-1", { phase: "HandoffVerified", sequence: 2 });
    assert.deepEqual(await store.read("thread-1"), {
      phase: "HandoffVerified",
      sequence: 2,
    });
  });
});

test("concurrent owners cannot both acquire one thread lease", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new RolloverStore(directory);
    const [left, right] = await Promise.all([
      store.acquireLease("thread-1", {
        ownerId: "left",
        acquiredAt: "2026-07-23T00:00:00.000Z",
      }),
      store.acquireLease("thread-1", {
        ownerId: "right",
        acquiredAt: "2026-07-23T00:00:00.000Z",
      }),
    ]);
    assert.equal(Number(left.acquired) + Number(right.acquired), 1);
    await (left.acquired ? left : right).release();
  });
});

test("a stale abandoned lease is recovered without deleting the new owner", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new RolloverStore(directory, {
      leaseStaleAfterMs: 1_000,
      leaseHeartbeatMs: 100,
    });
    const leasePath = store.leasePath("thread-1");
    await mkdir(leasePath, { recursive: true });
    await writeFile(
      store.leaseOwnerPath(leasePath),
      `${JSON.stringify({
        threadId: "thread-1",
        ownerId: "abandoned-owner",
        acquiredAt: "2026-07-23T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    await writeFile(store.leaseHeartbeatPath(leasePath), "\n", "utf8");
    const old = new Date(Date.now() - 5_000);
    await utimes(store.leaseHeartbeatPath(leasePath), old, old);

    const contenders = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        store.acquireLease("thread-1", {
          ownerId: `recovered-owner-${index}`,
          acquiredAt: "2026-07-23T00:01:00.000Z",
        }),
      ),
    );
    assert.equal(
      contenders.filter((candidate) => candidate.acquired).length,
      1,
    );
    assert.equal(
      (
        await store.acquireLease("thread-1", {
          ownerId: "third-owner",
          acquiredAt: "2026-07-23T00:02:00.000Z",
        })
      ).acquired,
      false,
    );
    await contenders.find((candidate) => candidate.acquired).release();
  });
});

test("a stale recovery claim cannot permanently block an abandoned lease", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new RolloverStore(directory, {
      leaseStaleAfterMs: 1_000,
      leaseHeartbeatMs: 100,
    });
    const leasePath = store.leasePath("thread-1");
    await mkdir(leasePath, { recursive: true });
    await writeFile(
      store.leaseOwnerPath(leasePath),
      `${JSON.stringify({
        threadId: "thread-1",
        ownerId: "abandoned-owner",
        acquiredAt: "2026-07-23T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    await writeFile(store.leaseHeartbeatPath(leasePath), "\n", "utf8");
    await writeFile(store.leaseRecoveryPath(leasePath), "abandoned-recovery\n");
    const old = new Date(Date.now() - 5_000);
    await utimes(store.leaseHeartbeatPath(leasePath), old, old);
    await utimes(store.leaseRecoveryPath(leasePath), old, old);

    const recovered = await store.acquireLease("thread-1", {
      ownerId: "recovered-owner",
      acquiredAt: "2026-07-23T00:01:00.000Z",
    });
    assert.equal(recovered.acquired, true);
    await recovered.release();
  });
});

test("pure state machine covers the successful transition sequence", () => {
  const now = "2026-07-23T00:00:00.000Z";
  let state = initialRolloverState({
    threadId: "thread-1",
    turnId: "turn-1",
    projectRootHash: "synthetic-root-hash",
    snapshot: {
      activeContextTokens: 90,
      accumulatedSessionTokens: 200,
      modelContextWindow: 100,
      rawRemainingTokens: 10,
      effectiveRemainingPercent: 10,
      source: "app-server",
    },
    now,
  });
  for (const event of [
    "threshold_reached",
    "handoff_verified",
    "watcher_requested",
    "watcher_accepted",
    "thread_creation_started",
    "thread_created",
    "old_thread_linked",
    "completed",
  ]) {
    state = transitionRollover(state, event, {}, now);
  }
  assert.equal(state.phase, PHASES.COMPLETE);
});

test("ambiguous creation enters reconciliation before any decision", () => {
  const now = "2026-07-23T00:00:00.000Z";
  let state = { phase: PHASES.CREATING_THREAD };
  state = transitionRollover(state, "creation_ambiguous", {}, now);
  assert.equal(state.phase, PHASES.RECONCILE);
  state = transitionRollover(
    state,
    "needs_decision",
    { errorCategory: "reconciliation_zero_candidates" },
    now,
  );
  assert.equal(state.phase, PHASES.NEEDS_DECISION);
});
