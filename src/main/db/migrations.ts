import type { SqlDatabase } from "./repositories/types.js";
import { DEFAULT_APPEARANCE } from "../../shared/theme.js";
import { DEFAULT_BRAND_SETTINGS, LEGACY_HIRI_BRAND_COPY } from "../../shared/brand.js";
import type { ChatTimelineItem } from "../../shared/ipc.js";
import { countDiffLines } from "./repositories/fileChanges.js";
import { normalizeProjectRoot } from "./repositories/projects.js";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { mergeModelConfigs, parseModelConfigs } from "./providerModels.js";
import { readCanonicalPiBlockIndex, restoreCanonicalPiTimelineProjection } from "./canonicalPiTimelineRepair.js";

type Clock = () => string;

export function migrateDatabase(db: SqlDatabase, now: Clock): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      root_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_opened_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project_id TEXT REFERENCES workspace_projects(id) ON DELETE SET NULL,
      active_plugin_ids_json TEXT NOT NULL DEFAULT '[]',
      session_id TEXT,
      session_file TEXT,
      session_format_version INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
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

    CREATE TABLE IF NOT EXISTS context_captures (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      run_id TEXT,
      task_index INTEGER NOT NULL DEFAULT 1,
      request_index INTEGER NOT NULL DEFAULT 1,
      request_count INTEGER NOT NULL DEFAULT 1,
      captured_at TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      source TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      raw_payload_gzip BLOB,
      raw_state TEXT NOT NULL CHECK (raw_state IN ('complete', 'legacy_truncated', 'unavailable')),
      raw_sha256 TEXT,
      raw_char_count INTEGER NOT NULL DEFAULT 0,
      raw_byte_count INTEGER NOT NULL DEFAULT 0,
      validation_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(message_id, task_index, request_index)
    );

    CREATE TABLE IF NOT EXISTS thread_drafts (
      thread_id TEXT PRIMARY KEY REFERENCES chat_threads(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key_ref TEXT NOT NULL,
      models_json TEXT NOT NULL,
      default_model TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'unchecked',
      last_checked_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK (kind IN ('provider_call')),
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
      provider_id TEXT,
      model_id TEXT,
      input_summary TEXT,
      output_summary TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      elapsed_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
      source_thread_id TEXT REFERENCES chat_threads(id) ON DELETE SET NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      instructions TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_settings (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0,
      local_only INTEGER NOT NULL DEFAULT 1,
      capture_window_titles INTEGER NOT NULL DEFAULT 0,
      capture_screenshots INTEGER NOT NULL DEFAULT 0,
      retention_days INTEGER NOT NULL DEFAULT 30,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_observations (
      id TEXT PRIMARY KEY,
      note TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('manual')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS web_search_settings (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL DEFAULT 'pi-web-access',
      max_results INTEGER NOT NULL DEFAULT 4,
      timeout_ms INTEGER NOT NULL DEFAULT 7000,
      last_run_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skill_sources (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_template_sources (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS external_skill_states (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_servers (
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

    CREATE TABLE IF NOT EXISTS app_settings (
      id TEXT PRIMARY KEY,
      tool_provider_id TEXT NOT NULL DEFAULT 'deepseek',
      tool_model_id TEXT NOT NULL DEFAULT 'deepseek-v4-flash',
      tool_reasoning_effort TEXT NOT NULL DEFAULT 'off',
      appearance_accent TEXT NOT NULL DEFAULT '${DEFAULT_APPEARANCE.accent}',
      appearance_surface TEXT NOT NULL DEFAULT '${DEFAULT_APPEARANCE.surface}',
      appearance_ink TEXT NOT NULL DEFAULT '${DEFAULT_APPEARANCE.ink}',
      appearance_success TEXT NOT NULL DEFAULT '${DEFAULT_APPEARANCE.success}',
      appearance_danger TEXT NOT NULL DEFAULT '${DEFAULT_APPEARANCE.danger}',
      brand_logo_data_url TEXT,
      brand_main_title TEXT NOT NULL DEFAULT '${sqlLiteral(DEFAULT_BRAND_SETTINGS.mainTitle)}',
      brand_subtitle TEXT NOT NULL DEFAULT '${sqlLiteral(DEFAULT_BRAND_SETTINGS.subtitle)}',
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

    CREATE TABLE IF NOT EXISTS working_tasks (
      thread_id TEXT PRIMARY KEY REFERENCES chat_threads(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('running', 'waiting_user', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted')),
      activity TEXT NOT NULL DEFAULT 'Working',
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      queue_count INTEGER NOT NULL DEFAULT 0,
      unread INTEGER NOT NULL DEFAULT 0,
      notified_statuses_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_chat_threads_updated_at ON chat_threads(updated_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_projects_root_key ON workspace_projects(root_key);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_created_at ON chat_messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_context_captures_thread_captured_at ON context_captures(thread_id, captured_at);
    CREATE INDEX IF NOT EXISTS idx_context_captures_message_id ON context_captures(message_id);
    CREATE INDEX IF NOT EXISTS idx_thread_drafts_updated_at ON thread_drafts(updated_at);
    CREATE INDEX IF NOT EXISTS idx_tool_runs_thread_started_at ON tool_runs(thread_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);
    CREATE INDEX IF NOT EXISTS idx_skills_enabled_name ON skills(enabled, name);
    CREATE INDEX IF NOT EXISTS idx_skill_sources_path ON skill_sources(path);
    CREATE INDEX IF NOT EXISTS idx_prompt_template_sources_path ON prompt_template_sources(path);
    CREATE INDEX IF NOT EXISTS idx_external_skill_states_enabled ON external_skill_states(enabled);
    CREATE INDEX IF NOT EXISTS idx_activity_observations_created_at ON activity_observations(created_at);
    CREATE INDEX IF NOT EXISTS idx_working_tasks_status_updated_at ON working_tasks(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_working_tasks_finished_at ON working_tasks(finished_at);
  `);
  addColumnIfMissing(db, "chat_messages", "attachments_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "chat_messages", "model_id", "TEXT");
  addColumnIfMissing(db, "chat_messages", "memory_used_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "chat_messages", "skills_used_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "chat_messages", "plugins_used_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "chat_messages", "web_search_used_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "chat_messages", "timeline_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "chat_threads", "project_id", "TEXT REFERENCES workspace_projects(id) ON DELETE SET NULL");
  addColumnIfMissing(db, "chat_threads", "active_plugin_ids_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "chat_threads", "session_id", "TEXT");
  addColumnIfMissing(db, "chat_threads", "session_file", "TEXT");
  addColumnIfMissing(db, "chat_threads", "session_format_version", "INTEGER");
  addColumnIfMissing(db, "chat_messages", "session_entry_id", "TEXT");
  addColumnIfMissing(db, "chat_messages", "run_id", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_chat_threads_project_updated_at ON chat_threads(project_id, updated_at);");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_threads_session_id ON chat_threads(session_id) WHERE session_id IS NOT NULL;");
  db.exec("CREATE INDEX IF NOT EXISTS idx_chat_messages_session_entry_id ON chat_messages(session_entry_id) WHERE session_entry_id IS NOT NULL;");
  db.exec("CREATE INDEX IF NOT EXISTS idx_chat_messages_run_id ON chat_messages(run_id) WHERE run_id IS NOT NULL;");
  markMigration(db, 1, "initial schema", now);
  markMigration(db, 2, "chat message attachments and model metadata", now);
  markMigration(db, 3, "trace memory activity and thread drafts", now);
  markMigration(db, 4, "local skills", now);
  markMigration(db, 5, "web search settings and message search citations", now);
  markMigration(db, 6, "pi-compatible assistant message timeline", now);
  markMigration(db, 7, "app tool model settings", now);
  markMigration(db, 8, "external skill sources", now);
  markMigration(db, 9, "external skill enabled states", now);
  addColumnIfMissing(db, "app_settings", "appearance_accent", `TEXT NOT NULL DEFAULT '${DEFAULT_APPEARANCE.accent}'`);
  addColumnIfMissing(db, "app_settings", "appearance_surface", `TEXT NOT NULL DEFAULT '${DEFAULT_APPEARANCE.surface}'`);
  addColumnIfMissing(db, "app_settings", "appearance_ink", `TEXT NOT NULL DEFAULT '${DEFAULT_APPEARANCE.ink}'`);
  addColumnIfMissing(db, "app_settings", "appearance_success", `TEXT NOT NULL DEFAULT '${DEFAULT_APPEARANCE.success}'`);
  addColumnIfMissing(db, "app_settings", "appearance_danger", `TEXT NOT NULL DEFAULT '${DEFAULT_APPEARANCE.danger}'`);
  addColumnIfMissing(db, "app_settings", "language", "TEXT NOT NULL DEFAULT 'en'");
  addColumnIfMissing(db, "app_settings", "skill_editor_path", "TEXT");
  markMigration(db, 10, "appearance theme settings", now);
  markMigration(db, 11, "app language setting", now);
  // Jasmine's first desktop schema already had a smaller mcp_servers table.
  // CREATE TABLE IF NOT EXISTS does not add later marketplace columns, so repair
  // the table shape before creating indexes or running repository queries.
  addColumnIfMissing(db, "mcp_servers", "description", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "mcp_servers", "transport", "TEXT NOT NULL DEFAULT 'stdio'");
  addColumnIfMissing(db, "mcp_servers", "url", "TEXT");
  addColumnIfMissing(db, "mcp_servers", "source", "TEXT NOT NULL DEFAULT 'manual'");
  addColumnIfMissing(db, "mcp_servers", "marketplace_id", "TEXT");
  addColumnIfMissing(db, "mcp_servers", "package_name", "TEXT");
  addColumnIfMissing(db, "mcp_servers", "homepage", "TEXT");
  addColumnIfMissing(db, "mcp_servers", "category", "TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_marketplace_id ON mcp_servers(marketplace_id);
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled_name ON mcp_servers(enabled, name);
  `);
  markMigration(db, 12, "mcp server settings", now);
  markMigration(db, 13, "skill editor path setting", now);
  markMigration(db, 14, "remote ssh connections", now);
  if (!hasMigration(db, 15)) {
    db.prepare("UPDATE web_search_settings SET provider = 'pi-web-access', updated_at = ? WHERE provider = 'duckduckgo'").run(now());
  }
  markMigration(db, 15, "pi web access provider default", now);
  markMigration(db, 16, "prompt template sources", now);
  addColumnIfMissing(db, "app_settings", "terminal_shell_path", "TEXT");
  markMigration(db, 17, "terminal shell setting", now);
  addColumnIfMissing(db, "app_settings", "brand_logo_data_url", "TEXT");
  addColumnIfMissing(db, "app_settings", "brand_main_title", `TEXT NOT NULL DEFAULT '${sqlLiteral(DEFAULT_BRAND_SETTINGS.mainTitle)}'`);
  addColumnIfMissing(db, "app_settings", "brand_subtitle", `TEXT NOT NULL DEFAULT '${sqlLiteral(DEFAULT_BRAND_SETTINGS.subtitle)}'`);
  markMigration(db, 18, "entry brand settings", now);
  markMigration(db, 19, "per-turn plugin references", now);
  if (!hasMigration(db, 20)) {
    backfillDefaultWorkspaceProject(db, now);
  }
  markMigration(db, 20, "local folder workspace projects", now);
  markMigration(db, 21, "thread active plugin state", now);
  addColumnIfMissing(db, "chat_threads", "message_count", "INTEGER NOT NULL DEFAULT 0");
  if (!hasMigration(db, 22)) {
    // Backfill the denormalized per-thread count once; afterwards it is
    // maintained by the message insert/delete paths in the same transaction.
    db.exec(`
      UPDATE chat_threads SET message_count = (
        SELECT COUNT(*) FROM chat_messages WHERE chat_messages.thread_id = chat_threads.id
      );
    `);
  }
  markMigration(db, 22, "denormalized thread message counts", now);
  addColumnIfMissing(db, "app_settings", "chrome_takeover_enabled", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "app_settings", "chrome_takeover_extension_id", "TEXT");
  markMigration(db, 23, "chrome takeover settings", now);
  if (!hasMigration(db, 24)) {
    db.prepare(`
      UPDATE app_settings
      SET brand_main_title = ?, brand_subtitle = ?, updated_at = ?
      WHERE brand_main_title = ? AND brand_subtitle = ?
    `).run(
      DEFAULT_BRAND_SETTINGS.mainTitle,
      DEFAULT_BRAND_SETTINGS.subtitle,
      now(),
      LEGACY_HIRI_BRAND_COPY.mainTitle,
      LEGACY_HIRI_BRAND_COPY.subtitle
    );
  }
  markMigration(db, 24, "restore Jasmine entry brand defaults", now);
  markMigration(db, 25, "upgrade legacy mcp server marketplace columns", now);
  markMigration(db, 26, "pi jsonl session bindings and message projection links", now);
  if (!hasMigration(db, 27)) {
    mergeCurrentPiProviderModels(db, "deepseek", ["deepseek-v4-flash", "deepseek-v4-pro"], now());
    mergeCurrentPiProviderModels(db, "moonshot", ["kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k3"], now());
  }
  markMigration(db, 27, "refresh bundled DeepSeek and Kimi model catalogs", now);
  markMigration(db, 28, "reserve legacy DeepSeek projection repair", now);
  if (!hasMigration(db, 29)) restoreCanonicalPiTimelineRows(db, now());
  markMigration(db, 30, "agent run message linkage", now);
  if (!hasMigration(db, 31)) migrateInlineContextCaptures(db);
  markMigration(db, 31, "independent compressed context taxonomy captures", now);
  addColumnIfMissing(db, "app_settings", "working_notification_mode", "TEXT NOT NULL DEFAULT 'background'");
  addColumnIfMissing(db, "app_settings", "working_notification_include_details", "INTEGER NOT NULL DEFAULT 1");
  markMigration(db, 32, "working task registry and recent results", now);
  markMigration(db, 33, "working notification preferences", now);
  addColumnIfMissing(db, "app_settings", "permission_mode", "TEXT NOT NULL DEFAULT 'ask'");
  markMigration(db, 34, "agent permission mode", now);
  ensureFileChangeTables(db);
  markMigration(db, 35, "deterministic file change captures", now);
  addColumnIfMissing(db, "app_settings", "file_change_tracking_mode", "TEXT NOT NULL DEFAULT 'managed-tools-only'");
  if (!hasMigration(db, 36)) migrateFileChangesToSparseEvidence(db);
  markMigration(db, 36, "fast file change modes and sparse watcher evidence", now);
  addColumnIfMissing(db, "file_changes", "diff_added_lines", "INTEGER");
  addColumnIfMissing(db, "file_changes", "diff_deleted_lines", "INTEGER");
  if (!hasMigration(db, 37)) backfillFileChangeDiffLineStats(db);
  markMigration(db, 37, "per-file diff line stats", now);
  // The remote SSH feature is gone, so its table only holds rows nothing can
  // read anymore. Manually added connections exist nowhere else, so they are
  // written beside the database before the table goes.
  if (!hasMigration(db, 38) && retireRemoteConnections(db)) {
    markMigration(db, 38, "remove remote ssh connections", now);
  }
}

/**
 * Archives any stored remote connections next to the database, then drops the
 * table. Returns false when the archive could not be written, which leaves the
 * table and the migration unmarked so the next launch retries instead of
 * discarding rows the user cannot recover from `~/.ssh/config`.
 */
function retireRemoteConnections(db: SqlDatabase): boolean {
  const table = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'remote_connections'")
    .get() as { present?: number } | undefined;
  if (!table) return true;
  const rows = db.prepare("SELECT * FROM remote_connections ORDER BY name").all();
  if (rows.length > 0) {
    const archivePath = remoteConnectionArchivePath(db);
    if (!archivePath) return false;
    try {
      writeFileSync(archivePath, `${JSON.stringify({
        retiredAt: new Date().toISOString(),
        note: "Jasmine removed its remote SSH target. These records are kept for reference only.",
        connections: rows
      }, null, 2)}\n`, "utf8");
    } catch {
      return false;
    }
  }
  db.exec("DROP TABLE IF EXISTS remote_connections;");
  return true;
}

function remoteConnectionArchivePath(db: SqlDatabase): string | null {
  try {
    const entries = db.prepare("PRAGMA database_list").all() as Array<{ name?: string; file?: string }>;
    const file = entries.find((entry) => entry.name === "main")?.file;
    if (!file) return null;
    return path.join(path.dirname(file), "retired-remote-connections.json");
  } catch {
    return null;
  }
}

function backfillFileChangeDiffLineStats(db: SqlDatabase): void {
  // A truncated row only kept a prefix of its diff, so counting it would
  // publish a partial total as the file's complete one. Those rows keep no
  // stats and fall back to byte weight, which matches what ingestion does now.
  const pending = db.prepare(`
    SELECT id FROM file_changes
    WHERE unified_diff IS NOT NULL AND diff_added_lines IS NULL AND diff_truncated = 0
  `).all() as Array<{ id: string }>;
  if (pending.length === 0) return;
  // Diffs are read one at a time so a large history never has to be resident.
  const readDiff = db.prepare("SELECT unified_diff FROM file_changes WHERE id = ?");
  const update = db.prepare("UPDATE file_changes SET diff_added_lines = ?, diff_deleted_lines = ? WHERE id = ?");
  for (const row of pending) {
    const diff = (readDiff.get(row.id) as { unified_diff: string | null } | undefined)?.unified_diff;
    if (diff === null || diff === undefined) continue;
    const stats = countDiffLines(diff);
    update.run(stats.added, stats.deleted, row.id);
  }
}

function ensureFileChangeTables(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_change_captures (
      id TEXT PRIMARY KEY,
      producer_capture_id TEXT,
      thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
      run_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      cwd TEXT NOT NULL,
      roots_json TEXT NOT NULL DEFAULT '[]',
      excludes_json TEXT NOT NULL DEFAULT '[]',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      coverage_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS file_changes (
      id TEXT PRIMARY KEY,
      capture_id TEXT NOT NULL REFERENCES file_change_captures(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      status TEXT NOT NULL CHECK (status IN ('added', 'modified', 'deleted')),
      kind TEXT NOT NULL CHECK (kind IN ('text', 'image', 'binary', 'other')),
      path TEXT NOT NULL,
      root TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      before_sha256 TEXT,
      before_size INTEGER CHECK (before_size IS NULL OR before_size >= 0),
      before_media_type TEXT,
      before_encoding TEXT CHECK (before_encoding IS NULL OR before_encoding IN ('utf8', 'base64')),
      before_mode TEXT,
      before_content TEXT,
      before_content_truncated INTEGER NOT NULL DEFAULT 0 CHECK (before_content_truncated IN (0, 1)),
      before_redacted INTEGER NOT NULL DEFAULT 0 CHECK (before_redacted IN (0, 1)),
      after_sha256 TEXT,
      after_size INTEGER CHECK (after_size IS NULL OR after_size >= 0),
      after_media_type TEXT,
      after_encoding TEXT CHECK (after_encoding IS NULL OR after_encoding IN ('utf8', 'base64')),
      after_mode TEXT,
      after_content TEXT,
      after_content_truncated INTEGER NOT NULL DEFAULT 0 CHECK (after_content_truncated IN (0, 1)),
      after_redacted INTEGER NOT NULL DEFAULT 0 CHECK (after_redacted IN (0, 1)),
      unified_diff TEXT,
      diff_truncated INTEGER NOT NULL DEFAULT 0 CHECK (diff_truncated IN (0, 1)),
      provenance TEXT NOT NULL CHECK (provenance = 'observed-between-checkpoints'),
      UNIQUE(capture_id, ordinal),
      CHECK (before_redacted = 0 OR before_content IS NULL),
      CHECK (after_redacted = 0 OR after_content IS NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_file_change_captures_thread_completed_at
      ON file_change_captures(thread_id, completed_at);
    CREATE INDEX IF NOT EXISTS idx_file_change_captures_message_id
      ON file_change_captures(message_id);
    CREATE INDEX IF NOT EXISTS idx_file_change_captures_run_id
      ON file_change_captures(run_id) WHERE run_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_file_changes_capture_ordinal
      ON file_changes(capture_id, ordinal);
  `);
  // Keep development databases usable when a pre-release v35 table shape was
  // created before the protocol gained producer IDs and file modes.
  addColumnIfMissing(db, "file_change_captures", "producer_capture_id", "TEXT");
  addColumnIfMissing(db, "file_changes", "before_mode", "TEXT");
  addColumnIfMissing(db, "file_changes", "after_mode", "TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_file_change_captures_run_producer
      ON file_change_captures(run_id, producer_capture_id) WHERE producer_capture_id IS NOT NULL;
  `);
}

function migrateFileChangesToSparseEvidence(db: SqlDatabase): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'file_changes'").get() as { sql?: string } | undefined;
  if (!table?.sql?.includes("status = 'added'")) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_file_changes_capture_ordinal;
    CREATE TABLE file_changes_v36 (
      id TEXT PRIMARY KEY,
      capture_id TEXT NOT NULL REFERENCES file_change_captures(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      status TEXT NOT NULL CHECK (status IN ('added', 'modified', 'deleted')),
      kind TEXT NOT NULL CHECK (kind IN ('text', 'image', 'binary', 'other')),
      path TEXT NOT NULL,
      root TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      before_sha256 TEXT,
      before_size INTEGER CHECK (before_size IS NULL OR before_size >= 0),
      before_media_type TEXT,
      before_encoding TEXT CHECK (before_encoding IS NULL OR before_encoding IN ('utf8', 'base64')),
      before_mode TEXT,
      before_content TEXT,
      before_content_truncated INTEGER NOT NULL DEFAULT 0 CHECK (before_content_truncated IN (0, 1)),
      before_redacted INTEGER NOT NULL DEFAULT 0 CHECK (before_redacted IN (0, 1)),
      after_sha256 TEXT,
      after_size INTEGER CHECK (after_size IS NULL OR after_size >= 0),
      after_media_type TEXT,
      after_encoding TEXT CHECK (after_encoding IS NULL OR after_encoding IN ('utf8', 'base64')),
      after_mode TEXT,
      after_content TEXT,
      after_content_truncated INTEGER NOT NULL DEFAULT 0 CHECK (after_content_truncated IN (0, 1)),
      after_redacted INTEGER NOT NULL DEFAULT 0 CHECK (after_redacted IN (0, 1)),
      unified_diff TEXT,
      diff_truncated INTEGER NOT NULL DEFAULT 0 CHECK (diff_truncated IN (0, 1)),
      provenance TEXT NOT NULL CHECK (provenance = 'observed-between-checkpoints'),
      UNIQUE(capture_id, ordinal),
      CHECK (before_redacted = 0 OR before_content IS NULL),
      CHECK (after_redacted = 0 OR after_content IS NULL)
    );
    INSERT INTO file_changes_v36 (
      id, capture_id, ordinal, status, kind, path, root, relative_path,
      before_sha256, before_size, before_media_type, before_encoding, before_mode,
      before_content, before_content_truncated, before_redacted,
      after_sha256, after_size, after_media_type, after_encoding, after_mode,
      after_content, after_content_truncated, after_redacted,
      unified_diff, diff_truncated, provenance
    )
    SELECT
      id, capture_id, ordinal, status, kind, path, root, relative_path,
      before_sha256, before_size, before_media_type, before_encoding, before_mode,
      before_content, before_content_truncated, before_redacted,
      after_sha256, after_size, after_media_type, after_encoding, after_mode,
      after_content, after_content_truncated, after_redacted,
      unified_diff, diff_truncated, provenance
    FROM file_changes;
    DROP TABLE file_changes;
    ALTER TABLE file_changes_v36 RENAME TO file_changes;
    CREATE INDEX idx_file_changes_capture_ordinal ON file_changes(capture_id, ordinal);
  `);
}

function migrateInlineContextCaptures(db: SqlDatabase): void {
  const rows = db.prepare(`
    SELECT id, thread_id, run_id, created_at, timeline_json
    FROM chat_messages
    WHERE role = 'assistant' AND timeline_json LIKE '%context-taxonomy%'
  `).all() as Array<{ id: string; thread_id: string; run_id: string | null; created_at: string; timeline_json: string }>;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO context_captures (
      id, thread_id, message_id, run_id, task_index, request_index, request_count,
      captured_at, provider, model, source, schema_version, raw_payload_gzip,
      raw_state, raw_sha256, raw_char_count, raw_byte_count, validation_json, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateTimeline = db.prepare("UPDATE chat_messages SET timeline_json = ? WHERE id = ? AND timeline_json = ?");

  for (const row of rows) {
    let timeline: ChatTimelineItem[];
    try { timeline = JSON.parse(row.timeline_json) as ChatTimelineItem[]; } catch { continue; }
    const captureItems = timeline.filter((item): item is Extract<ChatTimelineItem, { kind: "system" }> =>
      item.kind === "system" && item.customType === "context-taxonomy" && Boolean(item.data && typeof item.data === "object")
    );
    if (captureItems.length === 0) continue;
    let migrated = true;
    for (const [captureIndex, item] of captureItems.entries()) {
      try {
        const taxonomy = item.data as Record<string, unknown>;
        const raw = typeof taxonomy.rawPayload === "string" ? taxonomy.rawPayload : null;
        let rawState: "complete" | "legacy_truncated" | "unavailable" = raw ? "complete" : "unavailable";
        if (raw) {
          try { JSON.parse(raw); } catch { rawState = "legacy_truncated"; }
        }
        const request = taxonomy.providerRequest && typeof taxonomy.providerRequest === "object" ? taxonomy.providerRequest as Record<string, unknown> : {};
        const requestIndex = positiveInteger(request.index, captureIndex + 1);
        const requestCount = positiveInteger(request.count, captureItems.length);
        const taskIndex = positiveInteger(request.taskIndex, 1);
        const fallbackTaxonomy = rawState === "complete" ? undefined : withoutRawPayload(taxonomy);
        const metadata = {
          assemblyReason: taxonomy.assemblyReason,
          cacheMetrics: taxonomy.cacheMetrics,
          payloadShape: taxonomy.payloadShape,
          ...(fallbackTaxonomy ? { fallbackTaxonomy } : {})
        };
        insert.run(
          randomUUID(), row.thread_id, row.id, row.run_id, taskIndex, requestIndex, requestCount,
          typeof taxonomy.capturedAt === "string" ? taxonomy.capturedAt : row.created_at,
          typeof taxonomy.provider === "string" ? taxonomy.provider : "unknown-provider",
          typeof taxonomy.model === "string" ? taxonomy.model : "unknown-model",
          typeof taxonomy.source === "string" ? taxonomy.source : "provider-payload",
          positiveInteger(taxonomy.payloadSchemaVersion, 4),
          raw ? gzipSync(Buffer.from(raw, "utf8")) : null,
          rawState,
          typeof taxonomy.payloadHash === "string" ? taxonomy.payloadHash : raw ? createHash("sha256").update(raw).digest("hex") : null,
          raw?.length ?? 0,
          raw ? Buffer.byteLength(raw, "utf8") : 0,
          JSON.stringify(taxonomy.reasoningValidation ?? {}),
          JSON.stringify(metadata)
        );
      } catch {
        migrated = false;
        break;
      }
    }
    if (migrated) {
      const retained = timeline.filter((item) => !(item.kind === "system" && item.customType === "context-taxonomy"));
      updateTimeline.run(JSON.stringify(retained), row.id, row.timeline_json);
    }
  }
}

function withoutRawPayload(taxonomy: Record<string, unknown>): Record<string, unknown> {
  const { rawPayload: _rawPayload, ...rest } = taxonomy;
  return rest;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function markMigration(db: SqlDatabase, version: number, name: string, now: Clock): void {
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(version, name, now());
}

function addColumnIfMissing(db: SqlDatabase, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function hasMigration(db: SqlDatabase, version: number): boolean {
  const row = db.prepare("SELECT 1 AS exists_flag FROM schema_migrations WHERE version = ?").get(version) as { exists_flag?: number } | undefined;
  return row?.exists_flag === 1;
}

function mergeCurrentPiProviderModels(db: SqlDatabase, providerId: string, bundledModelIds: string[], timestamp: string): void {
  const row = db.prepare("SELECT models_json FROM providers WHERE id = ?").get(providerId) as { models_json?: string } | undefined;
  if (!row?.models_json) return;
  const existing = parseModelConfigs(row.models_json);
  const modelIds = Array.from(new Set([...existing.map((model) => model.id), ...bundledModelIds]));
  db.prepare("UPDATE providers SET models_json = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(mergeModelConfigs(existing, modelIds)),
    timestamp,
    providerId
  );
}

function restoreCanonicalPiTimelineRows(db: SqlDatabase, appliedAt: string): void {
  const rows = db.prepare(`
    SELECT messages.id, messages.content, messages.timeline_json, messages.session_entry_id,
           threads.session_id, threads.session_file
    FROM chat_messages AS messages
    JOIN chat_threads AS threads ON threads.id = messages.thread_id
    WHERE messages.role = 'assistant'
      AND messages.timeline_json IS NOT NULL
      AND messages.session_entry_id IS NOT NULL
      AND lower(messages.model_id) LIKE '%deepseek-v4%'
      AND threads.session_id IS NOT NULL
      AND threads.session_file IS NOT NULL
  `).all() as Array<{
    id: string;
    content: string;
    timeline_json: string | null;
    session_entry_id: string;
    session_id: string | null;
    session_file: string;
  }>;
  const plans: Array<{ id: string; oldContent: string; oldTimelineJson: string; content: string; timelineJson: string }> = [];
  let unresolvedCanonicalSource = false;
  const canonicalByFile = new Map<string, ReturnType<typeof readCanonicalPiBlockIndex>>();
  for (const row of rows) {
    if (!row.timeline_json) {
      unresolvedCanonicalSource = true;
      continue;
    }
    let timeline: unknown;
    try {
      timeline = JSON.parse(row.timeline_json);
    } catch {
      unresolvedCanonicalSource = true;
      continue;
    }
    if (!Array.isArray(timeline)) {
      unresolvedCanonicalSource = true;
      continue;
    }
    let canonical = canonicalByFile.get(row.session_file);
    if (canonical === undefined) {
      canonical = readCanonicalPiBlockIndex(row.session_file);
      canonicalByFile.set(row.session_file, canonical);
    }
    if (!canonical || canonical.sessionId !== row.session_id) {
      unresolvedCanonicalSource = true;
      continue;
    }
    const repaired = restoreCanonicalPiTimelineProjection(timeline as ChatTimelineItem[], row.content, canonical, row.session_entry_id);
    if (!repaired.resolved) {
      unresolvedCanonicalSource = true;
      continue;
    }
    if (!repaired.changed) continue;
    plans.push({
      id: row.id,
      oldContent: row.content,
      oldTimelineJson: row.timeline_json,
      content: repaired.content,
      timelineJson: JSON.stringify(repaired.timeline)
    });
  }

  db.exec("BEGIN IMMEDIATE;");
  try {
    const update = db.prepare(`
      UPDATE chat_messages SET content = ?, timeline_json = ?
      WHERE id = ? AND content = ? AND timeline_json = ?
    `);
    for (const plan of plans) {
      const result = update.run(plan.content, plan.timelineJson, plan.id, plan.oldContent, plan.oldTimelineJson);
      if (result.changes !== 1) throw new Error(`Canonical Pi timeline projection changed concurrently: ${plan.id}`);
    }
    // A temporarily locked/missing JSONL must not permanently suppress a
    // future repair attempt. Valid rows are still restored idempotently now;
    // the migration marker is written only after every candidate is readable.
    if (!unresolvedCanonicalSource) {
      markMigration(db, 29, "restore canonical Pi timeline projections", () => appliedAt);
    }
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the original migration error if SQLite already rolled back.
    }
    throw error;
  }
}

function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function backfillDefaultWorkspaceProject(db: SqlDatabase, now: Clock): void {
  const timestamp = now();
  const normalized = normalizeProjectRoot(process.env.JASMINE_DEFAULT_PROJECT_ROOT ?? process.cwd());
  const existing = db.prepare("SELECT id FROM workspace_projects WHERE root_key = ?").get(normalized.rootKey) as { id?: string } | undefined;
  const projectId = existing?.id ?? randomUUID();
  if (!existing) {
    db.prepare(`
      INSERT INTO workspace_projects (id, name, root_path, root_key, created_at, updated_at, last_opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, normalized.defaultName, normalized.rootPath, normalized.rootKey, timestamp, timestamp, timestamp);
  }
  db.prepare("UPDATE chat_threads SET project_id = ? WHERE project_id IS NULL").run(projectId);
}
