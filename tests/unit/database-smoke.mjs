import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const dir = await mkdtemp(path.join(tmpdir(), "jasmine-db-smoke-"));
const dbPath = path.join(dir, "jasmine.sqlite");
let db;

try {
  const threads = await import("../../dist/main/main/db/repositories/threads.js");
  const projects = await import("../../dist/main/main/db/repositories/projects.js");
  const messages = await import("../../dist/main/main/db/repositories/messages.js");
  const contextCaptures = await import("../../dist/main/main/db/repositories/contextCaptures.js");
  const fileChanges = await import("../../dist/main/main/db/repositories/fileChanges.js");
  const migrations = await import("../../dist/main/main/db/migrations.js");
  const schemas = await import("../../dist/main/shared/schemas.js");
  const appSettings = await import("../../dist/main/main/db/repositories/appSettings.js");
  const workingTasks = await import("../../dist/main/main/db/repositories/workingTasks.js");
  const mcpServers = await import("../../dist/main/main/db/repositories/mcpServers.js");
  const remoteConnections = await import("../../dist/main/main/db/repositories/remoteConnections.js");
  const skillFiles = await import("../../dist/main/main/services/skillFiles.js");
  const skillManifests = await import("../../dist/main/main/services/skillManifests.js");
  const skillRuntimeContext = await import("../../dist/main/main/services/skillRuntimeContext.js");
  db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspace_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      root_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_opened_at TEXT NOT NULL
    );
    CREATE TABLE chat_threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project_id TEXT REFERENCES workspace_projects(id) ON DELETE SET NULL,
      active_plugin_ids_json TEXT NOT NULL DEFAULT '[]',
      message_count INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      session_file TEXT,
      session_format_version INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      elapsed_ms INTEGER,
      model_id TEXT,
      status TEXT CHECK (status IN ('sent', 'error')),
      memory_used_json TEXT NOT NULL DEFAULT '[]',
      skills_used_json TEXT NOT NULL DEFAULT '[]',
      plugins_used_json TEXT NOT NULL DEFAULT '[]',
      web_search_used_json TEXT NOT NULL DEFAULT '[]',
      timeline_json TEXT NOT NULL DEFAULT '[]',
      session_entry_id TEXT,
      run_id TEXT
    );
    CREATE TABLE thread_drafts (
      thread_id TEXT PRIMARY KEY REFERENCES chat_threads(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE app_settings (
      id TEXT PRIMARY KEY,
      tool_provider_id TEXT NOT NULL DEFAULT 'deepseek',
      tool_model_id TEXT NOT NULL DEFAULT 'deepseek-v4-flash',
      tool_reasoning_effort TEXT NOT NULL DEFAULT 'off',
      appearance_accent TEXT NOT NULL DEFAULT '#0169cc',
      appearance_surface TEXT NOT NULL DEFAULT '#ffffff',
      appearance_ink TEXT NOT NULL DEFAULT '#0d0d0d',
      appearance_success TEXT NOT NULL DEFAULT '#00a240',
      appearance_danger TEXT NOT NULL DEFAULT '#e02e2a',
      brand_logo_data_url TEXT,
      brand_main_title TEXT NOT NULL DEFAULT 'Talk to yourself.',
      brand_subtitle TEXT NOT NULL DEFAULT 'Jasmine listens. Jasmine learns. Jasmine becomes yours.',
      language TEXT NOT NULL DEFAULT 'en',
      chrome_takeover_enabled INTEGER NOT NULL DEFAULT 0,
      chrome_takeover_extension_id TEXT,
      working_notification_mode TEXT NOT NULL DEFAULT 'background',
      working_notification_include_details INTEGER NOT NULL DEFAULT 1,
      permission_mode TEXT NOT NULL DEFAULT 'ask',
      file_change_tracking_mode TEXT NOT NULL DEFAULT 'managed-tools-only',
      skill_editor_path TEXT,
      terminal_shell_path TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      command TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '[]',
      env_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      transport TEXT NOT NULL DEFAULT 'stdio',
      url TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      marketplace_id TEXT,
      package_name TEXT,
      homepage TEXT,
      category TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE remote_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      user TEXT,
      port INTEGER,
      remote_path TEXT,
      config_host TEXT,
      config_path TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      active INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unchecked',
      last_connected_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const timestamp = new Date().toISOString();
  const projectRoot = path.join(dir, "workspace-folder");
  const normalizedProject = projects.normalizeProjectRoot(path.join(projectRoot, "."));
  assert.equal(normalizedProject.rootPath, path.resolve(projectRoot));
  if (process.platform === "win32") {
    assert.equal(projects.normalizeProjectRoot(projectRoot.toUpperCase()).rootKey, normalizedProject.rootKey);
  }
  const project = projects.openOrCreateProject(db, { rootPath: projectRoot }, timestamp);
  assert.equal(project.name, "workspace-folder");
  const duplicateProject = projects.openOrCreateProject(db, { rootPath: path.join(projectRoot, ".") }, timestamp);
  assert.equal(duplicateProject.id, project.id);
  const renamedProject = projects.renameProject(db, project.id, "Renamed workspace", timestamp);
  assert.equal(renamedProject.name, "Renamed workspace");

  const legacyDbPath = path.join(dir, "legacy-migration.sqlite");
  const legacyDb = new DatabaseSync(legacyDbPath);
  const previousDefaultRoot = process.env.JASMINE_DEFAULT_PROJECT_ROOT;
  try {
    process.env.JASMINE_DEFAULT_PROJECT_ROOT = projectRoot;
    legacyDb.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE chat_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO chat_threads (id, title, created_at, updated_at)
      VALUES ('legacy-thread', 'Legacy thread', '${timestamp}', '${timestamp}');
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO chat_messages (id, thread_id, role, content, created_at) VALUES
        ('legacy-msg-1', 'legacy-thread', 'user', 'hello', '${timestamp}'),
        ('legacy-msg-2', 'legacy-thread', 'assistant', 'hi', '${timestamp}');
      CREATE TABLE app_settings (
        id TEXT PRIMARY KEY,
        tool_provider_id TEXT NOT NULL DEFAULT 'deepseek',
        tool_model_id TEXT NOT NULL DEFAULT 'deepseek-v4-flash',
        tool_reasoning_effort TEXT NOT NULL DEFAULT 'off',
        appearance_accent TEXT NOT NULL DEFAULT '#0169cc',
        appearance_surface TEXT NOT NULL DEFAULT '#ffffff',
        appearance_ink TEXT NOT NULL DEFAULT '#0d0d0d',
        appearance_success TEXT NOT NULL DEFAULT '#00a240',
        appearance_danger TEXT NOT NULL DEFAULT '#e02e2a',
        brand_logo_data_url TEXT,
        brand_main_title TEXT NOT NULL DEFAULT '有什么需要帮忙的？',
        brand_subtitle TEXT NOT NULL DEFAULT '一个想法、半句话、一段粘贴——剩下交给 Hiri One。',
        language TEXT NOT NULL DEFAULT 'en',
        skill_editor_path TEXT,
        terminal_shell_path TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO app_settings (
        id,
        brand_main_title,
        brand_subtitle,
        updated_at
      ) VALUES (
        'default',
        '有什么需要帮忙的？',
        '一个想法、半句话、一段粘贴——剩下交给 Hiri One。',
        '${timestamp}'
      );
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        env_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO mcp_servers (id, name, command, args_json, env_json, enabled, created_at, updated_at)
      VALUES ('legacy-mcp', 'Legacy MCP', 'legacy-command', '["--stdio"]', '{}', 1, '${timestamp}', '${timestamp}');
      CREATE TABLE file_change_captures (
        id TEXT PRIMARY KEY, producer_capture_id TEXT, thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL, run_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL, started_at TEXT NOT NULL, completed_at TEXT NOT NULL, cwd TEXT NOT NULL,
        roots_json TEXT NOT NULL DEFAULT '[]', excludes_json TEXT NOT NULL DEFAULT '[]', warnings_json TEXT NOT NULL DEFAULT '[]', coverage_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE file_changes (
        id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES file_change_captures(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, status TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, root TEXT NOT NULL, relative_path TEXT NOT NULL,
        before_sha256 TEXT, before_size INTEGER, before_media_type TEXT, before_encoding TEXT,
        before_content TEXT, before_content_truncated INTEGER NOT NULL DEFAULT 0, before_redacted INTEGER NOT NULL DEFAULT 0,
        after_sha256 TEXT, after_size INTEGER, after_media_type TEXT, after_encoding TEXT,
        after_content TEXT, after_content_truncated INTEGER NOT NULL DEFAULT 0, after_redacted INTEGER NOT NULL DEFAULT 0,
        unified_diff TEXT, diff_truncated INTEGER NOT NULL DEFAULT 0,
        provenance TEXT NOT NULL CHECK (provenance = 'observed-between-checkpoints'),
        before_mode TEXT, after_mode TEXT,
        CHECK (
          (status = 'added' AND before_sha256 IS NULL AND before_size IS NULL AND after_sha256 IS NOT NULL AND after_size IS NOT NULL)
          OR (status = 'modified' AND before_sha256 IS NOT NULL AND before_size IS NOT NULL AND after_sha256 IS NOT NULL AND after_size IS NOT NULL)
          OR (status = 'deleted' AND before_sha256 IS NOT NULL AND before_size IS NOT NULL AND after_sha256 IS NULL AND after_size IS NULL)
        )
      );
      INSERT INTO file_change_captures (
        id, producer_capture_id, thread_id, message_id, run_id, schema_version, started_at, completed_at, cwd
      ) VALUES ('pre-v36-capture', 'pre-v36-producer', 'legacy-thread', 'legacy-msg-2', 'pre-v36-run', 1, '${timestamp}', '${timestamp}', '${projectRoot.replaceAll("'", "''")}');
      INSERT INTO file_changes (
        id, capture_id, ordinal, status, kind, path, root, relative_path,
        before_sha256, before_size, after_sha256, after_size, provenance, before_mode, after_mode
      ) VALUES (
        'pre-v36-change', 'pre-v36-capture', 0, 'modified', 'text', 'pre-v36.txt', '.', 'pre-v36.txt',
        '${"1".repeat(64)}', 6, '${"2".repeat(64)}', 5, 'observed-between-checkpoints', '100644', '100755'
      );
      INSERT INTO file_changes (
        id, capture_id, ordinal, status, kind, path, root, relative_path,
        before_sha256, before_size, after_sha256, after_size, unified_diff, diff_truncated, provenance, before_mode, after_mode
      ) VALUES (
        'pre-v37-truncated', 'pre-v36-capture', 2, 'modified', 'text', 'pre-v37-cut.txt', '.', 'pre-v37-cut.txt',
        '${"5".repeat(64)}', 6, '${"6".repeat(64)}', 9,
        '@@ -1 +1,2 @@' || char(10) || '-old' || char(10) || '+new',
        1, 'observed-between-checkpoints', '100644', '100644'
      );
      INSERT INTO file_changes (
        id, capture_id, ordinal, status, kind, path, root, relative_path,
        before_sha256, before_size, after_sha256, after_size, unified_diff, provenance, before_mode, after_mode
      ) VALUES (
        'pre-v37-change', 'pre-v36-capture', 1, 'modified', 'text', 'pre-v37.txt', '.', 'pre-v37.txt',
        '${"3".repeat(64)}', 6, '${"4".repeat(64)}', 9,
        '--- a/pre-v37.txt' || char(10) || '+++ b/pre-v37.txt' || char(10) || '@@ -1,2 +1,3 @@' || char(10)
          || '-old' || char(10) || '--- note' || char(10) || '+new' || char(10) || '+extra' || char(10) || '+++counter;',
        'observed-between-checkpoints', '100644', '100644'
      );
    `);
    migrations.migrateDatabase(legacyDb, () => timestamp);
    const backfilled = legacyDb.prepare("SELECT project_id FROM chat_threads WHERE id = 'legacy-thread'").get();
    assert.equal(typeof backfilled.project_id, "string");
    assert.deepEqual(JSON.parse(legacyDb.prepare("SELECT active_plugin_ids_json FROM chat_threads WHERE id = 'legacy-thread'").get().active_plugin_ids_json), []);
    assert.equal(legacyDb.prepare("SELECT COUNT(*) AS count FROM workspace_projects").get().count, 1);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 21").get().exists_flag, 1);
    // Migration 22 backfills the denormalized count from ground-truth COUNT(*).
    assert.equal(legacyDb.prepare("SELECT message_count FROM chat_threads WHERE id = 'legacy-thread'").get().message_count, 2);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 22").get().exists_flag, 1);
    const legacyAppSettingsColumns = legacyDb.prepare("PRAGMA table_info(app_settings)").all().map((row) => row.name);
    assert.equal(legacyAppSettingsColumns.includes("chrome_takeover_enabled"), true);
    assert.equal(legacyAppSettingsColumns.includes("chrome_takeover_extension_id"), true);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 23").get().exists_flag, 1);
    const migratedBrand = legacyDb.prepare("SELECT brand_main_title, brand_subtitle FROM app_settings WHERE id = 'default'").get();
    assert.equal(migratedBrand.brand_main_title, "Talk to yourself.");
    assert.equal(migratedBrand.brand_subtitle, "Jasmine listens. Jasmine learns. Jasmine becomes yours.");
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 24").get().exists_flag, 1);
    const legacyMcpColumns = legacyDb.prepare("PRAGMA table_info(mcp_servers)").all().map((row) => row.name);
    for (const column of ["description", "transport", "url", "source", "marketplace_id", "package_name", "homepage", "category"]) {
      assert.equal(legacyMcpColumns.includes(column), true, `legacy MCP table should gain ${column}`);
    }
    assert.deepEqual(mcpServers.listMcpServers(legacyDb), [{
      id: "legacy-mcp",
      name: "Legacy MCP",
      description: "",
      command: "legacy-command",
      args: ["--stdio"],
      envJson: "{}",
      enabled: true,
      transport: "stdio",
      url: undefined,
      source: "manual",
      marketplaceId: undefined,
      packageName: undefined,
      homepage: undefined,
      category: undefined,
      createdAt: timestamp,
      updatedAt: timestamp
    }]);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 25").get().exists_flag, 1);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 26").get().exists_flag, 1);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 27").get().exists_flag, 1);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 28").get().exists_flag, 1);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 29").get().exists_flag, 1);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 30").get().exists_flag, 1);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 31").get().exists_flag, 1);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 32").get().exists_flag, 1);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 33").get().exists_flag, 1);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 34").get().exists_flag, 1);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 35").get().exists_flag, 1);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 36").get().exists_flag, 1);
    assert.equal(legacyDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'file_changes'").get().sql.includes("status = 'added'"), false);
    assert.deepEqual({ ...legacyDb.prepare("SELECT before_mode, after_mode FROM file_changes WHERE id = 'pre-v36-change'").get() }, { before_mode: "100644", after_mode: "100755" });
    assert.deepEqual(
      { ...legacyDb.prepare("SELECT diff_added_lines, diff_deleted_lines FROM file_changes WHERE id = 'pre-v37-change'").get() },
      { diff_added_lines: 3, diff_deleted_lines: 2 },
      "migration counts hunk payload once, including content lines that start with +++ or ---, and never the file header pair"
    );
    assert.deepEqual(
      { ...legacyDb.prepare("SELECT diff_added_lines, diff_deleted_lines FROM file_changes WHERE id = 'pre-v36-change'").get() },
      { diff_added_lines: null, diff_deleted_lines: null },
      "a row without a stored diff has no line stats to report"
    );
    assert.deepEqual(
      { ...legacyDb.prepare("SELECT diff_added_lines, diff_deleted_lines FROM file_changes WHERE id = 'pre-v37-truncated'").get() },
      { diff_added_lines: null, diff_deleted_lines: null },
      "a legacy row that kept only a prefix of its diff must not publish that prefix as a complete total"
    );
    legacyDb.prepare("DELETE FROM file_changes WHERE id IN ('pre-v37-change', 'pre-v37-truncated')").run();
    legacyDb.prepare("DELETE FROM file_change_captures WHERE id = 'pre-v36-capture'").run();
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM sqlite_master WHERE type = 'table' AND name = 'file_change_captures'").get().exists_flag, 1);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM sqlite_master WHERE type = 'table' AND name = 'file_changes'").get().exists_flag, 1);
    assert.equal(legacyDb.prepare("SELECT permission_mode FROM app_settings WHERE id = 'default'").get().permission_mode, "ask");
    assert.equal(legacyDb.prepare("SELECT file_change_tracking_mode FROM app_settings WHERE id = 'default'").get().file_change_tracking_mode, "managed-tools-only");
    assert.equal(legacyDb.prepare("PRAGMA table_info(app_settings)").all().some((row) => row.name === "working_notification_mode"), true);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM sqlite_master WHERE type = 'table' AND name = 'working_tasks'").get().exists_flag, 1);
    assert.equal(legacyDb.prepare("PRAGMA table_info(context_captures)").all().some((row) => row.name === "raw_payload_gzip"), true);
    assert.equal(legacyDb.prepare("PRAGMA table_info(chat_threads)").all().some((row) => row.name === "session_file"), true);
    assert.equal(legacyDb.prepare("PRAGMA table_info(chat_messages)").all().some((row) => row.name === "session_entry_id"), true);
    assert.equal(legacyDb.prepare("PRAGMA table_info(chat_messages)").all().some((row) => row.name === "run_id"), true);

    const canonicalSessionFile = path.join(dir, "legacy-canonical-session.jsonl");
    await writeFile(canonicalSessionFile, [
      { type: "session", version: 3, id: "legacy-thread", timestamp, cwd: projectRoot },
      { type: "message", id: "legacy-user-entry", parentId: null, timestamp, message: { role: "user", content: "inspect" } },
      {
        type: "message",
        id: "legacy-assistant-tool-entry",
        parentId: "legacy-user-entry",
        timestamp,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "The provider returned a visible tool preamble." },
            { type: "toolCall", id: "legacy-tool-call", name: "read", arguments: {} }
          ],
          api: "openai-completions",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          stopReason: "toolUse"
        }
      },
      { type: "message", id: "legacy-tool-result", parentId: "legacy-assistant-tool-entry", timestamp, message: { role: "toolResult", toolCallId: "legacy-tool-call", toolName: "read", content: [{ type: "text", text: "fixture" }], isError: false } },
      { type: "message", id: "legacy-final-entry", parentId: "legacy-tool-result", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Final answer." }], api: "openai-completions", provider: "deepseek", model: "deepseek-v4-flash", stopReason: "stop" } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    legacyDb.prepare("UPDATE chat_threads SET session_id = ?, session_file = ?, session_format_version = 3 WHERE id = 'legacy-thread'")
      .run("legacy-thread", canonicalSessionFile);

    const malformedDeepSeekTimeline = [
      {
        id: "legacy-context-taxonomy",
        kind: "system",
        title: "Context taxonomy",
        text: "captured",
        customType: "context-taxonomy",
        data: {
          items: [{ kind: "provider_options", text: JSON.stringify({ thinking: { type: "enabled" }, reasoning_effort: "high" }) }]
        }
      },
      { id: "deepseek-thinking-level-repair", kind: "system", title: "Thinking level", text: "high" },
      { id: "legacy-assistant-tool-entry-0", kind: "thinking", text: "The provider returned a visible tool preamble." },
      { id: "legacy-tool-call", kind: "tool_call", toolName: "read", title: "read", argumentsJson: "{}" },
      { id: "legacy-tool-result", kind: "tool_result", toolName: "read", title: "read", content: "fixture" },
      { id: "legacy-final-entry-0", kind: "assistant_text", text: "Final answer." }
    ];
    legacyDb.prepare(`
      INSERT INTO chat_messages (id, thread_id, role, content, created_at, model_id, timeline_json, session_entry_id)
      VALUES (?, ?, 'assistant', ?, ?, 'deepseek-v4-flash', ?, ?)
    `).run(
      "legacy-deepseek-thinking",
      "legacy-thread",
      "Final answer.",
      timestamp,
      JSON.stringify(malformedDeepSeekTimeline),
      "legacy-assistant-tool-entry"
    );
    const pendingCanonicalSessionFile = path.join(dir, "pending-canonical-session.jsonl");
    legacyDb.prepare(`
      INSERT INTO chat_threads (id, title, created_at, updated_at, session_id, session_file, session_format_version)
      VALUES (?, ?, ?, ?, ?, ?, 3)
    `).run(
      "legacy-pending-thread",
      "Pending canonical source",
      timestamp,
      timestamp,
      "legacy-pending-thread",
      pendingCanonicalSessionFile
    );
    legacyDb.prepare(`
      INSERT INTO chat_messages (id, thread_id, role, content, created_at, model_id, timeline_json, session_entry_id)
      VALUES (?, ?, 'assistant', '', ?, 'deepseek-v4-flash', ?, ?)
    `).run(
      "legacy-pending-assistant",
      "legacy-pending-thread",
      timestamp,
      JSON.stringify([{ id: "pending-assistant-entry-0", kind: "thinking", text: "Pending visible text." }]),
      "pending-assistant-entry"
    );
    legacyDb.prepare(`
      INSERT INTO chat_messages (id, thread_id, role, content, created_at, model_id, timeline_json, session_entry_id)
      VALUES (?, ?, 'assistant', '', ?, 'deepseek-v4-flash', ?, ?)
    `).run(
      "legacy-stale-anchor-assistant",
      "legacy-thread",
      timestamp,
      JSON.stringify([
        { id: "deepseek-thinking-level-repair", kind: "system", title: "Thinking level", text: "high" },
        { id: "legacy-assistant-tool-entry-0", kind: "thinking", text: "The provider returned a visible tool preamble." }
      ]),
      "legacy-user-entry"
    );
    legacyDb.prepare("DELETE FROM schema_migrations WHERE version IN (29, 31)").run();
    migrations.migrateDatabase(legacyDb, () => timestamp);
    const repairedDeepSeek = legacyDb.prepare("SELECT content, timeline_json FROM chat_messages WHERE id = 'legacy-deepseek-thinking'").get();
    const repairedDeepSeekTimeline = JSON.parse(repairedDeepSeek.timeline_json);
    assert.equal(repairedDeepSeek.content, "The provider returned a visible tool preamble.\nFinal answer.");
    assert.deepEqual(
      repairedDeepSeekTimeline.filter((item) => item.kind !== "system").map((item) => item.kind),
      ["assistant_text", "tool_call", "tool_result", "assistant_text"]
    );
    assert.equal(repairedDeepSeekTimeline.some((item) => item.id === "deepseek-thinking-level-repair"), false);
    assert.equal(repairedDeepSeekTimeline.some((item) => item.customType === "context-taxonomy"), false);
    const migratedCapture = legacyDb.prepare("SELECT message_id, raw_state, raw_payload_gzip, metadata_json FROM context_captures WHERE message_id = 'legacy-deepseek-thinking'").get();
    assert.equal(migratedCapture.message_id, "legacy-deepseek-thinking");
    assert.equal(migratedCapture.raw_state, "unavailable");
    assert.equal(migratedCapture.raw_payload_gzip, null);
    assert.equal(JSON.parse(migratedCapture.metadata_json).fallbackTaxonomy.items[0].kind, "provider_options");
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 29").get(), undefined);

    await writeFile(pendingCanonicalSessionFile, [
      { type: "session", version: 3, id: "legacy-pending-thread", timestamp, cwd: projectRoot },
      { type: "message", id: "pending-user-entry", parentId: null, timestamp, message: { role: "user", content: "pending" } },
      { type: "message", id: "pending-assistant-entry", parentId: "pending-user-entry", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Pending visible text." }], api: "openai-completions", provider: "deepseek", model: "deepseek-v4-flash", stopReason: "stop" } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    migrations.migrateDatabase(legacyDb, () => timestamp);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 29").get(), undefined);
    const repairedPending = legacyDb.prepare("SELECT content, timeline_json FROM chat_messages WHERE id = 'legacy-pending-assistant'").get();
    assert.equal(repairedPending.content, "Pending visible text.");
    assert.equal(JSON.parse(repairedPending.timeline_json)[0].kind, "assistant_text");
    const unresolvedStale = legacyDb.prepare("SELECT content, timeline_json FROM chat_messages WHERE id = 'legacy-stale-anchor-assistant'").get();
    assert.equal(unresolvedStale.content, "");
    assert.deepEqual(JSON.parse(unresolvedStale.timeline_json).map((item) => item.kind), ["system", "thinking"]);

    legacyDb.prepare("UPDATE chat_messages SET session_entry_id = ? WHERE id = 'legacy-stale-anchor-assistant'")
      .run("legacy-assistant-tool-entry");
    migrations.migrateDatabase(legacyDb, () => timestamp);
    assert.equal(legacyDb.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = 29").get().exists_flag, 1);
    const repairedStale = legacyDb.prepare("SELECT content, timeline_json FROM chat_messages WHERE id = 'legacy-stale-anchor-assistant'").get();
    assert.equal(repairedStale.content, "The provider returned a visible tool preamble.");
    assert.deepEqual(JSON.parse(repairedStale.timeline_json).map((item) => item.kind), ["assistant_text"]);
    migrations.migrateDatabase(legacyDb, () => timestamp);
    assert.equal(mcpServers.listMcpServers(legacyDb).length, 1);

    legacyDb.prepare(`
      INSERT INTO chat_messages (id, thread_id, role, content, created_at, timeline_json)
      VALUES ('complete-capture-message', 'legacy-thread', 'assistant', 'answer', ?, '[]')
    `).run(timestamp);
    const completeRaw = JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "x".repeat(16_384) }] }, null, 2);
    const completeCaptureId = contextCaptures.addContextCapture(legacyDb, {
      threadId: "legacy-thread",
      messageId: "complete-capture-message",
      runId: "capture-run",
      taxonomy: {
        capturedAt: timestamp,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        source: "provider-payload",
        providerRequest: { index: 1, count: 1, taskIndex: 1, policy: "task-capture" },
        rawPayload: completeRaw,
        payloadSchemaVersion: 5,
        reasoningValidation: { status: "pass", policyId: "deepseek-tool-interval-v1", policyVersion: 1, summary: "ok", requiredCount: 1, sentCount: 1, blocks: [] },
        items: []
      }
    });
    const storedCapture = contextCaptures.getContextCapture(legacyDb, completeCaptureId);
    assert.equal(storedCapture.rawPayload, completeRaw);
    assert.equal(storedCapture.summary.rawSha256.length, 64);
    assert.equal(storedCapture.summary.reasoningValidation.status, "pass");
    assert.deepEqual(contextCaptures.listLatestTaskContextCaptures(legacyDb, "legacy-thread").map((capture) => capture.id), [completeCaptureId]);
    const compressedBytes = legacyDb.prepare("SELECT length(raw_payload_gzip) AS bytes FROM context_captures WHERE id = ?").get(completeCaptureId).bytes;
    assert.ok(compressedBytes < Buffer.byteLength(completeRaw, "utf8") / 4, "repeated raw payload should be gzip compressed");
    legacyDb.prepare("DELETE FROM chat_messages WHERE id = 'complete-capture-message'").run();
    assert.equal(contextCaptures.getContextCapture(legacyDb, completeCaptureId), null, "capture should cascade with its message");

    legacyDb.prepare(`
      INSERT INTO chat_messages (id, thread_id, run_id, role, content, created_at, timeline_json)
      VALUES ('file-change-message', 'legacy-thread', 'file-change-run', 'assistant', 'changed files', ?, '[]')
    `).run(timestamp);
    const fileCaptureId = fileChanges.addFileChangeCapture(legacyDb, {
      threadId: "legacy-thread",
      messageId: "file-change-message",
      runId: "file-change-run",
      capture: {
        producerCaptureId: "producer-capture-1",
        schemaVersion: 1,
        startedAt: "2026-08-10T01:02:03.000Z",
        completedAt: "2026-08-10T01:02:04.000Z",
        cwd: projectRoot,
        roots: [projectRoot],
        excludes: ["**/.git/**"],
        warnings: ["A test warning."],
        coverage: { status: "partial", target: "local", reason: "Fixture coverage.", scannedFiles: 3, bashCoverage: "agent-start-roots-only" },
        changes: [
          {
            status: "modified",
            kind: "text",
            path: path.join(projectRoot, "z.txt"),
            root: projectRoot,
            relativePath: "z.txt",
            before: { sha256: "a".repeat(64), size: 13, mediaType: "text/plain", encoding: "utf8", mode: "100644", content: "secret-before", redacted: true },
            after: { sha256: "b".repeat(64), size: 12, mediaType: "text/plain", encoding: "utf8", mode: "100755", content: "secret-after" },
            unifiedDiff: "secret-unified-diff",
            provenance: "observed-between-checkpoints"
          },
          {
            status: "deleted",
            kind: "image",
            path: path.join(projectRoot, "image.png"),
            root: projectRoot,
            relativePath: "image.png",
            before: { sha256: "c".repeat(64), size: 3, mediaType: "image/png", encoding: "base64", content: "YWJj" },
            provenance: "observed-between-checkpoints"
          },
          {
            status: "added",
            kind: "text",
            path: path.join(projectRoot, "a.txt"),
            root: projectRoot,
            relativePath: "a.txt",
            after: { sha256: "d".repeat(64), size: 8, mediaType: "text/plain", encoding: "utf8", mode: "100644", content: "new file" },
            unifiedDiff: "@@ -0,0 +1 @@\n+new file",
            provenance: "observed-between-checkpoints"
          }
        ]
      }
    });
    assert.equal(fileChanges.addFileChangeCapture(legacyDb, {
      threadId: "legacy-thread",
      messageId: "file-change-message",
      runId: "file-change-run",
      capture: {
        producerCaptureId: "producer-capture-1",
        schemaVersion: 1,
        startedAt: timestamp,
        completedAt: timestamp,
        cwd: projectRoot,
        roots: [projectRoot],
        excludes: [],
        warnings: [],
        coverage: { status: "complete", target: "local" },
        changes: []
      }
    }), fileCaptureId, "producer capture persistence should be idempotent within a run");
    assert.throws(() => fileChanges.addFileChangeCapture(legacyDb, {
      threadId: "legacy-thread",
      messageId: "file-change-message",
      runId: "another-run",
      capture: {
        schemaVersion: 1,
        startedAt: timestamp,
        completedAt: timestamp,
        cwd: projectRoot,
        roots: [],
        excludes: [],
        warnings: [],
        coverage: { status: "complete", target: "local" },
        changes: []
      }
    }), /same thread and run/);
    legacyDb.prepare(`
      INSERT INTO tool_runs (id, thread_id, kind, title, status, started_at)
      VALUES ('failed-file-change-run', 'legacy-thread', 'provider_call', 'failed capture', 'error', ?)
    `).run(timestamp);
    const failedRunCaptureId = fileChanges.addFileChangeCapture(legacyDb, {
      threadId: "legacy-thread",
      runId: "failed-file-change-run",
      capture: {
        producerCaptureId: "failed-producer-capture",
        schemaVersion: 1,
        startedAt: timestamp,
        completedAt: timestamp,
        cwd: projectRoot,
        roots: [],
        excludes: [],
        warnings: ["Run stopped after capture."],
        coverage: { status: "partial", target: "local", reason: "Interrupted run." },
        changes: []
      }
    });
    const failedRunCapture = fileChanges.listFileChangeCaptures(legacyDb, "legacy-thread").find((capture) => capture.id === failedRunCaptureId);
    assert.equal(failedRunCapture.messageId, undefined, "failed-run evidence must not inject a synthetic assistant message");
    legacyDb.prepare("DELETE FROM file_change_captures WHERE id = ?").run(failedRunCaptureId);
    assert.throws(() => fileChanges.addFileChangeCapture(legacyDb, {
      threadId: "legacy-thread",
      messageId: "file-change-message",
      runId: "unsupported-file-change-run",
      capture: {
        schemaVersion: 2,
        startedAt: timestamp,
        completedAt: timestamp,
        cwd: projectRoot,
        roots: [projectRoot],
        excludes: [],
        warnings: [],
        coverage: { status: "complete", target: "local" },
        changes: []
      }
    }), /Unsupported file change capture schema version: 2/);

    const ingestOversizedText = "t".repeat(fileChanges.FILE_CHANGE_DETAIL_CONTENT_MAX_CHARS + 1);
    const ingestOversizedBase64 = "A".repeat(fileChanges.FILE_CHANGE_DETAIL_CONTENT_MAX_CHARS + 4);
    const ingestOversizedDiff = "d".repeat(fileChanges.FILE_CHANGE_DETAIL_DIFF_MAX_CHARS + 1);
    const oversizedDiffAddedLines = Math.ceil(fileChanges.FILE_CHANGE_DETAIL_DIFF_MAX_CHARS / 3) + 10;
    const completeOversizedDiff = `@@ -0,0 +1,${oversizedDiffAddedLines} @@\n${"+x\n".repeat(oversizedDiffAddedLines)}`;
    const boundedCaptureId = fileChanges.addFileChangeCapture(legacyDb, {
      threadId: "legacy-thread",
      messageId: "file-change-message",
      runId: "file-change-run",
      capture: {
        schemaVersion: 1,
        startedAt: timestamp,
        completedAt: timestamp,
        cwd: projectRoot,
        roots: [projectRoot],
        excludes: [],
        warnings: [],
        coverage: { status: "complete", target: "local" },
        changes: [{
          status: "modified",
          kind: "other",
          path: path.join(projectRoot, "oversized.dat"),
          root: projectRoot,
          relativePath: "oversized.dat",
          before: { sha256: "f".repeat(64), size: ingestOversizedText.length, encoding: "utf8", content: ingestOversizedText },
          after: { sha256: "0".repeat(64), size: ingestOversizedBase64.length, encoding: "base64", content: ingestOversizedBase64 },
          unifiedDiff: ingestOversizedDiff,
          provenance: "observed-between-checkpoints"
        },
        {
          status: "added",
          kind: "text",
          path: path.join(projectRoot, "oversized-complete.txt"),
          root: projectRoot,
          relativePath: "oversized-complete.txt",
          after: { sha256: "9".repeat(64), size: completeOversizedDiff.length, encoding: "utf8", content: "x\n" },
          unifiedDiff: completeOversizedDiff,
          provenance: "observed-between-checkpoints"
        },
        {
          status: "added",
          kind: "text",
          path: path.join(projectRoot, "producer-truncated.txt"),
          root: projectRoot,
          relativePath: "producer-truncated.txt",
          after: { sha256: "8".repeat(64), size: 6, encoding: "utf8", content: "x\n" },
          unifiedDiff: "@@ -0,0 +1,2 @@\n+x\n+y",
          diffTruncated: true,
          provenance: "observed-between-checkpoints"
        }]
      }
    });
    const boundedChanges = fileChanges.listFileChangeCaptures(legacyDb, "legacy-thread")
      .find((capture) => capture.id === boundedCaptureId).changes;
    const completeOversized = boundedChanges.find((change) => change.relativePath === "oversized-complete.txt");
    assert.equal(completeOversized.diffTruncated, true, "the storage cap must still be reported");
    assert.deepEqual(
      completeOversized.lineStats,
      { added: oversizedDiffAddedLines, deleted: 0 },
      "counts come from the diff as received, so the storage cap cannot shrink the reported total"
    );
    const producerTruncated = boundedChanges.find((change) => change.relativePath === "producer-truncated.txt");
    assert.equal(
      Object.hasOwn(producerTruncated, "lineStats"),
      false,
      "a diff the producer already cut short has no complete total to report"
    );
    const boundedStored = legacyDb.prepare(`
      SELECT before_content, before_content_truncated, after_content, after_content_truncated,
             length(unified_diff) AS diff_chars, diff_truncated
      FROM file_changes WHERE capture_id = ? AND relative_path = 'oversized.dat'
    `).get(boundedCaptureId);
    assert.equal(boundedStored.before_content, null);
    assert.equal(boundedStored.before_content_truncated, 1);
    assert.equal(boundedStored.after_content, null);
    assert.equal(boundedStored.after_content_truncated, 1);
    assert.equal(boundedStored.diff_chars, fileChanges.FILE_CHANGE_DETAIL_DIFF_MAX_CHARS);
    assert.equal(boundedStored.diff_truncated, 1);
    const boundedStoredChangeId = boundedChanges.find((change) => change.relativePath === "oversized.dat").id;
    const boundedStoredDetail = fileChanges.getFileChangeDetail(legacyDb, "legacy-thread", boundedStoredChangeId);
    assert.equal(Object.hasOwn(boundedStoredDetail.before, "content"), false);
    assert.equal(boundedStoredDetail.before.contentTruncated, true);
    assert.equal(Object.hasOwn(boundedStoredDetail.after, "content"), false);
    assert.equal(boundedStoredDetail.after.contentTruncated, true);
    assert.equal(boundedStoredDetail.unifiedDiff.length, fileChanges.FILE_CHANGE_DETAIL_DIFF_MAX_CHARS);
    assert.equal(boundedStoredDetail.diffTruncated, true);
    legacyDb.prepare("DELETE FROM file_change_captures WHERE id = ?").run(boundedCaptureId);

    const watcherCaptureId = fileChanges.addFileChangeCapture(legacyDb, {
      threadId: "legacy-thread",
      messageId: "file-change-message",
      runId: "file-change-run",
      capture: {
        producerCaptureId: "watcher-sparse-capture",
        schemaVersion: 1,
        startedAt: timestamp,
        completedAt: timestamp,
        cwd: projectRoot,
        roots: [projectRoot],
        excludes: [],
        warnings: [],
        coverage: { status: "complete", target: "local", trackingMode: "watcher", bashCoverage: "watcher-observed" },
        changes: [
          {
            status: "modified",
            kind: "text",
            path: path.join(projectRoot, "watcher-after-only.txt"),
            root: projectRoot,
            relativePath: "watcher-after-only.txt",
            after: { sha256: "e".repeat(64), size: 5, encoding: "utf8", content: "after" },
            provenance: "observed-between-checkpoints"
          },
          {
            status: "deleted",
            kind: "other",
            path: path.join(projectRoot, "watcher-path-only.txt"),
            root: projectRoot,
            relativePath: "watcher-path-only.txt",
            provenance: "observed-between-checkpoints"
          }
        ]
      }
    });
    const watcherStored = fileChanges.listFileChangeCaptures(legacyDb, "legacy-thread").find((capture) => capture.id === watcherCaptureId);
    assert.deepEqual(watcherStored.changes.map((change) => [change.relativePath, Boolean(change.before), Boolean(change.after)]), [
      ["watcher-after-only.txt", false, true],
      ["watcher-path-only.txt", false, false]
    ]);
    legacyDb.prepare("DELETE FROM file_change_captures WHERE id = ?").run(watcherCaptureId);

    const captureList = fileChanges.listFileChangeCaptures(legacyDb, "legacy-thread");
    assert.equal(captureList.length, 1);
    assert.equal(captureList[0].id, fileCaptureId);
    assert.equal(captureList[0].producerCaptureId, "producer-capture-1");
    assert.equal(captureList[0].messageId, "file-change-message");
    assert.equal(captureList[0].runId, "file-change-run");
    assert.equal(captureList[0].capturedAt, "2026-08-10T01:02:04.000Z");
    assert.deepEqual(captureList[0].coverage, { status: "partial", target: "local", reason: "Fixture coverage.", scannedFiles: 3, bashCoverage: "agent-start-roots-only" });
    assert.deepEqual(captureList[0].changes.map((change) => change.relativePath), ["a.txt", "image.png", "z.txt"]);
    const serializedList = JSON.stringify(captureList);
    for (const contentValue of ["new file", "YWJj", "secret-before", "secret-after", "secret-unified-diff", "@@ -0,0 +1 @@"]) {
      assert.equal(serializedList.includes(contentValue), false, "artifact list must never include detail content or diffs");
    }
    const [addedSummary, imageSummary, redactedSummary] = captureList[0].changes;
    assert.equal(addedSummary.after.contentAvailable, true);
    assert.equal(addedSummary.after.mode, "100644");
    assert.equal(Object.hasOwn(addedSummary.after, "content"), false);
    assert.equal(redactedSummary.before.redacted, true);
    assert.equal(redactedSummary.before.contentAvailable, false);
    assert.equal(redactedSummary.after.redacted, true);
    assert.equal(redactedSummary.after.contentAvailable, false);
    assert.equal(redactedSummary.hasUnifiedDiff, false, "a diff touching redacted content must not be retained");
    assert.deepEqual(addedSummary.lineStats, { added: 1, deleted: 0 }, "the list must carry line counts without carrying the diff");
    assert.equal(Object.hasOwn(imageSummary, "lineStats"), false);
    assert.equal(Object.hasOwn(redactedSummary, "lineStats"), false, "a redacted change has no diff to count");

    schemas.fileChangeIdSchema.parse(addedSummary.id);
    assert.throws(() => schemas.fileChangeIdSchema.parse(path.join(projectRoot, "a.txt")));
    const addedDetail = fileChanges.getFileChangeDetail(legacyDb, "legacy-thread", addedSummary.id);
    assert.equal(addedDetail.after.content, "new file");
    assert.equal(addedDetail.after.mode, "100644");
    assert.equal(addedDetail.unifiedDiff, "@@ -0,0 +1 @@\n+new file");
    assert.deepEqual(addedDetail.lineStats, { added: 1, deleted: 0 });
    const redactedDetail = fileChanges.getFileChangeDetail(legacyDb, "legacy-thread", redactedSummary.id);
    assert.equal(redactedDetail.before.redacted, true);
    assert.equal(redactedDetail.before.mode, "100644");
    assert.equal(redactedDetail.after.redacted, true);
    assert.equal(redactedDetail.after.mode, "100755");
    assert.equal(Object.hasOwn(redactedDetail.before, "content"), false);
    assert.equal(Object.hasOwn(redactedDetail.after, "content"), false);
    assert.equal(Object.hasOwn(redactedDetail, "unifiedDiff"), false);
    const redactedStored = legacyDb.prepare("SELECT before_content, after_content, unified_diff FROM file_changes WHERE id = ?").get(redactedSummary.id);
    assert.deepEqual({ ...redactedStored }, { before_content: null, after_content: null, unified_diff: null });

    const overlongText = "x".repeat(fileChanges.FILE_CHANGE_DETAIL_CONTENT_MAX_CHARS + 1);
    const overlongDiff = "d".repeat(fileChanges.FILE_CHANGE_DETAIL_DIFF_MAX_CHARS + 1);
    legacyDb.prepare("UPDATE file_changes SET after_content = ?, unified_diff = ? WHERE id = ?")
      .run(overlongText, overlongDiff, addedSummary.id);
    const boundedTextDetail = fileChanges.getFileChangeDetail(legacyDb, "legacy-thread", addedSummary.id);
    assert.equal(boundedTextDetail.after.content.length, fileChanges.FILE_CHANGE_DETAIL_CONTENT_MAX_CHARS);
    assert.equal(boundedTextDetail.after.contentTruncated, true);
    assert.equal(boundedTextDetail.unifiedDiff.length, fileChanges.FILE_CHANGE_DETAIL_DIFF_MAX_CHARS);
    assert.equal(boundedTextDetail.diffTruncated, true);

    const overlongBase64 = "A".repeat(fileChanges.FILE_CHANGE_DETAIL_CONTENT_MAX_CHARS + 4);
    legacyDb.prepare("UPDATE file_changes SET before_content = ? WHERE id = ?").run(overlongBase64, imageSummary.id);
    const boundedImageDetail = fileChanges.getFileChangeDetail(legacyDb, "legacy-thread", imageSummary.id);
    assert.equal(Object.hasOwn(boundedImageDetail.before, "content"), false, "oversized base64 must not be returned as invalid partial data");
    assert.equal(boundedImageDetail.before.contentTruncated, true);
    assert.equal(fileChanges.getFileChangeDetail(legacyDb, "legacy-thread", randomUUID()), null);
    assert.equal(fileChanges.getFileChangeDetail(legacyDb, "another-thread", addedSummary.id), null, "detail must remain scoped to its thread");

    legacyDb.prepare("DELETE FROM chat_messages WHERE id = 'file-change-message'").run();
    const unanchoredCapture = fileChanges.listFileChangeCaptures(legacyDb, "legacy-thread");
    assert.equal(unanchoredCapture.length, 1, "run-level evidence should survive conversation branch pruning");
    assert.equal(unanchoredCapture[0].messageId, undefined);
    assert.ok(fileChanges.getFileChangeDetail(legacyDb, "legacy-thread", addedSummary.id), "run-level detail should survive assistant deletion");

    legacyDb.prepare(`
      INSERT INTO chat_threads (id, title, created_at, updated_at)
      VALUES ('file-change-cascade-thread', 'File change cascade', ?, ?)
    `).run(timestamp, timestamp);
    legacyDb.prepare(`
      INSERT INTO chat_messages (id, thread_id, run_id, role, content, created_at, timeline_json)
      VALUES ('file-change-cascade-message', 'file-change-cascade-thread', 'file-change-cascade-run', 'assistant', 'changed', ?, '[]')
    `).run(timestamp);
    const cascadeCaptureId = fileChanges.addFileChangeCapture(legacyDb, {
      threadId: "file-change-cascade-thread",
      messageId: "file-change-cascade-message",
      runId: "file-change-cascade-run",
      capture: {
        schemaVersion: 1,
        startedAt: timestamp,
        completedAt: timestamp,
        cwd: projectRoot,
        roots: [projectRoot],
        excludes: [],
        warnings: [],
        coverage: { status: "complete", target: "local" },
        changes: [{
          status: "added",
          kind: "text",
          path: path.join(projectRoot, "cascade.txt"),
          root: projectRoot,
          relativePath: "cascade.txt",
          after: { sha256: "e".repeat(64), size: 1, encoding: "utf8", content: "x" },
          provenance: "observed-between-checkpoints"
        }]
      }
    });
    const cascadeChangeId = fileChanges.listFileChangeCaptures(legacyDb, "file-change-cascade-thread")[0].changes[0].id;
    legacyDb.prepare("DELETE FROM chat_threads WHERE id = 'file-change-cascade-thread'").run();
    assert.equal(legacyDb.prepare("SELECT COUNT(*) AS count FROM file_change_captures WHERE id = ?").get(cascadeCaptureId).count, 0);
    assert.equal(legacyDb.prepare("SELECT COUNT(*) AS count FROM file_changes WHERE id = ?").get(cascadeChangeId).count, 0);

    workingTasks.startWorkingTask(legacyDb, { requestId: "working-request", threadId: "legacy-thread", activity: "Preparing response" }, timestamp);
    assert.equal(workingTasks.listWorkingTasks(legacyDb, "2000-01-01T00:00:00.000Z").activeCount, 1);
    workingTasks.updateWorkingTask(legacyDb, { requestId: "working-request", status: "waiting_user", unread: true }, timestamp);
    assert.equal(workingTasks.listWorkingTasks(legacyDb, "2000-01-01T00:00:00.000Z").attentionCount, 1);
    assert.equal(workingTasks.markWorkingNotificationSent(legacyDb, "working-request", "waiting_user"), true);
    assert.equal(workingTasks.markWorkingNotificationSent(legacyDb, "working-request", "waiting_user"), false);
    workingTasks.recoverInterruptedWorking(legacyDb, timestamp);
    assert.equal(workingTasks.listWorkingTasks(legacyDb, "2000-01-01T00:00:00.000Z").items[0].status, "interrupted");
  } finally {
    if (previousDefaultRoot === undefined) delete process.env.JASMINE_DEFAULT_PROJECT_ROOT;
    else process.env.JASMINE_DEFAULT_PROJECT_ROOT = previousDefaultRoot;
    legacyDb.close();
  }

  appSettings.ensureAppSettings(db, timestamp);
  assert.deepEqual(appSettings.getAppSettings(db).toolModel, {
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    reasoningEffort: "off",
    updatedAt: timestamp
  });
  assert.equal(appSettings.getAppSettings(db).language, "en");
  assert.deepEqual(appSettings.getAppSettings(db).chromeTakeover, {
    enabled: false,
    extensionId: null
  });
  assert.deepEqual(appSettings.getAppSettings(db).workingNotifications, {
    mode: "background",
    includeDetails: true
  });
  assert.equal(appSettings.getAppSettings(db).permissionMode, "ask");
  assert.equal(appSettings.getAppSettings(db).fileChangeTrackingMode, "managed-tools-only");
  assert.deepEqual(appSettings.getAppSettings(db).brand, {
    logoDataUrl: null,
    mainTitle: "Talk to yourself.",
    subtitle: "Jasmine listens. Jasmine learns. Jasmine becomes yours.",
    updatedAt: timestamp
  });
  appSettings.updateAppSettings(db, appSettings.getAppSettings(db), { toolModel: { providerId: "moonshot", modelId: "kimi-k2.6", reasoningEffort: "minimal" } }, timestamp);
  assert.equal(appSettings.getAppSettings(db).toolModel.modelId, "kimi-k2.6");
  appSettings.updateAppSettings(db, appSettings.getAppSettings(db), { brand: { logoDataUrl: "data:image/png;base64,AAAA", mainTitle: "Custom title", subtitle: "Custom subtitle" } }, timestamp);
  assert.deepEqual(appSettings.getAppSettings(db).brand, {
    logoDataUrl: "data:image/png;base64,AAAA",
    mainTitle: "Custom title",
    subtitle: "Custom subtitle",
    updatedAt: timestamp
  });
  appSettings.updateAppSettings(db, appSettings.getAppSettings(db), { brand: { logoDataUrl: null, mainTitle: "   ", subtitle: "" } }, timestamp);
  assert.deepEqual(appSettings.getAppSettings(db).brand, {
    logoDataUrl: null,
    mainTitle: "Talk to yourself.",
    subtitle: "",
    updatedAt: timestamp
  });
  appSettings.updateAppSettings(db, appSettings.getAppSettings(db), { language: "zh" }, timestamp);
  assert.equal(appSettings.getAppSettings(db).language, "zh");
  appSettings.updateAppSettings(db, appSettings.getAppSettings(db), { chromeTakeover: { enabled: true, extensionId: "a".repeat(32) } }, timestamp);
  assert.deepEqual(appSettings.getAppSettings(db).chromeTakeover, {
    enabled: true,
    extensionId: "a".repeat(32)
  });
  appSettings.updateAppSettings(db, appSettings.getAppSettings(db), { workingNotifications: { mode: "never", includeDetails: false } }, timestamp);
  assert.deepEqual(appSettings.getAppSettings(db).workingNotifications, { mode: "never", includeDetails: false });
  appSettings.updateAppSettings(db, appSettings.getAppSettings(db), { permissionMode: "full-access" }, timestamp);
  appSettings.updateAppSettings(db, appSettings.getAppSettings(db), { fileChangeTrackingMode: "watcher" }, timestamp);
  assert.equal(appSettings.getAppSettings(db).fileChangeTrackingMode, "watcher");
  assert.equal(appSettings.getAppSettings(db).permissionMode, "full-access");
  appSettings.updateAppSettings(db, appSettings.getAppSettings(db), { skillEditorPath: process.execPath }, timestamp);
  assert.equal(appSettings.getAppSettings(db).skillEditorPath, process.execPath);
  appSettings.updateAppSettings(db, appSettings.getAppSettings(db), { terminalShellPath: process.execPath }, timestamp);
  assert.equal(appSettings.getAppSettings(db).terminalShellPath, process.execPath);
  if (process.platform === "win32") {
    const windowsBashPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "bash.exe");
    appSettings.updateAppSettings(db, appSettings.getAppSettings(db), { terminalShellPath: windowsBashPath }, timestamp);
    assert.equal(appSettings.getAppSettings(db).terminalShellPath, undefined);
  }
  appSettings.updateAppSettings(db, appSettings.getAppSettings(db), { skillEditorPath: "", terminalShellPath: "" }, timestamp);
  assert.equal(appSettings.getAppSettings(db).skillEditorPath, undefined);
  assert.equal(appSettings.getAppSettings(db).terminalShellPath, undefined);
  appSettings.updateAppSettings(db, appSettings.getAppSettings(db), { appearance: { accent: "#0057d8", surface: "#fffdf8", ink: "#101820", success: "#008f4c", danger: "#d12a20" } }, timestamp);
  assert.deepEqual(appSettings.getAppSettings(db).appearance, {
    accent: "#0057d8",
    surface: "#fffdf8",
    ink: "#101820",
    success: "#008f4c",
    danger: "#d12a20",
    updatedAt: timestamp
  });

  const localSkillManifests = await skillManifests.prepareSkillManifests([{
    id: "skill-technical-writer",
    name: "Technical Writer",
    description: "Tightens technical documentation.",
    instructions: "Hidden full local skill instructions.",
    enabled: true,
    source: "local",
    createdAt: timestamp,
    updatedAt: timestamp
  }], dir);
  assert.equal(localSkillManifests.length, 1);
  assert.equal(path.basename(localSkillManifests[0].skillFilePath), "SKILL.md");
  const localSkillFile = await readFile(localSkillManifests[0].skillFilePath, "utf8");
  assert.match(localSkillFile, /name: "technical-writer"/);
  assert.match(localSkillFile, /Hidden full local skill instructions/);

  await skillFiles.ensureLocalSkillFiles(dir, []);
  const bundledSkills = await skillFiles.loadLocalSkills(dir, new Map());
  assert.equal(bundledSkills.some((skill) => skill.name === "technical-writer"), true);
  assert.equal(bundledSkills.some((skill) => skill.name === "code-reviewer"), true);
  const fileBackedSkill = await skillFiles.createLocalSkill(dir, { name: "Release Notes", description: "Draft release notes." });
  assert.equal(fileBackedSkill.name, "release-notes");
  assert.match(fileBackedSkill.instructions, /Use this skill when the user asks for this workflow/);
  assert.equal(path.basename(fileBackedSkill.skillFilePath), "SKILL.md");
  const fileBackedManifests = await skillManifests.prepareSkillManifests([fileBackedSkill], dir);
  assert.equal(fileBackedManifests[0].skillFilePath, fileBackedSkill.skillFilePath);
  const inlineExternalSkill = {
    id: "external:document-analysis",
    name: "document-analysis",
    description: "Reads stowage plans and exposes sibling scripts.",
    instructions: "Use the document analysis workflow and verify the generated output.",
    enabled: true,
    source: "external",
    sourcePath: path.join(dir, "external-skills", "document-analysis"),
    skillFilePath: path.join(dir, "external-skills", "document-analysis", "SKILL.md"),
    readonly: true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const mergedRuntimeSkills = skillRuntimeContext.mergeRuntimeSkills([fileBackedSkill], [inlineExternalSkill], [inlineExternalSkill]);
  assert.deepEqual(mergedRuntimeSkills.map((skill) => skill.id), [fileBackedSkill.id, inlineExternalSkill.id]);
  assert.deepEqual(skillRuntimeContext.skillReferenceIds([
    { id: inlineExternalSkill.id, name: inlineExternalSkill.name, description: inlineExternalSkill.description },
    { id: inlineExternalSkill.id, name: inlineExternalSkill.name, description: inlineExternalSkill.description }
  ]), [inlineExternalSkill.id]);
  const inlineExternalManifests = await skillManifests.prepareSkillManifests(mergedRuntimeSkills, dir);
  assert.equal(inlineExternalManifests.at(-1).skillFilePath, inlineExternalSkill.skillFilePath);

  const context7 = mcpServers.createMcpServer(db, {
    name: "Context7",
    description: "Versioned docs",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    envJson: "{}",
    source: "marketplace",
    marketplaceId: "jasmine:context7",
    packageName: "@upstash/context7-mcp",
    category: "documentation"
  }, timestamp);
  assert.equal(context7.enabled, true);
  assert.equal(mcpServers.listMcpServers(db).length, 1);
  assert.equal(mcpServers.createMcpServer(db, { ...context7, marketplaceId: "jasmine:context7" }, timestamp).id, context7.id);
  mcpServers.updateMcpServer(db, context7, { id: context7.id, enabled: false, envJson: JSON.stringify({ CONTEXT7_TOKEN: "secret" }) }, timestamp);
  const disabledContext7 = mcpServers.getMcpServer(db, context7.id);
  assert.equal(disabledContext7.enabled, false);
  assert.equal(disabledContext7.envJson, "{\"CONTEXT7_TOKEN\":\"secret\"}");
  mcpServers.deleteMcpServer(db, context7.id);
  assert.equal(mcpServers.listMcpServers(db).length, 0);

  const manualRemote = remoteConnections.createRemoteConnection(db, {
    name: "Local WSL",
    host: "localhost",
    user: "dev",
    port: 2222,
    remotePath: "/home/dev/project",
    active: true
  }, timestamp);
  assert.equal(manualRemote.active, true);
  assert.equal(remoteConnections.getActiveRemoteConnection(db).id, manualRemote.id);
  const importedRemote = remoteConnections.upsertRemoteConnection(db, {
    name: "VS Code host",
    host: "example.internal",
    user: "ubuntu",
    configHost: "prod-box",
    configPath: path.join(dir, "ssh-config"),
    source: "vscode",
    active: true
  }, timestamp);
  assert.equal(importedRemote.source, "vscode");
  assert.equal(remoteConnections.getActiveRemoteConnection(db).id, importedRemote.id);
  assert.equal(remoteConnections.getRemoteConnection(db, manualRemote.id).active, false);
  remoteConnections.updateRemoteConnectionStatus(db, importedRemote.id, { status: "connected", lastConnectedAt: timestamp, remotePath: "/srv/app" }, timestamp);
  assert.equal(remoteConnections.getRemoteConnection(db, importedRemote.id).remotePath, "/srv/app");
  remoteConnections.updateRemoteConnection(db, importedRemote, { id: importedRemote.id, active: false }, timestamp);
  assert.equal(remoteConnections.getActiveRemoteConnection(db), null);
  remoteConnections.deleteRemoteConnection(db, importedRemote.id);
  assert.equal(remoteConnections.listRemoteConnections(db).length, 1);

  db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'initial schema', ?), (2, 'metadata', ?), (3, 'drafts', ?)")
    .run(timestamp, timestamp, timestamp);

  const thread = threads.createThread(db, "Unit thread", timestamp, project.id);
  assert.equal(threads.hasThread(db, thread.id), true);
  assert.equal(thread.projectId, project.id);
  assert.equal(threads.getThreadMessageCount(db, thread.id), 0);
  assert.deepEqual(threads.listThreads(db, { projectId: project.id }).map((item) => item.id), [thread.id]);
  assert.deepEqual(threads.listThreads(db, { projectId: null }).map((item) => item.id), []);
  const withPlugins = threads.updateThreadActivePluginIds(db, thread.id, ["plugin-a", "plugin-a", "plugin-b"], timestamp);
  assert.deepEqual(withPlugins.activePluginIds, ["plugin-a", "plugin-b"]);
  assert.deepEqual(threads.getThread(db, thread.id).activePluginIds, ["plugin-a", "plugin-b"]);

  threads.updateThreadDraft(db, thread.id, "unit draft", timestamp);
  assert.equal(threads.getThreadDraft(db, thread.id), "unit draft");

  const renamed = threads.updateThreadTitle(db, thread.id, "Renamed unit thread", timestamp);
  assert.equal(renamed.title, "Renamed unit thread");
  threads.updateThreadSessionBinding(db, thread.id, { sessionId: "pi-session", sessionFile: "C:\\tmp\\pi-session.jsonl", sessionFormatVersion: 3 });
  assert.deepEqual(threads.getThreadSessionBinding(db, thread.id), {
    sessionId: "pi-session",
    sessionFile: "C:\\tmp\\pi-session.jsonl",
    sessionFormatVersion: 3
  });

  // The denormalized chat_threads.message_count contract: repo callers adjust
  // the count in the same transaction as the row change (database.ts does this).
  const userMessage = messages.addMessage(db, { threadId: thread.id, role: "user", content: "hello", sessionEntryId: "pi-user" }, timestamp);
  threads.adjustThreadMessageCount(db, thread.id, 1);
  const assistantMessage = messages.addMessage(db, { threadId: thread.id, runId: "unit-run", role: "assistant", content: "hi", elapsedMs: 229000, modelId: "unit-model" }, timestamp);
  threads.adjustThreadMessageCount(db, thread.id, 1);
  assert.equal(threads.getThreadMessageCount(db, thread.id), 2);
  assert.equal(threads.getThread(db, thread.id).messageCount, 2);
  assert.deepEqual(messages.listMessages(db, thread.id).map((message) => message.id), [userMessage.id, assistantMessage.id]);
  assert.equal(messages.listMessages(db, thread.id).at(-1).runId, "unit-run");
  assert.equal(messages.listMessages(db, thread.id).at(-1).elapsedMs, 229000);
  assert.equal(messages.getMessageSessionEntryId(db, thread.id, userMessage.id), "pi-user");
  messages.linkMessageSessionEntry(db, thread.id, assistantMessage.id, "pi-assistant");
  assert.equal(messages.getMessageSessionEntryId(db, thread.id, assistantMessage.id), "pi-assistant");
  assert.deepEqual(messages.listMessages(db, thread.id, { limit: 1 }).map((message) => message.id), [assistantMessage.id]);
  assert.deepEqual(
    messages.listMessages(db, thread.id, {
      limit: 1,
      before: {
        id: assistantMessage.id,
        createdAt: assistantMessage.createdAt
      }
    }).map((message) => message.id),
    [userMessage.id]
  );

  const deletedCount = messages.deleteMessagesByIds(db, thread.id, [assistantMessage.id]);
  assert.equal(deletedCount, 1);
  threads.adjustThreadMessageCount(db, thread.id, -deletedCount);
  assert.equal(messages.listMessages(db, thread.id).length, 1);
  assert.equal(threads.getThreadMessageCount(db, thread.id), 1);

  threads.deleteThread(db, thread.id);
  assert.equal(threads.hasThread(db, thread.id), false);

  const migrationRows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
  assert.deepEqual(migrationRows.map((row) => row.version), [1, 2, 3]);

  const otherThread = threads.createThread(db, `Unit ${randomUUID()}`, timestamp);
  assert.equal(threads.listThreads(db).some((item) => item.id === otherThread.id), true);
  assert.equal(threads.listThreads(db, { projectId: null }).some((item) => item.id === otherThread.id), true);
  const movedThread = threads.createThread(db, "Project thread to move", timestamp, project.id);
  projects.removeProject(db, project.id);
  assert.equal(threads.getThread(db, movedThread.id).projectId, null);
} finally {
  db?.close();
  await rm(dir, { recursive: true, force: true });
}
