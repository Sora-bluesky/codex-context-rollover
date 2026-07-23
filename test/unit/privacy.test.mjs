import test from "node:test";
import assert from "node:assert/strict";
import { createSafeLogger } from "../../scripts/lib/safe-logger.mjs";

test("structured logs discard private and secret-bearing fields", () => {
  const lines = [];
  const logger = createSafeLogger((line) => lines.push(line));
  logger.write({
    event: "rollover_error",
    phase: "Requested",
    threadId: "opaque-thread",
    errorCategory: "synthetic_error",
    transcript: "private transcript text",
    prompt: "private prompt text",
    toolOutput: "private tool output",
    environment: "SECRET_VALUE",
    credential: "synthetic-credential",
    email: "person@example.invalid",
    remote: "private.example/repository",
    path: "C:\\private\\repository",
  });
  const output = lines.join("\n");
  assert.match(output, /rollover_error/);
  for (const forbidden of [
    "private transcript",
    "private prompt",
    "private tool",
    "SECRET_VALUE",
    "synthetic-credential",
    "person@example.invalid",
    "private.example",
    "C:\\\\private",
  ]) {
    assert.doesNotMatch(output, new RegExp(forbidden.replaceAll("\\", "\\\\")));
  }
});
