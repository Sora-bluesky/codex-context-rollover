import { readFile, writeFile } from "node:fs/promises";
import { RolloverError } from "../lib/errors.mjs";

export async function createRolloverProviders({ configuration }) {
  if (configuration.mode !== "synthetic") {
    throw new RolloverError("synthetic_provider_refused");
  }

  const successorWatcher = { running: false };
  const oldWatcher = {
    running: true,
    target: {
      provider: "synthetic",
      immutableId: "synthetic-runner-target",
      commitSha: "synthetic-commit",
    },
    async stop() {
      this.running = false;
    },
  };

  return {
    handoffUpdater: async ({ handoffPath }) => {
      const current = await readFile(handoffPath, "utf8");
      await writeFile(
        handoffPath,
        `${current}\nSynthetic runner verified the handoff.\n`,
        "utf8",
      );
    },
    oldWatcher,
    successorWatcherProvider: {
      async start({ targetHash }) {
        successorWatcher.running = true;
        return {
          watcher: successorWatcher,
          acknowledgement: {
            targetHash,
            firstObservation: {
              status: "success",
              observedAt: new Date().toISOString(),
            },
          },
        };
      },
    },
    threadClient: {
      async start() {
        return { threadId: "synthetic-runner-successor" };
      },
    },
    oldThreadClient: {
      async sendGuidance() {},
    },
  };
}
