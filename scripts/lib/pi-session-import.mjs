import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync, backup } = require("node:sqlite");

export function discoverPiSessionFiles(sourceRoot) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push(fullPath);
    }
  };
  visit(path.resolve(sourceRoot));
  return files.sort((left, right) => left.localeCompare(right));
}

export function parsePiSessionFile(filePath, options = {}) {
  const absoluteFilePath = path.resolve(filePath);
  const rows = readFileSync(absoluteFilePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${absoluteFilePath}:${index + 1}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  const session = rows.find((entry) => entry?.type === "session");
  if (!session?.id || !session?.cwd || !session?.timestamp) {
    throw new Error(`${absoluteFilePath}: missing Pi session id, cwd, or timestamp.`);
  }

  const activeEntries = activeSessionEntries(rows);
  const assetRoot = path.resolve(options.assetRoot ?? path.join(path.dirname(absoluteFilePath), ".jasmine-import-assets"));
  const assets = [];
  const messages = [];
  let currentModel = null;
  let thinkingLevel = null;
  let lastUserTimestamp = null;
  let pending = createPendingAssistant();
  let assistantSequence = 0;

  const ensurePending = (entry) => {
    if (!pending.startedAt) {
      pending.startedAt = timestampOf(entry, session.timestamp);
      if (currentModel) {
        pending.timeline.push({
          id: deterministicId(`${session.id}:assistant:${assistantSequence}:model`),
          kind: "system",
          title: "Model",
          text: `${currentModel.provider}/${currentModel.modelId}`
        });
        pending.modelId = currentModel.modelId;
      }
      if (thinkingLevel) {
        pending.timeline.push({
          id: deterministicId(`${session.id}:assistant:${assistantSequence}:thinking-level`),
          kind: "system",
          title: "Thinking level",
          text: thinkingLevel
        });
      }
    }
    pending.lastAt = timestampOf(entry, pending.startedAt);
    if (!pending.sessionEntryId && entry.type === "message") pending.sessionEntryId = entry.id;
  };

  const flushAssistant = () => {
    if (pending.timeline.length === 0) {
      pending = createPendingAssistant();
      return;
    }
    if (!hasVisibleTimelineActivity(pending.timeline)) {
      const previous = messages.at(-1);
      if (previous?.role === "assistant") {
        previous.timeline.push(...pending.timeline);
        previous.webSearchUsed = mergeWebSearchResults(previous.webSearchUsed, pending.webSearchUsed);
      }
      pending = createPendingAssistant();
      return;
    }
    const createdAt = pending.startedAt ?? lastUserTimestamp ?? session.timestamp;
    const content = assistantTextFromTimeline(pending.timeline);
    const elapsedMs = lastUserTimestamp
      ? Math.max(0, Date.parse(pending.lastAt ?? createdAt) - Date.parse(lastUserTimestamp))
      : undefined;
    messages.push({
      id: deterministicId(`${session.id}:assistant:${assistantSequence}`),
      role: "assistant",
      content,
      attachments: [],
      createdAt,
      elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : undefined,
      modelId: pending.modelId ?? currentModel?.modelId,
      status: pending.error ? "error" : "sent",
      sessionEntryId: pending.sessionEntryId,
      webSearchUsed: pending.webSearchUsed,
      timeline: pending.timeline
    });
    assistantSequence += 1;
    pending = createPendingAssistant();
  };

  for (const entry of activeEntries) {
    if (entry.type === "session_info") continue;
    if (entry.type === "model_change") {
      currentModel = { provider: stringValue(entry.provider, "unknown"), modelId: stringValue(entry.modelId, "unknown") };
      if (pending.startedAt) {
        ensurePending(entry);
        pending.modelId = currentModel.modelId;
        pending.timeline.push({ id: entry.id, kind: "system", title: "Model", text: `${currentModel.provider}/${currentModel.modelId}` });
      }
      continue;
    }
    if (entry.type === "thinking_level_change") {
      thinkingLevel = stringValue(entry.thinkingLevel, "");
      if (pending.startedAt) {
        ensurePending(entry);
        pending.timeline.push({ id: entry.id, kind: "system", title: "Thinking level", text: thinkingLevel });
      }
      continue;
    }

    if (entry.type === "message" && entry.message?.role === "user") {
      flushAssistant();
      const userAssets = imageAssets(entry, session.id, assetRoot);
      assets.push(...userAssets);
      const content = contentToText(entry.message.content);
      messages.push({
        id: deterministicId(`${session.id}:user:${entry.id}`),
        role: "user",
        content: content || (userAssets.length > 0 ? "[Image]" : ""),
        attachments: userAssets.map((asset) => ({
          name: path.basename(asset.filePath),
          path: asset.filePath,
          kind: "file",
          mediaType: asset.mediaType,
          isImage: true,
          previewDataUrl: `data:${asset.mediaType};base64,${asset.data}`
        })),
        createdAt: timestampOf(entry, session.timestamp),
        status: "sent",
        sessionEntryId: entry.id,
        webSearchUsed: [],
        timeline: []
      });
      lastUserTimestamp = timestampOf(entry, session.timestamp);
      continue;
    }

    const timelineItems = entryToTimeline(entry, session.id, assetRoot, assets);
    if (timelineItems.length === 0) continue;
    ensurePending(entry);
    pending.timeline.push(...timelineItems);
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const provider = stringValue(entry.message.provider, currentModel?.provider ?? "unknown");
      const modelId = stringValue(entry.message.model, currentModel?.modelId ?? "unknown");
      currentModel = { provider, modelId };
      pending.modelId = modelId;
      pending.error ||= entry.message.stopReason === "error" || Boolean(entry.message.errorMessage);
    }
    if (entry.type === "custom" && entry.customType === "web-search-results") {
      pending.webSearchUsed = mergeWebSearchResults(pending.webSearchUsed, extractWebSearchResults(entry.data));
    }
  }
  flushAssistant();

  const titleEntry = [...activeEntries].reverse().find((entry) => entry.type === "session_info" && stringValue(entry.name, "").trim());
  const firstUser = messages.find((message) => message.role === "user")?.content ?? "";
  const createdAt = timestampOf(session, messages[0]?.createdAt ?? new Date(statSync(absoluteFilePath).birthtimeMs).toISOString());
  const updatedAt = activeEntries.at(-1) ? timestampOf(activeEntries.at(-1), createdAt) : createdAt;
  return {
    id: session.id,
    formatVersion: Number.isInteger(session.version) ? session.version : 1,
    title: safeTitle(stringValue(titleEntry?.name, "").trim() || fallbackTitle(firstUser, createdAt)),
    cwd: path.resolve(session.cwd),
    sourceFile: absoluteFilePath,
    createdAt,
    updatedAt,
    messages,
    assets,
    sourceRowCount: rows.length,
    activeEntryCount: activeEntries.length,
    excludedBranchEntryCount: Math.max(0, rows.filter((entry) => entry.type !== "session").length - activeEntries.length)
  };
}

