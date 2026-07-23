import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOldThreadGuidance,
  createThreadOnce,
  reconcileThreadCandidates,
} from "../../scripts/adapters/codex-thread-client.mjs";

const EXPECTED = {
  notBefore: "2026-07-23T00:00:00.000Z",
  notAfter: "2026-07-23T00:05:00.000Z",
  projectRoot: "synthetic-root",
  source: "codex-context-rollover",
  rolloverId: "rollover-1",
};

function candidate(threadId = "successor-1") {
  return {
    threadId,
    startedAt: "2026-07-23T00:01:00.000Z",
    projectRoot: EXPECTED.projectRoot,
    source: EXPECTED.source,
    rolloverId: EXPECTED.rolloverId,
  };
}

test("thread start is called once and returns a valid successor", async () => {
  let calls = 0;
  const result = await createThreadOnce({
    threadClient: {
      async start() {
        calls += 1;
        return { threadId: "successor-1" };
      },
    },
    request: {},
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    status: "created",
    successorThreadId: "successor-1",
  });
});

test("lost and malformed responses do not trigger an automatic retry", async () => {
  for (const start of [
    async () => {
      throw new Error("synthetic lost response");
    },
    async () => ({}),
  ]) {
    let calls = 0;
    const result = await createThreadOnce({
      threadClient: {
        async start(request) {
          calls += 1;
          return await start(request);
        },
      },
      request: {},
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "ambiguous");
  }
});

test("reconciliation accepts exactly one candidate", () => {
  assert.equal(
    reconcileThreadCandidates({ expected: EXPECTED, candidates: [] }).reason,
    "reconciliation_zero_candidates",
  );
  assert.deepEqual(
    reconcileThreadCandidates({
      expected: EXPECTED,
      candidates: [candidate()],
    }),
    { status: "reconciled", successorThreadId: "successor-1" },
  );
  assert.equal(
    reconcileThreadCandidates({
      expected: EXPECTED,
      candidates: [candidate("successor-1"), candidate("successor-2")],
    }).reason,
    "reconciliation_multiple_candidates",
  );
});

test("old-thread guidance contains successor id and verified handoff path", () => {
  const guidance = buildOldThreadGuidance({
    successorThreadId: "successor-1",
    handoffPath: "C:\\synthetic\\HANDOFF.md",
  });
  assert.match(guidance, /successor-1/);
  assert.match(guidance, /HANDOFF\.md/);
  assert.match(guidance, /do not archive or delete/i);
});
