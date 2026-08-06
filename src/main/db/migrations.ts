import type { SqlDatabase } from "./repositories/types.js";
import { DEFAULT_APPEARANCE } from "../../shared/theme.js";
import { DEFAULT_BRAND_SETTINGS, LEGACY_HIRI_BRAND_COPY } from "../../shared/brand.js";
import { normalizeProjectRoot } from "./repositories/projects.js";
import { randomUUID } from "node:crypto";

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
      timeline_json TEXT NOT NULL DEFAULT '[]'
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

    CREATE TABLE IF NOT EXISTS remote_connections (
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
      skill_editor_path TEXT,
      terminal_shell_path TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_threads_updated_at ON chat_threads(updated_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_projects_root_key ON workspace_projects(root_key);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_created_at ON chat_messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_thread_drafts_updated_at ON thread_drafts(updated_at);
    CREATE INDEX IF NOT EXISTS idx_tool_runs_thread_started_at ON tool_runs(thread_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);
    CREATE INDEX IF NOT EXISTS idx_skills_enabled_name ON skills(enabled, name);
    CREATE INDEX IF NOT EXISTS idx_skill_sources_path ON skill_sources(path);
    CREATE INDEX IF NOT EXISTS idx_prompt_template_sources_path ON prompt_template_sources(path);
    CREATE INDEX IF NOT EXISTS idx_external_skill_states_enabled ON external_skill_states(enabled);
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_marketplace_id ON mcp_servers(marketplace_id);
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled_name ON mcp_servers(enabled, name);
    CREATE INDEX IF NOT EXISTS idx_remote_connections_active ON remote_connections(active, name);
    CREATE INDEX IF NOT EXISTS idx_remote_connections_config ON remote_connections(config_path, config_host);
    CREATE INDEX IF NOT EXISTS idx_activity_observations_created_at ON activity_observations(created_at);
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
  db.exec("CREATE INDEX IF NOT EXISTS idx_chat_threads_project_updated_at ON chat_threads(project_id, updated_at);");
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
