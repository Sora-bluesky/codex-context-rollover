#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fromAppServerNotification } from "./adapters/app-server-usage.mjs";
import { readTranscriptSnapshot } from "./adapters/transcript-usage.mjs";
import { asErrorCategory, RolloverError } from "./lib/errors.mjs";

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

async function main() {
  const args = process.argv.slice(2);
  const expectedThreadId = option(args, "--thread-id");
  const expectedTurnId = option(args, "--turn-id");
  const notificationPath = option(args, "--notification-file");
  const transcriptPath = option(args, "--transcript-file");
  if (
    typeof expectedThreadId !== "string" ||
    expectedThreadId.length === 0 ||
    Number(notificationPath !== null) + Number(transcriptPath !== null) !== 1
  ) {
    throw new RolloverError("unambiguous_context_source_required");
  }

  let snapshot;
  if (notificationPath !== null) {
    const notification = JSON.parse(await readFile(notificationPath, "utf8"));
    snapshot = fromAppServerNotification(notification);
    if (snapshot.threadId !== expectedThreadId) {
      throw new RolloverError("notification_thread_mismatch");
    }
  } else {
    if (typeof expectedTurnId !== "string" || expectedTurnId.length === 0) {
      throw new RolloverError("unambiguous_context_source_required");
    }
    snapshot = await readTranscriptSnapshot({
      transcriptPath,
      expectedThreadId,
      expectedTurnId,
    });
  }
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ errorCategory: asErrorCategory(error) })}\n`,
  );
  process.exitCode = 2;
}
