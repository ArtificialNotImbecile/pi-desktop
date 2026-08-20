import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { PiRemoteError } from "./errors.js";

export interface OwnedFileLockOptions {
  attempts?: number;
  pollMs?: number;
  staleMs?: number;
  timeoutCode?: string;
  timeoutMessage?: string;
  phase?: "profile" | "runtime" | "session" | "config";
}

const OWNER_NAME = /^owner-[0-9a-f-]{36}\.lock$/u;
const RELEASING_NAME = /^releasing-[0-9a-f-]{36}-[0-9a-f-]{36}\.lock$/u;
/** Codes that mean the lock directory is already gone or on its way out. */
const LOCK_DIRECTORY_GONE = ["ENOENT", "ENOTDIR", "EPERM", "EBUSY"];

/**
 * Whether a filesystem error means the lock directory a contender was about to
 * scan or remove no longer exists. POSIX reports that as ENOENT; Windows
 * reports a directory pending deletion as EPERM or EBUSY, which is why those
 * are the same answer rather than a failure. EACCES is deliberately absent: a
 * lock directory the process genuinely may not read is a real error.
 */
export function isLockDirectoryGone(code: string | undefined): boolean {
  return LOCK_DIRECTORY_GONE.includes(code ?? "");
}

/**
 * Remove one cryptographically unique owner from a non-empty lock directory.
 * The rename is the ownership operation: a replacement lock cannot contain the
 * old random filename, and the tombstone keeps the old directory non-empty
 * until cleanup. A delayed rmdir therefore cannot remove a replacement owner.
 */
export async function removeOwnedLock(lockPath: string, ownerName: string): Promise<boolean> {
  const tombstonePath = await claimOwnedLock(lockPath, ownerName);
  if (!tombstonePath) return false;
  await finishOwnedLockRemoval(lockPath, tombstonePath);
  return true;
}

/** Claim a stale owner, then restore it if a heartbeat landed after observation. */
export async function reclaimOwnedLock(lockPath: string, ownerName: string, observedMtimeMs: number, staleBefore: number): Promise<boolean> {
  const tombstonePath = await claimOwnedLock(lockPath, ownerName);
  if (!tombstonePath) return false;
  const claimed = await stat(tombstonePath).catch(() => null);
  if (claimed && (claimed.mtimeMs !== observedMtimeMs || claimed.mtimeMs > staleBefore)) {
    await rename(tombstonePath, path.join(lockPath, ownerName));
    return false;
  }
  await finishOwnedLockRemoval(lockPath, tombstonePath);
  return true;
}

async function claimOwnedLock(lockPath: string, ownerName: string): Promise<string | undefined> {
  if (!OWNER_NAME.test(ownerName)) throw new TypeError("Invalid lock owner name");
  const tombstoneName = `releasing-${ownerName.slice(6, -5)}-${randomUUID()}.lock`;
  const tombstonePath = path.join(lockPath, tombstoneName);
  try {
    await rename(path.join(lockPath, ownerName), tombstonePath);
    return tombstonePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function finishOwnedLockRemoval(lockPath: string, tombstonePath: string): Promise<void> {
  await rm(tombstonePath, { force: true }).catch(() => {});
  await rmdir(lockPath).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (!isLockDirectoryGone(code) && !["ENOTEMPTY", "EEXIST"].includes(code ?? "")) throw error;
  });
}

/** Cross-process lock whose release and stale recovery are bound to a random owner filename. */
export async function withOwnedFileLock<T>(lockPath: string, run: () => Promise<T>, options: OwnedFileLockOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 100;
  const pollMs = options.pollMs ?? 50;
  const staleMs = options.staleMs ?? 30_000;
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const ownerName = `owner-${randomUUID()}.lock`;
  const candidatePath = `${lockPath}.candidate-${randomUUID()}`;
  await mkdir(candidatePath, { mode: 0o700 });
  await writeFile(path.join(candidatePath, ownerName), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  let acquired = false;
  try {
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      try {
        await rename(candidatePath, lockPath);
        acquired = true;
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      }
      if (attempt === attempts) {
        await reclaimStaleLock(lockPath, Date.now() - staleMs);
        try {
          await rename(candidatePath, lockPath);
          acquired = true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
        }
        break;
      }
      await reclaimStaleLock(lockPath, Date.now() - staleMs);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (!acquired) {
      throw new PiRemoteError(options.timeoutCode ?? "host-lock-timeout", options.timeoutMessage ?? "Timed out waiting for a profile state lock.", {
        phase: options.phase ?? "runtime",
        retryable: true
      });
    }
    const ownerPath = path.join(lockPath, ownerName);
    const heartbeatMs = Math.max(250, Math.floor(staleMs / 3));
    const heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(ownerPath, now, now).catch(() => {});
    }, heartbeatMs);
    heartbeat.unref();
    try {
      return await run();
    } finally {
      clearInterval(heartbeat);
      await removeOwnedLock(lockPath, ownerName);
    }
  } finally {
    if (!acquired) await rm(candidatePath, { recursive: true, force: true }).catch(() => {});
  }
}

async function reclaimStaleLock(lockPath: string, staleBefore: number): Promise<void> {
  let entries;
  try {
    entries = await readdir(lockPath, { withFileTypes: true });
  } catch (error) {
    // Scanning races a contender removing the same directory. POSIX reports
    // that as ENOENT, but Windows reports a directory pending deletion as EPERM
    // or EBUSY -- the same outcome, and the same one the rmdir below already
    // treats as benign. There is nothing left to reclaim either way.
    if (isLockDirectoryGone((error as NodeJS.ErrnoException).code)) return;
    throw error;
  }
  const owner = entries.find((entry) => entry.isFile() && OWNER_NAME.test(entry.name));
  if (owner) {
    const info = await stat(path.join(lockPath, owner.name)).catch(() => null);
    if (info && info.mtimeMs <= staleBefore) await reclaimOwnedLock(lockPath, owner.name, info.mtimeMs, staleBefore);
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !RELEASING_NAME.test(entry.name)) continue;
    const target = path.join(lockPath, entry.name);
    const info = await stat(target).catch(() => null);
    if (info && info.mtimeMs <= staleBefore) await rm(target, { force: true }).catch(() => {});
  }
  await rmdir(lockPath).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (!isLockDirectoryGone(code) && !["ENOTEMPTY", "EEXIST"].includes(code ?? "")) throw error;
  });
}
