import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fromAppServerNotification } from "../adapters/app-server-usage.mjs";
import { validateProjectConfiguration } from "../config.mjs";
import { RolloverController } from "../controller/rollover-controller.mjs";
import { RolloverStore } from "../state/rollover-store.mjs";

const SYNTHETIC_TIME = "2026-07-23T12:00:00.000Z";

export async function runSyntheticDryRun() {
  const effects = {
    threadStarts: [],
    watcherStarts: [],
    oldThreadGuidance: [],
    oldThreadArchives: [],
    oldThreadDeletes: [],
    globalConfigurationChanges: [],
  };
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "codex-context-rollover-dry-run-"),
  );
  const projectRoot = path.join(temporaryRoot, "synthetic-project");
  const handoffPath = path.join(projectRoot, "HANDOFF.md");
  const dataDirectory = path.join(temporaryRoot, "plugin-data");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(projectRoot, { recursive: true }),
  );
  await writeFile(
    handoffPath,
    [
      "# HANDOFF",
      "",
      "## 完了した作業",
      "",
      "- 合成開始状態",
      "",
      "## 保留中の作業",
      "",
      "- 合成ロールオーバー",
      "",
    ].join("\n"),
    "utf8",
  );

  const configuration = validateProjectConfiguration({
    mode: "synthetic",
    projectRoot,
    dataDirectory,
    handoffPaths: ["HANDOFF.md"],
    requiredHandoffHeadings: [
      "# HANDOFF",
      "## 完了した作業",
      "## 保留中の作業",
    ],
    thresholds: {
      remainingPercent: 20,
      rawRemainingTokens: 48_000,
    },
  });
  const store = new RolloverStore(dataDirectory);
  let idCounter = 0;
  const controller = new RolloverController({
    store,
    configuration,
    clock: () => SYNTHETIC_TIME,
    createId: () => `synthetic-id-${++idCounter}`,
  });
  const snapshot = fromAppServerNotification(
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "synthetic-old-thread",
        turnId: "synthetic-threshold-turn",
        tokenUsage: {
          last: { totalTokens: 160_000 },
          total: { totalTokens: 420_000 },
          modelContextWindow: 200_000,
        },
      },
    },
    { observedAt: SYNTHETIC_TIME },
  );

  const timeline = [];
  const successorWatcher = { running: false };
  const oldWatcher = {
    running: true,
    target: {
      provider: "synthetic",
      immutableId: "synthetic-run-42",
      commitSha: "0123456789abcdef",
    },
    async stop() {
      this.running = false;
      timeline.push({
        event: "old_stopped",
        owners: Number(this.running) + Number(successorWatcher.running),
      });
    },
  };
  const successorWatcherProvider = {
    async start({ target, targetHash }) {
      effects.watcherStarts.push({
        providerKind: "synthetic",
        target,
        targetHash,
      });
      successorWatcher.running = true;
      timeline.push({
        event: "successor_acknowledged",
        owners: Number(oldWatcher.running) + Number(successorWatcher.running),
      });
      return {
        watcher: successorWatcher,
        acknowledgement: {
          targetHash,
          firstObservation: {
            status: "success",
            observedAt: SYNTHETIC_TIME,
          },
        },
      };
    },
  };
  const threadClient = {
    async start(request) {
      effects.threadStarts.push({
        providerKind: "synthetic",
        request,
      });
      return { threadId: "synthetic-successor-thread" };
    },
  };
  const oldThreadClient = {
    async sendGuidance(message) {
      effects.oldThreadGuidance.push(message);
    },
    async archive(message) {
      effects.oldThreadArchives.push(message);
    },
    async delete(message) {
      effects.oldThreadDeletes.push(message);
    },
  };

  try {
    const request = await controller.requestRollover(snapshot);
    assert.equal(request.status, "requested");
    const result = await controller.executeRollover({
      threadId: snapshot.threadId,
      handoffUpdater: async ({ handoffPath: exactPath }) => {
        const current = await readFile(exactPath, "utf8");
        await writeFile(
          exactPath,
          `${current}\n合成乾式実行で検証済み。\n`,
          "utf8",
        );
      },
      oldWatcher,
      successorWatcherProvider,
      threadClient,
      oldThreadClient,
    });

    assert.equal(result.status, "complete");
    assert.equal(effects.threadStarts.length, 1);
    assert.equal(oldWatcher.running, false);
    assert.equal(successorWatcher.running, true);
    assert.equal(effects.oldThreadGuidance.length, 1);
    assert.match(
      effects.oldThreadGuidance[0].guidance,
      /synthetic-successor-thread/,
    );
    assert.match(effects.oldThreadGuidance[0].guidance, /HANDOFF\.md/);
    assert.ok(timeline.every((entry) => entry.owners >= 1));

    return {
      status: result.status,
      finalPhase: result.state.phase,
      threadStartCalls: effects.threadStarts.length,
      syntheticThreadStarts: effects.threadStarts.filter(
        (entry) => entry.providerKind === "synthetic",
      ).length,
      syntheticWatcherStarts: effects.watcherStarts.filter(
        (entry) => entry.providerKind === "synthetic",
      ).length,
      oldThreadGuidanceCalls: effects.oldThreadGuidance.length,
      oldThreadArchived: effects.oldThreadArchives.length > 0,
      oldThreadDeleted: effects.oldThreadDeletes.length > 0,
      realCodexThreadsCreated: effects.threadStarts.filter(
        (entry) => entry.providerKind === "real",
      ).length,
      realCiWatchersStarted: effects.watcherStarts.filter(
        (entry) => entry.providerKind === "real",
      ).length,
      globalConfigurationChanges: effects.globalConfigurationChanges.length,
      minimumWatcherOwners: Math.min(
        ...timeline.map((entry) => entry.owners),
      ),
    };
  } finally {
    const normalizedTemporaryRoot = path.resolve(temporaryRoot);
    const normalizedSystemTemporary = path.resolve(os.tmpdir());
    if (
      normalizedTemporaryRoot.startsWith(
        `${normalizedSystemTemporary}${path.sep}`,
      ) &&
      path.basename(normalizedTemporaryRoot).startsWith(
        "codex-context-rollover-dry-run-",
      )
    ) {
      await rm(normalizedTemporaryRoot, { recursive: true, force: true });
    }
  }
}
