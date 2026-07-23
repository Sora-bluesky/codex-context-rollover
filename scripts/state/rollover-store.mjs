import {
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "../lib/crypto.mjs";
import { RolloverError } from "../lib/errors.mjs";

function stateKey(threadId) {
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new TypeError("threadId is required");
  }
  return sha256(threadId);
}

export class RolloverStore {
  constructor(
    dataDirectory,
    {
      leaseStaleAfterMs = 60_000,
      leaseHeartbeatMs = 20_000,
    } = {},
  ) {
    if (typeof dataDirectory !== "string" || dataDirectory.length === 0) {
      throw new TypeError("An explicit data directory is required");
    }
    this.dataDirectory = path.resolve(dataDirectory);
    this.stateDirectory = path.join(this.dataDirectory, "state");
    this.leaseDirectory = path.join(this.dataDirectory, "leases");
    if (
      !Number.isSafeInteger(leaseStaleAfterMs) ||
      leaseStaleAfterMs <= 0 ||
      !Number.isSafeInteger(leaseHeartbeatMs) ||
      leaseHeartbeatMs <= 0 ||
      leaseHeartbeatMs >= leaseStaleAfterMs
    ) {
      throw new TypeError("Lease heartbeat must be positive and shorter than stale timeout");
    }
    this.leaseStaleAfterMs = leaseStaleAfterMs;
    this.leaseHeartbeatMs = leaseHeartbeatMs;
  }

  statePath(threadId) {
    return path.join(this.stateDirectory, `${stateKey(threadId)}.json`);
  }

  leasePath(threadId) {
    return path.join(this.leaseDirectory, `${stateKey(threadId)}.lock`);
  }

  leaseOwnerPath(leasePath) {
    return path.join(leasePath, "owner.json");
  }

  leaseHeartbeatPath(leasePath) {
    return path.join(leasePath, "heartbeat");
  }

  leaseRecoveryPath(leasePath) {
    return path.join(leasePath, "recovery");
  }

  async read(threadId) {
    try {
      const contents = await readFile(this.statePath(threadId), "utf8");
      return JSON.parse(contents);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      if (error instanceof SyntaxError) {
        throw new RolloverError("state_corrupt");
      }
      throw error;
    }
  }

