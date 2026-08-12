import { randomUUID } from "node:crypto";
import type {
  FileChangeCaptureInput,
  FileChangeCaptureSummary,
  FileChangeCoverage,
  FileChangeDetail,
  FileChangeInput,
  FileChangeLineStats,
  FileChangeRevision,
  FileChangeRevisionSummary,
  FileChangeSummary
} from "../../../shared/ipc.js";
import type { SqlDatabase } from "./types.js";

export const FILE_CHANGE_DETAIL_CONTENT_MAX_CHARS = 4 * 1024 * 1024;
export const FILE_CHANGE_DETAIL_DIFF_MAX_CHARS = 2 * 1024 * 1024;

type FileChangeCaptureRow = {
  id: string;
  producer_capture_id: string | null;
  thread_id: string;
  message_id: string | null;
  run_id: string;
  schema_version: number;
  started_at: string;
  completed_at: string;
  cwd: string;
  roots_json: string;
  excludes_json: string;
  warnings_json: string;
  coverage_json: string;
};

type FileChangeRow = {
  id: string;
  capture_id: string;
  ordinal: number;
  status: FileChangeInput["status"];
  kind: FileChangeInput["kind"];
  path: string;
  root: string;
  relative_path: string;
  before_sha256: string | null;
  before_size: number | null;
  before_media_type: string | null;
  before_encoding: FileChangeRevision["encoding"] | null;
  before_mode: string | null;
  before_content?: string | null;
  before_content_present?: number;
  before_content_over_limit?: number;
  before_content_truncated: number;
  before_redacted: number;
  after_sha256: string | null;
  after_size: number | null;
  after_media_type: string | null;
  after_encoding: FileChangeRevision["encoding"] | null;
  after_mode: string | null;
  after_content?: string | null;
  after_content_present?: number;
  after_content_over_limit?: number;
  after_content_truncated: number;
  after_redacted: number;
  unified_diff?: string | null;
  has_unified_diff?: number;
  unified_diff_over_limit?: number;
  diff_truncated: number;
  diff_added_lines: number | null;
  diff_deleted_lines: number | null;
  provenance: FileChangeInput["provenance"];
};

export type AddFileChangeCaptureInput = {
  threadId: string;
  messageId?: string;
  runId: string;
  capture: FileChangeCaptureInput;
};

