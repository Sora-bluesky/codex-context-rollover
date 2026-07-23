import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../lib/crypto.mjs";
import { RolloverError } from "../lib/errors.mjs";

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export async function resolveConfiguredHandoff({
  projectRoot,
  handoffPaths,
}) {
  if (!Array.isArray(handoffPaths) || handoffPaths.length !== 1) {
    return {
      status: "needs_decision",
      reason:
        Array.isArray(handoffPaths) && handoffPaths.length > 1
          ? "multiple_handoff_paths"
          : "handoff_path_missing",
    };
  }

  let realProjectRoot;
  let realHandoffPath;
  let handoffMetadata;
  try {
    realProjectRoot = await realpath(projectRoot);
    realHandoffPath = await realpath(
      path.resolve(realProjectRoot, handoffPaths[0]),
    );
    handoffMetadata = await stat(realHandoffPath);
  } catch {
    return { status: "needs_decision", reason: "handoff_path_unresolvable" };
  }

  if (!isInside(realProjectRoot, realHandoffPath)) {
    return { status: "needs_decision", reason: "handoff_path_outside_project" };
  }
  if (!handoffMetadata.isFile() || handoffMetadata.nlink !== 1) {
    return { status: "needs_decision", reason: "handoff_path_ambiguous" };
  }

  return {
    status: "resolved",
    projectRoot: realProjectRoot,
    handoffPath: realHandoffPath,
    fileIdentity: {
      device: handoffMetadata.dev,
      inode: handoffMetadata.ino,
    },
  };
}

export async function updateAndVerifyHandoff({
  resolvedHandoff,
  requiredHeadings,
  updateHandoff,
}) {
  if (resolvedHandoff?.status !== "resolved") {
    throw new RolloverError("handoff_not_resolved");
  }
  if (typeof updateHandoff !== "function") {
    throw new TypeError("updateHandoff provider is required");
  }

  const readVerifiedContents = async () => {
    let handle;
    try {
      handle = await open(resolvedHandoff.handoffPath, "r");
      const handleMetadata = await handle.stat();
      const currentRealPath = await realpath(resolvedHandoff.handoffPath);
      const pathMetadata = await stat(currentRealPath);
      if (!isInside(resolvedHandoff.projectRoot, currentRealPath)) {
        return { status: "not_verified", reason: "handoff_path_changed" };
      }
      if (
        handleMetadata.dev !== resolvedHandoff.fileIdentity.device ||
        handleMetadata.ino !== resolvedHandoff.fileIdentity.inode ||
        pathMetadata.dev !== handleMetadata.dev ||
        pathMetadata.ino !== handleMetadata.ino ||
        handleMetadata.nlink !== 1 ||
        pathMetadata.nlink !== 1
      ) {
        return { status: "not_verified", reason: "handoff_identity_changed" };
      }
      const contents = await handle.readFile("utf8");
      const finalPathMetadata = await stat(resolvedHandoff.handoffPath);
      if (
        finalPathMetadata.dev !== handleMetadata.dev ||
        finalPathMetadata.ino !== handleMetadata.ino ||
        finalPathMetadata.nlink !== 1
      ) {
        return { status: "not_verified", reason: "handoff_identity_changed" };
      }
      return { status: "verified", contents };
    } catch {
      return { status: "not_verified", reason: "handoff_read_failed" };
    } finally {
      await handle?.close().catch(() => {});
    }
  };

  const beforeResult = await readVerifiedContents();
  if (beforeResult.status !== "verified") {
    return beforeResult;
  }
  const before = beforeResult.contents;
  if (typeof before !== "string") {
    return { status: "not_verified", reason: "handoff_read_failed" };
  }
  const preWriteHash = sha256(before);

  try {
    await updateHandoff({
      handoffPath: resolvedHandoff.handoffPath,
      preWriteHash,
    });
  } catch {
    return { status: "not_verified", reason: "handoff_update_failed" };
  }

  const afterResult = await readVerifiedContents();
  if (afterResult.status !== "verified") {
    return afterResult;
  }
  const after = afterResult.contents;
  if (typeof after !== "string") {
    return { status: "not_verified", reason: "handoff_read_failed" };
  }
  const postWriteHash = sha256(after);
  if (preWriteHash === postWriteHash) {
    return { status: "not_verified", reason: "handoff_unchanged" };
  }
  if (
    !Array.isArray(requiredHeadings) ||
    requiredHeadings.length === 0 ||
    requiredHeadings.some((heading) => !after.includes(heading))
  ) {
    return { status: "not_verified", reason: "handoff_content_invalid" };
  }

  return {
    status: "verified",
    preWriteHash,
    postWriteHash,
  };
}