  async write(threadId, state) {
    await mkdir(this.stateDirectory, { recursive: true });
    const destination = this.statePath(threadId);
    const temporary = path.join(
      this.stateDirectory,
      `.${stateKey(threadId)}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(temporary, destination);
    } catch (error) {
      try {
        await unlink(temporary);
      } catch {
        // The rename may have completed despite a late error.
      }
      throw error;
    }
  }

  async acquireLease(threadId, { ownerId, acquiredAt }) {
    await mkdir(this.leaseDirectory, { recursive: true });
    const leasePath = this.leasePath(threadId);
    let created = await this.#createLeaseDirectory(leasePath, {
      threadId,
      ownerId,
      acquiredAt,
    });
    if (!created) {
      if (!(await this.#recoverStaleLease(leasePath))) {
        return { acquired: false };
      }
      created = await this.#createLeaseDirectory(leasePath, {
        threadId,
        ownerId,
        acquiredAt,
      });
      if (!created) {
        return { acquired: false };
      }
    }

    const ownerPath = this.leaseOwnerPath(leasePath);
    const heartbeatPath = this.leaseHeartbeatPath(leasePath);

    let released = false;
    const heartbeat = setInterval(async () => {
      if (released) {
        return;
      }
      try {
        const current = JSON.parse(await readFile(ownerPath, "utf8"));
        if (current.ownerId !== ownerId) {
          clearInterval(heartbeat);
          return;
        }
        const now = new Date();
        await utimes(heartbeatPath, now, now);
      } catch {
        clearInterval(heartbeat);
      }
    }, this.leaseHeartbeatMs);
    heartbeat.unref();

    const closeWithoutDeleting = async () => {
      if (released) {
        return false;
      }
      released = true;
      clearInterval(heartbeat);
      return true;
    };

    return {
      acquired: true,
      async release() {
        if (!(await closeWithoutDeleting())) {
          return;
        }
        let ownsCurrentLease = false;
        try {
          const current = JSON.parse(await readFile(ownerPath, "utf8"));
          ownsCurrentLease = current.ownerId === ownerId;
        } catch {
          ownsCurrentLease = false;
        }
        if (!ownsCurrentLease) {
          return;
        }
        await unlink(heartbeatPath).catch(() => {});
        await unlink(ownerPath).catch(() => {});
        await rmdir(leasePath).catch((error) => {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) {
            throw error;
          }
        });
      },
    };
  }

  async #createLeaseDirectory(leasePath, owner) {
    try {
      await mkdir(leasePath, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") {
        return false;
      }
      throw error;
    }

    const ownerPath = this.leaseOwnerPath(leasePath);
    const heartbeatPath = this.leaseHeartbeatPath(leasePath);
    let ownerHandle;
    let heartbeatHandle;
    try {
      ownerHandle = await open(ownerPath, "wx", 0o600);
      await ownerHandle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await ownerHandle.sync();
      await ownerHandle.close();
      ownerHandle = null;

      heartbeatHandle = await open(heartbeatPath, "wx", 0o600);
      await heartbeatHandle.writeFile("\n", "utf8");
      await heartbeatHandle.sync();
      await heartbeatHandle.close();
      heartbeatHandle = null;
      return true;
    } catch (error) {
      await ownerHandle?.close().catch(() => {});
      await heartbeatHandle?.close().catch(() => {});
      await unlink(heartbeatPath).catch(() => {});
      await unlink(ownerPath).catch(() => {});
      await rmdir(leasePath).catch(() => {});
      throw error;
    }
  }

  async #observeLease(leasePath) {
    let directoryMetadata;
    try {
      directoryMetadata = await stat(leasePath);
    } catch (error) {
      return error?.code === "ENOENT" ? null : undefined;
    }
    let ownerContents = null;
    let heartbeatMtimeMs = null;
    try {
      ownerContents = await readFile(this.leaseOwnerPath(leasePath), "utf8");
    } catch {}
    try {
      heartbeatMtimeMs = (
        await stat(this.leaseHeartbeatPath(leasePath))
      ).mtimeMs;
    } catch {}
    return {
      device: directoryMetadata.dev,
      inode: directoryMetadata.ino,
      directoryMtimeMs: directoryMetadata.mtimeMs,
      ownerContents,
      heartbeatMtimeMs,
    };
  }

  #isStale(observation) {
    const lastHeartbeat =
      observation.heartbeatMtimeMs ?? observation.directoryMtimeMs;
    return Date.now() - lastHeartbeat > this.leaseStaleAfterMs;
  }

  #sameLease(left, right) {
    return (
      left !== null &&
      left !== undefined &&
      right !== null &&
      right !== undefined &&
      left.device === right.device &&
      left.inode === right.inode &&
      left.ownerContents === right.ownerContents &&
      left.heartbeatMtimeMs === right.heartbeatMtimeMs
    );
  }

  async #recoverStaleLease(leasePath) {
    const observed = await this.#observeLease(leasePath);
    if (observed === null) {
      return true;
    }
    if (observed === undefined || !this.#isStale(observed)) {
      return false;
    }

    const recoveryPath = this.leaseRecoveryPath(leasePath);
    const recoveryId = randomUUID();
    let recoveryHandle;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        recoveryHandle = await open(recoveryPath, "wx", 0o600);
        await recoveryHandle.writeFile(`${recoveryId}\n`, "utf8");
        await recoveryHandle.sync();
        await recoveryHandle.close();
        recoveryHandle = null;
        break;
      } catch (error) {
        await recoveryHandle?.close().catch(() => {});
        recoveryHandle = null;
        if (error?.code === "ENOENT") {
          return true;
        }
        if (error?.code !== "EEXIST" || attempt === 1) {
          return false;
        }
        let recoveryMetadata;
        try {
          recoveryMetadata = await stat(recoveryPath);
        } catch {
          return false;
        }
        if (
          Date.now() - recoveryMetadata.mtimeMs <= this.leaseStaleAfterMs ||
          !this.#sameLease(observed, await this.#observeLease(leasePath))
        ) {
          return false;
        }
        await unlink(recoveryPath).catch(() => {});
      }
    }

    const confirmed = await this.#observeLease(leasePath);
    const confirmedHeartbeat =
      confirmed?.heartbeatMtimeMs ?? observed.directoryMtimeMs;
    if (
      !this.#sameLease(observed, confirmed) ||
      Date.now() - confirmedHeartbeat <= this.leaseStaleAfterMs
    ) {
      await unlink(recoveryPath).catch(() => {});
      return false;
    }

    const stalePath = `${leasePath}.stale.${randomUUID()}`;
    try {
      await rename(leasePath, stalePath);
    } catch (error) {
      await unlink(recoveryPath).catch(() => {});
      if (error?.code === "ENOENT") {
        return true;
      }
      return false;
    }
    await unlink(this.leaseRecoveryPath(stalePath)).catch(() => {});
    await unlink(this.leaseHeartbeatPath(stalePath)).catch(() => {});
    await unlink(this.leaseOwnerPath(stalePath)).catch(() => {});
    await rmdir(stalePath).catch(() => {});
    return true;
  }
}
