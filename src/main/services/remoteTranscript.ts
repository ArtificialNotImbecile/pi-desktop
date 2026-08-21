import { appendFile, copyFile, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
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

/** The shape of one byte range, independent of how it was transported. */
export type SessionChunkLike = {
  offset: number;
  bytes: number;
  size: number;
  data: string;
  headerFingerprint: string;
  eof: boolean;
};

export type SessionSyncResult = {
  /** Total bytes of the local copy after the sync. */
  offset: number;
  /** Bytes this sync had to download. */
  fetchedBytes: number;
  /** True when the download had to start over instead of resuming. */
  restarted: boolean;
  fingerprint: string | null;
  remoteSize: number | null;
};

/** How far back a torn trailing record is searched for before giving up on the copy. */
const RECORD_ALIGN_WINDOW_BYTES = 1024 * 1024;

type SessionSyncOptions = {
  transcriptPath: string;
  /** Zero starts over; any other value resumes from the local copy. */
  fromOffset: number;
  /**
   * Fingerprint the local copy was built from. Resuming without one is refused,
   * because there would be nothing to check the first resumed chunk against.
   */
  expectedFingerprint: string | null;
  maxSyncBytes: number;
  readChunk(fromOffset: number): Promise<SessionChunkLike>;
  onTooLarge(fetchedBytes: number): Error;
};

/** Syncs in progress, keyed by transcript path. See {@link syncSessionFile}. */
const queuedSyncs = new Map<string, Promise<void>>();

/**
 * Brings a local copy of a remote session file up to date.
 *
 * Every byte lands in a staging file that replaces the published copy only once
 * the whole range has arrived, so a read that fails halfway leaves the previous
 * copy exactly as it was. The resume point is taken from the staged bytes rather
 * than from a stored offset, which is what keeps a database that lags the file
 * from causing a duplicated range, and a torn trailing record is cut back to a
 * whole line before anything is appended after it.
 */
export function syncSessionFile(options: SessionSyncOptions): Promise<SessionSyncResult> {
  // One session has one staging file, so two syncs of it cannot run at once:
  // each removes, appends to, and renames that path, and interleaving them
  // publishes a spliced transcript or fails an open whose staging file another
  // call renamed away. Selecting a session, leaving, and selecting it again is
  // enough to reach that, since neither request is cancelled.
  const key = options.transcriptPath;
  const previous = queuedSyncs.get(key);
  const run = previous
    ? previous.then(() => syncSessionFileExclusive(options), () => syncSessionFileExclusive(options))
    : syncSessionFileExclusive(options);
  const settled = run.then(() => {}, () => {});
  queuedSyncs.set(key, settled);
  void settled.then(() => {
    if (queuedSyncs.get(key) === settled) queuedSyncs.delete(key);
  });
  return run;
}

async function syncSessionFileExclusive(options: SessionSyncOptions): Promise<SessionSyncResult> {
  const { transcriptPath } = options;
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  const staging = `${transcriptPath}.partial`;
  await rm(staging, { force: true });

  let offset = 0;
  let fetchedBytes = 0;
  let restarted = false;
  let fingerprint: string | null = null;
  let remoteSize: number | null = null;

  try {
    if (options.fromOffset > 0 && options.expectedFingerprint) {
      await copyFile(transcriptPath, staging);
      offset = await alignToRecordBoundary(staging);
      // Carried into the loop so the first resumed chunk is checked too: the
      // remote file can be replaced between the listing that decided to resume
      // and this read, and appending its bytes to the old prefix would splice
      // two different transcripts into one.
      fingerprint = offset > 0 ? options.expectedFingerprint : null;
      restarted = offset === 0;
    } else {
      restarted = options.fromOffset > 0;
      await writeFile(staging, "", "utf8");
    }

    for (;;) {
      let chunk: SessionChunkLike;
      try {
        chunk = await options.readChunk(offset);
      } catch (error) {
        // A cursor the host will not accept means the remote file was replaced
        // or truncated. Start over once rather than fail the open.
        if (offset > 0 && (error as { code?: string })?.code === "session-offset-past-end") {
          offset = 0;
          restarted = true;
          fetchedBytes = 0;
          await writeFile(staging, "", "utf8");
          continue;
        }
        throw error;
      }
      if (fingerprint && chunk.headerFingerprint !== fingerprint) {
        // The file changed identity mid-download; the partial copy is unusable.
        offset = 0;
        restarted = true;
        fetchedBytes = 0;
        fingerprint = null;
        await writeFile(staging, "", "utf8");
        continue;
      }
      fingerprint = chunk.headerFingerprint;
      remoteSize = chunk.size;
      // The cap is on the size of the mirror, not on one visit's download.
      // Checking only what this call fetched would let a session that grows a
      // little at a time pass every open and still end up unbounded on disk and
      // in memory when it is read back. Checked before the write so the limit
      // holds for the final chunk too.
      if (offset + chunk.bytes > options.maxSyncBytes) throw options.onTooLarge(offset + chunk.bytes);
      if (chunk.bytes > 0) {
        await appendFile(staging, Buffer.from(chunk.data, "base64"));
        offset += chunk.bytes;
        fetchedBytes += chunk.bytes;
      }
      if (chunk.eof || chunk.bytes === 0) break;
    }

    await rename(staging, transcriptPath);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => {});
    throw error;
  }

  return { offset, fetchedBytes, restarted, fingerprint, remoteSize };
}

