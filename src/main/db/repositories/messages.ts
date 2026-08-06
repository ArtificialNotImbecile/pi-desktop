import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatRole, ChatTimelineItem, MemoryReference, PickedPath, PluginReference, SkillReference, WebSearchResult } from "../../../shared/ipc.js";
import type { SqlDatabase } from "./types.js";

type MessageRow = {
  id: string;
  thread_id: string;
  role: ChatRole;
  content: string;
  attachments_json?: string | null;
  created_at: string;
  elapsed_ms: number | null;
  model_id: string | null;
  status: "sent" | "error" | null;
  memory_used_json?: string | null;
  skills_used_json?: string | null;
  plugins_used_json?: string | null;
  web_search_used_json?: string | null;
  timeline_json?: string | null;
};

export type MessageListOptions = {
  limit?: number;
  before?: {
    id: string;
    createdAt: string;
  };
};

const MESSAGE_COLUMNS = "id, thread_id, role, content, attachments_json, created_at, elapsed_ms, model_id, status, memory_used_json, skills_used_json, plugins_used_json, web_search_used_json, timeline_json";

export function listMessages(db: SqlDatabase, threadId: string, options: MessageListOptions = {}): ChatMessage[] {
  const limit = options.limit ? Math.max(1, Math.min(500, options.limit)) : undefined;
  if (!limit) {
    return db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC`
      )
      .all(threadId)
      .map((row) => mapMessage(row as MessageRow));
  }

  const rows = options.before
    ? db
        .prepare(
          `SELECT ${MESSAGE_COLUMNS}
           FROM chat_messages
           WHERE thread_id = ?
             AND (
               created_at < ?
               OR (
                 created_at = ?
                 AND rowid < (SELECT rowid FROM chat_messages WHERE thread_id = ? AND id = ?)
               )
             )
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?`
        )
        .all(threadId, options.before.createdAt, options.before.createdAt, threadId, options.before.id, limit)
    : db
        .prepare(
          `SELECT ${MESSAGE_COLUMNS}
           FROM chat_messages
           WHERE thread_id = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?`
        )
        .all(threadId, limit);
  return rows.reverse().map((row) => mapMessage(row as MessageRow));
}

export function deleteMessagesByIds(db: SqlDatabase, threadId: string, messageIds: string[]): number {
  if (messageIds.length === 0) return 0;
  const placeholders = messageIds.map(() => "?").join(", ");
  const result = db.prepare(`DELETE FROM chat_messages WHERE thread_id = ? AND id IN (${placeholders})`).run(threadId, ...messageIds);
  return Number(result.changes ?? 0);
}

export function updateMessage(
  db: SqlDatabase,
  input: { threadId: string; messageId: string; content: string; attachments?: PickedPath[]; skillsUsed?: SkillReference[]; pluginsUsed?: PluginReference[] }
): ChatMessage {
  if (input.skillsUsed || input.pluginsUsed) {
    db.prepare("UPDATE chat_messages SET content = ?, attachments_json = ?, skills_used_json = ?, plugins_used_json = ? WHERE thread_id = ? AND id = ? AND role = 'user'")
      .run(input.content, JSON.stringify(input.attachments ?? []), JSON.stringify(input.skillsUsed ?? []), JSON.stringify(input.pluginsUsed ?? []), input.threadId, input.messageId);
  } else {
    db.prepare("UPDATE chat_messages SET content = ?, attachments_json = ? WHERE thread_id = ? AND id = ? AND role = 'user'")
      .run(input.content, JSON.stringify(input.attachments ?? []), input.threadId, input.messageId);
  }

  const row = db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE thread_id = ? AND id = ?`
    )
    .get(input.threadId, input.messageId) as MessageRow | undefined;
  if (!row) throw new Error("Message to edit does not exist.");
  return mapMessage(row);
}

export function addMessage(
  db: SqlDatabase,
  input: {
    threadId: string;
    role: ChatRole;
    content: string;
    attachments?: PickedPath[];
    elapsedMs?: number;
    modelId?: string;
    status?: "sent" | "error";
    memoryUsed?: MemoryReference[];
    skillsUsed?: SkillReference[];
    pluginsUsed?: PluginReference[];
    webSearchUsed?: WebSearchResult[];
    timeline?: ChatTimelineItem[];
  },
  timestamp: string
): ChatMessage {
  const message: ChatMessage = {
    id: randomUUID(),
    threadId: input.threadId,
    role: input.role,
    content: input.content,
    attachments: input.attachments,
    createdAt: timestamp,
    elapsedMs: input.elapsedMs,
    modelId: input.modelId,
    status: input.status ?? "sent",
    memoryUsed: input.memoryUsed,
    skillsUsed: input.skillsUsed,
    pluginsUsed: input.pluginsUsed,
    webSearchUsed: input.webSearchUsed,
    timeline: input.timeline
  };

  db.prepare(
    "INSERT INTO chat_messages (id, thread_id, role, content, attachments_json, created_at, elapsed_ms, model_id, status, memory_used_json, skills_used_json, plugins_used_json, web_search_used_json, timeline_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    message.id,
    message.threadId,
    message.role,
    message.content,
    JSON.stringify(input.attachments ?? []),
    message.createdAt,
    message.elapsedMs ?? null,
    message.modelId ?? null,
    message.status ?? "sent",
    JSON.stringify(input.memoryUsed ?? []),
    JSON.stringify(input.skillsUsed ?? []),
    JSON.stringify(input.pluginsUsed ?? []),
    JSON.stringify(input.webSearchUsed ?? []),
    JSON.stringify(input.timeline ?? [])
  );

  return message;
}

function mapMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    attachments: parseAttachments(row.attachments_json),
    createdAt: row.created_at,
    elapsedMs: row.elapsed_ms ?? undefined,
    modelId: row.model_id ?? undefined,
    status: row.status ?? "sent",
    memoryUsed: parseMemoryReferences(row.memory_used_json),
    skillsUsed: parseSkillReferences(row.skills_used_json),
    pluginsUsed: parsePluginReferences(row.plugins_used_json),
    webSearchUsed: parseWebSearchResults(row.web_search_used_json),
    timeline: parseTimeline(row.timeline_json)
  };
}

function parseAttachments(value: string | null | undefined): PickedPath[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPickedPath);
  } catch {
    return [];
  }
}

function parseMemoryReferences(value: string | null | undefined): MemoryReference[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isMemoryReference).map((item) => ({
      id: item.id,
      content: item.content
    }));
  } catch {
    return [];
  }
}

function parseWebSearchResults(value: string | null | undefined): WebSearchResult[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isWebSearchResult).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet
    }));
  } catch {
    return [];
  }
}

function isMemoryReference(item: unknown): item is MemoryReference {
  if (!item || typeof item !== "object") return false;
  const value = item as { id?: unknown; content?: unknown };
  return typeof value.id === "string" && typeof value.content === "string";
}

function parseSkillReferences(value: string | null | undefined): SkillReference[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSkillReference).map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      instructions: typeof item.instructions === "string" ? item.instructions : undefined
    }));
  } catch {
    return [];
  }
}

function isSkillReference(item: unknown): item is SkillReference {
  if (!item || typeof item !== "object") return false;
  const value = item as { id?: unknown; name?: unknown; description?: unknown };
  return typeof value.id === "string" && typeof value.name === "string" && typeof value.description === "string";
}

function parsePluginReferences(value: string | null | undefined): PluginReference[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPluginReference).map((item) => ({
      id: item.id,
      name: item.name,
      source: item.source,
      scope: item.scope,
      enabled: item.enabled
    }));
  } catch {
    return [];
  }
}

function isPluginReference(item: unknown): item is PluginReference {
  if (!item || typeof item !== "object") return false;
  const value = item as { id?: unknown; name?: unknown; source?: unknown; scope?: unknown; enabled?: unknown };
  return typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.source === "string"
    && (value.scope === "user" || value.scope === "project")
    && typeof value.enabled === "boolean";
}

function isWebSearchResult(item: unknown): item is WebSearchResult {
  if (!item || typeof item !== "object") return false;
  const value = item as { title?: unknown; url?: unknown; snippet?: unknown };
  return typeof value.title === "string" && typeof value.url === "string" && typeof value.snippet === "string";
}

function parseTimeline(value: string | null | undefined): ChatTimelineItem[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTimelineItem);
  } catch {
    return [];
  }
}

function isTimelineItem(item: unknown): item is ChatTimelineItem {
  if (!item || typeof item !== "object") return false;
  const value = item as {
    id?: unknown;
    kind?: unknown;
    text?: unknown;
    toolName?: unknown;
    title?: unknown;
    argumentsJson?: unknown;
    content?: unknown;
    isError?: unknown;
    customType?: unknown;
    data?: unknown;
  };
  if (typeof value.id !== "string" || typeof value.kind !== "string") return false;
  if (value.kind === "thinking") return typeof value.text === "string";
  if (value.kind === "assistant_text") return typeof value.text === "string";
  if (value.kind === "system") return typeof value.title === "string" && typeof value.text === "string";
  if (value.kind === "tool_call") {
    return typeof value.toolName === "string" && typeof value.title === "string" && typeof value.argumentsJson === "string";
  }
  if (value.kind === "tool_result") {
    return typeof value.toolName === "string" && typeof value.title === "string" && typeof value.content === "string";
  }
  return false;
}

function isPickedPath(item: unknown): item is PickedPath {
  if (!item || typeof item !== "object") return false;
  const value = item as { name?: unknown; path?: unknown; kind?: unknown };
  return typeof value.name === "string" && typeof value.path === "string" && (value.kind === "file" || value.kind === "folder");
}
