#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { realpath } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readProjectConfiguration } from "./config.mjs";
import { RolloverController } from "./controller/rollover-controller.mjs";
import {
  PHASES,
} from "./domain/rollover-machine.mjs";
import { asErrorCategory, RolloverError } from "./lib/errors.mjs";
import { RolloverStore } from "./state/rollover-store.mjs";

const PROVIDER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function loadProviderFactory({ providerModule }) {
  if (
    typeof providerModule !== "string" ||
    providerModule.length === 0
  ) {
    throw new RolloverError("provider_module_missing");
  }
  let realRoot;
  let realModule;
  try {
    realRoot = await realpath(PROVIDER_ROOT);
    realModule = await realpath(path.resolve(realRoot, providerModule));
  } catch {
    throw new RolloverError("provider_module_unresolvable");
  }
  if (!isInside(realRoot, realModule)) {
    throw new RolloverError("provider_module_outside_root");
  }
  const loaded = await import(pathToFileURL(realModule).href);
  if (typeof loaded.createRolloverProviders !== "function") {
    throw new RolloverError("provider_module_invalid");
  }
  return loaded.createRolloverProviders;
}

export async function runPersistedRollover({
  configuration,
  threadId,
  providerModule,
}) {
  const store = new RolloverStore(configuration.dataDirectory);
  const state = await store.read(threadId);
  if (state === null) {
    return { status: "needs_decision", errorCategory: "rollover_request_missing" };
  }
  const controller = new RolloverController({ store, configuration });

  if (![PHASES.REQUESTED, PHASES.RECONCILE].includes(state.phase)) {
    return await controller.recoverInterruptedRollover(threadId);
  }

  let createProviders;
  try {
    createProviders = await loadProviderFactory({
      providerModule,
    });
  } catch (error) {
    if (error instanceof RolloverError) {
      return await controller.markNeedsDecision(threadId, error.code);
    }
    throw error;
  }
  const providers = await createProviders({
    configuration,
    store,
    state,
  });

  if (state.phase === PHASES.REQUESTED) {
    return await controller.executeRollover({
      ...providers,
      threadId,
    });
  }
  if (state.phase === PHASES.RECONCILE) {
    return await controller.reconcileRollover({
      ...providers,
      threadId,
    });
  }
  return { status: "not_ready", state };
}

async function main() {
  const args = process.argv.slice(2);
  const configurationPath = option(args, "--config");
  const threadId = option(args, "--thread-id");
  const providerModule = option(args, "--provider-module");
  if (args.includes("--provider-root")) {
    throw new RolloverError("provider_root_override_forbidden");
  }
  if (
    configurationPath === null ||
    threadId === null ||
    providerModule === null
  ) {
    throw new RolloverError("explicit_runner_inputs_required");
  }

  const configuration = await readProjectConfiguration(configurationPath);
  const result = await runPersistedRollover({
    configuration,
    threadId,
    providerModule,
  });
  process.stdout.write(
    `${JSON.stringify({
      status: result.status,
      phase: result.state?.phase ?? null,
      errorCategory: result.state?.errorCategory ?? result.errorCategory ?? null,
    })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        status: "needs_decision",
        phase: null,
        errorCategory: asErrorCategory(error),
      })}\n`,
    );
  }
}
