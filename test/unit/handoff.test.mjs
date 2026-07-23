import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  link,
  mkdtemp,
  rename,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveConfiguredHandoff,
  updateAndVerifyHandoff,
} from "../../scripts/adapters/handoff-file.mjs";

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rollover-handoff-test-"));
  const projectRoot = path.join(root, "project");
  const outsideRoot = path.join(root, "outside");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  const handoffPath = path.join(projectRoot, "HANDOFF.md");
  const outsidePath = path.join(outsideRoot, "HANDOFF.md");
  await writeFile(handoffPath, "# HANDOFF\n\n## Required\n", "utf8");
  await writeFile(outsidePath, "# HANDOFF\n\n## Required\n", "utf8");
  try {
    return await run({ root, projectRoot, handoffPath, outsidePath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("missing and multiple handoff declarations need a decision", async () => {
  await fixture(async ({ projectRoot }) => {
    assert.deepEqual(
      await resolveConfiguredHandoff({ projectRoot, handoffPaths: [] }),
      { status: "needs_decision", reason: "handoff_path_missing" },
    );
    assert.deepEqual(
      await resolveConfiguredHandoff({
        projectRoot,
        handoffPaths: ["HANDOFF.md", "docs/HANDOFF.md"],
      }),
      { status: "needs_decision", reason: "multiple_handoff_paths" },
    );
  });
});

test("handoff outside the configured project is rejected", async () => {
  await fixture(async ({ projectRoot, outsidePath }) => {
    assert.deepEqual(
      await resolveConfiguredHandoff({
        projectRoot,
        handoffPaths: [outsidePath],
      }),
      { status: "needs_decision", reason: "handoff_path_outside_project" },
    );
  });
});

test("a multiply linked handoff is rejected as ambiguous", async () => {
  await fixture(async ({ projectRoot, handoffPath, outsidePath }) => {
    await rm(outsidePath);
    await link(handoffPath, outsidePath);
    assert.deepEqual(
      await resolveConfiguredHandoff({
        projectRoot,
        handoffPaths: ["HANDOFF.md"],
      }),
      { status: "needs_decision", reason: "handoff_path_ambiguous" },
    );
  });
});

test("handoff update requires both changed hash and required content", async () => {
  await fixture(async ({ projectRoot }) => {
    const resolved = await resolveConfiguredHandoff({
      projectRoot,
      handoffPaths: ["HANDOFF.md"],
    });
    const unchanged = await updateAndVerifyHandoff({
      resolvedHandoff: resolved,
      requiredHeadings: ["# HANDOFF", "## Required"],
      updateHandoff: async () => {},
    });
    assert.equal(unchanged.status, "not_verified");
    assert.equal(unchanged.reason, "handoff_unchanged");

    const invalid = await updateAndVerifyHandoff({
      resolvedHandoff: resolved,
      requiredHeadings: ["# HANDOFF", "## Required"],
      updateHandoff: async ({ handoffPath }) => {
        await writeFile(handoffPath, "# HANDOFF\n\nchanged\n", "utf8");
      },
    });
    assert.equal(invalid.status, "not_verified");
    assert.equal(invalid.reason, "handoff_content_invalid");

    await writeFile(
      resolved.handoffPath,
      "# HANDOFF\n\n## Required\n",
      "utf8",
    );
    const verified = await updateAndVerifyHandoff({
      resolvedHandoff: resolved,
      requiredHeadings: ["# HANDOFF", "## Required"],
      updateHandoff: async ({ handoffPath }) => {
        const current = await readFile(handoffPath, "utf8");
        await writeFile(handoffPath, `${current}\nupdated\n`, "utf8");
      },
    });
    assert.equal(verified.status, "verified");
    assert.notEqual(verified.preWriteHash, verified.postWriteHash);
  });
});

test("handoff verification rejects a path replaced with a different file", async () => {
  await fixture(async ({ projectRoot, handoffPath }) => {
    const resolved = await resolveConfiguredHandoff({
      projectRoot,
      handoffPaths: ["HANDOFF.md"],
    });
    const replacementPath = path.join(projectRoot, "replacement.md");
    const result = await updateAndVerifyHandoff({
      resolvedHandoff: resolved,
      requiredHeadings: ["# HANDOFF", "## Required"],
      updateHandoff: async () => {
        await writeFile(
          replacementPath,
          "# HANDOFF\n\n## Required\n\nreplacement\n",
          "utf8",
        );
        await rm(handoffPath);
        await rename(replacementPath, handoffPath);
      },
    });
    assert.equal(result.status, "not_verified");
    assert.equal(result.reason, "handoff_identity_changed");
  });
});
