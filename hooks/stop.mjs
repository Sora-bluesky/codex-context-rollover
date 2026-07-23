#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";
import { realpath } from "node:fs/promises";
import { readProjectConfiguration } from "../scripts/config.mjs";
import { readTranscriptSnapshot } from "../scripts/adapters/transcript-usage.mjs";
import { RolloverStore } from "../scripts/state/rollover-store.mjs";
import { RolloverController } from "../scripts/controller/rollover-controller.mjs";
import { asErrorCategory, RolloverError } from "../scripts/lib/errors.mjs";

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;

async function readStandardInput(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_HOOK_INPUT_BYTES) {
      throw new RolloverError("hook_input_too_large");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RolloverError("hook_input_invalid");
  }
}

async function sessionBelongsToProject(cwd, projectRoot) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    return false;
  }
  try {
    const [realCwd, realProjectRoot] = await Promise.all([
      realpath(cwd),
      realpath(projectRoot),
    ]);
    const relative = path.relative(realProjectRoot, realCwd);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    );
  } catch {
    return false;
  }
}

export async function handleStopEvent({
  input,
  configuration,
  store = new RolloverStore(configuration.dataDirectory),
  observedAt,
}) {
  if (input?.stop_hook_active === true) {
    return { status: "ignored_stop_hook_active", hookOutput: null };
  }
  if (
    typeof input?.session_id !== "string" ||
    input.session_id.length === 0 ||
    typeof input?.turn_id !== "string" ||
    input.turn_id.length === 0 ||
    typeof input?.transcript_path !== "string" ||
    input.transcript_path.length === 0
  ) {
    return { status: "stopped_safe", errorCategory: "hook_input_missing_fields" };
  }
  if (!(await sessionBelongsToProject(input.cwd, configuration.projectRoot))) {
    return { status: "stopped_safe", errorCategory: "project_context_mismatch" };
  }
  if (
    input.hook_event_name !== undefined &&
    input.hook_event_name !== "Stop"
  ) {
    return { status: "stopped_safe", errorCategory: "hook_event_mismatch" };
  }

  try {
    const snapshot = await readTranscriptSnapshot({
      transcriptPath: input.transcript_path,
      expectedThreadId: input.session_id,
      expectedTurnId: input.turn_id,
      observedAt,
    });
    const controller = new RolloverController({ store, configuration });
    return await controller.requestRollover(snapshot);
  } catch (error) {
    return { status: "stopped_safe", errorCategory: asErrorCategory(error) };
  }
}

function configurationLocationFromArgs(args) {
  if (args.includes("--plugin-data-config")) {
    if (
      typeof process.env.PLUGIN_DATA !== "string" ||
      process.env.PLUGIN_DATA.length === 0
    ) {
      throw new RolloverError("plugin_data_directory_missing");
    }
    return {
      configurationPath: path.join(process.env.PLUGIN_DATA, "config.json"),
      expectedDataDirectory: path.resolve(process.env.PLUGIN_DATA),
    };
  }
  const index = args.indexOf("--config");
  if (index === -1 || typeof args[index + 1] !== "string") {
    throw new RolloverError("configuration_path_missing");
  }
  return {
    configurationPath: args[index + 1],
    expectedDataDirectory: null,
  };
}

async function main() {
  try {
    const input = await readStandardInput(process.stdin);
    if (input?.stop_hook_active === true) {
      return;
    }
    const location = configurationLocationFromArgs(process.argv.slice(2));
    const configuration = await readProjectConfiguration(
      location.configurationPath,
    );
    if (
      location.expectedDataDirectory !== null &&
      configuration.dataDirectory !== location.expectedDataDirectory
    ) {
      throw new RolloverError("plugin_data_directory_mismatch");
    }
    const result = await handleStopEvent({ input, configuration });
    if (result.hookOutput !== null && result.hookOutput !== undefined) {
      process.stdout.write(`${JSON.stringify(result.hookOutput)}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ errorCategory: asErrorCategory(error) })}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
