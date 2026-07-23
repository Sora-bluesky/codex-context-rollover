import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fromAppServerNotification } from "../../scripts/adapters/app-server-usage.mjs";
import { validateProjectConfiguration } from "../../scripts/config.mjs";
import { RolloverController } from "../../scripts/controller/rollover-controller.mjs";
import { RolloverStore } from "../../scripts/state/rollover-store.mjs";
import { runPersistedRollover } from "../../scripts/run-rollover.mjs";
import { transitionRollover } from "../../scripts/domain/rollover-machine.mjs";

const NOW = "2026-07-23T00:00:00.000Z";

async function fixture(
  run,
  { handoffPaths = ["HANDOFF.md"], mode = "provider" } = {},
) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rollover-controller-test-"),
  );
  const projectRoot = path.join(root, "project");
  const dataDirectory = path.join(root, "data");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    path.join(projectRoot, "HANDOFF.md"),
    "# HANDOFF\n\n## Required\n",
    "utf8",
  );
  const configuration = validateProjectConfiguration({
    mode,
    projectRoot,
    dataDirectory,
    handoffPaths,
    requiredHandoffHeadings: ["# HANDOFF", "## Required"],
    thresholds: { remainingPercent: 20, rawRemainingTokens: 48_000 },
  });
  const store = new RolloverStore(dataDirectory);
  let id = 0;
  const controller = new RolloverController({
    store,
    configuration,
    clock: () => NOW,
    createId: () => `id-${++id}`,
  });
  const snapshot = fromAppServerNotification(
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "old-thread",
        turnId: "threshold-turn",
        tokenUsage: {
          last: { totalTokens: 160_000 },
          total: { totalTokens: 300_000 },
          modelContextWindow: 200_000,
        },
      },
    },
    { observedAt: NOW },
  );
  await controller.requestRollover(snapshot);

  const successorWatcher = { running: false };
  const oldWatcher = {
    running: true,
    target: {
      provider: "synthetic",
      immutableId: "run-1",
      commitSha: "abcdef",
    },
    async stop() {
      this.running = false;
    },
  };
  const successorWatcherProvider = {
    async start({ targetHash }) {
      successorWatcher.running = true;
      return {
        watcher: successorWatcher,
        acknowledgement: {
          targetHash,
          firstObservation: { status: "success", observedAt: NOW },
        },
      };
    },
  };
  const handoffUpdater = async ({ handoffPath }) => {
    const current = await readFile(handoffPath, "utf8");
    await writeFile(handoffPath, `${current}\nupdated\n`, "utf8");
  };

  try {
    return await run({
      controller,
      store,
      snapshot,
      oldWatcher,
      successorWatcher,
      successorWatcherProvider,
      handoffUpdater,
      configuration,
      root,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("CreatingThread is durable before one request and success is durable before guidance", async () => {
  await fixture(
    async ({
      controller,
      store,
      snapshot,
      oldWatcher,
      successorWatcherProvider,
      handoffUpdater,
    }) => {
      let startCalls = 0;
      let guidanceCalls = 0;
      const result = await controller.executeRollover({
        threadId: snapshot.threadId,
        handoffUpdater,
        oldWatcher,
        successorWatcherProvider,
        threadClient: {
          async start() {
            startCalls += 1;
            assert.equal(
              (await store.read(snapshot.threadId)).phase,
              "CreatingThread",
            );
            return { threadId: "successor-thread" };
          },
        },
        oldThreadClient: {
          async sendGuidance() {
            guidanceCalls += 1;
            const persisted = await store.read(snapshot.threadId);
            assert.equal(persisted.phase, "SuccessorCreated");
            assert.equal(persisted.successorThreadId, "successor-thread");
          },
        },
      });
      assert.equal(result.status, "complete");
      assert.equal(startCalls, 1);
      assert.equal(guidanceCalls, 1);
      assert.equal(oldWatcher.running, false);
    },
  );
});

test("durable state stores only the configured project hash, never its path", async () => {
  await fixture(async ({ store, snapshot, configuration }) => {
    const persisted = await store.read(snapshot.threadId);
    const serialized = JSON.stringify(persisted);
    assert.equal(typeof persisted.projectRootHash, "string");
    assert.equal(persisted.projectRootHash.length, 64);
    assert.equal(serialized.includes(configuration.projectRoot), false);
    assert.equal(persisted.projectRoot, undefined);
    assert.equal(persisted.measurementSource, undefined);
    assert.equal(persisted.effectiveRemainingPercent, undefined);
  });
});

test("lost creation response enters Reconcile without retry and keeps old owner", async () => {
  await fixture(
    async ({
      controller,
      snapshot,
      oldWatcher,
      successorWatcher,
      successorWatcherProvider,
      handoffUpdater,
      configuration,
    }) => {
      let startCalls = 0;
      const result = await controller.executeRollover({
        threadId: snapshot.threadId,
        handoffUpdater,
        oldWatcher,
        successorWatcherProvider,
        threadClient: {
          async start() {
            startCalls += 1;
            throw new Error("synthetic response loss");
          },
        },
        oldThreadClient: {
          async sendGuidance() {
            assert.fail("guidance must wait for reconciliation");
          },
        },
      });
      assert.equal(result.status, "reconcile");
      assert.equal(result.state.phase, "Reconcile");
      assert.equal(startCalls, 1);
      assert.equal(oldWatcher.running, true);
      assert.equal(successorWatcher.running, true);
    },
  );
});

test("one bounded reconciliation candidate completes without a second create request", async () => {
  await fixture(
    async ({
      controller,
      snapshot,
      oldWatcher,
      successorWatcher,
      successorWatcherProvider,
      handoffUpdater,
      configuration,
    }) => {
      let startCalls = 0;
      const ambiguous = await controller.executeRollover({
        threadId: snapshot.threadId,
        handoffUpdater,
        oldWatcher,
        successorWatcherProvider,
        threadClient: {
          async start() {
            startCalls += 1;
            return {};
          },
        },
        oldThreadClient: {
          async sendGuidance() {
            assert.fail("guidance must wait for reconciliation");
          },
        },
      });
      assert.equal(ambiguous.status, "reconcile");
      const reconciled = await controller.reconcileRollover({
        threadId: snapshot.threadId,
        notAfter: "2026-07-23T00:05:00.000Z",
        candidates: [
          {
            threadId: "reconciled-successor",
            startedAt: NOW,
            projectRoot: configuration.projectRoot,
            source: "codex-context-rollover",
            rolloverId: ambiguous.state.rolloverId,
          },
        ],
        oldWatcher,
        watcherTransfer: ambiguous.watcherTransfer,
        oldThreadClient: {
          async sendGuidance({ guidance }) {
            assert.match(guidance, /reconciled-successor/);
          },
        },
      });
      assert.equal(reconciled.status, "complete");
      assert.equal(startCalls, 1);
      assert.equal(oldWatcher.running, false);
      assert.equal(successorWatcher.running, true);
    },
  );
});

test("failed handoff verification leaves old thread and watcher authoritative", async () => {
  await fixture(
    async ({
      controller,
      snapshot,
      oldWatcher,
      successorWatcherProvider,
    }) => {
      let watcherStarts = 0;
      const result = await controller.executeRollover({
        threadId: snapshot.threadId,
        handoffUpdater: async () => {},
        oldWatcher,
        successorWatcherProvider: {
          async start(input) {
            watcherStarts += 1;
            return successorWatcherProvider.start(input);
          },
        },
        threadClient: {
          async start() {
            assert.fail("thread must not be created");
          },
        },
        oldThreadClient: {
          async sendGuidance() {
            assert.fail("old thread must not be modified");
          },
        },
      });
      assert.equal(result.status, "handoff_not_verified");
      assert.equal(result.state.phase, "Requested");
      assert.equal(watcherStarts, 0);
      assert.equal(oldWatcher.running, true);
    },
  );
});

test("missing explicit handoff path persists needs decision without external mutation", async () => {
  await fixture(
    async ({ controller, snapshot, oldWatcher, successorWatcherProvider }) => {
      let externalCalls = 0;
      const result = await controller.executeRollover({
        threadId: snapshot.threadId,
        handoffUpdater: async () => {
          externalCalls += 1;
        },
        oldWatcher,
        successorWatcherProvider,
        threadClient: {
          async start() {
            externalCalls += 1;
          },
        },
        oldThreadClient: {
          async sendGuidance() {
            externalCalls += 1;
          },
        },
      });
      assert.equal(result.status, "needs_decision");
      assert.equal(result.state.errorCategory, "handoff_path_missing");
      assert.equal(externalCalls, 0);
      assert.equal(oldWatcher.running, true);
    },
    { handoffPaths: [] },
  );
});

test("the executable continuation runner completes a persisted synthetic request", async () => {
  await fixture(
    async ({ configuration, snapshot }) => {
      const result = await runPersistedRollover({
        configuration,
        threadId: snapshot.threadId,
        providerModule: "scripts/synthetic/runner-provider.mjs",
      });
      assert.equal(result.status, "complete");
      assert.equal(result.state.phase, "Complete");
      assert.equal(
        result.state.successorThreadId,
        "synthetic-runner-successor",
      );
    },
    { mode: "synthetic" },
  );
});

test("the continuation runner cannot redirect provider loading outside the plugin root", async () => {
  await fixture(async ({ configuration, snapshot, root }) => {
    const outsideProvider = path.join(root, "outside-provider.mjs");
    await writeFile(
      outsideProvider,
      "export function createRolloverProviders() { throw new Error('loaded'); }\n",
      "utf8",
    );
    const result = await runPersistedRollover({
      configuration,
      threadId: snapshot.threadId,
      providerRoot: root,
      providerModule: "outside-provider.mjs",
    });
    assert.equal(result.status, "needs_decision");
    assert.equal(result.state.errorCategory, "provider_module_unresolvable");
  });
});

test("a crash after the durable creating checkpoint resumes in Reconcile without creation", async () => {
  await fixture(async ({ controller, store, snapshot }) => {
    let state = await store.read(snapshot.threadId);
    for (const event of [
      "handoff_verified",
      "watcher_requested",
      "watcher_accepted",
      "thread_creation_started",
    ]) {
      state = transitionRollover(
        state,
        event,
        event === "thread_creation_started"
          ? {
              rolloverId: "interrupted-rollover",
              creationStartedAt: NOW,
            }
          : {},
        NOW,
      );
    }
    await store.write(snapshot.threadId, state);

    const recovered = await controller.recoverInterruptedRollover(
      snapshot.threadId,
    );
    assert.equal(recovered.status, "reconcile");
    assert.equal(recovered.state.phase, "Reconcile");
    assert.equal(
      recovered.state.errorCategory,
      "thread_creation_interrupted",
    );
  });
});

test("an interrupted non-creation phase becomes needs decision and preserves authority", async () => {
  await fixture(async ({ controller, store, snapshot, oldWatcher }) => {
    let state = await store.read(snapshot.threadId);
    state = transitionRollover(state, "handoff_verified", {}, NOW);
    await store.write(snapshot.threadId, state);
    const recovered = await controller.recoverInterruptedRollover(
      snapshot.threadId,
    );
    assert.equal(recovered.status, "needs_decision");
    assert.equal(recovered.state.phase, "NeedsDecision");
    assert.equal(oldWatcher.running, true);
  });
});