export function addFileChangeCapture(db: SqlDatabase, input: AddFileChangeCaptureInput): string {
  if (input.capture.schemaVersion !== 1) {
    throw new Error(`Unsupported file change capture schema version: ${input.capture.schemaVersion}.`);
  }
  if (input.messageId) {
    const owner = db.prepare("SELECT thread_id, run_id, role FROM chat_messages WHERE id = ?").get(input.messageId) as {
      thread_id: string;
      run_id: string | null;
      role: string;
    } | undefined;
    if (!owner || owner.thread_id !== input.threadId || owner.run_id !== input.runId || owner.role !== "assistant") {
      throw new Error("A file change capture must belong to an assistant message in the same thread and run.");
    }
  } else {
    const run = db.prepare("SELECT thread_id FROM tool_runs WHERE id = ?").get(input.runId) as { thread_id: string } | undefined;
    if (!run || run.thread_id !== input.threadId) {
      throw new Error("An unanchored file change capture must belong to a tool run in the same thread.");
    }
  }
  if (input.capture.producerCaptureId) {
    const existing = db.prepare(`
      SELECT id, thread_id, message_id FROM file_change_captures
      WHERE run_id = ? AND producer_capture_id = ?
    `).get(input.runId, input.capture.producerCaptureId) as {
      id: string;
      thread_id: string;
      message_id: string | null;
    } | undefined;
    if (existing) {
      if (existing.thread_id !== input.threadId || (existing.message_id !== null && existing.message_id !== (input.messageId ?? null))) {
        throw new Error("A producer capture ID cannot be reused by another message or thread.");
      }
      return existing.id;
    }
  }
  const id = randomUUID();
  const capture = input.capture;
  db.prepare(`
    INSERT INTO file_change_captures (
      id, producer_capture_id, thread_id, message_id, run_id, schema_version, started_at, completed_at,
      cwd, roots_json, excludes_json, warnings_json, coverage_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    capture.producerCaptureId ?? null,
    input.threadId,
    input.messageId ?? null,
    input.runId,
    capture.schemaVersion,
    capture.startedAt,
    capture.completedAt,
    capture.cwd,
    JSON.stringify(capture.roots),
    JSON.stringify(capture.excludes),
    JSON.stringify(capture.warnings),
    JSON.stringify(capture.coverage)
  );

  const insertChange = db.prepare(`
    INSERT INTO file_changes (
      id, capture_id, ordinal, status, kind, path, root, relative_path,
      before_sha256, before_size, before_media_type, before_encoding, before_mode, before_content, before_content_truncated, before_redacted,
      after_sha256, after_size, after_media_type, after_encoding, after_mode, after_content, after_content_truncated, after_redacted,
      unified_diff, diff_truncated, diff_added_lines, diff_deleted_lines, provenance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [ordinal, change] of stableChanges(capture.changes).entries()) {
    const redacted = Boolean(change.before?.redacted || change.after?.redacted);
    const before = revisionForStorage(change.before, redacted);
    const after = revisionForStorage(change.after, redacted);
    const diff = redacted ? { value: undefined, truncated: false } : boundText(change.unifiedDiff, FILE_CHANGE_DETAIL_DIFF_MAX_CHARS);
    // Counted here so the list query never has to read diff text back out.
    const lineStats = diff.value === undefined ? undefined : countDiffLines(diff.value);
    insertChange.run(
      randomUUID(),
      id,
      ordinal,
      change.status,
      change.kind,
      change.path,
      change.root,
      change.relativePath,
      change.before?.sha256 ?? null,
      change.before?.size ?? null,
      change.before?.mediaType ?? null,
      change.before?.encoding ?? null,
      change.before?.mode ?? null,
      before.content,
      before.contentTruncated ? 1 : 0,
      change.before && redacted ? 1 : 0,
      change.after?.sha256 ?? null,
      change.after?.size ?? null,
      change.after?.mediaType ?? null,
      change.after?.encoding ?? null,
      change.after?.mode ?? null,
      after.content,
      after.contentTruncated ? 1 : 0,
      change.after && redacted ? 1 : 0,
      diff.value ?? null,
      change.diffTruncated || diff.truncated ? 1 : 0,
      lineStats?.added ?? null,
      lineStats?.deleted ?? null,
      change.provenance
    );
  }
  return id;
}

export function listFileChangeCaptures(db: SqlDatabase, threadId: string): FileChangeCaptureSummary[] {
  const captures = db.prepare(`
    SELECT * FROM file_change_captures
    WHERE thread_id = ?
    ORDER BY completed_at ASC, rowid ASC
  `).all(threadId) as FileChangeCaptureRow[];
  if (captures.length === 0) return [];

  const changes = db.prepare(`
    SELECT
      changes.id, changes.capture_id, changes.ordinal, changes.status, changes.kind,
      changes.path, changes.root, changes.relative_path,
      changes.before_sha256, changes.before_size, changes.before_media_type, changes.before_encoding, changes.before_mode,
      CASE WHEN changes.before_content IS NULL THEN 0 ELSE 1 END AS before_content_present,
      changes.before_content_truncated, changes.before_redacted,
      changes.after_sha256, changes.after_size, changes.after_media_type, changes.after_encoding, changes.after_mode,
      CASE WHEN changes.after_content IS NULL THEN 0 ELSE 1 END AS after_content_present,
      changes.after_content_truncated, changes.after_redacted,
      CASE WHEN changes.unified_diff IS NULL THEN 0 ELSE 1 END AS has_unified_diff,
      changes.diff_truncated, changes.diff_added_lines, changes.diff_deleted_lines, changes.provenance
    FROM file_changes AS changes
    JOIN file_change_captures AS captures ON captures.id = changes.capture_id
    WHERE captures.thread_id = ?
    ORDER BY captures.completed_at ASC, captures.rowid ASC, changes.ordinal ASC, changes.rowid ASC
  `).all(threadId) as FileChangeRow[];
  const changesByCapture = new Map<string, FileChangeSummary[]>();
  for (const row of changes) {
    const items = changesByCapture.get(row.capture_id) ?? [];
    items.push(rowToSummary(row));
    changesByCapture.set(row.capture_id, items);
  }
  return captures.map((row) => rowToCaptureSummary(row, changesByCapture.get(row.id) ?? []));
}

export function getFileChangeDetail(db: SqlDatabase, threadId: string, changeId: string): FileChangeDetail | null {
  const row = db.prepare(`
    WITH limits(content_max, diff_max) AS (VALUES (?, ?))
    SELECT
      changes.id, changes.capture_id, changes.ordinal, changes.status, changes.kind,
      changes.path, changes.root, changes.relative_path,
      changes.before_sha256, changes.before_size, changes.before_media_type, changes.before_encoding, changes.before_mode,
      CASE
        WHEN changes.before_encoding = 'base64' AND length(changes.before_content) > limits.content_max THEN NULL
        ELSE substr(changes.before_content, 1, limits.content_max)
      END AS before_content,
      CASE WHEN length(changes.before_content) > limits.content_max THEN 1 ELSE 0 END AS before_content_over_limit,
      changes.before_content_truncated, changes.before_redacted,
      changes.after_sha256, changes.after_size, changes.after_media_type, changes.after_encoding, changes.after_mode,
      CASE
        WHEN changes.after_encoding = 'base64' AND length(changes.after_content) > limits.content_max THEN NULL
        ELSE substr(changes.after_content, 1, limits.content_max)
      END AS after_content,
      CASE WHEN length(changes.after_content) > limits.content_max THEN 1 ELSE 0 END AS after_content_over_limit,
      changes.after_content_truncated, changes.after_redacted,
      substr(changes.unified_diff, 1, limits.diff_max) AS unified_diff,
      CASE WHEN length(changes.unified_diff) > limits.diff_max THEN 1 ELSE 0 END AS unified_diff_over_limit,
      changes.diff_truncated, changes.diff_added_lines, changes.diff_deleted_lines, changes.provenance
    FROM file_changes AS changes
    JOIN file_change_captures AS captures ON captures.id = changes.capture_id
    CROSS JOIN limits
    WHERE changes.id = ? AND captures.thread_id = ?
  `).get(FILE_CHANGE_DETAIL_CONTENT_MAX_CHARS, FILE_CHANGE_DETAIL_DIFF_MAX_CHARS, changeId, threadId) as FileChangeRow | undefined;
  if (!row) return null;
  const before = detailRevision(row, "before");
  const after = detailRevision(row, "after");
  const boundedDiff = boundText(row.unified_diff, FILE_CHANGE_DETAIL_DIFF_MAX_CHARS);
  const lineStats = rowLineStats(row);
  return {
    id: row.id,
    captureId: row.capture_id,
    status: row.status,
    kind: row.kind,
    path: row.path,
    root: row.root,
    relativePath: row.relative_path,
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(boundedDiff.value !== undefined ? { unifiedDiff: boundedDiff.value } : {}),
    diffTruncated: Boolean(row.diff_truncated) || Boolean(row.unified_diff_over_limit) || boundedDiff.truncated,
    ...(lineStats ? { lineStats } : {}),
    provenance: row.provenance
  };
}

function rowToCaptureSummary(row: FileChangeCaptureRow, changes: FileChangeSummary[]): FileChangeCaptureSummary {
  return {
    id: row.id,
    ...(row.producer_capture_id ? { producerCaptureId: row.producer_capture_id } : {}),
    threadId: row.thread_id,
    ...(row.message_id ? { messageId: row.message_id } : {}),
    runId: row.run_id,
    schemaVersion: row.schema_version,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    capturedAt: row.completed_at,
    cwd: row.cwd,
    roots: parseStringArray(row.roots_json),
    excludes: parseStringArray(row.excludes_json),
    warnings: parseStringArray(row.warnings_json),
    coverage: parseCoverage(row.coverage_json),
    changes
  };
}

function rowToSummary(row: FileChangeRow): FileChangeSummary {
  const before = summaryRevision(row, "before");
  const after = summaryRevision(row, "after");
  const lineStats = rowLineStats(row);
  return {
    id: row.id,
    captureId: row.capture_id,
    status: row.status,
    kind: row.kind,
    path: row.path,
    root: row.root,
    relativePath: row.relative_path,
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    hasUnifiedDiff: Boolean(row.has_unified_diff),
    diffTruncated: Boolean(row.diff_truncated),
    ...(lineStats ? { lineStats } : {}),
    provenance: row.provenance
  };
}

function rowLineStats(row: FileChangeRow): FileChangeLineStats | undefined {
  if (row.diff_added_lines === null || row.diff_added_lines === undefined) return undefined;
  return { added: row.diff_added_lines, deleted: row.diff_deleted_lines ?? 0 };
}

/**
 * Counts payload lines of a unified diff the way `git diff --numstat` does.
 *
 * Only the `+++`/`---` pair that precedes a hunk is a file header. Inside a
 * hunk the same three characters are ordinary content: a line reading `++i;`
 * is encoded as `+++i;`, and deleting the SQL comment `-- note` produces
 * `--- note`. Hunk state is what separates the two.
 */
export function countDiffLines(diff: string): FileChangeLineStats {
  let added = 0;
  let deleted = 0;
  let inHunk = false;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("diff ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) deleted += 1;
  }
  return { added, deleted };
}

function summaryRevision(row: FileChangeRow, side: "before" | "after"): FileChangeRevisionSummary | undefined {
  const sha256 = row[`${side}_sha256`];
  const size = row[`${side}_size`];
  if (sha256 === null || size === null) return undefined;
  const mediaType = row[`${side}_media_type`];
  const encoding = row[`${side}_encoding`];
  const mode = row[`${side}_mode`];
  return {
    sha256,
    size,
    ...(mediaType ? { mediaType } : {}),
    ...(encoding ? { encoding } : {}),
    ...(mode ? { mode } : {}),
    contentAvailable: Boolean(row[`${side}_content_present`]),
    ...(row[`${side}_content_truncated`] ? { contentTruncated: true } : {}),
    ...(row[`${side}_redacted`] ? { redacted: true } : {})
  };
}

function detailRevision(row: FileChangeRow, side: "before" | "after"): FileChangeRevision | undefined {
  const sha256 = row[`${side}_sha256`];
  const size = row[`${side}_size`];
  if (sha256 === null || size === null) return undefined;
  const mediaType = row[`${side}_media_type`];
  const encoding = row[`${side}_encoding`];
  const mode = row[`${side}_mode`];
  const redacted = Boolean(row[`${side}_redacted`]);
  const content = redacted ? null : row[`${side}_content`];
  const bounded = boundRevisionContent(content, encoding);
  return {
    sha256,
    size,
    ...(mediaType ? { mediaType } : {}),
    ...(encoding ? { encoding } : {}),
    ...(mode ? { mode } : {}),
    ...(bounded.value !== undefined ? { content: bounded.value } : {}),
    ...(row[`${side}_content_truncated`] || row[`${side}_content_over_limit`] || bounded.truncated ? { contentTruncated: true } : {}),
    ...(redacted ? { redacted: true } : {})
  };
}

function revisionForStorage(revision: FileChangeRevision | undefined, changeRedacted = false): { content: string | null; contentTruncated: boolean } {
  if (!revision) return { content: null, contentTruncated: false };
  if (changeRedacted || revision.redacted) {
    return { content: null, contentTruncated: Boolean(revision.contentTruncated) };
  }
  if (revision.content === undefined) {
    return { content: null, contentTruncated: Boolean(revision.contentTruncated) };
  }
  if (revision.content.length > FILE_CHANGE_DETAIL_CONTENT_MAX_CHARS) {
    return { content: null, contentTruncated: true };
  }
  return { content: revision.content, contentTruncated: Boolean(revision.contentTruncated) };
}

function stableChanges(changes: FileChangeInput[]): FileChangeInput[] {
  return changes
    .map((change, index) => ({ change, index }))
    .sort((left, right) => compareChange(left.change, right.change) || left.index - right.index)
    .map(({ change }) => change);
}

function compareChange(left: FileChangeInput, right: FileChangeInput): number {
  return compareText(left.root, right.root)
    || compareText(left.relativePath, right.relativePath)
    || compareText(left.path, right.path)
    || compareText(left.status, right.status)
    || compareText(left.kind, right.kind);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundRevisionContent(value: string | null | undefined, encoding: FileChangeRevision["encoding"] | null): { value?: string; truncated: boolean } {
  if (value === null || value === undefined) return { truncated: false };
  if (value.length <= FILE_CHANGE_DETAIL_CONTENT_MAX_CHARS) return { value, truncated: false };
  // A partial base64 payload is not a valid image or binary representation, so
  // omit it rather than returning deceptively broken data.
  if (encoding?.toLowerCase() === "base64") return { truncated: true };
  return { value: value.slice(0, FILE_CHANGE_DETAIL_CONTENT_MAX_CHARS), truncated: true };
}

function boundText(value: string | null | undefined, limit: number): { value?: string; truncated: boolean } {
  if (value === null || value === undefined) return { truncated: false };
  if (value.length <= limit) return { value, truncated: false };
  return { value: value.slice(0, limit), truncated: true };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseCoverage(value: string): FileChangeCoverage {
  try {
    const parsed = JSON.parse(value) as Partial<FileChangeCoverage>;
    if (
      parsed
      && (parsed.status === "complete" || parsed.status === "partial" || parsed.status === "failed" || parsed.status === "unsupported")
      && (parsed.target === "local" || parsed.target === "remote")
    ) {
      return parsed as FileChangeCoverage;
    }
  } catch {
    // Fall through to an explicit corrupt-metadata state.
  }
  return {
    status: "unsupported",
    target: "local",
    reason: "Stored coverage metadata is invalid."
  };
}
