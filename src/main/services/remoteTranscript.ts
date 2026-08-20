import type { RemoteTranscriptEntry, RemoteTranscriptEntryKind } from "../../shared/ipc.js";

/**
 * Deciding what a session open has to download. Kept apart from the service so
 * it can be exercised without Electron, an SSH host, or a database: this is the
 * rule that makes "already have it locally" mean no network at all.
 */
export type SessionCacheFacts = {
  cachedBytes: number;
  cachedFingerprint: string | null;
  /** Fingerprint the most recent listing reported for the remote file. */
  headerFingerprint: string | null;
  remoteSizeBytes: number | null;
  transcriptExists: boolean;
  missing: boolean;
};

export type SessionSyncPlan =
  /** The local copy is complete and current; render it and touch nothing. */
  | { mode: "cached" }
  /** The remote file grew; fetch only the bytes past what is stored. */
  | { mode: "append"; fromOffset: number }
  /** The cached prefix is not the remote prefix; the file must be refetched. */
  | { mode: "full"; reason: "requested" | "fingerprint" | "truncated" | "absent" };

export function resolveSessionSyncPlan(facts: SessionCacheFacts, options: { refetch?: boolean } = {}): SessionSyncPlan {
  // Nothing on the host to compare against, so whatever is stored is the answer.
  if (facts.missing) return { mode: "cached" };
  if (options.refetch) return { mode: "full", reason: "requested" };
  if (facts.cachedBytes <= 0 || !facts.transcriptExists) return { mode: "full", reason: "absent" };
  // A rewritten header means the byte offset points into a different file, so
  // the fingerprint is checked before any size comparison.
  if (facts.cachedFingerprint && facts.headerFingerprint && facts.cachedFingerprint !== facts.headerFingerprint) {
    return { mode: "full", reason: "fingerprint" };
  }
  if (facts.remoteSizeBytes !== null && facts.remoteSizeBytes < facts.cachedBytes) {
    return { mode: "full", reason: "truncated" };
  }
  if (facts.remoteSizeBytes !== null && facts.remoteSizeBytes === facts.cachedBytes) return { mode: "cached" };
  return { mode: "append", fromOffset: facts.cachedBytes };
}

/**
 * Projects a stored Pi session file into readable rows. `appendedFromByte` marks
 * which rows arrived in the last sync, so the reader can point at what is new
 * instead of redrawing the whole transcript as if it just appeared.
 */
export function readTranscriptEntries(raw: string, appendedFromByte: number): RemoteTranscriptEntry[] {
  if (!raw) return [];
  const entries: RemoteTranscriptEntry[] = [];
  let byteCursor = 0;
  for (const line of raw.split("\n")) {
    const lineStart = byteCursor;
    byteCursor += Buffer.byteLength(line, "utf8") + 1;
    if (!line.trim()) continue;
    const entry = parseTranscriptLine(line, lineStart >= appendedFromByte);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Anything Jasmine cannot name is dropped rather than shown as raw JSON. */
export function parseTranscriptLine(line: string, appended: boolean): RemoteTranscriptEntry | null {
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    value = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const id = typeof value.id === "string" ? value.id : null;
  const timestamp = typeof value.timestamp === "string" ? value.timestamp : null;
  if (value.type === "compaction") {
    return entry(id, "compaction", timestamp, typeof value.summary === "string" ? value.summary : "", null, appended);
  }
  if (value.type !== "message") return null;
  const message = value.message && typeof value.message === "object" ? value.message as Record<string, unknown> : null;
  if (!message) return null;
  const role = typeof message.role === "string" ? message.role : "";
  const parts = contentParts(message.content);
  if (role === "user") return entry(id, "user", timestamp, parts.text, null, appended);
  if (role === "toolResult" || role === "tool") {
    return entry(id, "tool", timestamp, parts.text, typeof message.toolName === "string" ? message.toolName : null, appended);
  }
  if (role !== "assistant") return null;
  if (parts.toolName) return entry(id, "tool", timestamp, parts.text, parts.toolName, appended);
  if (parts.text) return entry(id, "assistant", timestamp, parts.text, null, appended);
  if (parts.thinking) return entry(id, "thinking", timestamp, parts.thinking, null, appended);
  return null;
}

function entry(
  id: string | null,
  kind: RemoteTranscriptEntryKind,
  timestamp: string | null,
  text: string,
  toolName: string | null,
  appended: boolean
): RemoteTranscriptEntry | null {
  const trimmed = text.trim();
  if (!trimmed && !toolName) return null;
  return { id: id ?? `${kind}-${timestamp ?? "0"}-${trimmed.slice(0, 16)}`, kind, timestamp, text: trimmed, toolName, appended };
}

function contentParts(content: unknown): { text: string; thinking: string; toolName: string | null } {
  if (typeof content === "string") return { text: content, thinking: "", toolName: null };
  if (!Array.isArray(content)) return { text: "", thinking: "", toolName: null };
  const text: string[] = [];
  const thinking: string[] = [];
  let toolName: string | null = null;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const candidate = part as Record<string, unknown>;
    if (candidate.type === "text" && typeof candidate.text === "string") text.push(candidate.text);
    else if (candidate.type === "thinking" && typeof candidate.thinking === "string") thinking.push(candidate.thinking);
    else if (candidate.type === "toolCall" && typeof candidate.name === "string") toolName = candidate.name;
  }
  return { text: text.join("\n").trim(), thinking: thinking.join("\n").trim(), toolName };
}

export function normalizeRemotePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return "/";
  const collapsed = trimmed.replace(/\/{2,}/gu, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/u, "") : "/";
}

export function joinRemotePath(directory: string, name: string): string {
  return directory === "/" ? `/${name}` : `${directory}/${name}`;
}

export function parentRemotePath(value: string): string | null {
  if (value === "/") return null;
  const index = value.lastIndexOf("/");
  return index <= 0 ? "/" : value.slice(0, index);
}
