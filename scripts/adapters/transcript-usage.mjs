import { open } from "node:fs/promises";
import { createContextSnapshot } from "../domain/context-snapshot.mjs";
import { RolloverError } from "../lib/errors.mjs";

export const SUPPORTED_TRANSCRIPT_SHAPE = "codex-rollout-jsonl/token-count-v1";
const MAX_TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

function newestTokenRecord(text) {
  const lines = text.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === "") {
      continue;
    }
    let record;
    try {
      record = JSON.parse(lines[index]);
    } catch {
      throw new RolloverError("malformed_transcript");
    }
    if (record === null || typeof record !== "object") {
      throw new RolloverError("unsupported_transcript_shape");
    }
    if (typeof record.type !== "string" || record.type.length === 0) {
      throw new RolloverError("unsupported_transcript_shape");
    }
    if (
      record.type === "event_msg" &&
      (record.payload === null ||
        typeof record.payload !== "object" ||
        typeof record.payload.type !== "string")
    ) {
      throw new RolloverError("unsupported_transcript_shape");
    }
    if (
      record.type === "event_msg" &&
      record.payload?.type === "token_count"
    ) {
      if (
        record.info !== undefined ||
        record.payload.info === null ||
        typeof record.payload.info !== "object"
      ) {
        throw new RolloverError("malformed_transcript_token_usage");
      }
      return record;
    }
  }
  throw new RolloverError("token_usage_record_missing");
}

export function fromSupportedTranscriptText(
  text,
  { expectedThreadId, expectedTurnId, observedAt } = {},
) {
  if (
    typeof expectedThreadId !== "string" ||
    expectedThreadId.length === 0 ||
    typeof expectedTurnId !== "string" ||
    expectedTurnId.length === 0
  ) {
    throw new RolloverError("transcript_identity_missing");
  }
  const record = newestTokenRecord(text);
  const info = record.payload.info;

  try {
    return createContextSnapshot({
      threadId: expectedThreadId,
      turnId: expectedTurnId,
      activeContextTokens: info.last_token_usage?.total_tokens,
      accumulatedSessionTokens: info.total_token_usage?.total_tokens,
      modelContextWindow: info.model_context_window,
      observedAt: observedAt ?? record.timestamp,
      source: "hook-transcript",
    });
  } catch {
    throw new RolloverError("malformed_transcript_token_usage");
  }
}

async function readExactTranscriptTail(transcriptPath) {
  let handle;
  try {
    handle = await open(transcriptPath, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - MAX_TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    return text;
  } catch {
    throw new RolloverError("transcript_unreadable");
  } finally {
    await handle?.close();
  }
}

export async function readTranscriptSnapshot({
  transcriptPath,
  expectedThreadId,
  expectedTurnId,
  observedAt,
}) {
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) {
    throw new RolloverError("transcript_path_missing");
  }

  const text = await readExactTranscriptTail(transcriptPath);
  return fromSupportedTranscriptText(text, {
    expectedThreadId,
    expectedTurnId,
    observedAt,
  });
}
