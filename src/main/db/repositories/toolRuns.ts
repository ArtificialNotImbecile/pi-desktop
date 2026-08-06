import { randomUUID } from "node:crypto";
import type { ToolRun, ToolRunStatus } from "../../../shared/ipc.js";
import type { SqlDatabase } from "./types.js";

type ToolRunRow = {
  id: string;
  thread_id: string;
  message_id: string | null;
  kind: "provider_call";
  title: string;
  status: ToolRunStatus;
  provider_id: string | null;
  model_id: string | null;
  input_summary: string | null;
  output_summary: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  elapsed_ms: number | null;
};

const TOOL_RUN_COLUMNS = "id, thread_id, message_id, kind, title, status, provider_id, model_id, input_summary, output_summary, error, started_at, finished_at, elapsed_ms";

export function createToolRun(
  db: SqlDatabase,
  input: {
    threadId: string;
    title: string;
    providerId?: string;
    modelId?: string;
    inputSummary?: string;
  },
  timestamp: string
): ToolRun {
  const run: ToolRun = {
    id: randomUUID(),
    threadId: input.threadId,
    kind: "provider_call",
    title: input.title,
    status: "running",
    providerId: input.providerId,
    modelId: input.modelId,
    inputSummary: input.inputSummary,
    startedAt: timestamp
  };

  db.prepare(
    "INSERT INTO tool_runs (id, thread_id, kind, title, status, provider_id, model_id, input_summary, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(run.id, run.threadId, run.kind, run.title, run.status, run.providerId ?? null, run.modelId ?? null, run.inputSummary ?? null, run.startedAt);

  return run;
}

export function finishToolRun(
  db: SqlDatabase,
  input: {
    id: string;
    status: Exclude<ToolRunStatus, "running">;
    messageId?: string;
    outputSummary?: string;
    error?: string;
    elapsedMs?: number;
  },
  timestamp: string
): void {
  db.prepare(
    "UPDATE tool_runs SET status = ?, message_id = ?, output_summary = ?, error = ?, finished_at = ?, elapsed_ms = ? WHERE id = ?"
  ).run(input.status, input.messageId ?? null, input.outputSummary ?? null, input.error ?? null, timestamp, input.elapsedMs ?? null, input.id);
}

export function listToolRunsForThread(db: SqlDatabase, threadId: string): ToolRun[] {
  return db
    .prepare(`SELECT ${TOOL_RUN_COLUMNS} FROM tool_runs WHERE thread_id = ? ORDER BY started_at DESC`)
    .all(threadId)
    .map((row) => mapToolRun(row as ToolRunRow));
}

export function listToolRunsForMessage(db: SqlDatabase, messageId: string): ToolRun[] {
  return db
    .prepare(`SELECT ${TOOL_RUN_COLUMNS} FROM tool_runs WHERE message_id = ? ORDER BY started_at DESC`)
    .all(messageId)
    .map((row) => mapToolRun(row as ToolRunRow));
}

export function getToolRun(db: SqlDatabase, runId: string): ToolRun | null {
  const row = db
    .prepare(`SELECT ${TOOL_RUN_COLUMNS} FROM tool_runs WHERE id = ?`)
    .get(runId) as ToolRunRow | undefined;
  return row ? mapToolRun(row) : null;
}

function mapToolRun(row: ToolRunRow): ToolRun {
  return {
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id ?? undefined,
    kind: row.kind,
    title: row.title,
    status: row.status,
    providerId: row.provider_id ?? undefined,
    modelId: row.model_id ?? undefined,
    inputSummary: row.input_summary ?? undefined,
    outputSummary: row.output_summary ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    elapsedMs: row.elapsed_ms ?? undefined
  };
}
