import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { ContextCacheMetrics, ContextRawPayloadState, ContextReasoningValidation, ContextTaxonomy, ThreadContextTaxonomyResponse } from "../../../shared/ipc.js";
import type { SqlDatabase } from "./types.js";

type ContextCaptureRow = {
  id: string;
  thread_id: string;
  message_id: string;
  run_id: string | null;
  task_index: number;
  request_index: number;
  request_count: number;
  captured_at: string;
  provider: string;
  model: string;
  source: ContextTaxonomy["source"];
  schema_version: number;
  raw_payload_gzip: Uint8Array | null;
  raw_state: ContextRawPayloadState;
  raw_sha256: string | null;
  raw_char_count: number;
  raw_byte_count: number;
  validation_json: string;
  metadata_json: string;
};

export type StoredContextCapture = {
  summary: ThreadContextTaxonomyResponse["captures"][number];
  rawPayload: string | null;
  metadata: {
    assemblyReason?: ContextTaxonomy["assemblyReason"];
    cacheMetrics?: ContextCacheMetrics;
    payloadShape?: ContextTaxonomy["payloadShape"];
    fallbackTaxonomy?: ContextTaxonomy;
  };
};

export function addContextCapture(db: SqlDatabase, input: {
  threadId: string;
  messageId: string;
  runId?: string;
  taxonomy: ContextTaxonomy;
}): string {
  const taxonomy = input.taxonomy;
  const raw = taxonomy.rawPayload ?? null;
  const request = taxonomy.providerRequest;
  const id = randomUUID();
  const rawState: ContextRawPayloadState = raw ? (taxonomy.rawState ?? "complete") : "unavailable";
  const rawSha256 = raw ? createHash("sha256").update(raw).digest("hex") : null;
  const fallbackTaxonomy = raw ? undefined : withoutRawPayload(taxonomy);
  db.prepare(`
    INSERT INTO context_captures (
      id, thread_id, message_id, run_id, task_index, request_index, request_count,
      captured_at, provider, model, source, schema_version, raw_payload_gzip,
      raw_state, raw_sha256, raw_char_count, raw_byte_count, validation_json, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.threadId,
    input.messageId,
    input.runId ?? null,
    request?.taskIndex ?? 1,
    request?.index ?? 1,
    request?.count ?? 1,
    taxonomy.capturedAt,
    taxonomy.provider,
    taxonomy.model,
    taxonomy.source,
    taxonomy.payloadSchemaVersion ?? 5,
    raw ? gzipSync(Buffer.from(raw, "utf8")) : null,
    rawState,
    rawSha256,
    raw?.length ?? 0,
    raw ? Buffer.byteLength(raw, "utf8") : 0,
    JSON.stringify(taxonomy.reasoningValidation ?? {}),
    JSON.stringify({
      assemblyReason: taxonomy.assemblyReason,
      cacheMetrics: taxonomy.cacheMetrics,
      payloadShape: taxonomy.payloadShape,
      ...(fallbackTaxonomy ? { fallbackTaxonomy } : {})
    })
  );
  return id;
}

export function listLatestTaskContextCaptures(db: SqlDatabase, threadId: string): ThreadContextTaxonomyResponse["captures"] {
  const latest = db.prepare(`
    SELECT run_id, message_id, task_index
    FROM context_captures
    WHERE thread_id = ?
    ORDER BY captured_at DESC, rowid DESC
    LIMIT 1
  `).get(threadId) as { run_id: string | null; message_id: string; task_index: number } | undefined;
  if (!latest) return [];
  const rows = latest.run_id
    ? db.prepare(`
        SELECT * FROM context_captures
        WHERE thread_id = ? AND run_id = ? AND task_index = ?
        ORDER BY request_index ASC, captured_at ASC
      `).all(threadId, latest.run_id, latest.task_index) as ContextCaptureRow[]
    : db.prepare(`
        SELECT * FROM context_captures
        WHERE thread_id = ? AND message_id = ? AND task_index = ?
        ORDER BY request_index ASC, captured_at ASC
      `).all(threadId, latest.message_id, latest.task_index) as ContextCaptureRow[];
  return rows.map(rowToSummary);
}

export function getContextCapture(db: SqlDatabase, captureId: string): StoredContextCapture | null {
  const row = db.prepare("SELECT * FROM context_captures WHERE id = ?").get(captureId) as ContextCaptureRow | undefined;
  if (!row) return null;
  let rawPayload: string | null = null;
  if (row.raw_payload_gzip) {
    try { rawPayload = gunzipSync(Buffer.from(row.raw_payload_gzip)).toString("utf8"); } catch { rawPayload = null; }
  }
  return {
    summary: rowToSummary(row),
    rawPayload,
    metadata: parseMetadata(row.metadata_json)
  };
}

function rowToSummary(row: ContextCaptureRow): ThreadContextTaxonomyResponse["captures"][number] {
  const metadata = parseMetadata(row.metadata_json);
  const validation = parseValidation(row.validation_json);
  return {
    id: row.id,
    messageId: row.message_id,
    runId: row.run_id,
    createdAt: row.captured_at,
    provider: row.provider,
    model: row.model,
    source: row.source,
    schemaVersion: row.schema_version,
    taskIndex: row.task_index,
    requestIndex: row.request_index,
    requestCount: row.request_count,
    rawState: row.raw_state,
    rawSha256: row.raw_sha256,
    rawCharCount: row.raw_char_count,
    rawByteCount: row.raw_byte_count,
    ...(metadata.cacheMetrics ? { cacheMetrics: metadata.cacheMetrics } : {}),
    ...(validation ? { reasoningValidation: validation } : {})
  };
}

function parseValidation(value: string): ContextReasoningValidation | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<ContextReasoningValidation>;
    return parsed && typeof parsed.status === "string" && typeof parsed.policyId === "string"
      ? parsed as ContextReasoningValidation
      : undefined;
  } catch { return undefined; }
}

function parseMetadata(value: string): StoredContextCapture["metadata"] {
  try {
    const parsed = JSON.parse(value) as StoredContextCapture["metadata"];
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function withoutRawPayload(taxonomy: ContextTaxonomy): ContextTaxonomy {
  const { rawPayload: _rawPayload, ...rest } = taxonomy;
  return rest;
}
