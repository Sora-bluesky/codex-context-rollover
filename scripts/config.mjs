import path from "node:path";
import { readFile } from "node:fs/promises";
import { validateThresholds } from "./domain/remaining-context.mjs";
import { RolloverError } from "./lib/errors.mjs";

function requireString(value, code) {
  if (typeof value !== "string" || value.length === 0) {
    throw new RolloverError(code);
  }
  return value;
}

export function validateProjectConfiguration(configuration) {
  if (configuration === null || typeof configuration !== "object") {
    throw new RolloverError("configuration_invalid");
  }
  const projectRoot = path.resolve(
    requireString(configuration.projectRoot, "project_root_missing"),
  );
  const dataDirectory = path.resolve(
    requireString(configuration.dataDirectory, "data_directory_missing"),
  );
  const handoffPaths = configuration.handoffPaths;
  if (!Array.isArray(handoffPaths)) {
    throw new RolloverError("handoff_paths_invalid");
  }
  if (
    !Array.isArray(configuration.requiredHandoffHeadings) ||
    configuration.requiredHandoffHeadings.length === 0 ||
    configuration.requiredHandoffHeadings.some(
      (heading) => typeof heading !== "string" || heading.length === 0,
    )
  ) {
    throw new RolloverError("handoff_headings_invalid");
  }

  return Object.freeze({
    mode: configuration.mode === "synthetic" ? "synthetic" : "provider",
    projectRoot,
    dataDirectory,
    handoffPaths: Object.freeze([...handoffPaths]),
    requiredHandoffHeadings: Object.freeze([
      ...configuration.requiredHandoffHeadings,
    ]),
    thresholds: validateThresholds(configuration.thresholds),
    watcherAcknowledgementTimeoutMs:
      Number.isSafeInteger(configuration.watcherAcknowledgementTimeoutMs) &&
      configuration.watcherAcknowledgementTimeoutMs > 0
        ? configuration.watcherAcknowledgementTimeoutMs
        : 30_000,
    watcherCancellationTimeoutMs:
      Number.isSafeInteger(configuration.watcherCancellationTimeoutMs) &&
      configuration.watcherCancellationTimeoutMs > 0
        ? configuration.watcherCancellationTimeoutMs
        : 1_000,
  });
}

export async function readProjectConfiguration(configurationPath) {
  if (typeof configurationPath !== "string" || configurationPath.length === 0) {
    throw new RolloverError("configuration_path_missing");
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configurationPath, "utf8"));
  } catch {
    throw new RolloverError("configuration_unreadable");
  }
  return validateProjectConfiguration(parsed);
}
