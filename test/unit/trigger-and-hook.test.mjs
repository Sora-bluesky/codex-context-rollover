import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { fromAppServerNotification } from "../../scripts/adapters/app-server-usage.mjs";
import { validateProjectConfiguration } from "../../scripts/config.mjs";
import { RolloverController } from "../../scripts/controller/rollover-controller.mjs";
import { RolloverStore } from "../../scripts/state/rollover-store.mjs";
import { handleStopEvent } from "../../hooks/stop.mjs";

const NOW = "2026-07-23T00:00:00.000Z";

function snapshot(activeContextTokens) {
  return fromAppServerNotification(
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          last: { totalTokens: activeContextTokens },
          total: { totalTokens: 300_000 },
          modelContextWindow: 200_000,
        },
      },
    },
    { observedAt: NOW },
  );
}

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rollover-trigger-test-"));
  const projectRoot = path.join(root, "project");
  const dataDirectory = path.join(root, "data");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(projectRoot, { recursive: true }),
  );
  const configuration = validateProjectConfiguration({
    projectRoot,
    dataDirectory,
    handoffPaths: ["HANDOFF.md"],
    requiredHandoffHeadings: ["# HANDOFF"],
    thresholds: { remainingPercent: 20, rawRemainingTokens: 48_000 },
  });
  try {
    return await run({
      root,
      projectRoot,
      dataDirectory,
      configuration,
      store: new RolloverStore(dataDirectory),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("below-threshold turn creates no state or hook output", async () => {
  await fixture(async ({ dataDirectory, configuration, store }) => {
    const controller = new RolloverController({
      store,
      configuration,
      clock: () => NOW,
      createId: () => "owner-1",
    });
    const result = await controller.requestRollover(snapshot(20_000));
    assert.equal(result.status, "below_threshold");
    assert.equal(result.hookOutput, null);
    await assert.rejects(access(dataDirectory), { code: "ENOENT" });
  });
});

test("first crossing persists one request and repeated events are no-ops", async () => {
  await fixture(async ({ configuration, store }) => {
    let id = 0;
    const controller = new RolloverController({
      store,
      configuration,
      clock: () => NOW,
      createId: () => `owner-${++id}`,
    });
    const first = await controller.requestRollover(snapshot(160_000));
    const second = await controller.requestRollover(snapshot(160_000));
    assert.equal(first.status, "requested");
    assert.equal(first.hookOutput.decision, "block");
    assert.match(first.hookOutput.reason, /durable rollover request/);
    assert.equal(second.status, "already_requested");
    assert.equal(second.hookOutput, null);
    assert.equal((await store.read("thread-1")).phase, "Requested");
  });
});

test("concurrent threshold events produce exactly one owner", async () => {
  await fixture(async ({ configuration, store }) => {
    let id = 0;
    const controller = new RolloverController({
      store,
      configuration,
      clock: () => NOW,
      createId: () => `owner-${++id}`,
    });
    const results = await Promise.all([
      controller.requestRollover(snapshot(160_000)),
      controller.requestRollover(snapshot(160_000)),
    ]);
    assert.equal(
      results.filter((result) => result.status === "requested").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "lease_held").length,
      1,
    );
  });
});

test("stop_hook_active prevents a continuation loop and any mutation", async () => {
  await fixture(async ({ dataDirectory, configuration, store }) => {
    const result = await handleStopEvent({
      input: { stop_hook_active: true },
      configuration,
      store,
      observedAt: NOW,
    });
    assert.equal(result.status, "ignored_stop_hook_active");
    assert.equal(result.hookOutput, null);
    await assert.rejects(access(dataDirectory), { code: "ENOENT" });
  });
});

test("unsupported transcript stops safely without rollover state", async () => {
  await fixture(async ({ root, configuration, store }) => {
    const transcriptPath = path.join(root, "unsupported.json");
    await writeFile(
      transcriptPath,
      JSON.stringify({ schemaVersion: "unknown", records: [] }),
      "utf8",
    );
    const result = await handleStopEvent({
      input: {
        stop_hook_active: false,
        session_id: "thread-1",
        turn_id: "turn-1",
        cwd: configuration.projectRoot,
        transcript_path: transcriptPath,
      },
      configuration,
      store,
      observedAt: NOW,
    });
    assert.equal(result.status, "stopped_safe");
    assert.equal(result.errorCategory, "unsupported_transcript_shape");
    assert.equal(await store.read("thread-1"), null);
  });
});

test("supported transcript produces the executable Stop hook response", async () => {
  await fixture(async ({ root, configuration, store }) => {
    const transcriptPath = path.join(root, "supported.json");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: NOW,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { total_tokens: 160_000 },
              total_token_usage: { total_tokens: 300_000 },
              model_context_window: 200_000,
            },
            rate_limits: null,
          },
        }),
      ].join("\n"),
      "utf8",
    );
    const result = await handleStopEvent({
      input: {
        stop_hook_active: false,
        session_id: "thread-1",
        turn_id: "turn-1",
        cwd: configuration.projectRoot,
        transcript_path: transcriptPath,
      },
      configuration,
      store,
      observedAt: NOW,
    });
    assert.equal(result.status, "requested");
    assert.equal(result.hookOutput.decision, "block");
    assert.match(result.hookOutput.reason, /durable rollover request/);
  });
});