/**
 * Cuts a staged copy back to its last complete line and returns the new size.
 * Resuming mid-record would leave that record broken forever, since every later
 * byte is appended after it.
 */
export async function alignToRecordBoundary(filePath: string): Promise<number> {
  const info = await stat(filePath).catch(() => null);
  if (!info || info.size === 0) return 0;
  const handle = await open(filePath, "r+");
  try {
    const window = Math.min(info.size, RECORD_ALIGN_WINDOW_BYTES);
    const buffer = Buffer.allocUnsafe(window);
    const { bytesRead } = await handle.read(buffer, 0, window, info.size - window);
    const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    // A whole window with no record boundary is not a prefix worth resuming.
    const aligned = lastNewline < 0 ? 0 : info.size - bytesRead + lastNewline + 1;
    if (aligned !== info.size) await handle.truncate(aligned);
    return aligned;
  } finally {
    await handle.close();
  }
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
    entries.push(...parseTranscriptLine(line, lineStart >= appendedFromByte));
  }
  return entries;
}

/**
 * Projects one JSONL record into the entries it is worth rendering. Anything
 * Jasmine cannot name is dropped rather than shown as raw JSON.
 *
 * One assistant message can carry several kinds of content at once. A reasoning
 * model's turn is typically a thinking block followed by text or a tool call, so
 * the record becomes both entries: choosing one kind per message renders remote
 * history as if the model never reasoned.
 */
export function parseTranscriptLine(line: string, appended: boolean): RemoteTranscriptEntry[] {
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    value = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  const id = typeof value.id === "string" ? value.id : null;
  const timestamp = typeof value.timestamp === "string" ? value.timestamp : null;
  if (value.type === "compaction") {
    return present(entry(id, "compaction", timestamp, typeof value.summary === "string" ? value.summary : "", null, appended));
  }
  if (value.type !== "message") return [];
  const message = value.message && typeof value.message === "object" ? value.message as Record<string, unknown> : null;
  if (!message) return [];
  const role = typeof message.role === "string" ? message.role : "";
  const parts = contentParts(message.content);
  if (role === "user") return present(entry(id, "user", timestamp, parts.text, null, appended));
  if (role === "toolResult" || role === "tool") {
    return present(entry(id, "tool", timestamp, parts.text, typeof message.toolName === "string" ? message.toolName : null, appended));
  }
  if (role !== "assistant") return [];
  // Every block in the order the model produced it: the thinking that led to the
  // output, the output, and one entry per tool call. Batched calls are several
  // blocks in one record, so collapsing to a single tool name would render a
  // parallel batch as one call.
  const blocks = assistantBlocks(message.content);
  return present(...blocks.map((block, index) => entry(
    id && blocks.length > 1 ? `${id}:${index}` : id,
    block.kind,
    timestamp,
    block.text,
    block.toolName,
    appended
  )));
}

function present(...entries: Array<RemoteTranscriptEntry | null>): RemoteTranscriptEntry[] {
  return entries.filter((value): value is RemoteTranscriptEntry => value !== null);
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

function contentParts(content: unknown): { text: string } {
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: "" };
  const text: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const candidate = part as Record<string, unknown>;
    if (candidate.type === "text" && typeof candidate.text === "string") text.push(candidate.text);
  }
  return { text: text.join("\n").trim() };
}

type AssistantBlock = { kind: RemoteTranscriptEntryKind; text: string; toolName: string | null };

/**
 * The blocks of one assistant message, in order. Runs of the same kind are
 * joined so text that arrived in several parts stays one entry, while a
 * different kind -- thinking, or a tool call -- always starts a new one.
 */
function assistantBlocks(content: unknown): AssistantBlock[] {
  if (typeof content === "string") return [{ kind: "assistant", text: content, toolName: null }];
  if (!Array.isArray(content)) return [];
  const blocks: AssistantBlock[] = [];
  const append = (kind: RemoteTranscriptEntryKind, text: string) => {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind && !last.toolName) last.text = `${last.text}\n${text}`;
    else blocks.push({ kind, text, toolName: null });
  };
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const candidate = part as Record<string, unknown>;
    if (candidate.type === "text" && typeof candidate.text === "string") append("assistant", candidate.text);
    else if (candidate.type === "thinking" && typeof candidate.thinking === "string") append("thinking", candidate.thinking);
    else if (candidate.type === "toolCall" && typeof candidate.name === "string") {
      blocks.push({ kind: "tool", text: "", toolName: candidate.name });
    }
  }
  return blocks;
}

/**
 * Reduces a remote directory to the single spelling it is keyed by. The host
 * reports a canonical cwd for every session it lists, so a stored path that
 * still carries `.`, `..`, doubled or trailing slashes can never match one --
 * it becomes a second workspace for a directory that already has one.
 */
export function normalizeRemotePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return "/";
  const collapsed = path.posix.normalize(trimmed);
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