export async function importPiSessions(options) {
  const databasePath = path.resolve(options.databasePath);
  const sessions = options.sessions;
  const write = Boolean(options.write);
  const db = new DatabaseSync(databasePath, { readOnly: !write });
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 10000;");
  validateJasmineDatabase(db, databasePath);

  const existingThreadIds = new Set(db.prepare("SELECT id FROM chat_threads").all().map((row) => row.id));
  const replace = Boolean(options.replace);
  const pendingSessions = sessions.filter((session) => replace || !existingThreadIds.has(session.id));
  const skippedSessions = sessions.filter((session) => !replace && existingThreadIds.has(session.id));
  const replacedSessions = replace ? sessions.filter((session) => existingThreadIds.has(session.id)) : [];
  const summary = summarizeImport(sessions, pendingSessions, skippedSessions, replacedSessions);
  if (!write || pendingSessions.length === 0) {
    db.close();
    return { ...summary, written: false, backupPath: null };
  }

  const backupPath = options.createBackup === false ? null : await backupDatabase(db, databasePath, options.backupDirectory);
  const createdAssets = [];
  const createdSessionFiles = [];
  const sessionRoot = path.resolve(options.sessionRoot ?? path.join(path.dirname(path.dirname(databasePath)), "pi-agent", "sessions"));
  try {
    writeAssets(pendingSessions, createdAssets);
    writeSessionFiles(pendingSessions, sessionRoot, createdSessionFiles);
    db.exec("BEGIN IMMEDIATE;");
    const insertProject = db.prepare(`
      INSERT INTO workspace_projects (id, name, root_path, root_key, created_at, updated_at, last_opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertThread = db.prepare(`
      INSERT INTO chat_threads (
        id, title, project_id, active_plugin_ids_json, message_count,
        session_id, session_file, session_format_version, created_at, updated_at
      ) VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)
    `);
    const insertMessage = db.prepare(`
      INSERT INTO chat_messages (
        id, thread_id, role, content, attachments_json, created_at, elapsed_ms, model_id, status,
        memory_used_json, skills_used_json, plugins_used_json, web_search_used_json, timeline_json, session_entry_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', ?, ?, ?)
    `);
    const findProject = db.prepare("SELECT id FROM workspace_projects WHERE root_key = ?");
    const deleteThread = db.prepare("DELETE FROM chat_threads WHERE id = ?");
    const touchProject = db.prepare(`
      UPDATE workspace_projects
      SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END,
          last_opened_at = CASE WHEN last_opened_at < ? THEN ? ELSE last_opened_at END
      WHERE id = ?
    `);
    const projectIds = new Map();

    for (const session of pendingSessions) {
      if (replace && existingThreadIds.has(session.id)) deleteThread.run(session.id);
      const normalized = normalizeProjectRoot(session.cwd);
      let projectId = projectIds.get(normalized.rootKey) ?? findProject.get(normalized.rootKey)?.id;
      if (!projectId) {
        projectId = randomUUID();
        insertProject.run(projectId, normalized.defaultName, normalized.rootPath, normalized.rootKey, session.createdAt, session.updatedAt, session.updatedAt);
      } else {
        touchProject.run(session.updatedAt, session.updatedAt, session.updatedAt, session.updatedAt, projectId);
      }
      projectIds.set(normalized.rootKey, projectId);
      insertThread.run(
        session.id,
        session.title,
        projectId,
        session.messages.length,
        session.id,
        targetSessionFile(session, sessionRoot),
        session.formatVersion,
        session.createdAt,
        session.updatedAt
      );
      for (const message of session.messages) {
        insertMessage.run(
          message.id,
          session.id,
          message.role,
          message.content,
          JSON.stringify(message.attachments ?? []),
          message.createdAt,
          message.elapsedMs ?? null,
          message.modelId ?? null,
          message.status ?? "sent",
          JSON.stringify(message.webSearchUsed ?? []),
          JSON.stringify(message.timeline ?? []),
          message.sessionEntryId ?? null
        );
      }
    }
    db.exec("COMMIT;");
  } catch (error) {
    try { db.exec("ROLLBACK;"); } catch {}
    for (const filePath of createdAssets.reverse()) {
      try { rmSync(filePath, { force: true }); } catch {}
    }
    for (const filePath of createdSessionFiles.reverse()) {
      try { rmSync(filePath, { force: true }); } catch {}
    }
    db.close();
    throw error;
  }
  db.close();
  return { ...summary, written: true, backupPath };
}

function activeSessionEntries(rows) {
  const entries = rows.filter((entry) => entry?.type !== "session" && typeof entry?.id === "string");
  if (entries.length === 0) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const chain = [];
  const visited = new Set();
  let current = entries.at(-1);
  while (current) {
    if (visited.has(current.id)) throw new Error(`Pi session contains a parent cycle at ${current.id}.`);
    visited.add(current.id);
    chain.push(current);
    if (!current.parentId) break;
    const parent = byId.get(current.parentId);
    if (!parent) throw new Error(`Pi session entry ${current.id} references missing parent ${current.parentId}.`);
    current = parent;
  }
  return chain.reverse();
}

function createPendingAssistant() {
  return { timeline: [], webSearchUsed: [], startedAt: null, lastAt: null, modelId: undefined, sessionEntryId: undefined, error: false };
}

function entryToTimeline(entry, sessionId, assetRoot, assets) {
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return [{ id: entry.id, kind: "system", title: entry.type === "compaction" ? "Compaction" : "Branch summary", text: stringValue(entry.summary, "") }];
  }
  if (entry.type === "custom_message" && entry.display) {
    return [{ id: entry.id, kind: "system", title: stringValue(entry.customType, "Custom message"), text: contentToText(entry.content) }];
  }
  if (entry.type === "custom") {
    return [{
      id: entry.id,
      kind: "system",
      title: stringValue(entry.customType, "Extension state"),
      text: summarizeCustomEntry(entry.customType, entry.data),
      customType: stringValue(entry.customType, "custom"),
      origin: "pi-extension",
      data: entry.data
    }];
  }
  if (entry.type !== "message" || !entry.message) return [];
  const message = entry.message;
  if (message.role === "toolResult") {
    const imageList = imageAssets(entry, sessionId, assetRoot);
    assets.push(...imageList);
    return [{
      id: entry.id,
      kind: "tool_result",
      toolName: stringValue(message.toolName, "tool"),
      title: stringValue(message.toolName, "Tool result"),
      content: toolResultText(message.content, imageList),
      isError: Boolean(message.isError)
    }];
  }
  if (message.role === "bashExecution") {
    return [{
      id: entry.id,
      kind: "tool_result",
      toolName: "bash",
      title: stringValue(message.command, "Shell"),
      content: stringValue(message.output, ""),
      isError: Number(message.exitCode ?? 0) !== 0 || Boolean(message.cancelled)
    }];
  }
  if (message.role === "custom") {
    if (message.display === false) return [];
    return [{ id: entry.id, kind: "system", title: stringValue(message.customType, "Custom message"), text: contentToText(message.content) }];
  }
  if (message.role !== "assistant") return [];
  const blocks = Array.isArray(message.content) ? message.content : [message.content];
  return blocks.flatMap((block, index) => {
    if (!block || typeof block !== "object") return [];
    if (block.type === "thinking") return [{ id: `${entry.id}-${index}`, kind: "thinking", text: stringValue(block.thinking, "") }];
    if (block.type === "toolCall") {
      const name = stringValue(block.name, "tool");
      return [{ id: stringValue(block.id, `${entry.id}-${index}`), kind: "tool_call", toolName: name, title: name, argumentsJson: safeJson(block.arguments) }];
    }
    if (block.type === "text" && stringValue(block.text, "").trim()) {
      return [{ id: `${entry.id}-${index}`, kind: "assistant_text", text: block.text }];
    }
    return [];
  });
}

function imageAssets(entry, sessionId, assetRoot) {
  const content = entry.message?.content;
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.flatMap((block, index) => {
    if (!block || typeof block !== "object" || block.type !== "image" || typeof block.data !== "string") return [];
    const mediaType = stringValue(block.mimeType, "image/png");
    const fileName = `${entry.id}-${index}.${extensionForMediaType(mediaType)}`;
    return [{ filePath: path.join(assetRoot, sessionId, fileName), mediaType, data: block.data }];
  });
}

function toolResultText(content, imageList) {
  const text = contentToText(content, { includeImagePlaceholder: false });
  const imageLines = imageList.map((asset) => `[Image output saved to: ${asset.filePath}]`);
  return [text, ...imageLines].filter(Boolean).join("\n");
}

function contentToText(content, options = {}) {
  if (typeof content === "string") return content;
  const blocks = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
  return blocks.map((block) => {
    if (!block || typeof block !== "object") return "";
    if (block.type === "text") return stringValue(block.text, "");
    if (block.type === "image" && options.includeImagePlaceholder !== false) return "[Image]";
    return "";
  }).filter(Boolean).join("\n");
}

function hasVisibleTimelineActivity(timeline) {
  return timeline.some((item) => {
    if (item.kind === "thinking" || item.kind === "assistant_text") return Boolean(item.text?.trim());
    if (item.kind === "tool_call" || item.kind === "tool_result") return true;
    if (item.kind !== "system" || item.customType) return false;
    return item.title !== "Model" && item.title !== "Thinking level" && Boolean(item.title?.trim() || item.text?.trim());
  });
}

function assistantTextFromTimeline(timeline) {
  return timeline.filter((item) => item.kind === "assistant_text").map((item) => item.text.trim()).filter(Boolean).join("\n").trim();
}

function summarizeCustomEntry(customType, data) {
  if (customType !== "web-search-results") return "Extension state saved.";
  const count = Array.isArray(data?.queries) ? data.queries.length : Array.isArray(data?.urls) ? data.urls.length : 0;
  const id = stringValue(data?.id, "");
  return `${data?.type === "fetch" ? "Fetched content" : "Search results"} saved${id ? ` as ${id}` : ""}${count ? ` (${count})` : ""}.`;
}

function extractWebSearchResults(data) {
  const results = [];
  if (Array.isArray(data?.queries)) {
    for (const query of data.queries) {
      const candidates = Array.isArray(query?.results) ? query.results : Array.isArray(query?.sources) ? query.sources : [];
      for (const candidate of candidates) pushWebSearchResult(results, candidate);
    }
  }
  if (Array.isArray(data?.urls)) {
    for (const candidate of data.urls) pushWebSearchResult(results, candidate);
  }
  return results;
}

function pushWebSearchResult(results, candidate) {
  const url = stringValue(candidate?.url, "");
  if (!url || results.some((item) => item.url === url)) return;
  results.push({ title: stringValue(candidate?.title, url), url, snippet: stringValue(candidate?.snippet, stringValue(candidate?.content, stringValue(candidate?.error, ""))) });
}

function mergeWebSearchResults(first = [], second = []) {
  const merged = [...first];
  for (const result of second) if (!merged.some((item) => item.url === result.url)) merged.push(result);
  return merged;
}

function fallbackTitle(firstUserText, createdAt) {
  const compact = firstUserText.replace(/\[Image\]/g, "").replace(/\s+/g, " ").trim();
  if (compact) return compact.length > 72 ? `${compact.slice(0, 71)}…` : compact;
  return `Pi session ${createdAt.slice(0, 10)}`;
}

function safeTitle(value) {
  return value
    .replace(/\bsk-[A-Za-z0-9._-]{6,}\b/g, "sk-***")
    .replace(/((?:pass(?:word)?|pwd|token|api[_ -]?key)\s*[=:]\s*)[^\s,;)\]}]+/gi, "$1***")
    .replace(/(bearer\s+)[A-Za-z0-9._-]{6,}/gi, "$1***");
}

function timestampOf(entry, fallback) {
  const timestamp = stringValue(entry?.timestamp, "");
  return Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : fallback;
}

function deterministicId(value) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function normalizeProjectRoot(rootPath) {
  const expanded = rootPath.trim().replace(/^~(?=$|[\\/])/, os.homedir());
  const resolved = path.resolve(expanded);
  const parsed = path.parse(resolved);
  const rootPathValue = resolved === parsed.root ? resolved : resolved.replace(/[\\/]+$/, "");
  return {
    rootPath: rootPathValue,
    rootKey: process.platform === "win32" ? rootPathValue.toLowerCase() : rootPathValue,
    defaultName: path.basename(rootPathValue) || rootPathValue
  };
}

function validateJasmineDatabase(db, databasePath) {
  const required = ["workspace_projects", "chat_threads", "chat_messages"];
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  const missing = required.filter((name) => !tables.has(name));
  if (missing.length > 0) throw new Error(`${databasePath} is not a compatible Jasmine database; missing ${missing.join(", ")}.`);
  const threadColumns = new Set(db.prepare("PRAGMA table_info(chat_threads)").all().map((row) => row.name));
  const messageColumns = new Set(db.prepare("PRAGMA table_info(chat_messages)").all().map((row) => row.name));
  const requiredThreadColumns = ["message_count", "session_id", "session_file", "session_format_version"];
  const requiredMessageColumns = ["session_entry_id"];
  if (requiredThreadColumns.some((column) => !threadColumns.has(column)) || requiredMessageColumns.some((column) => !messageColumns.has(column))) {
    throw new Error(`${databasePath} must be opened once by the current Jasmine version before import.`);
  }
}

async function backupDatabase(db, databasePath, backupDirectory) {
  const directory = path.resolve(backupDirectory ?? path.join(path.dirname(databasePath), "backups"));
  mkdirSync(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(directory, `jasmine-before-pi-import-${timestamp}.sqlite`);
  await backup(db, backupPath);
  return backupPath;
}

function writeAssets(sessions, createdAssets) {
  for (const session of sessions) {
    for (const asset of session.assets) {
      mkdirSync(path.dirname(asset.filePath), { recursive: true });
      const data = Buffer.from(asset.data, "base64");
      if (existsSync(asset.filePath)) {
        const existing = readFileSync(asset.filePath);
        if (existing.equals(data)) continue;
        throw new Error(`Refusing to overwrite a different imported asset: ${asset.filePath}`);
      }
      writeFileSync(asset.filePath, data, { flag: "wx" });
      createdAssets.push(asset.filePath);
    }
  }
}

function writeSessionFiles(sessions, sessionRoot, createdSessionFiles) {
  for (const session of sessions) {
    const target = targetSessionFile(session, sessionRoot);
    mkdirSync(path.dirname(target), { recursive: true });
    if (path.resolve(target) === path.resolve(session.sourceFile)) continue;
    if (existsSync(target)) {
      if (readFileSync(target).equals(readFileSync(session.sourceFile))) continue;
      throw new Error(`Refusing to overwrite a different Pi session file: ${target}`);
    }
    copyFileSync(session.sourceFile, target);
    createdSessionFiles.push(target);
  }
}

function targetSessionFile(session, sessionRoot) {
  const encodedCwd = `--${path.resolve(session.cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(sessionRoot, encodedCwd, path.basename(session.sourceFile));
}

function summarizeImport(sessions, pendingSessions, skippedSessions, replacedSessions) {
  const total = (list, selector) => list.reduce((sum, item) => sum + selector(item), 0);
  return {
    discoveredSessions: sessions.length,
    importableSessions: pendingSessions.length,
    skippedSessions: skippedSessions.length,
    replacedSessions: replacedSessions.length,
    projects: new Set(pendingSessions.map((session) => normalizeProjectRoot(session.cwd).rootKey)).size,
    messages: total(pendingSessions, (session) => session.messages.length),
    assets: total(pendingSessions, (session) => session.assets.length),
    excludedBranchEntries: total(pendingSessions, (session) => session.excludedBranchEntryCount),
    imported: pendingSessions.map((session) => ({ id: session.id, title: session.title, cwd: session.cwd, messages: session.messages.length, assets: session.assets.length })),
    skipped: skippedSessions.map((session) => ({ id: session.id, title: session.title }))
  };
}

function extensionForMediaType(mediaType) {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  return "png";
}

function safeJson(value) {
  try { return JSON.stringify(value ?? {}, null, 2); } catch { return "{}"; }
}

function stringValue(value, fallback) {
  return typeof value === "string" ? value : fallback;
}
