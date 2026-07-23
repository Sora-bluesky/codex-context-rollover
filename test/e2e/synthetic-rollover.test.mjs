import test from "node:test";
import assert from "node:assert/strict";
import { runSyntheticDryRun } from "../../scripts/synthetic/dry-run-scenario.mjs";

test("synthetic rollover completes with no real external mutation", async () => {
  const result = await runSyntheticDryRun();
  assert.deepEqual(result, {
    status: "complete",
    finalPhase: "Complete",
    threadStartCalls: 1,
    syntheticThreadStarts: 1,
    syntheticWatcherStarts: 1,
    oldThreadGuidanceCalls: 1,
    oldThreadArchived: false,
    oldThreadDeleted: false,
    realCodexThreadsCreated: 0,
    realCiWatchersStarted: 0,
    globalConfigurationChanges: 0,
    minimumWatcherOwners: 1,
  });
});