test("Stop hook refuses a task outside the explicitly configured project", async () => {
  await fixture(async ({ root, configuration, store }) => {
    const result = await handleStopEvent({
      input: {
        stop_hook_active: false,
        session_id: "thread-1",
        turn_id: "turn-1",
        cwd: root,
        transcript_path: path.join(root, "not-read.jsonl"),
      },
      configuration,
      store,
      observedAt: NOW,
    });
    assert.equal(result.status, "stopped_safe");
    assert.equal(result.errorCategory, "project_context_mismatch");
    assert.equal(await store.read("thread-1"), null);
  });
});

test("safely ignored CLI input exits zero without continuation feedback", async () => {
  await fixture(async ({ root, configuration }) => {
    const configurationPath = path.join(root, "config.json");
    await writeFile(
      configurationPath,
      `${JSON.stringify({
        projectRoot: configuration.projectRoot,
        dataDirectory: configuration.dataDirectory,
        handoffPaths: configuration.handoffPaths,
        requiredHandoffHeadings: configuration.requiredHandoffHeadings,
        thresholds: configuration.thresholds,
      })}\n`,
      "utf8",
    );
    const execution = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../../hooks/stop.mjs", import.meta.url)),
        "--config",
        configurationPath,
      ],
      {
        input: JSON.stringify({
          stop_hook_active: false,
          session_id: "thread-1",
          turn_id: "turn-1",
          cwd: root,
          transcript_path: path.join(root, "not-read.jsonl"),
        }),
        encoding: "utf8",
      },
    );
    assert.equal(execution.status, 0);
    assert.equal(execution.stdout, "");
    assert.equal(execution.stderr, "");
  });
});

test("threshold CLI output blocks with a continuation only after durable Request", async () => {
  await fixture(async ({ root, configuration, store }) => {
    const configurationPath = path.join(root, "config.json");
    const transcriptPath = path.join(root, "threshold.jsonl");
    await writeFile(
      configurationPath,
      `${JSON.stringify({
        projectRoot: configuration.projectRoot,
        dataDirectory: configuration.dataDirectory,
        handoffPaths: configuration.handoffPaths,
        requiredHandoffHeadings: configuration.requiredHandoffHeadings,
        thresholds: configuration.thresholds,
      })}\n`,
      "utf8",
    );
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        timestamp: NOW,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 160_000 },
            total_token_usage: { total_tokens: 300_000 },
            model_context_window: 200_000,
          },
          rate_limits: null,
        },
      })}\n`,
      "utf8",
    );
    const execution = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../../hooks/stop.mjs", import.meta.url)),
        "--config",
        configurationPath,
      ],
      {
        input: JSON.stringify({
          stop_hook_active: false,
          session_id: "thread-1",
          turn_id: "turn-1",
          cwd: configuration.projectRoot,
          transcript_path: transcriptPath,
          hook_event_name: "Stop",
        }),
        encoding: "utf8",
      },
    );
    assert.equal(execution.status, 0);
    assert.equal(execution.stderr, "");
    const output = JSON.parse(execution.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /rollover-continue/);
    assert.equal((await store.read("thread-1")).phase, "Requested");
  });
});

test("bundled hook uses the current matcher-group shape and stop-active CLI is silent", async () => {
  const hookConfiguration = JSON.parse(
    await readFile(
      new URL("../../hooks/hooks.json", import.meta.url),
      "utf8",
    ),
  );
  const handler = hookConfiguration.hooks.Stop[0].hooks[0];
  assert.equal(handler.type, "command");
  assert.match(handler.command, /PLUGIN_ROOT/);
  assert.match(handler.commandWindows, /PLUGIN_ROOT/);
  assert.match(handler.commandWindows, /plugin-data-config/);

  const execution = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../../hooks/stop.mjs", import.meta.url))],
    {
      input: JSON.stringify({ stop_hook_active: true }),
      encoding: "utf8",
    },
  );
  assert.equal(execution.status, 0);
  assert.equal(execution.stdout, "");
  assert.equal(execution.stderr, "");
});
