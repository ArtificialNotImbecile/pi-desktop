import { randomUUID } from "node:crypto";
import type { ChatThread } from "../../../shared/ipc.js";
import type { SqlDatabase } from "./types.js";

type ThreadRow = {
  id: string;
  title: string;
  project_id?: string | null;
  active_plugin_ids_json?: string | null;
  message_count: number;
  draft?: string | null;
  created_at: string;
  updated_at: string;
};

export function listThreads(db: SqlDatabase, filter: { projectId?: string | null } = {}): ChatThread[] {
  const whereClause = filter.projectId === undefined
    ? ""
    : filter.projectId === null
      ? "WHERE chat_threads.project_id IS NULL"
      : "WHERE chat_threads.project_id = ?";
  // message_count is denormalized onto chat_threads (maintained by the message
  // insert/delete paths) so listing threads never scans chat_messages.
  // The draft is truncated to a short preview: list consumers only need a
  // has-draft indicator; the full draft is fetched via threads:draft:get when
  // a thread is activated.
  const statement = db
    .prepare(`
      SELECT
        chat_threads.id,
        chat_threads.title,
        chat_threads.project_id,
        chat_threads.active_plugin_ids_json,
        SUBSTR(thread_drafts.content, 1, 120) AS draft,
        chat_threads.created_at,
        chat_threads.updated_at,
        chat_threads.message_count
      FROM chat_threads
      LEFT JOIN thread_drafts ON thread_drafts.thread_id = chat_threads.id
      ${whereClause}
      ORDER BY chat_threads.updated_at DESC
    `);
  const rows = filter.projectId === undefined || filter.projectId === null
    ? statement.all()
    : statement.all(filter.projectId);
  return rows.map((row) => mapThread(row as ThreadRow));
}

export function getThread(db: SqlDatabase, threadId: string): ChatThread | null {
  const row = db
    .prepare(`
      SELECT
        chat_threads.id,
        chat_threads.title,
        chat_threads.project_id,
        chat_threads.active_plugin_ids_json,
        thread_drafts.content AS draft,
        chat_threads.created_at,
        chat_threads.updated_at,
        chat_threads.message_count
      FROM chat_threads
      LEFT JOIN thread_drafts ON thread_drafts.thread_id = chat_threads.id
      WHERE chat_threads.id = ?
    `)
    .get(threadId) as ThreadRow | undefined;
  return row ? mapThread(row) : null;
}

export function createThread(db: SqlDatabase, title: string, timestamp: string, projectId: string | null = null): ChatThread {
  const thread: ChatThread = {
    id: randomUUID(),
    title,
    projectId,
    messageCount: 0,
    activePluginIds: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };

  db.prepare("INSERT INTO chat_threads (id, title, project_id, active_plugin_ids_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(thread.id, thread.title, thread.projectId, JSON.stringify(thread.activePluginIds), thread.createdAt, thread.updatedAt);

  return thread;
}

export function updateThreadTitle(db: SqlDatabase, threadId: string, title: string, timestamp: string): ChatThread {
  db.prepare("UPDATE chat_threads SET title = ?, updated_at = ? WHERE id = ?").run(title, timestamp, threadId);
  const thread = getThread(db, threadId);
  if (!thread) throw new Error("Thread does not exist.");
  return thread;
}

export function touchThread(db: SqlDatabase, threadId: string, timestamp: string): void {
  db.prepare("UPDATE chat_threads SET updated_at = ? WHERE id = ?").run(timestamp, threadId);
}

export function deleteThread(db: SqlDatabase, threadId: string): void {
  db.prepare("DELETE FROM chat_threads WHERE id = ?").run(threadId);
}

export function deleteThreadsByIds(db: SqlDatabase, threadIds: string[]): void {
  if (threadIds.length === 0) return;
  const placeholders = threadIds.map(() => "?").join(", ");
  db.prepare(`DELETE FROM chat_threads WHERE id IN (${placeholders})`).run(...threadIds);
}

export function hasThread(db: SqlDatabase, threadId: string): boolean {
  const row = db.prepare("SELECT 1 AS exists_flag FROM chat_threads WHERE id = ?").get(threadId) as { exists_flag?: number };
  return row?.exists_flag === 1;
}

export function getThreadMessageCount(db: SqlDatabase, threadId: string): number {
  const row = db.prepare("SELECT message_count AS count FROM chat_threads WHERE id = ?").get(threadId) as { count?: number };
  return Number(row?.count ?? 0);
}

// Keeps the denormalized chat_threads.message_count in step with message
// inserts/deletes. Callers must run this inside the same transaction as the
// row change itself.
export function adjustThreadMessageCount(db: SqlDatabase, threadId: string, delta: number): void {
  db.prepare("UPDATE chat_threads SET message_count = MAX(0, message_count + ?) WHERE id = ?").run(delta, threadId);
}

export function getThreadDraft(db: SqlDatabase, threadId: string): string {
  const row = db.prepare("SELECT content FROM thread_drafts WHERE thread_id = ?").get(threadId) as { content?: string } | undefined;
  return row?.content ?? "";
}

export function updateThreadDraft(db: SqlDatabase, threadId: string, content: string, timestamp: string): void {
  if (!content) {
    db.prepare("DELETE FROM thread_drafts WHERE thread_id = ?").run(threadId);
    return;
  }
  db.prepare(
    "INSERT INTO thread_drafts (thread_id, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at"
  ).run(threadId, content, timestamp);
}

export function updateThreadActivePluginIds(db: SqlDatabase, threadId: string, pluginIds: string[], timestamp: string): ChatThread {
  const activePluginIds = Array.from(new Set(pluginIds)).slice(0, 6);
  db.prepare("UPDATE chat_threads SET active_plugin_ids_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(activePluginIds), timestamp, threadId);
  const thread = getThread(db, threadId);
  if (!thread) throw new Error("Thread does not exist.");
  return thread;
}

function mapThread(row: ThreadRow): ChatThread {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id ?? null,
    messageCount: Number(row.message_count ?? 0),
    draft: row.draft ?? undefined,
    activePluginIds: parseActivePluginIds(row.active_plugin_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseActivePluginIds(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0))).slice(0, 6);
  } catch {
    return [];
  }
}
