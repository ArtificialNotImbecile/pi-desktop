import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChatMessage } from "../../shared/ipc.js";
import type { JasmineDatabase } from "../db/database.js";
import { getJasminePiAgentDir } from "./piAgent.js";

export type PreparedPiSession = {
  manager: SessionManager;
  created: boolean;
};

export function prepareThreadPiSession(
  db: JasmineDatabase,
  userDataDir: string,
  threadId: string,
  cwd: string
): PreparedPiSession {
  const binding = db.getThreadSessionBinding(threadId);
  if (binding?.sessionFile && existsSync(binding.sessionFile)) {
    const manager = SessionManager.open(binding.sessionFile, path.dirname(binding.sessionFile), cwd);
    syncThreadSessionName(db, threadId, manager);
    return {
      manager,
      created: false
    };
  }

  const sessionDir = jasmineSessionDir(userDataDir, cwd);
  mkdirSync(sessionDir, { recursive: true });
  const manager = SessionManager.create(cwd, sessionDir, { id: binding?.sessionId ?? threadId });
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Pi did not create a persistent session file binding.");
  db.updateThreadSessionBinding(threadId, {
    sessionId: manager.getSessionId(),
    sessionFile,
    sessionFormatVersion: CURRENT_SESSION_VERSION
  });
  syncThreadSessionName(db, threadId, manager);
  return { manager, created: true };
}

export function branchParentForMessage(
  db: JasmineDatabase,
  threadId: string,
  manager: SessionManager,
  messages: ChatMessage[],
  messageId: string
): string | null | undefined {
  const linkedId = db.getMessageSessionEntryId(threadId, messageId);
  const linked = linkedId ? manager.getEntry(linkedId) : undefined;
  if (linked?.type === "message" && linked.message.role === "user") return linked.parentId;

  const targetIndex = messages.findIndex((message) => message.id === messageId && message.role === "user");
  if (targetIndex < 0) return undefined;
  const userOrdinal = messages.slice(0, targetIndex + 1).filter((message) => message.role === "user").length - 1;
  const userEntries = manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user");
  const fallback = userEntries[userOrdinal];
  if (!fallback) return undefined;
  db.linkMessageSessionEntry(threadId, messageId, fallback.id);
  return fallback.parentId;
}

export function appendThreadSessionName(db: JasmineDatabase, threadId: string, name: string): void {
  const binding = db.getThreadSessionBinding(threadId);
  if (!binding?.sessionFile || !existsSync(binding.sessionFile)) return;
  const manager = SessionManager.open(binding.sessionFile, path.dirname(binding.sessionFile));
  if (manager.getSessionName() === name) return;
  manager.appendSessionInfo(name);
}

export function jasmineSessionDir(userDataDir: string, cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const encodedCwd = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  // APFS and most Unix filesystems limit one path component to 255 bytes. A
  // long (or multibyte) cwd can exceed that even while the full path remains
  // valid. Preserve Pi's readable legacy directory for ordinary workspaces,
  // but use a stable, collision-resistant component before that boundary.
  const sessionComponent = Buffer.byteLength(encodedCwd, "utf8") <= 240
    ? encodedCwd
    : `--cwd-sha256-${createHash("sha256").update(resolvedCwd).digest("hex")}--`;
  return path.join(getJasminePiAgentDir(userDataDir), "sessions", sessionComponent);
}

export function deleteOwnedPiSessionFile(userDataDir: string, sessionFile: string | null | undefined): void {
  if (!sessionFile || !existsSync(sessionFile)) return;
  const ownedRoot = path.resolve(getJasminePiAgentDir(userDataDir), "sessions");
  const resolvedFile = path.resolve(sessionFile);
  const relative = path.relative(ownedRoot, resolvedFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(resolvedFile).toLowerCase() !== ".jsonl") {
    throw new Error("Refusing to delete a Pi session file outside Jasmine-owned session storage.");
  }
  rmSync(resolvedFile);
}

function syncThreadSessionName(db: JasmineDatabase, threadId: string, manager: SessionManager): void {
  const title = db.getThread(threadId)?.title.trim();
  if (!title || manager.getSessionName() === title) return;
  manager.appendSessionInfo(title);
}
