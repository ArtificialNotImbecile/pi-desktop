import type { WebSearchSettings, WebSearchSettingsUpdateRequest } from "../../../shared/ipc.js";
import type { SqlDatabase } from "./types.js";

type WebSearchSettingsRow = {
  id: string;
  enabled: number;
  updated_at: string;
};

export function ensureWebSearchSettings(db: SqlDatabase, timestamp: string): void {
  const existing = db.prepare("SELECT 1 AS exists_flag FROM web_search_settings WHERE id = 'default'").get() as { exists_flag?: number };
  if (existing?.exists_flag === 1) return;
  db.prepare(
    "INSERT INTO web_search_settings (id, enabled, updated_at) VALUES ('default', 0, ?)"
  ).run(timestamp);
}

export function getWebSearchSettings(db: SqlDatabase): WebSearchSettings | null {
  const row = db
    .prepare("SELECT id, enabled, updated_at FROM web_search_settings WHERE id = 'default'")
    .get() as WebSearchSettingsRow | undefined;
  return row ? mapWebSearchSettings(row) : null;
}

export function updateWebSearchSettings(
  db: SqlDatabase,
  current: WebSearchSettings,
  input: WebSearchSettingsUpdateRequest,
  timestamp: string
): void {
  const enabled = input.enabled ?? current.enabled;
  db.prepare("UPDATE web_search_settings SET enabled = ?, updated_at = ? WHERE id = 'default'")
    .run(enabled ? 1 : 0, timestamp);
}

function mapWebSearchSettings(row: WebSearchSettingsRow): WebSearchSettings {
  return {
    enabled: row.enabled === 1,
    updatedAt: row.updated_at
  };
}
