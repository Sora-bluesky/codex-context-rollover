import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateRemainingContext,
  shouldRequestRollover,
} from "../../scripts/domain/remaining-context.mjs";
import { fromAppServerNotification } from "../../scripts/adapters/app-server-usage.mjs";
import {
  fromSupportedTranscriptText,
} from "../../scripts/adapters/transcript-usage.mjs";

const OBSERVED_AT = "2026-07-23T00:00:00.000Z";

function notification({
  active = 40_000,
  accumulated = 90_000,
  window = 100_000,
  turnId = "turn-1",
} = {}) {
  return {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId,
      tokenUsage: {
        last: { totalTokens: active },
        total: { totalTokens: accumulated },
        modelContextWindow: window,
      },
    },
  };
}

test("raw remaining tokens cover all required boundaries", () => {
  const window = 100_000;
  const activeValues = [
    0,
    1,
    11_999,
    12_000,
    12_001,
    47_999,
    48_000,
    48_001,
    99_999,
    100_000,
    100_001,
  ];
  for (const activeContextTokens of activeValues) {
    const result = calculateRemainingContext({
      activeContextTokens,
      modelContextWindow: window,
    });
    assert.equal(
      result.rawRemainingTokens,
      Math.max(0, window - activeContextTokens),
      `active=${activeContextTokens}`,
    );
  }
});

test("raw threshold minus one, threshold, and plus one trigger correctly", () => {
  const thresholds = { remainingPercent: 0, rawRemainingTokens: 48_000 };
  for (const [rawRemainingTokens, expected] of [
    [47_999, true],
    [48_000, true],
    [48_001, false],
  ]) {
    assert.equal(
      shouldRequestRollover(
        {
          rawRemainingTokens,
          effectiveRemainingPercent: 50,
        },
        thresholds,
      ),
      expected,
    );
  }
});

test("percentage matches the 12,000 token display baseline", () => {
  assert.equal(
    calculateRemainingContext({
      activeContextTokens: 0,
      modelContextWindow: 100_000,
    }).effectiveRemainingPercent,
    100,
  );
  assert.equal(
    calculateRemainingContext({
      activeContextTokens: 12_000,
      modelContextWindow: 100_000,
    }).effectiveRemainingPercent,
    100,
  );
  assert.equal(
    calculateRemainingContext({
      activeContextTokens: 56_000,
      modelContextWindow: 100_000,
    }).effectiveRemainingPercent,
    50,
  );
  assert.equal(
    calculateRemainingContext({
      activeContextTokens: 100_000,
      modelContextWindow: 100_000,
    }).effectiveRemainingPercent,
    0,
  );
  assert.equal(
    calculateRemainingContext({
      activeContextTokens: 1,
      modelContextWindow: 12_000,
    }).effectiveRemainingPercent,
    0,
  );
});

test("missing and invalid context windows remain unknown", () => {
  for (const modelContextWindow of [null, undefined, 0, -1, 1.5, "100000"]) {
    const result = calculateRemainingContext({
      activeContextTokens: 1,
      modelContextWindow,
    });
    assert.equal(result.modelContextWindow, null);
    assert.equal(result.rawRemainingTokens, null);
    assert.equal(result.effectiveRemainingPercent, null);
  }
});

test("active and accumulated token counts stay separate across compaction", () => {
  const before = fromAppServerNotification(
    notification({
      active: 80_000,
      accumulated: 100_000,
      turnId: "before-compaction",
    }),
    { observedAt: OBSERVED_AT },
  );
  const after = fromAppServerNotification(
    notification({
      active: 20_000,
      accumulated: 110_000,
      turnId: "after-compaction",
    }),
    { observedAt: OBSERVED_AT },
  );
  assert.ok(after.activeContextTokens < before.activeContextTokens);
  assert.ok(
    after.accumulatedSessionTokens > before.accumulatedSessionTokens,
  );
  assert.equal(
    shouldRequestRollover(after, {
      remainingPercent: 20,
      rawRemainingTokens: 48_000,
    }),
    false,
  );
});

test("direct and transcript adapters normalize to one domain shape", () => {
  const direct = fromAppServerNotification(notification(), {
    observedAt: OBSERVED_AT,
  });
  const transcript = fromSupportedTranscriptText(
    [
      JSON.stringify({
        timestamp: OBSERVED_AT,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 40_000 },
            total_token_usage: { total_tokens: 90_000 },
            model_context_window: 100_000,
          },
          rate_limits: null,
        },
      }),
      JSON.stringify({
        timestamp: OBSERVED_AT,
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1" },
      }),
    ].join("\n"),
    {
      expectedThreadId: "thread-1",
      expectedTurnId: "turn-1",
      observedAt: OBSERVED_AT,
    },
  );

  assert.deepEqual(
    { ...transcript, source: direct.source },
    direct,
  );
  assert.equal(direct.activeContextTokens, 40_000);
  assert.equal(direct.accumulatedSessionTokens, 90_000);
});

test("unknown transcript schema stops safely", () => {
  assert.throws(
    () =>
      fromSupportedTranscriptText(
        JSON.stringify({ unexpected: "shape" }),
        { expectedThreadId: "thread-1", expectedTurnId: "turn-1" },
      ),
    { code: "unsupported_transcript_shape" },
  );
});

test("transcript adapter uses the newest token record and rejects a malformed newest record", () => {
  const validRecord = (totalTokens) =>
    JSON.stringify({
      timestamp: OBSERVED_AT,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { total_tokens: totalTokens },
          total_token_usage: { total_tokens: totalTokens + 100_000 },
          model_context_window: 200_000,
        },
        rate_limits: null,
      },
    });
  const options = {
    expectedThreadId: "thread-1",
    expectedTurnId: "turn-1",
    observedAt: OBSERVED_AT,
  };
  const newest = fromSupportedTranscriptText(
    [validRecord(20_000), validRecord(160_000)].join("\n"),
    options,
  );
  assert.equal(newest.activeContextTokens, 160_000);

  assert.throws(
    () =>
      fromSupportedTranscriptText(
        [
          validRecord(20_000),
          JSON.stringify({
            timestamp: OBSERVED_AT,
            type: "event_msg",
            payload: { type: "token_count", info: null },
          }),
        ].join("\n"),
        options,
      ),
    { code: "malformed_transcript_token_usage" },
  );
});
