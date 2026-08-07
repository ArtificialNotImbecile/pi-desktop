import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { importPiSessions, parsePiSessionFile } from "../../scripts/lib/pi-session-import.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const temporary = await mkdtemp(path.join(tmpdir(), "jasmine-pi-import-"));

try {
  const workspace = path.join(temporary, "workspace");
  const sessionFile = path.join(temporary, "session.jsonl");
  const databasePath = path.join(temporary, "jasmine.sqlite");
  const assetRoot = path.join(temporary, "assets");
  const sessionRoot = path.join(temporary, "pi-agent", "sessions");
  await mkdir(workspace);
  const rows = [
    { type: "session", version: 3, id: "019fd5fa-61a6-77f4-9cd3-7c2ccf175546", timestamp: "2026-08-06T07:29:43.846Z", cwd: workspace },
    { type: "model_change", id: "model", parentId: null, timestamp: "2026-08-06T07:29:44.000Z", provider: "test-provider", modelId: "test-model" },
    { type: "message", id: "user", parentId: "model", timestamp: "2026-08-06T07:30:00.000Z", message: { role: "user", content: { type: "text", text: "Import this Pi session" } } },
    { type: "message", id: "call", parentId: "user", timestamp: "2026-08-06T07:30:01.000Z", message: { role: "assistant", provider: "test-provider", model: "test-model", content: [{ type: "thinking", thinking: "Inspecting" }, { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "a.txt" } }] } },
    { type: "message", id: "result", parentId: "call", timestamp: "2026-08-06T07:30:02.000Z", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file contents" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] } },
    { type: "message", id: "abandoned", parentId: "result", timestamp: "2026-08-06T07:30:03.000Z", message: { role: "assistant", provider: "test-provider", model: "test-model", content: [{ type: "text", text: "abandoned branch" }] } },
    { type: "custom", customType: "web-search-results", id: "search", parentId: "result", timestamp: "2026-08-06T07:30:03.100Z", data: { id: "search-1", type: "search", queries: [{ sources: [{ title: "Example", url: "https://example.com" }] }] } },
    { type: "message", id: "answer", parentId: "search", timestamp: "2026-08-06T07:30:04.000Z", message: { role: "assistant", provider: "test-provider", model: "test-model", stopReason: "stop", content: [{ type: "text", text: "Imported answer" }] } },
    { type: "session_info", id: "name", parentId: "answer", timestamp: "2026-08-06T07:30:05.000Z", name: "Named Pi session token=secretsecret" }
  ];
  await writeFile(sessionFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const session = parsePiSessionFile(sessionFile, { assetRoot });
  assert.equal(session.title, "Named Pi session token=***");
  assert.equal(session.excludedBranchEntryCount, 1);
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[0].role, "user");
  assert.equal(session.messages[0].content, "Import this Pi session");
  assert.equal(session.messages[0].sessionEntryId, "user");
  assert.equal(session.messages[1].role, "assistant");
  assert.equal(session.messages[1].content, "Imported answer");
  assert.equal(session.messages[1].modelId, "test-model");
  assert.equal(session.messages[1].status, "sent");
  assert.equal(session.messages[1].sessionEntryId, "call");
  assert.equal(session.messages[1].timeline.some((item) => item.kind === "thinking" && item.text === "Inspecting"), true);
  assert.equal(session.messages[1].timeline.some((item) => item.kind === "tool_call" && item.toolName === "read"), true);
  assert.equal(session.messages[1].timeline.some((item) => item.kind === "tool_result" && item.content.includes("file contents") && item.content.includes("Image output saved to")), true);
  assert.equal(session.messages[1].timeline.some((item) => JSON.stringify(item).includes("abandoned branch")), false);
  assert.deepEqual(session.messages[1].webSearchUsed, [{ title: "Example", url: "https://example.com", snippet: "" }]);
  assert.equal(session.assets.length, 1);

  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspace_projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, root_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_opened_at TEXT NOT NULL
    );
    CREATE TABLE chat_threads (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT REFERENCES workspace_projects(id) ON DELETE SET NULL,
      active_plugin_ids_json TEXT NOT NULL DEFAULT '[]', message_count INTEGER NOT NULL DEFAULT 0,
      session_id TEXT, session_file TEXT, session_format_version INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), content TEXT NOT NULL,
      attachments_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, elapsed_ms INTEGER, model_id TEXT,
      status TEXT CHECK (status IN ('sent', 'error')), memory_used_json TEXT NOT NULL DEFAULT '[]',
      skills_used_json TEXT NOT NULL DEFAULT '[]', plugins_used_json TEXT NOT NULL DEFAULT '[]',
      web_search_used_json TEXT NOT NULL DEFAULT '[]', timeline_json TEXT NOT NULL DEFAULT '[]'
      , session_entry_id TEXT
    );
  `);
  db.close();

  const dryRun = await importPiSessions({ databasePath, sessions: [session], write: false, sessionRoot });
  assert.equal(dryRun.importableSessions, 1);
  assert.equal(dryRun.written, false);
  const firstImport = await importPiSessions({ databasePath, sessions: [session], write: true, createBackup: false, sessionRoot });
  assert.equal(firstImport.importableSessions, 1);
  assert.equal(firstImport.written, true);
  const secondImport = await importPiSessions({ databasePath, sessions: [session], write: true, createBackup: false, sessionRoot });
  assert.equal(secondImport.importableSessions, 0);
  assert.equal(secondImport.skippedSessions, 1);

  const verificationDb = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verificationDb.prepare("SELECT COUNT(*) AS count FROM workspace_projects").get().count, 1);
  assert.deepEqual(
    { ...verificationDb.prepare("SELECT title, message_count, session_id, session_format_version FROM chat_threads WHERE id = ?").get(session.id) },
    { title: "Named Pi session token=***", message_count: 2, session_id: session.id, session_format_version: 3 }
  );
  assert.equal(verificationDb.prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE thread_id = ?").get(session.id).count, 2);
  assert.deepEqual(
    verificationDb.prepare("SELECT session_entry_id FROM chat_messages WHERE thread_id = ? ORDER BY created_at").all(session.id).map((row) => row.session_entry_id),
    ["user", "call"]
  );
  const importedSessionFile = verificationDb.prepare("SELECT session_file FROM chat_threads WHERE id = ?").get(session.id).session_file;
  verificationDb.close();
  assert.deepEqual(await readFile(importedSessionFile), await readFile(sessionFile));
  const replaceImport = await importPiSessions({ databasePath, sessions: [session], write: true, replace: true, createBackup: false, sessionRoot });
  assert.equal(replaceImport.replacedSessions, 1);
  const replacedDb = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(replacedDb.prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE thread_id = ?").get(session.id).count, 2);
  replacedDb.close();
  console.log("Pi session import tests passed.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
