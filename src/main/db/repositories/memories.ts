import { randomUUID } from "node:crypto";
import type { MemoryRecord } from "../../../shared/ipc.js";
import type { SqlDatabase } from "./types.js";

type MemoryRow = {
  id: string;
  content: string;
  source_message_id: string | null;
  source_thread_id: string | null;
  archived: number;
  deleted: number;
  created_at: string;
  updated_at: string;
};

const MEMORY_COLUMNS = "id, content, source_message_id, source_thread_id, archived, deleted, created_at, updated_at";

export function listMemories(db: SqlDatabase, input: { includeArchived?: boolean } = {}): MemoryRecord[] {
  const where = input.includeArchived ? "deleted = 0" : "deleted = 0 AND archived = 0";
  return db
    .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE ${where} ORDER BY updated_at DESC`)
    .all()
    .map((row) => mapMemory(row as MemoryRow));
}

export function getMemory(db: SqlDatabase, memoryId: string): MemoryRecord | null {
  const row = db
    .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ? AND deleted = 0`)
    .get(memoryId) as MemoryRow | undefined;
  return row ? mapMemory(row) : null;
}

export function createMemory(
  db: SqlDatabase,
  input: { content: string; sourceMessageId?: string; sourceThreadId?: string },
  timestamp: string
): MemoryRecord {
  const memory: MemoryRecord = {
    id: randomUUID(),
    content: input.content.trim(),
    sourceMessageId: input.sourceMessageId,
    sourceThreadId: input.sourceThreadId,
    archived: false,
    deleted: false,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  if (!memory.content) throw new Error("Memory content is empty.");

  db.prepare(
    "INSERT INTO memories (id, content, source_message_id, source_thread_id, archived, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    memory.id,
    memory.content,
    memory.sourceMessageId ?? null,
    memory.sourceThreadId ?? null,
    0,
    0,
    memory.createdAt,
    memory.updatedAt
  );

  return memory;
}

export function updateMemory(db: SqlDatabase, input: { id: string; content: string }, timestamp: string): void {
  const content = input.content.trim();
  if (!content) throw new Error("Memory content is empty.");
  db.prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ? AND deleted = 0").run(content, timestamp, input.id);
}

export function archiveMemory(db: SqlDatabase, input: { id: string; archived: boolean }, timestamp: string): void {
  db.prepare("UPDATE memories SET archived = ?, updated_at = ? WHERE id = ? AND deleted = 0")
    .run(input.archived ? 1 : 0, timestamp, input.id);
}

export function deleteMemory(db: SqlDatabase, memoryId: string, timestamp: string): void {
  db.prepare("UPDATE memories SET deleted = 1, updated_at = ? WHERE id = ?").run(timestamp, memoryId);
}

function mapMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    content: row.content,
    sourceMessageId: row.source_message_id ?? undefined,
    sourceThreadId: row.source_thread_id ?? undefined,
    archived: row.archived === 1,
    deleted: row.deleted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
